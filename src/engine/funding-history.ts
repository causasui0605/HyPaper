import { createHash } from 'node:crypto';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D } from '../utils/math.js';
import { pnlFundingCorrectionSchema, pnlFundingEventSchema } from '../types/pnl.js';
import {
  pnlFundingCorrectionId,
  pnlFundingEventId,
} from '../worker/funding-worker.js';

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
  const events = new Map<string, ReturnType<typeof pnlFundingEventSchema.parse>>();
  const eventRaw = new Map<string, string>();
  for (const id of ids) {
    const raw = await fundingRedis.get(KEYS.PNL_FUNDING_EVENT(normalizedUser, id));
    if (!raw) throw new Error(`funding event ${id} is missing`);
    const event = pnlFundingEventSchema.parse(JSON.parse(raw));
    if (event.eventId !== id
      || event.eventId !== pnlFundingEventId(normalizedUser, event.asset, event.fundingTime)) {
      throw new Error(`funding event ${id} identity conflicts`);
    }
    if (!D(event.fundingCharge).eq(D(event.szi).times(event.oraclePx).times(event.fundingRate))) {
      throw new Error(`funding event ${id} charge conflicts`);
    }
    events.set(id, event);
    eventRaw.set(id, raw);
  }

  const correctionIds = await fundingRedis.lrange(
    KEYS.PNL_FUNDING_CORRECTIONS(normalizedUser), 0, -1,
  );
  if (new Set(correctionIds).size !== correctionIds.length) {
    throw new Error('funding correction ledger contains duplicate ids');
  }
  const corrections = new Map<string, ReturnType<typeof pnlFundingCorrectionSchema.parse>>();
  for (const correctionId of correctionIds) {
    const raw = await fundingRedis.get(
      KEYS.PNL_FUNDING_CORRECTION(normalizedUser, correctionId),
    );
    if (!raw) throw new Error(`funding correction ${correctionId} is missing`);
    const correction = pnlFundingCorrectionSchema.parse(JSON.parse(raw));
    const original = events.get(correction.originalEventId);
    if (!original
      || correction.correctionId !== correctionId
      || correction.correctionId !== pnlFundingCorrectionId(
        normalizedUser, correction.asset, correction.fundingTime, correction.originalEventId,
      )
      || correction.asset !== original.asset
      || correction.coin !== original.coin
      || correction.fundingTime !== original.fundingTime
      || correction.szi !== original.szi
      || correction.originalFundingCharge !== original.fundingCharge
      || correction.source.originalEventSha256
        !== createHash('sha256').update(eventRaw.get(correction.originalEventId)!).digest('hex')) {
      throw new Error(`funding correction ${correctionId} identity conflicts`);
    }
    if (!D(correction.correctedFundingCharge).eq(
      D(correction.szi).times(correction.correctedOraclePx)
        .times(correction.correctedFundingRate),
    ) || !D(correction.fundingChargeDelta).eq(
      D(correction.correctedFundingCharge).minus(correction.originalFundingCharge),
    )) {
      throw new Error(`funding correction ${correctionId} arithmetic conflicts`);
    }
    if (corrections.has(correction.originalEventId)) {
      throw new Error(`funding event ${correction.originalEventId} has multiple corrections`);
    }
    corrections.set(correction.originalEventId, correction);
  }

  const result: UserFundingDelta[] = [];
  for (const [id, event] of events) {
    if (event.fundingTime < start || (end !== undefined && event.fundingTime > end)) continue;
    const correction = corrections.get(id);
    result.push({
      time: event.fundingTime,
      hash: correction?.correctionId ?? event.eventId,
      delta: {
        type: 'funding',
        coin: event.coin,
        usdc: D(correction?.correctedFundingCharge ?? event.fundingCharge).negated().toString(),
        szi: event.szi,
        fundingRate: correction?.correctedFundingRate ?? event.fundingRate,
      },
    });
  }
  result.sort((left, right) => left.time - right.time || left.delta.coin.localeCompare(right.delta.coin));
  return result;
}
