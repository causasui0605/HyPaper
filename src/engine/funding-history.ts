import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D } from '../utils/math.js';
import { pnlFundingEventSchema } from '../types/pnl.js';
import { pnlFundingEventId } from '../worker/funding-worker.js';

export interface FundingHistoryRedis {
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  get(key: string): Promise<string | null>;
}

export interface UserFundingDelta {
  time: number;
  hash: string;
  delta: {
    type: 'funding';
    coin: string;
    usdc: string;
    szi: string;
    fundingRate: string;
  };
}

function requireTime(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export async function getUserFunding(
  userId: string,
  startTime = 0,
  endTime?: number,
  fundingRedis: FundingHistoryRedis = redis,
): Promise<UserFundingDelta[]> {
  const normalizedUser = userId.toLowerCase();
  const start = requireTime(startTime, 'startTime')!;
  const end = requireTime(endTime, 'endTime');
  if (end !== undefined && end < start) throw new Error('endTime must not precede startTime');

  const ids = await fundingRedis.lrange(KEYS.PNL_FUNDING_EVENTS(normalizedUser), 0, -1);
  if (new Set(ids).size !== ids.length) throw new Error('funding ledger contains duplicate event ids');
  const result: UserFundingDelta[] = [];
  let priorFundingTime = -1;
  for (const id of ids) {
    const raw = await fundingRedis.get(KEYS.PNL_FUNDING_EVENT(normalizedUser, id));
    if (!raw) throw new Error(`funding event ${id} is missing`);
    const event = pnlFundingEventSchema.parse(JSON.parse(raw));
    if (event.eventId !== id
      || event.eventId !== pnlFundingEventId(normalizedUser, event.asset, event.fundingTime)) {
      throw new Error(`funding event ${id} identity conflicts`);
    }
    if (event.fundingTime < priorFundingTime) throw new Error('funding ledger is out of order');
    if (!D(event.fundingCharge).eq(D(event.szi).times(event.oraclePx).times(event.fundingRate))) {
      throw new Error(`funding event ${id} charge conflicts`);
    }
    priorFundingTime = event.fundingTime;
    if (event.fundingTime < start || (end !== undefined && event.fundingTime > end)) continue;
    result.push({
      time: event.fundingTime,
      hash: event.eventId,
      delta: {
        type: 'funding',
        coin: event.coin,
        usdc: D(event.fundingCharge).negated().toString(),
        szi: event.szi,
        fundingRate: event.fundingRate,
      },
    });
  }
  return result;
}
