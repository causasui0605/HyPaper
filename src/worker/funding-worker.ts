import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { D } from '../utils/math.js';
import {
  PNL_FUNDING_CORRECTION_SCHEMA,
  PNL_FUNDING_EVENT_SCHEMA,
  pnlFundingCorrectionSchema,
  pnlFundingEventSchema,
  type PnlFundingCorrection,
  type PnlFundingEvent,
} from '../types/pnl.js';

export interface FundingRedis {
  smembers(key: string): Promise<string[]>;
  srem(key: string, ...members: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  get(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface FundingCorrectionInput {
  userId: string;
  asset: number;
  coin: string;
  fundingTime: number;
  appliedAt: number;
  expectedSzi: string;
  correctedOraclePx: string;
  correctedFundingRate: string;
  source: PnlFundingCorrection['source'];
}

export interface FundingDependencies {
  redis: FundingRedis;
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  fundingRateAt: (coin: string, fundingTime: number) => Promise<{
    rate: string;
    observedTime: number;
  }>;
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
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  fundingRateAt: async (coin, fundingTime) => {
    const response = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'fundingHistory',
        coin,
        startTime: fundingTime,
        endTime: fundingTime + config.FUNDING_INTERVAL_MS - 1,
      }),
    });
    if (!response.ok) throw new Error(`funding history request failed with ${response.status}`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error('funding history response is malformed');
    const matches = payload.filter((row): row is { time: number; fundingRate: string } => {
      if (typeof row !== 'object' || row === null) return false;
      const candidate = row as Record<string, unknown>;
      return Number.isSafeInteger(candidate.time)
        && typeof candidate.fundingRate === 'string'
        && Math.floor(Number(candidate.time) / config.FUNDING_INTERVAL_MS)
          * config.FUNDING_INTERVAL_MS === fundingTime;
    });
    if (matches.length !== 1) throw new Error('funding history boundary is missing or ambiguous');
    return { rate: matches[0].fundingRate, observedTime: matches[0].time };
  },
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

export const PNL_FUNDING_CORRECTION_LUA = String.raw`
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

local existing = redis.call('GET', KEYS[4])
if existing then
  if key_type(KEYS[5]) ~= 'list' or not redis.call('LPOS', KEYS[5], transaction.correctionId) then
    return response('refused', 'funding correction exists without immutable ledger index')
  end
  return response('retry', existing)
end

if key_type(KEYS[1]) ~= 'hash' then return response('refused', 'account hash is missing or malformed') end
if key_type(KEYS[2]) ~= 'hash' then return response('refused', 'position hash is missing or malformed') end
if key_type(KEYS[3]) ~= 'string' then return response('refused', 'original funding event is missing or malformed') end
if redis.call('GET', KEYS[3]) ~= transaction.originalEventJson then return response('refused', 'original funding event changed before correction commit') end
if not require_type(KEYS[4], 'string') then return response('refused', 'funding correction key has wrong type') end
if not require_type(KEYS[5], 'list') then return response('refused', 'funding correction index has wrong type') end
if redis.call('HGET', KEYS[1], 'userId') ~= transaction.user then return response('refused', 'account identity changed before correction commit') end
if redis.call('HGET', KEYS[1], 'balance') ~= transaction.accountBalanceBefore then return response('refused', 'account balance changed before correction commit') end
if redis.call('HGET', KEYS[2], 'userId') ~= transaction.user then return response('refused', 'position identity changed before correction commit') end
if redis.call('HGET', KEYS[2], 'asset') ~= transaction.asset then return response('refused', 'position asset changed before correction commit') end
if redis.call('HGET', KEYS[2], 'coin') ~= transaction.coin then return response('refused', 'position coin changed before correction commit') end
if redis.call('HGET', KEYS[2], 'szi') ~= transaction.szi then return response('refused', 'position size changed before correction commit') end
if (redis.call('HGET', KEYS[2], 'cumFunding') or '0') ~= transaction.cumFundingBefore then return response('refused', 'position cumulative funding changed before correction commit') end
if (redis.call('HGET', KEYS[2], 'cumFundingSinceOpen') or '0') ~= transaction.cumFundingSinceOpenBefore then return response('refused', 'position open funding changed before correction commit') end
if (redis.call('HGET', KEYS[2], 'cumFundingSinceChange') or '0') ~= transaction.cumFundingSinceChangeBefore then return response('refused', 'position change funding changed before correction commit') end

redis.call('HSET', KEYS[1], 'balance', transaction.accountBalanceAfter)
redis.call('HSET', KEYS[2],
  'cumFunding', transaction.cumFundingAfter,
  'cumFundingSinceOpen', transaction.cumFundingSinceOpenAfter,
  'cumFundingSinceChange', transaction.cumFundingSinceChangeAfter)
redis.call('SET', KEYS[4], transaction.correctionJson)
redis.call('RPUSH', KEYS[5], transaction.correctionId)
return response('applied', transaction.correctionJson)
`;

export function pnlFundingEventId(user: string, asset: number, fundingTime: number): string {
  const digest = createHash('sha256')
    .update(`${user}\0${asset}\0${fundingTime}`, 'utf8')
    .digest('hex');
  return `hpfe${digest}`;
}

export function pnlFundingCorrectionId(
  user: string,
  asset: number,
  fundingTime: number,
  originalEventId: string,
): string {
  const digest = createHash('sha256')
    .update(`${user}\0${asset}\0${fundingTime}\0${originalEventId}`, 'utf8')
    .digest('hex');
  return `hpfc${digest}`;
}

function parseLuaEnvelope(raw: unknown): z.infer<typeof luaEnvelopeSchema> {
  if (typeof raw !== 'string') throw new Error('funding transaction returned a non-string envelope');
  return luaEnvelopeSchema.parse(JSON.parse(raw));
}

function canonicalDecimal(raw: string, label: string): string {
  try {
    const value = D(raw);
    if (!value.isFinite()) throw new Error('not finite');
    // Decimal#toString switches to exponent notation below its configured
    // threshold. Durable PnL schemas intentionally allow only ordinary decimal
    // strings, so normalize without an exponent before schema validation.
    return value.toFixed();
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

function sameCorrectionInputs(
  stored: PnlFundingCorrection,
  input: FundingCorrectionInput,
  original: PnlFundingEvent,
): boolean {
  return stored.originalEventId === original.eventId
    && stored.asset === input.asset
    && stored.coin === input.coin
    && stored.fundingTime === input.fundingTime
    && stored.szi === input.expectedSzi
    && stored.originalFundingCharge === original.fundingCharge
    && stored.correctedOraclePx === input.correctedOraclePx
    && stored.correctedFundingRate === input.correctedFundingRate
    && JSON.stringify(stored.source) === JSON.stringify(input.source);
}

export class FundingWorker {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly dependencies: FundingDependencies;

  constructor(dependencies: Partial<FundingDependencies> = {}) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  private requireScheduleConfig(): void {
    for (const [label, value] of [
      ['FUNDING_INTERVAL_MS', config.FUNDING_INTERVAL_MS],
      ['FUNDING_APPLY_DELAY_MS', config.FUNDING_APPLY_DELAY_MS],
      ['FUNDING_MAX_LATE_MS', config.FUNDING_MAX_LATE_MS],
      ['FUNDING_RETRY_MS', config.FUNDING_RETRY_MS],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${label} must be a strictly positive safe integer`);
      }
    }
    if (config.FUNDING_APPLY_DELAY_MS >= config.FUNDING_MAX_LATE_MS
      || config.FUNDING_MAX_LATE_MS >= config.FUNDING_INTERVAL_MS) {
      throw new Error('funding timing configuration is inconsistent');
    }
  }

  private schedule(boundary: number, target: number): void {
    if (!this.running || this.timeoutId) return;
    const now = this.dependencies.now();
    requireSafeTime(now, 'funding clock');
    const delay = Math.max(1, target - now);
    this.timeoutId = this.dependencies.setTimer(() => {
      this.timeoutId = null;
      const firedAt = this.dependencies.now();
      if (firedAt < target) {
        this.schedule(boundary, target);
        return;
      }
      this.applyFunding(boundary, true)
        .then(() => this.scheduleNext(boundary))
        .catch((err) => {
          logger.error({ err, boundary }, 'Funding worker boundary attempt failed');
          const retryAt = this.dependencies.now() + config.FUNDING_RETRY_MS;
          const deadline = boundary + config.FUNDING_MAX_LATE_MS;
          if (retryAt <= deadline) this.schedule(boundary, retryAt);
          else this.scheduleNext(boundary);
        });
    }, delay);
  }

  private scheduleNext(priorBoundary: number): void {
    if (!this.running || this.timeoutId) return;
    const now = this.dependencies.now();
    requireSafeTime(now, 'funding clock');
    let boundary = priorBoundary + config.FUNDING_INTERVAL_MS;
    if (boundary <= now) {
      boundary = (Math.floor(now / config.FUNDING_INTERVAL_MS) + 1)
        * config.FUNDING_INTERVAL_MS;
    }
    this.schedule(boundary, boundary + config.FUNDING_APPLY_DELAY_MS);
  }

  start(): void {
    if (this.running) return;
    this.requireScheduleConfig();
    const now = this.dependencies.now();
    requireSafeTime(now, 'funding clock');
    const currentBoundary = Math.floor(now / config.FUNDING_INTERVAL_MS)
      * config.FUNDING_INTERVAL_MS;
    const boundary = now <= currentBoundary + config.FUNDING_MAX_LATE_MS
      ? currentBoundary
      : currentBoundary + config.FUNDING_INTERVAL_MS;
    const target = Math.max(now + 1, boundary + config.FUNDING_APPLY_DELAY_MS);
    this.running = true;
    this.schedule(boundary, target);
    logger.info({ boundary, target, firstRunInMs: target - now }, 'Funding worker started');
  }

  stop(): void {
    this.running = false;
    if (this.timeoutId) {
      this.dependencies.clearTimer(this.timeoutId);
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

  async applyFundingCorrection(
    rawInput: FundingCorrectionInput,
  ): Promise<'applied' | 'retry'> {
    requireSafeTime(rawInput.asset, 'funding correction asset');
    requireSafeTime(rawInput.fundingTime, 'funding correction time');
    requireSafeTime(rawInput.appliedAt, 'funding correction application time');
    if (rawInput.appliedAt < rawInput.fundingTime) {
      throw new Error('funding correction application time predates funding time');
    }
    const input: FundingCorrectionInput = {
      ...rawInput,
      expectedSzi: canonicalDecimal(rawInput.expectedSzi, 'funding correction position size'),
      correctedOraclePx: canonicalDecimal(rawInput.correctedOraclePx, 'corrected oracle price'),
      correctedFundingRate: canonicalDecimal(rawInput.correctedFundingRate, 'corrected funding rate'),
    };
    if (!D(input.correctedOraclePx).isPositive()) throw new Error('corrected oracle price must be positive');
    if (D(input.correctedFundingRate).isZero()) throw new Error('corrected funding rate must be nonzero');

    const originalEventId = pnlFundingEventId(input.userId, input.asset, input.fundingTime);
    const originalEventJson = await this.dependencies.redis.get(
      KEYS.PNL_FUNDING_EVENT(input.userId, originalEventId),
    );
    if (!originalEventJson) throw new Error('original funding event is missing');
    const original = pnlFundingEventSchema.parse(JSON.parse(originalEventJson));
    if (original.eventId !== originalEventId
      || original.asset !== input.asset
      || original.coin !== input.coin
      || original.fundingTime !== input.fundingTime
      || original.szi !== input.expectedSzi) {
      throw new Error('original funding event identity conflicts');
    }
    const originalSha256 = createHash('sha256').update(originalEventJson).digest('hex');
    if (input.source.originalEventSha256 !== originalSha256) {
      throw new Error('original funding event SHA-256 conflicts');
    }

    const assetStr = String(input.asset);
    const positionKey = KEYS.USER_POS(input.userId, input.asset);
    const position = await this.dependencies.redis.hgetall(positionKey);
    if (position.userId !== input.userId
      || position.asset !== assetStr
      || position.coin !== input.coin
      || canonicalDecimal(position.szi ?? '', 'active position size') !== input.expectedSzi) {
      throw new Error(`active position ${input.asset} identity conflicts`);
    }
    const account = await this.dependencies.redis.hgetall(KEYS.USER_ACCOUNT(input.userId));
    const accountBalanceBefore = canonicalDecimal(account.balance ?? '', `account ${input.userId} balance`);
    const correctedFundingCharge = D(input.expectedSzi)
      .times(input.correctedOraclePx).times(input.correctedFundingRate).toString();
    const fundingChargeDelta = D(correctedFundingCharge).minus(original.fundingCharge).toString();
    if (D(fundingChargeDelta).isZero()) throw new Error('funding correction has zero effect');
    const accountBalanceAfter = D(accountBalanceBefore).minus(fundingChargeDelta).toString();
    const cumFundingBefore = canonicalDecimal(position.cumFunding ?? '0', 'cumulative funding');
    const cumFundingSinceOpenBefore = canonicalDecimal(
      position.cumFundingSinceOpen ?? '0', 'open cumulative funding',
    );
    const cumFundingSinceChangeBefore = canonicalDecimal(
      position.cumFundingSinceChange ?? '0', 'change cumulative funding',
    );
    const cumFundingAfter = D(cumFundingBefore).plus(fundingChargeDelta).toString();
    const cumFundingSinceOpenAfter = D(cumFundingSinceOpenBefore).plus(fundingChargeDelta).toString();
    const cumFundingSinceChangeAfter = D(cumFundingSinceChangeBefore).plus(fundingChargeDelta).toString();
    const correctionId = pnlFundingCorrectionId(
      input.userId, input.asset, input.fundingTime, originalEventId,
    );
    const correction: PnlFundingCorrection = pnlFundingCorrectionSchema.parse({
      schema: PNL_FUNDING_CORRECTION_SCHEMA,
      kind: 'pnl_funding_correction',
      paper: true,
      correctionId,
      originalEventId,
      asset: input.asset,
      coin: input.coin,
      fundingTime: input.fundingTime,
      appliedAt: input.appliedAt,
      szi: input.expectedSzi,
      originalFundingCharge: original.fundingCharge,
      correctedOraclePx: input.correctedOraclePx,
      correctedFundingRate: input.correctedFundingRate,
      correctedFundingCharge,
      fundingChargeDelta,
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
    const correctionJson = JSON.stringify(correction);
    const transaction = JSON.stringify({
      user: input.userId,
      asset: assetStr,
      coin: input.coin,
      szi: input.expectedSzi,
      correctionId,
      originalEventJson,
      accountBalanceBefore,
      accountBalanceAfter,
      cumFundingBefore,
      cumFundingAfter,
      cumFundingSinceOpenBefore,
      cumFundingSinceOpenAfter,
      cumFundingSinceChangeBefore,
      cumFundingSinceChangeAfter,
      correctionJson,
    });
    const raw = await this.dependencies.redis.eval(
      PNL_FUNDING_CORRECTION_LUA,
      5,
      KEYS.USER_ACCOUNT(input.userId),
      positionKey,
      KEYS.PNL_FUNDING_EVENT(input.userId, originalEventId),
      KEYS.PNL_FUNDING_CORRECTION(input.userId, correctionId),
      KEYS.PNL_FUNDING_CORRECTIONS(input.userId),
      transaction,
    );
    const outcome = parseLuaEnvelope(raw);
    if (outcome.state === 'refused') throw new Error(`funding correction refused: ${outcome.value}`);
    const stored = pnlFundingCorrectionSchema.parse(JSON.parse(outcome.value));
    if (stored.correctionId !== correctionId || !sameCorrectionInputs(stored, input, original)) {
      throw new Error('funding correction returned conflicting immutable evidence');
    }
    return outcome.state;
  }

  async applyFunding(explicitFundingTime?: number, requireFreshContext = false): Promise<void> {
    if (!config.FUNDING_ENABLED) return;
    if (!Number.isSafeInteger(config.FUNDING_INTERVAL_MS) || config.FUNDING_INTERVAL_MS <= 0) {
      throw new Error('FUNDING_INTERVAL_MS must be a strictly positive safe integer');
    }
    const appliedAt = this.dependencies.now();
    requireSafeTime(appliedAt, 'funding clock');
    const fundingTime = explicitFundingTime ?? Math.floor(appliedAt / config.FUNDING_INTERVAL_MS)
      * config.FUNDING_INTERVAL_MS;
    requireSafeTime(fundingTime, 'funding time');
    if (fundingTime % config.FUNDING_INTERVAL_MS !== 0) {
      throw new Error('funding time is not an exact interval boundary');
    }
    if (appliedAt < fundingTime) throw new Error('funding worker fired before its boundary');
    if (requireFreshContext && appliedAt > fundingTime + config.FUNDING_MAX_LATE_MS) {
      throw new Error('funding worker missed its authorized boundary window');
    }

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
          if (requireFreshContext) {
            const observedAt = Number(context.observedAt);
            if (!Number.isSafeInteger(observedAt) || observedAt < fundingTime || observedAt > appliedAt) {
              throw new Error(`active position ${coin} market context is not fresh for the boundary`);
            }
          }
          const boundaryRate = requireFreshContext
            ? await this.dependencies.fundingRateAt(coin, fundingTime)
            : null;
          await this.applyFundingEvent({
            userId,
            asset,
            coin,
            fundingTime,
            appliedAt,
            expectedSzi: position.szi ?? '',
            oraclePx: context.oraclePx,
            fundingRate: boundaryRate?.rate ?? context.funding,
            source: boundaryRate === null
              ? { kind: 'live_market_context' }
              : {
                kind: 'live_boundary_snapshot',
                fundingHistoryTime: boundaryRate.observedTime,
                contextObservedAt: Number(context.observedAt),
              },
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
