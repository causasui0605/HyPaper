import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D } from '../utils/math.js';
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

export interface FundingEventInput {
  userId: string;
  asset: number;
  coin: string;
  fundingTime: number;
  appliedAt: number;
  expectedSzi: string;
  oraclePx: string;
  fundingRate: string;
  source: PnlFundingEvent['source'];
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

function canonicalDecimal(raw: string, label: string): string {
  try {
    const value = D(raw);
    if (!value.isFinite()) throw new Error('not finite');
    return value.toString();
  } catch {
    throw new Error(`${label} must be a finite decimal string`);
  }
}

function requireSafeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function sameFundingInputs(stored: PnlFundingEvent, input: FundingEventInput): boolean {
  return stored.asset === input.asset
    && stored.coin === input.coin
    && stored.fundingTime === input.fundingTime
    && stored.szi === input.expectedSzi
    && stored.oraclePx === input.oraclePx
    && stored.fundingRate === input.fundingRate
    && JSON.stringify(stored.source) === JSON.stringify(input.source);
}

export class FundingWorker {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dependencies: FundingDependencies = defaultDependencies) {}

  start(): void {
    if (this.intervalId || this.timeoutId) return;
    if (!Number.isSafeInteger(config.FUNDING_INTERVAL_MS) || config.FUNDING_INTERVAL_MS <= 0) {
      throw new Error('FUNDING_INTERVAL_MS must be a strictly positive safe integer');
    }
    const now = this.dependencies.now();
    requireSafeTime(now, 'funding clock');
    const remainder = now % config.FUNDING_INTERVAL_MS;
    const delayMs = remainder === 0 ? config.FUNDING_INTERVAL_MS : config.FUNDING_INTERVAL_MS - remainder;
    const apply = () => {
      this.applyFunding().catch((err) => {
        logger.error({ err }, 'Funding worker error');
      });
    };
    this.timeoutId = setTimeout(() => {
      this.timeoutId = null;
      apply();
      this.intervalId = setInterval(apply, config.FUNDING_INTERVAL_MS);
    }, delayMs);
    logger.info({ intervalMs: config.FUNDING_INTERVAL_MS, firstRunInMs: delayMs }, 'Funding worker started');
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    logger.info('Funding worker stopped');
  }

