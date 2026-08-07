import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D, isZero } from '../utils/math.js';
import {
  PNL_FUNDING_EVENT_SCHEMA,
  pnlFundingEventSchema,
  type PnlFundingEvent,
} from '../types/pnl.js';

export interface FundingRedis {
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface FundingDependencies {
  redis: FundingRedis;
  now: () => number;
}

const defaultDependencies: FundingDependencies = {
  redis,
  now: Date.now,
};

const luaEnvelopeSchema = z.object({
  state: z.enum(['applied', 'retry', 'refused']),
  value: z.string(),
}).strict();

export const PNL_FUNDING_LUA = String.raw`
local transaction = cjson.decode(ARGV[1])
local function response(state, value) return cjson.encode({state=state, value=value}) end
local function key_type(key)
  local result = redis.call('TYPE', key)
  if type(result) == 'table' then return result['ok'] end
  return result
end
local function require_type(key, expected)
  local actual = key_type(key)
  return actual == 'none' or actual == expected
end

local existing = redis.call('GET', KEYS[3])
if existing then
  if key_type(KEYS[4]) ~= 'list' or not redis.call('LPOS', KEYS[4], transaction.eventId) then
    return response('refused', 'funding event exists without immutable ledger index')
  end
  return response('retry', existing)
end

if key_type(KEYS[1]) ~= 'hash' then return response('refused', 'account hash is missing or malformed') end
if key_type(KEYS[2]) ~= 'hash' then return response('refused', 'position hash is missing or malformed') end
if not require_type(KEYS[3], 'string') then return response('refused', 'funding event key has wrong type') end
if not require_type(KEYS[4], 'list') then return response('refused', 'funding ledger index has wrong type') end
if redis.call('HGET', KEYS[1], 'userId') ~= transaction.user then return response('refused', 'account identity changed before funding commit') end
if redis.call('HGET', KEYS[1], 'balance') ~= transaction.accountBalanceBefore then return response('refused', 'account balance changed before funding commit') end
if redis.call('HGET', KEYS[2], 'userId') ~= transaction.user then return response('refused', 'position identity changed before funding commit') end
if redis.call('HGET', KEYS[2], 'asset') ~= transaction.asset then return response('refused', 'position asset changed before funding commit') end
if redis.call('HGET', KEYS[2], 'coin') ~= transaction.coin then return response('refused', 'position coin changed before funding commit') end
if redis.call('HGET', KEYS[2], 'szi') ~= transaction.szi then return response('refused', 'position size changed before funding commit') end
if (redis.call('HGET', KEYS[2], 'cumFunding') or '0') ~= transaction.cumFundingBefore then return response('refused', 'position cumulative funding changed before funding commit') end
if (redis.call('HGET', KEYS[2], 'cumFundingSinceOpen') or '0') ~= transaction.cumFundingSinceOpenBefore then return response('refused', 'position open funding changed before funding commit') end
if (redis.call('HGET', KEYS[2], 'cumFundingSinceChange') or '0') ~= transaction.cumFundingSinceChangeBefore then return response('refused', 'position change funding changed before funding commit') end

redis.call('HSET', KEYS[1], 'balance', transaction.accountBalanceAfter)
redis.call('HSET', KEYS[2],
  'cumFunding', transaction.cumFundingAfter,
  'cumFundingSinceOpen', transaction.cumFundingSinceOpenAfter,
  'cumFundingSinceChange', transaction.cumFundingSinceChangeAfter)
redis.call('SET', KEYS[3], transaction.eventJson)
redis.call('RPUSH', KEYS[4], transaction.eventId)
return response('applied', transaction.eventJson)
`;

export function pnlFundingEventId(user: string, asset: number, fundingTime: number): string {
  const digest = createHash('sha256')
    .update(`${user}\0${asset}\0${fundingTime}`, 'utf8')
    .digest('hex');
  return `hpfe${digest}`;
}

function parseLuaEnvelope(raw: unknown): z.infer<typeof luaEnvelopeSchema> {
  if (typeof raw !== 'string') throw new Error('funding transaction returned a non-string envelope');
  return luaEnvelopeSchema.parse(JSON.parse(raw));
}

export class FundingWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly dependencies: FundingDependencies = defaultDependencies) {}

  start(): void {
    if (this.intervalId) return;
    if (!Number.isSafeInteger(config.FUNDING_INTERVAL_MS) || config.FUNDING_INTERVAL_MS <= 0) {
      throw new Error('FUNDING_INTERVAL_MS must be a strictly positive safe integer');
    }
    this.intervalId = setInterval(() => {
      this.applyFunding().catch((err) => {
        logger.error({ err }, 'Funding worker error');
      });
    }, config.FUNDING_INTERVAL_MS);
    logger.info({ intervalMs: config.FUNDING_INTERVAL_MS }, 'Funding worker started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Funding worker stopped');
    }
  }

  async applyFunding(): Promise<void> {
    if (!config.FUNDING_ENABLED) return;
    if (!Number.isSafeInteger(config.FUNDING_INTERVAL_MS) || config.FUNDING_INTERVAL_MS <= 0) {
      throw new Error('FUNDING_INTERVAL_MS must be a strictly positive safe integer');
    }
    const appliedAt = this.dependencies.now();
    if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) {
      throw new Error('funding clock returned an invalid timestamp');
    }
    const fundingTime = Math.floor(appliedAt / config.FUNDING_INTERVAL_MS)
      * config.FUNDING_INTERVAL_MS;

    const userIds = await this.dependencies.redis.smembers(KEYS.USERS_ACTIVE);
    if (userIds.length === 0) return;

    for (const userId of userIds) {
      const assets = await this.dependencies.redis.smembers(KEYS.USER_POSITIONS(userId));
      if (assets.length === 0) {
        await this.dependencies.redis.srem(KEYS.USERS_ACTIVE, userId);
        continue;
      }

      for (const assetStr of assets) {
        const asset = Number(assetStr);
        if (!Number.isSafeInteger(asset) || asset < 0 || String(asset) !== assetStr) {
          throw new Error(`invalid active position asset ${assetStr}`);
        }
        const positionKey = KEYS.USER_POS(userId, asset);
        const position = await this.dependencies.redis.hgetall(positionKey);
        const szi = position.szi ?? '0';
        if (isZero(szi)) continue;
        const coin = position.coin;
        if (!coin) throw new Error(`active position ${asset} is missing coin`);

        const context = await this.dependencies.redis.hgetall(KEYS.MARKET_CTX(coin));
        const fundingRate = context.funding;
        if (!fundingRate || isZero(fundingRate)) continue;
        const markPx = context.markPx;
        if (!markPx || isZero(markPx)) continue;

        const account = await this.dependencies.redis.hgetall(KEYS.USER_ACCOUNT(userId));
        if (!account.balance) throw new Error(`account ${userId} is missing balance`);
        const fundingCharge = D(szi).times(D(markPx)).times(D(fundingRate)).toString();
        const accountBalanceAfter = D(account.balance).minus(D(fundingCharge)).toString();
        const cumFundingBefore = position.cumFunding ?? '0';
        const cumFundingSinceOpenBefore = position.cumFundingSinceOpen ?? '0';
        const cumFundingSinceChangeBefore = position.cumFundingSinceChange ?? '0';
        const cumFundingAfter = D(cumFundingBefore).plus(D(fundingCharge)).toString();
        const cumFundingSinceOpenAfter = D(cumFundingSinceOpenBefore)
          .plus(D(fundingCharge)).toString();
        const cumFundingSinceChangeAfter = D(cumFundingSinceChangeBefore)
          .plus(D(fundingCharge)).toString();
        const id = pnlFundingEventId(userId, asset, fundingTime);
        const event: PnlFundingEvent = pnlFundingEventSchema.parse({
          schema: PNL_FUNDING_EVENT_SCHEMA,
          kind: 'pnl_funding_event',
          paper: true,
          eventId: id,
          asset,
          coin,
          fundingTime,
          appliedAt,
          szi,
          markPx,
          fundingRate,
          fundingCharge,
          accountBalanceBefore: account.balance,
          accountBalanceAfter,
          cumFundingBefore,
          cumFundingAfter,
          cumFundingSinceOpenBefore,
          cumFundingSinceOpenAfter,
          cumFundingSinceChangeBefore,
          cumFundingSinceChangeAfter,
        });
        const eventJson = JSON.stringify(event);
        const transaction = JSON.stringify({
          user: userId,
          asset: assetStr,
          coin,
          szi,
          eventId: id,
          accountBalanceBefore: account.balance,
          accountBalanceAfter,
          cumFundingBefore,
          cumFundingAfter,
          cumFundingSinceOpenBefore,
          cumFundingSinceOpenAfter,
          cumFundingSinceChangeBefore,
          cumFundingSinceChangeAfter,
          eventJson,
        });
        const raw = await this.dependencies.redis.eval(
          PNL_FUNDING_LUA,
          4,
          KEYS.USER_ACCOUNT(userId),
          positionKey,
          KEYS.PNL_FUNDING_EVENT(userId, id),
          KEYS.PNL_FUNDING_EVENTS(userId),
          transaction,
        );
        const outcome = parseLuaEnvelope(raw);
        if (outcome.state === 'refused') throw new Error(`funding transaction refused: ${outcome.value}`);
        const stored = pnlFundingEventSchema.parse(JSON.parse(outcome.value));
        if (stored.eventId !== id) throw new Error('funding transaction returned a different event');

        logger.debug({
          userId,
          coin,
          eventId: id,
          fundingTime,
          fundingCharge: stored.fundingCharge,
          state: outcome.state,
        }, 'Applied funding');
      }
    }
  }
}