  async applyFundingEvent(rawInput: FundingEventInput): Promise<'applied' | 'retry' | 'skipped'> {
    requireSafeTime(rawInput.asset, 'funding asset');
    requireSafeTime(rawInput.fundingTime, 'funding time');
    requireSafeTime(rawInput.appliedAt, 'funding application time');
    if (rawInput.appliedAt < rawInput.fundingTime) {
      throw new Error('funding application time predates funding time');
    }
    const input: FundingEventInput = {
      ...rawInput,
      expectedSzi: canonicalDecimal(rawInput.expectedSzi, 'position size'),
      oraclePx: canonicalDecimal(rawInput.oraclePx, 'oracle price'),
      fundingRate: canonicalDecimal(rawInput.fundingRate, 'funding rate'),
    };
    if (!D(input.oraclePx).isPositive()) throw new Error('oracle price must be positive');
    if (D(input.fundingRate).isZero()) return 'skipped';

    const assetStr = String(input.asset);
    const positionKey = KEYS.USER_POS(input.userId, input.asset);
    const position = await this.dependencies.redis.hgetall(positionKey);
    if (position.userId !== input.userId
      || position.asset !== assetStr
      || position.coin !== input.coin) {
      throw new Error(`active position ${input.asset} identity conflicts`);
    }
    const szi = canonicalDecimal(position.szi ?? '', 'active position size');
    if (szi !== input.expectedSzi) throw new Error(`active position ${input.asset} size conflicts`);
    if (D(szi).isZero()) return 'skipped';

    const account = await this.dependencies.redis.hgetall(KEYS.USER_ACCOUNT(input.userId));
    const accountBalanceBefore = canonicalDecimal(account.balance ?? '', `account ${input.userId} balance`);
    const fundingCharge = D(szi).times(D(input.oraclePx)).times(D(input.fundingRate)).toString();
    const accountBalanceAfter = D(accountBalanceBefore).minus(D(fundingCharge)).toString();
    const cumFundingBefore = canonicalDecimal(position.cumFunding ?? '0', 'cumulative funding');
    const cumFundingSinceOpenBefore = canonicalDecimal(
      position.cumFundingSinceOpen ?? '0', 'open cumulative funding',
    );
    const cumFundingSinceChangeBefore = canonicalDecimal(
      position.cumFundingSinceChange ?? '0', 'change cumulative funding',
    );
    const cumFundingAfter = D(cumFundingBefore).plus(D(fundingCharge)).toString();
    const cumFundingSinceOpenAfter = D(cumFundingSinceOpenBefore).plus(D(fundingCharge)).toString();
    const cumFundingSinceChangeAfter = D(cumFundingSinceChangeBefore).plus(D(fundingCharge)).toString();
    const id = pnlFundingEventId(input.userId, input.asset, input.fundingTime);
    const event: PnlFundingEvent = pnlFundingEventSchema.parse({
      schema: PNL_FUNDING_EVENT_SCHEMA,
      kind: 'pnl_funding_event',
      paper: true,
      eventId: id,
      asset: input.asset,
      coin: input.coin,
      fundingTime: input.fundingTime,
      appliedAt: input.appliedAt,
      szi,
      oraclePx: input.oraclePx,
      fundingRate: input.fundingRate,
      fundingCharge,
      source: input.source,
      accountBalanceBefore,
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
      user: input.userId,
      asset: assetStr,
      coin: input.coin,
      szi,
      eventId: id,
      accountBalanceBefore,
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
      KEYS.USER_ACCOUNT(input.userId),
      positionKey,
      KEYS.PNL_FUNDING_EVENT(input.userId, id),
      KEYS.PNL_FUNDING_EVENTS(input.userId),
      transaction,
    );
    const outcome = parseLuaEnvelope(raw);
    if (outcome.state === 'refused') throw new Error(`funding transaction refused: ${outcome.value}`);
    const stored = pnlFundingEventSchema.parse(JSON.parse(outcome.value));
    if (stored.eventId !== id || !sameFundingInputs(stored, input)) {
      throw new Error('funding transaction returned conflicting immutable evidence');
    }

    logger.debug({
      userId: input.userId,
      coin: input.coin,
      eventId: id,
      fundingTime: input.fundingTime,
      fundingCharge: stored.fundingCharge,
      state: outcome.state,
    }, 'Applied funding');
    return outcome.state;
  }

  async applyFunding(): Promise<void> {
    if (!config.FUNDING_ENABLED) return;
    if (!Number.isSafeInteger(config.FUNDING_INTERVAL_MS) || config.FUNDING_INTERVAL_MS <= 0) {
      throw new Error('FUNDING_INTERVAL_MS must be a strictly positive safe integer');
    }
    const appliedAt = this.dependencies.now();
    requireSafeTime(appliedAt, 'funding clock');
    const fundingTime = Math.floor(appliedAt / config.FUNDING_INTERVAL_MS)
      * config.FUNDING_INTERVAL_MS;

    const userIds = await this.dependencies.redis.smembers(KEYS.USERS_ACTIVE);
    if (userIds.length === 0) return;

    const errors: Error[] = [];
    for (const userId of userIds) {
      const assets = await this.dependencies.redis.smembers(KEYS.USER_POSITIONS(userId));
      if (assets.length === 0) {
        await this.dependencies.redis.srem(KEYS.USERS_ACTIVE, userId);
        continue;
      }

      for (const assetStr of assets) {
        try {
          const asset = Number(assetStr);
          if (!Number.isSafeInteger(asset) || asset < 0 || String(asset) !== assetStr) {
            throw new Error(`invalid active position asset ${assetStr}`);
          }
          const position = await this.dependencies.redis.hgetall(KEYS.USER_POS(userId, asset));
          const coin = position.coin;
          if (!coin) throw new Error(`active position ${asset} is missing coin`);
          const context = await this.dependencies.redis.hgetall(KEYS.MARKET_CTX(coin));
          if (!context.funding) throw new Error(`active position ${coin} is missing funding rate`);
          if (!context.oraclePx) throw new Error(`active position ${coin} is missing oracle price`);
          await this.applyFundingEvent({
            userId,
            asset,
            coin,
            fundingTime,
            appliedAt,
            expectedSzi: position.szi ?? '',
            oraclePx: context.oraclePx,
            fundingRate: context.funding,
            source: { kind: 'live_market_context' },
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          errors.push(err);
          logger.error({ err, userId, asset: assetStr, fundingTime }, 'Funding position refused');
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `${errors.length} funding position(s) refused: ${errors.map((error) => error.message).join('; ')}`,
      );
    }
  }
}
