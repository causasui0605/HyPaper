import { createHash } from 'node:crypto';
import DecimalModule from 'decimal.js';
import { z } from 'zod';
import { config } from '../config.js';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { getUserExecutionPresencePg } from '../store/pg-queries.js';
import { getAssetMetadata } from './asset.js';
import { computeVwap } from '../utils/slippage.js';
import {
  HISTORICAL_REPLAY_EVENT_SCHEMA,
  historicalReplayResultSchema,
  historicalReplayPayloadSchema,
  type HistoricalReplayPayload,
  type HistoricalReplayResult,
  type HistoricalReplayStoredEvent,
  type ReplayEvent,
  type ReplayPriceEvidence,
  type ReplayRiskMark,
} from '../types/historical-replay.js';

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const Decimal = DecimalModule.default ?? DecimalModule;
type DecimalValue = InstanceType<typeof Decimal>;
const PHASE_ORDER: Record<ReplayEvent['phase'], number> = {
  scheduled_entry: 0,
  scheduled_reduction: 1,
};

export function effectiveReplayTakerFee(feesEnabled: boolean, takerFeeRate: string): string {
  return feesEnabled ? takerFeeRate : '0';
}

interface ReplayRedis {
  get(key: string): Promise<string | null>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  smembers(key: string): Promise<string[]>;
  keys(pattern: string): Promise<string[]>;
  zcard(key: string): Promise<number>;
  hlen(key: string): Promise<number>;
  llen(key: string): Promise<number>;
  sismember(key: string, member: string): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface HistoricalReplayDependencies {
  redis: ReplayRedis;
  getUserExecutionPresencePg: typeof getUserExecutionPresencePg;
  getAssetMetadata: typeof getAssetMetadata;
  now: () => number;
  takerFeeRate: string;
}

const defaultDependencies: HistoricalReplayDependencies = {
  redis: redis as unknown as ReplayRedis,
  getUserExecutionPresencePg,
  getAssetMetadata,
  now: Date.now,
  takerFeeRate: effectiveReplayTakerFee(config.FEES_ENABLED, config.FEE_RATE_TAKER),
};

export class HistoricalReplayError extends Error {
  constructor(
    message: string,
    public readonly code: 'invalid' | 'disabled' | 'conflict' | 'not_found',
    public readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'HistoricalReplayError';
  }
}

function invalid(message: string): never {
  throw new HistoricalReplayError(message, 'invalid', 400);
}

/** Recursive sorted-key, compact UTF-8 JSON used by every replay digest. */
export function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function withoutId<T extends Record<string, unknown>>(value: T, id: keyof T): Record<string, unknown> {
  const copy = { ...value };
  delete copy[id];
  return copy;
}

export function expectedEvidenceId(evidence: ReplayPriceEvidence): string {
  return `hprp${sha256Canonical(withoutId(evidence, 'evidenceId'))}`;
}

export function expectedEventId(
  event: ReplayEvent,
  digests: Pick<HistoricalReplayPayload, 'sourceDigest' | 'priceEvidenceDigest' | 'modelInputDigest'>,
): string {
  return `hpre${sha256Canonical({
    event: withoutId(event, 'eventId'),
    sourceDigest: digests.sourceDigest,
    priceEvidenceDigest: digests.priceEvidenceDigest,
    modelInputDigest: digests.modelInputDigest,
  })}`;
}

export function expectedRiskMarkId(evidence: ReplayRiskMark): string {
  return `hprr${sha256Canonical(withoutId(evidence, 'riskMarkId'))}`;
}

export function expectedBatchId(payload: Omit<HistoricalReplayPayload, 'batchId'>): string {
  return `hprb${sha256Canonical({
    schema: payload.schema,
    sourceDigest: payload.sourceDigest,
    priceEvidenceDigest: payload.priceEvidenceDigest,
    modelInputDigest: payload.modelInputDigest,
    riskMarkEvidenceDigest: payload.riskMarkEvidenceDigest,
    assetBindings: payload.assetBindings,
    eventIds: payload.events.map((event) => event.eventId),
  })}`;
}

export function expectedSyntheticFillId(batchId: string, eventId: string, sequence: number): string {
  return `hprf${sha256Canonical({ batchId, eventId, sequence })}`;
}

function assertCanonicalConfiguredFee(value: string): void {
  if (!DECIMAL_PATTERN.test(value)) invalid('configured taker fee is not a canonical decimal');
}

function compareEventOrder(left: ReplayEvent, right: ReplayEvent): number {
  return left.effectiveAt - right.effectiveAt
    || PHASE_ORDER[left.phase] - PHASE_ORDER[right.phase]
    || left.sequence - right.sequence;
}

function assertBookLevels(evidence: ReplayPriceEvidence): void {
  const assertOrdered = (side: 'bids' | 'asks', descending: boolean): void => {
    const levels = evidence[side];
    if (!levels) return;
    for (let index = 1; index < levels.length; index += 1) {
      const prior = new Decimal(levels[index - 1].px);
      const current = new Decimal(levels[index].px);
      if (descending ? !prior.gt(current) : !prior.lt(current)) {
        invalid(`${evidence.evidenceId} ${side} must be strictly ${descending ? 'descending' : 'ascending'}`);
      }
    }
  };
  assertOrdered('bids', true);
  assertOrdered('asks', false);

  const mid = new Decimal(evidence.midPx);
  if (evidence.bids?.length && new Decimal(evidence.bids[0].px).gt(mid)) {
    invalid(`${evidence.evidenceId} best bid exceeds midPx`);
  }
  if (evidence.asks?.length && new Decimal(evidence.asks[0].px).lt(mid)) {
    invalid(`${evidence.evidenceId} best ask is below midPx`);
  }
  if (evidence.bids?.length && evidence.asks?.length
    && new Decimal(evidence.bids[0].px).gte(evidence.asks[0].px)) {
    invalid(`${evidence.evidenceId} book is crossed`);
  }
  const limit = new Decimal(evidence.aggressiveLimitPx);
  if (evidence.side === 'B' ? limit.lt(mid) : limit.gt(mid)) {
    invalid(`${evidence.evidenceId} aggressiveLimitPx is not aggressive for side`);
  }
}

/** Strict schema plus all cross-record, chronology, digest and programme checks. */
export function validateHistoricalReplayPayload(input: unknown, configuredTakerFee: string): HistoricalReplayPayload {
  const parsed = historicalReplayPayloadSchema.safeParse(input);
  if (!parsed.success) invalid(`invalid historical replay schema: ${parsed.error.message}`);
  const payload = parsed.data;

  assertCanonicalConfiguredFee(configuredTakerFee);
  if (payload.modelInputs.feeRate !== configuredTakerFee) {
    invalid('model feeRate does not exactly match the configured taker fee');
  }
  if (payload.sourceDigest !== sha256Canonical(payload.source)) invalid('sourceDigest mismatch');
  if (payload.modelInputDigest !== sha256Canonical(payload.modelInputs)) invalid('modelInputDigest mismatch');

  const riskMarkById = new Map<string, ReplayRiskMark>();
  for (const riskMark of payload.riskMarkEvidence) {
    if (riskMarkById.has(riskMark.riskMarkId)) invalid(`duplicate riskMarkId ${riskMark.riskMarkId}`);
    if (riskMark.riskMarkId !== expectedRiskMarkId(riskMark)) invalid(`riskMarkId mismatch for ${riskMark.riskMarkId}`);
    if (riskMark.responseAt < riskMark.requestAt || riskMark.responseAt - riskMark.requestAt > 60_000) {
      invalid(`${riskMark.riskMarkId} risk mark request/response interval is invalid`);
    }
    riskMarkById.set(riskMark.riskMarkId, riskMark);
  }
  if (payload.riskMarkEvidenceDigest !== sha256Canonical(payload.riskMarkEvidence)) {
    invalid('riskMarkEvidenceDigest mismatch');
  }
  if (payload.riskMarkEvidence.some((riskMark) => payload.source.generatedAt < riskMark.responseAt)) {
    invalid('source generatedAt precedes captured risk mark evidence');
  }

  const evidenceById = new Map<string, ReplayPriceEvidence>();
  for (const evidence of payload.priceEvidence) {
    if (evidenceById.has(evidence.evidenceId)) invalid(`duplicate evidenceId ${evidence.evidenceId}`);
    if (evidence.evidenceId !== expectedEvidenceId(evidence)) invalid(`evidenceId mismatch for ${evidence.evidenceId}`);
    if (evidence.side === 'B' && evidence.asks === undefined) {
      invalid(`${evidence.evidenceId} executed asks side must be explicitly present`);
    }
    if (evidence.side === 'A' && evidence.bids === undefined) {
      invalid(`${evidence.evidenceId} executed bids side must be explicitly present`);
    }
    if (evidence.requestAt < evidence.effectiveAt
      || evidence.responseAt < evidence.requestAt
      || evidence.requestAt - evidence.effectiveAt > 60_000
      || evidence.responseAt - evidence.effectiveAt > 60_000) {
      invalid(`${evidence.evidenceId} request/response timestamps must be within 60 seconds after effectiveAt`);
    }
    if (payload.source.generatedAt < evidence.responseAt) {
      invalid('source generatedAt precedes captured evidence');
    }
    assertBookLevels(evidence);
    evidenceById.set(evidence.evidenceId, evidence);
  }
  if (payload.priceEvidenceDigest !== sha256Canonical(payload.priceEvidence)) {
    invalid('priceEvidenceDigest mismatch');
  }

  const eventIds = new Set<string>();
  const sequences = new Set<number>();
  const referencedEvidence = new Set<string>();
  const remainingByAsset = new Map<number, DecimalValue>();
  const entrySideByAsset = new Map<number, 'B' | 'A'>();
  const coinByAsset = new Map<number, string>();
  for (let index = 0; index < payload.events.length; index += 1) {
    const event = payload.events[index];
    if (eventIds.has(event.eventId)) invalid(`duplicate eventId ${event.eventId}`);
    if (sequences.has(event.sequence)) invalid(`duplicate event sequence ${event.sequence}`);
    if (event.sequence !== index) invalid('event sequences must be contiguous and match canonical array order');
    if (index > 0 && compareEventOrder(payload.events[index - 1], event) >= 0) {
      invalid('events are not in canonical (effectiveAt, entry-before-reduction, sequence) order');
    }
    const evidence = evidenceById.get(event.priceEvidenceId);
    if (!evidence) invalid(`event ${event.eventId} references unknown price evidence`);
    if (referencedEvidence.has(event.priceEvidenceId)) invalid(`price evidence ${event.priceEvidenceId} is reused`);
    if (event.asset !== evidence.asset || event.coin !== evidence.coin || event.effectiveAt !== evidence.effectiveAt) {
      invalid(`event ${event.eventId} does not exactly match its price evidence`);
    }
    if (event.eventId !== expectedEventId(event, payload)) invalid(`eventId mismatch for ${event.eventId}`);

    const size = new Decimal(evidence.sz);
    const remaining = remainingByAsset.get(event.asset);
    if (event.phase === 'scheduled_entry') {
      if (remaining !== undefined) invalid(`asset ${event.asset} has more than one scheduled entry`);
      remainingByAsset.set(event.asset, size);
      entrySideByAsset.set(event.asset, evidence.side);
      coinByAsset.set(event.asset, event.coin);
    } else {
      if (remaining === undefined) invalid(`asset ${event.asset} reduction precedes its entry`);
      if (coinByAsset.get(event.asset) !== event.coin) invalid(`asset ${event.asset} coin changed`);
      if (entrySideByAsset.get(event.asset) === evidence.side) invalid(`asset ${event.asset} reduction increases exposure`);
      if (size.gt(remaining)) invalid(`asset ${event.asset} reduction flips position`);
      if (remaining.isZero()) invalid(`asset ${event.asset} is reduced after full close`);
      remainingByAsset.set(event.asset, remaining.minus(size));
    }
    eventIds.add(event.eventId);
    sequences.add(event.sequence);
    referencedEvidence.add(event.priceEvidenceId);
  }
  if (remainingByAsset.size === 0) invalid('replay has no scheduled entries');
  if (referencedEvidence.size !== payload.priceEvidence.length) invalid('unreferenced price evidence is not permitted');

  const boundAssets = new Set<number>();
  const referencedRiskMarks = new Set<string>();
  for (const binding of payload.assetBindings) {
    if (boundAssets.has(binding.asset)) invalid(`duplicate asset binding ${binding.asset}`);
    if (!remainingByAsset.has(binding.asset)) invalid(`asset binding ${binding.asset} has no replay events`);
    if (coinByAsset.get(binding.asset) !== binding.coin) invalid(`asset binding ${binding.asset} coin mismatch`);
    const riskMark = riskMarkById.get(binding.riskMarkId);
    if (!riskMark) invalid(`asset binding ${binding.asset} references unknown risk mark`);
    if (referencedRiskMarks.has(binding.riskMarkId)) invalid(`risk mark ${binding.riskMarkId} is reused`);
    if (riskMark.asset !== binding.asset || riskMark.coin !== binding.coin) {
      invalid(`asset binding ${binding.asset} does not exactly match risk mark evidence`);
    }
    if (binding.marginMode === 'cross' && binding.isolatedTargetLeverage !== undefined) {
      invalid(`cross asset ${binding.asset} must not specify isolatedTargetLeverage`);
    }
    if (binding.marginMode === 'isolated' && binding.isolatedTargetLeverage !== '3') {
      invalid(`isolated asset ${binding.asset} must use programme target leverage 3`);
    }
    boundAssets.add(binding.asset);
    referencedRiskMarks.add(binding.riskMarkId);
  }
  if (boundAssets.size !== remainingByAsset.size) invalid('every replay asset requires exactly one asset binding');
  if (referencedRiskMarks.size !== payload.riskMarkEvidence.length) invalid('unreferenced risk mark evidence is not permitted');
  if (payload.batchId !== expectedBatchId(payload)) invalid('batchId mismatch');
  return payload;
}

interface PreparedReplay {
  result: HistoricalReplayResult;
  finalPositions: HistoricalReplayResult['positions'];
  marginPosture: HistoricalReplayResult['marginPosture'];
  metadataBindings: Array<{
    asset: number;
    coin: string;
    szDecimals: number;
    maxLeverage: string;
    onlyIsolated: boolean | null;
  }>;
}

export async function prepareHistoricalReplay(
  user: string,
  input: unknown,
  dependencies: Pick<HistoricalReplayDependencies, 'getAssetMetadata' | 'now' | 'takerFeeRate'> = defaultDependencies,
): Promise<PreparedReplay> {
  const payload = validateHistoricalReplayPayload(input, dependencies.takerFeeRate);
  const evidenceById = new Map(payload.priceEvidence.map((evidence) => [evidence.evidenceId, evidence]));

  const assets = [...new Set(payload.events.map((event) => event.asset))];
  const metadata = new Map<number, Awaited<ReturnType<typeof getAssetMetadata>>>();
  const metadataBindings: PreparedReplay['metadataBindings'] = [];
  for (const asset of assets) {
    const assetMetadata = await dependencies.getAssetMetadata(asset);
    if (!assetMetadata) invalid(`unknown asset ${asset}`);
    const maxLeverage = assetMetadata.maxLeverage;
    if (!Number.isSafeInteger(assetMetadata.szDecimals) || assetMetadata.szDecimals < 0
      || maxLeverage === undefined || !Number.isSafeInteger(maxLeverage) || maxLeverage < 1) {
      invalid(`asset ${asset} metadata leverage/size precision is invalid`);
    }
    const coin = payload.events.find((event) => event.asset === asset)?.coin;
    if (assetMetadata.coin !== coin) invalid(`asset ${asset} metadata coin mismatch`);
    const binding = payload.assetBindings.find((candidate) => candidate.asset === asset)!;
    if (binding.selectedLeverage !== new Decimal(maxLeverage).toString()) {
      invalid(`asset ${asset} selectedLeverage must exactly equal metadata maxLeverage`);
    }
    if (assetMetadata.onlyIsolated && binding.marginMode !== 'isolated') {
      invalid(`asset ${asset} is isolated-only`);
    }
    if (binding.marginMode === 'cross' && assetMetadata.onlyIsolated !== false) {
      invalid(`asset ${asset} metadata does not explicitly permit cross margin`);
    }
    if (binding.marginMode === 'isolated'
      && new Decimal(binding.isolatedTargetLeverage!).gt(maxLeverage)) {
      invalid(`asset ${asset} isolated target exceeds maxLeverage`);
    }
    metadata.set(asset, assetMetadata);
    metadataBindings.push({
      asset,
      coin: assetMetadata.coin,
      szDecimals: assetMetadata.szDecimals,
      maxLeverage: new Decimal(maxLeverage).toString(),
      onlyIsolated: assetMetadata.onlyIsolated ?? null,
    });
  }

  const replayedAt = dependencies.now();
  if (payload.source.generatedAt > replayedAt
    || payload.events.some((event) => event.effectiveAt > replayedAt)) {
    invalid('historical replay source/events must not be later than replay time');
  }
  for (const riskMark of payload.riskMarkEvidence) {
    if (riskMark.responseAt > replayedAt || replayedAt - riskMark.responseAt > 60_000) {
      invalid(`${riskMark.riskMarkId} is not contemporaneous with replay preflight`);
    }
  }
  const states = new Map<number, { coin: string; szi: DecimalValue; entryPx: DecimalValue }>();
  const events: HistoricalReplayStoredEvent[] = [];
  let balance = new Decimal(payload.modelInputs.startingBalance);

  for (const event of payload.events) {
    const evidence = evidenceById.get(event.priceEvidenceId)!;
    const decimalPlaces = new Decimal(evidence.sz).decimalPlaces();
    if (decimalPlaces > metadata.get(event.asset)!.szDecimals) {
      invalid(`asset ${event.asset} size exceeds configured szDecimals`);
    }
    const sideLevels = evidence.side === 'B' ? evidence.asks : evidence.bids;
    const { fillPx, source } = computeVwap(
      sideLevels?.map((level) => ({ ...level, n: 0 })),
      evidence.sz,
      evidence.side === 'B',
      evidence.aggressiveLimitPx,
      evidence.midPx,
    );
    const fill = new Decimal(fillPx);
    const size = new Decimal(evidence.sz);
    const prior = states.get(event.asset) ?? { coin: event.coin, szi: new Decimal(0), entryPx: new Decimal(0) };
    const startPosition = prior.szi;
    let endPosition: DecimalValue;
    let entryPx: DecimalValue;
    let closedPnl = new Decimal(0);

    if (event.phase === 'scheduled_entry') {
      endPosition = evidence.side === 'B' ? size : size.negated();
      entryPx = fill;
    } else {
      const isLong = prior.szi.gt(0);
      endPosition = isLong ? prior.szi.minus(size) : prior.szi.plus(size);
      closedPnl = isLong
        ? fill.minus(prior.entryPx).times(size)
        : prior.entryPx.minus(fill).times(size);
      entryPx = endPosition.isZero() ? new Decimal(0) : prior.entryPx;
    }

    const fee = size.times(fill).times(payload.modelInputs.feeRate);
    balance = balance.plus(closedPnl).minus(fee);
    states.set(event.asset, { coin: event.coin, szi: endPosition, entryPx });
    const recordedAt = dependencies.now();
    if (recordedAt < replayedAt || recordedAt < event.effectiveAt) {
      invalid('recordedAt must be actual server time at or after replay/effective time');
    }
    events.push({
      schema: HISTORICAL_REPLAY_EVENT_SCHEMA,
      kind: 'historical_replay_event',
      paper: true,
      synthetic: true,
      historicalReplay: true,
      historical_replay: true,
      batchId: payload.batchId,
      eventId: event.eventId,
      syntheticFillId: expectedSyntheticFillId(payload.batchId, event.eventId, event.sequence),
      evidenceId: evidence.evidenceId,
      sourceDigest: payload.sourceDigest,
      priceEvidenceDigest: payload.priceEvidenceDigest,
      modelInputDigest: payload.modelInputDigest,
      riskMarkEvidenceDigest: payload.riskMarkEvidenceDigest,
      phase: event.phase,
      sequence: event.sequence,
      asset: event.asset,
      coin: event.coin,
      effectiveAt: event.effectiveAt,
      recordedAt,
      replayedAt,
      side: evidence.side,
      sz: evidence.sz,
      px: fill.toString(),
      priceSource: source,
      aggressiveLimitPx: evidence.aggressiveLimitPx,
      startPosition: startPosition.toString(),
      endPosition: endPosition.toString(),
      entryPx: entryPx.toString(),
      closedPnl: closedPnl.toString(),
      fee: fee.toString(),
      feeRate: payload.modelInputs.feeRate,
      feeToken: payload.modelInputs.feeToken,
      crossed: true,
    });
  }

  const finalPositions = [...states.entries()]
    .filter(([, state]) => !state.szi.isZero())
    .sort(([left], [right]) => left - right)
    .map(([asset, state]) => ({
      asset,
      coin: state.coin,
      szi: state.szi.toString(),
      entryPx: state.entryPx.toString(),
    }));
  const riskMarkById = new Map(payload.riskMarkEvidence.map((evidence) => [evidence.riskMarkId, evidence]));
  const finalPositionByAsset = new Map(finalPositions.map((position) => [position.asset, position]));
  const marginPosture = payload.assetBindings
    .slice()
    .sort((left, right) => left.asset - right.asset)
    .map((binding) => {
      const riskMark = riskMarkById.get(binding.riskMarkId)!;
      const position = finalPositionByAsset.get(binding.asset);
      const finalSzi = new Decimal(position?.szi ?? '0');
      const finalEntryPx = new Decimal(position?.entryPx ?? '0');
      const positionNotional = finalSzi.abs().times(riskMark.markPx);
      const unrealizedPnl = finalSzi.isZero()
        ? new Decimal(0)
        : finalSzi.gt(0)
          ? new Decimal(riskMark.markPx).minus(finalEntryPx).times(finalSzi.abs())
          : finalEntryPx.minus(riskMark.markPx).times(finalSzi.abs());
      const isolatedMargin = binding.marginMode === 'isolated'
        ? positionNotional.div(binding.isolatedTargetLeverage!).toString()
        : undefined;
      const marginRequired = binding.marginMode === 'isolated'
        ? new Decimal(isolatedMargin!)
        : positionNotional.div(binding.selectedLeverage);
      return {
        asset: binding.asset,
        coin: binding.coin,
        marginMode: binding.marginMode,
        selectedLeverage: binding.selectedLeverage,
        ...(binding.isolatedTargetLeverage === undefined ? {} : {
          isolatedTargetLeverage: binding.isolatedTargetLeverage,
        }),
        ...(isolatedMargin === undefined ? {} : { isolatedMargin }),
        riskMarkId: binding.riskMarkId,
        riskMarkPx: riskMark.markPx,
        finalSzi: finalSzi.toString(),
        finalEntryPx: finalEntryPx.toString(),
        positionNotional: positionNotional.toString(),
        unrealizedPnl: unrealizedPnl.toString(),
        marginRequired: marginRequired.toString(),
      };
    });
  if (balance.isNegative()) invalid('historical replay final cash balance is negative');
  const totalUnrealizedPnl = marginPosture.reduce(
    (total, posture) => total.plus(posture.unrealizedPnl),
    new Decimal(0),
  );
  const accountValue = balance.plus(totalUnrealizedPnl);
  const totalMargin = marginPosture.reduce(
    (total, posture) => total.plus(posture.marginRequired),
    new Decimal(0),
  );
  if (!accountValue.gt(0)) invalid('historical replay replay-time account value is nonpositive');
  if (totalMargin.gt(accountValue)) invalid('historical replay margin exceeds replay-time account value');
  const riskSummary = {
    cashBalance: balance.toString(),
    unrealizedPnl: totalUnrealizedPnl.toString(),
    accountValue: accountValue.toString(),
    totalMargin: totalMargin.toString(),
    marginAvailable: accountValue.minus(totalMargin).toString(),
  };
  return {
    finalPositions,
    marginPosture,
    metadataBindings,
    result: {
      type: 'historicalReplay',
      status: 'imported',
      paper: true,
      synthetic: true,
      historicalReplay: true,
      historical_replay: true,
      user,
      batchId: payload.batchId,
      sourceDigest: payload.sourceDigest,
      priceEvidenceDigest: payload.priceEvidenceDigest,
      modelInputDigest: payload.modelInputDigest,
      riskMarkEvidenceDigest: payload.riskMarkEvidenceDigest,
      startingBalance: payload.modelInputs.startingBalance,
      finalBalance: balance.toString(),
      replayedAt,
      eventCount: events.length,
      eventIds: events.map((event) => event.eventId),
      replay: payload,
      positions: finalPositions,
      marginPosture,
      riskSummary,
      events,
    },
  };
}

function refuse(message: string): never {
  throw new HistoricalReplayError(message, 'conflict', 409);
}

async function validateStoredHistoricalReplay(
  raw: string,
  expectedUser: string,
  expectedBatchId: string,
  takerFeeRate: string,
): Promise<HistoricalReplayResult> {
  try {
    const decoded: unknown = JSON.parse(raw);
    const parsed = historicalReplayResultSchema.parse(decoded) as HistoricalReplayResult;
    if (parsed.user !== expectedUser || parsed.batchId !== expectedBatchId) {
      throw new Error('stored replay identity mismatch');
    }
    for (let index = 0; index < parsed.events.length; index += 1) {
      const event = parsed.events[index];
      if (event.recordedAt < parsed.replayedAt || event.recordedAt < event.effectiveAt
        || (index > 0 && event.recordedAt < parsed.events[index - 1].recordedAt)) {
        throw new Error('stored replay server timestamps are inconsistent');
      }
    }

    let nowCall = 0;
    const rebuilt = await prepareHistoricalReplay(expectedUser, parsed.replay, {
      takerFeeRate,
      now: () => {
        if (nowCall === 0) {
          nowCall += 1;
          return parsed.replayedAt;
        }
        const recordedAt = parsed.events[nowCall - 1]?.recordedAt;
        nowCall += 1;
        if (recordedAt === undefined) throw new Error('stored replay timestamp count mismatch');
        return recordedAt;
      },
      getAssetMetadata: async (asset) => {
        const binding = parsed.replay.assetBindings.find((candidate) => candidate.asset === asset);
        if (!binding) return null;
        const evidence = parsed.replay.priceEvidence.filter((candidate) => candidate.asset === asset);
        return {
          coin: binding.coin,
          szDecimals: Math.max(...evidence.map((candidate) => new Decimal(candidate.sz).decimalPlaces())),
          maxLeverage: Number(binding.selectedLeverage),
          onlyIsolated: binding.marginMode === 'cross' ? false : true,
        };
      },
    });
    if (canonicalJson(rebuilt.result) !== canonicalJson(parsed)) {
      throw new Error('stored replay derived state mismatch');
    }
    return parsed;
  } catch {
    refuse('stored historical replay record failed integrity validation');
  }
}

async function existingReplay(
  redisClient: ReplayRedis,
  user: string,
  takerFeeRate: string,
): Promise<HistoricalReplayResult | null> {
  const batchId = await redisClient.get(KEYS.HISTORICAL_REPLAY_INDEX(user));
  if (!batchId) return null;
  const stored = await redisClient.get(KEYS.HISTORICAL_REPLAY_BATCH(user, batchId));
  if (!stored) refuse('historical replay index exists without its immutable batch record');
  return validateStoredHistoricalReplay(stored, user, batchId, takerFeeRate);
}

async function assertRedisPreconditions(
  redisClient: ReplayRedis,
  user: string,
  startingBalance: string,
): Promise<void> {
  const account = await redisClient.hgetall(KEYS.USER_ACCOUNT(user));
  if (!account.userId || account.userId !== user) refuse('account identity does not exactly match replay user');
  if (account.balance !== startingBalance) refuse('account balance does not exactly match startingBalance');

  const [positionMembers, positionKeys, leverageKeys, orderCount, cloidCount, fillCount, fundingCount, replayKeys, active] = await Promise.all([
    redisClient.smembers(KEYS.USER_POSITIONS(user)),
    redisClient.keys(`${KEYS.USER_POS(user, 0).replace(/0$/, '')}*`),
    redisClient.keys(`${KEYS.USER_LEV(user, 0).replace(/0$/, '')}*`),
    redisClient.zcard(KEYS.USER_ORDERS(user)),
    redisClient.hlen(KEYS.USER_CLOIDS(user)),
    redisClient.llen(KEYS.USER_FILLS(user)),
    redisClient.llen(KEYS.USER_FUNDINGS(user)),
    redisClient.keys(`user:${user}:hpr:*`),
    redisClient.sismember(KEYS.USERS_ACTIVE, user),
  ]);
  if (positionMembers.length !== 0 || positionKeys.length !== 0) refuse('ordinary Redis position state is not empty');
  if (leverageKeys.length !== 0) refuse('ordinary Redis leverage state is not empty');
  if (orderCount !== 0) refuse('ordinary Redis user orders are not empty');
  if (cloidCount !== 0) refuse('ordinary Redis user cloids are not empty');
  if (fillCount !== 0) refuse('ordinary Redis user fills are not empty');
  if (fundingCount !== 0) refuse('ordinary Redis user fundings are not empty');
  if (replayKeys.length !== 0) refuse('a historical replay record already exists');
  if (active !== 0) refuse('ordinary Redis active-user state is not empty');

  const globalOrderIds = new Set([
    ...(await redisClient.smembers(KEYS.ORDERS_OPEN)),
    ...(await redisClient.smembers(KEYS.ORDERS_TRIGGERS)),
  ]);
  for (const orderId of globalOrderIds) {
    if (await redisClient.hget(KEYS.ORDER(Number(orderId)), 'userId') === user) {
      refuse('ordinary Redis global order state contains this user');
    }
  }
  for (const orderKey of await redisClient.keys('order:*')) {
    if (await redisClient.hget(orderKey, 'userId') === user) {
      refuse('ordinary Redis order hash state contains this user');
    }
  }
}

/*
 * This script is the replay commit boundary. It checks key types and every
 * mutable Redis first-import premise before the first write. Redis executes a
 * script without interleaving; AOF records the resulting write sequence as one
 * atomic script invocation. No command after the first write is allowed to be
 * input-dependent or capable of a type error.
 */
export const HISTORICAL_REPLAY_LUA = String.raw`
local transaction = cjson.decode(ARGV[1])
local function response(state, value) return cjson.encode({state=state, value=value}) end
local function key_type(key)
  local result = redis.call('TYPE', key)
  if type(result) == 'table' then return result['ok'] end
  return result
end
local function require_type(key, expected)
  local actual = key_type(key)
  if actual ~= 'none' and actual ~= expected then
    return false
  end
  return true
end

local existing = redis.call('GET', KEYS[1])
if existing then
  if existing ~= transaction.batchId then return response('refused', 'a different replay batch already exists') end
  local stored = redis.call('GET', KEYS[2])
  if not stored then return response('refused', 'replay index is missing its batch record') end
  return response('retry', stored)
end

if not require_type(KEYS[4], 'hash') or key_type(KEYS[4]) ~= 'hash' then return response('refused', 'account hash is missing or malformed') end
if redis.call('HGET', KEYS[4], 'userId') ~= transaction.user then return response('refused', 'account identity changed before commit') end
if redis.call('HGET', KEYS[4], 'balance') ~= transaction.startingBalance then return response('refused', 'account balance changed before commit') end
if not require_type(KEYS[5], 'set') or redis.call('SCARD', KEYS[5]) ~= 0 then return response('refused', 'ordinary positions changed before commit') end
if not require_type(KEYS[6], 'zset') or redis.call('ZCARD', KEYS[6]) ~= 0 then return response('refused', 'ordinary user orders changed before commit') end
if not require_type(KEYS[7], 'hash') or redis.call('HLEN', KEYS[7]) ~= 0 then return response('refused', 'ordinary cloids changed before commit') end
if not require_type(KEYS[8], 'list') or redis.call('LLEN', KEYS[8]) ~= 0 then return response('refused', 'ordinary fills changed before commit') end
if not require_type(KEYS[9], 'list') or redis.call('LLEN', KEYS[9]) ~= 0 then return response('refused', 'ordinary fundings changed before commit') end
if not require_type(KEYS[10], 'set') or not require_type(KEYS[11], 'set') or not require_type(KEYS[12], 'set') then return response('refused', 'global execution key type changed before commit') end
if redis.call('SISMEMBER', KEYS[12], transaction.user) ~= 0 then return response('refused', 'active-user state changed before commit') end

local mainMeta = nil
for _, expected in ipairs(transaction.metadataBindings) do
  local actual = nil
  if expected.asset >= 100000 then
    if key_type(KEYS[14]) ~= 'hash' then return response('refused', 'builder asset metadata changed before commit') end
    local raw = redis.call('HGET', KEYS[14], tostring(expected.asset))
    if not raw then return response('refused', 'builder asset metadata changed before commit') end
    actual = cjson.decode(raw)
  else
    if not mainMeta then
      if key_type(KEYS[13]) ~= 'string' then return response('refused', 'main asset metadata changed before commit') end
      local raw = redis.call('GET', KEYS[13])
      if not raw then return response('refused', 'main asset metadata changed before commit') end
      mainMeta = cjson.decode(raw)
    end
    actual = mainMeta.universe[expected.asset + 1]
    if not actual then return response('refused', 'main asset metadata changed before commit') end
  end
  if actual.name and not actual.coin then actual.coin = actual.name end
  if actual.coin ~= expected.coin
    or tonumber(actual.szDecimals) ~= expected.szDecimals
    or tostring(actual.maxLeverage) ~= expected.maxLeverage then
    return response('refused', 'asset metadata changed before commit')
  end
  if expected.onlyIsolated == cjson.null then
    if actual.onlyIsolated ~= nil and actual.onlyIsolated ~= cjson.null then return response('refused', 'asset margin metadata changed before commit') end
  elseif actual.onlyIsolated ~= expected.onlyIsolated then
    return response('refused', 'asset margin metadata changed before commit')
  end
end

local positionKeys = redis.call('KEYS', transaction.positionPattern)
if #positionKeys ~= 0 then return response('refused', 'ordinary position keys changed before commit') end
local replayKeys = redis.call('KEYS', transaction.replayPattern)
if #replayKeys ~= 0 then return response('refused', 'replay keys changed before commit') end
local leverageKeys = redis.call('KEYS', transaction.leveragePattern)
if #leverageKeys ~= 0 then return response('refused', 'ordinary leverage keys changed before commit') end
local globalOrderIds = redis.call('SMEMBERS', KEYS[10])
local triggerIds = redis.call('SMEMBERS', KEYS[11])
for _, oid in ipairs(triggerIds) do table.insert(globalOrderIds, oid) end
for _, oid in ipairs(globalOrderIds) do
  if redis.call('HGET', 'order:' .. oid, 'userId') == transaction.user then
    return response('refused', 'global order state changed before commit')
  end
end
local orderKeys = redis.call('KEYS', 'order:*')
for _, orderKey in ipairs(orderKeys) do
  if redis.call('HGET', orderKey, 'userId') == transaction.user then
    return response('refused', 'ordinary order hash state changed before commit')
  end
end
for index = 15, #KEYS do
  if key_type(KEYS[index]) ~= 'none' then return response('refused', 'replay target key already exists') end
end

-- All validation ends above. From here to return, commands have fixed types.
redis.call('HSET', KEYS[4], 'balance', transaction.finalBalance)
for _, position in ipairs(transaction.positions) do
  redis.call('HSET', position.key,
    'userId', transaction.user,
    'asset', tostring(position.asset),
    'coin', position.coin,
    'szi', position.szi,
    'entryPx', position.entryPx,
    'cumFunding', '0',
    'cumFundingSinceOpen', '0',
    'cumFundingSinceChange', '0')
  redis.call('SADD', KEYS[5], tostring(position.asset))
end
for _, posture in ipairs(transaction.marginPosture) do
  if posture.marginMode == 'isolated' then
    redis.call('HSET', posture.key,
      'leverage', posture.selectedLeverage,
      'isCross', 'false',
      'isolatedMargin', posture.isolatedMargin)
  else
    redis.call('HSET', posture.key,
      'leverage', posture.selectedLeverage,
      'isCross', 'true')
  end
end
if #transaction.positions > 0 then redis.call('SADD', KEYS[12], transaction.user)
else redis.call('SREM', KEYS[12], transaction.user) end
redis.call('SET', KEYS[1], transaction.batchId)
redis.call('SET', KEYS[2], transaction.resultJson)
for _, event in ipairs(transaction.events) do
  redis.call('SET', event.key, event.json)
  redis.call('RPUSH', KEYS[3], event.eventId)
end
return response('imported', transaction.resultJson)
`;

const replayLuaEnvelopeSchema = z.object({
  state: z.enum(['imported', 'retry', 'refused']),
  value: z.string(),
}).strict();

function parseReplayLuaEnvelope(raw: unknown): z.infer<typeof replayLuaEnvelopeSchema> {
  try {
    if (typeof raw !== 'string') throw new Error('non-string Lua response');
    return replayLuaEnvelopeSchema.parse(JSON.parse(raw));
  } catch {
    refuse('historical replay transaction returned an invalid envelope');
  }
}

export async function importHistoricalReplay(
  user: string,
  input: unknown,
  dependencies: HistoricalReplayDependencies = defaultDependencies,
): Promise<HistoricalReplayResult> {
  const normalizedUser = user.toLowerCase();
  const payload = validateHistoricalReplayPayload(input, dependencies.takerFeeRate);
  const existing = await existingReplay(dependencies.redis, normalizedUser, dependencies.takerFeeRate);
  if (existing) {
    if (existing.batchId !== payload.batchId) refuse('a different historical replay batch was already imported');
    return existing;
  }

  await assertRedisPreconditions(dependencies.redis, normalizedUser, payload.modelInputs.startingBalance);
  const pgPresence = await dependencies.getUserExecutionPresencePg(normalizedUser);
  if (pgPresence.orders || pgPresence.fills) refuse('ordinary Postgres order/fill state is not empty');
  const prepared = await prepareHistoricalReplay(normalizedUser, payload, dependencies);
  const resultJson = canonicalJson(prepared.result);
  const eventPairs = prepared.result.events.map((event) => ({
    eventId: event.eventId,
    key: KEYS.HISTORICAL_REPLAY_EVENT(normalizedUser, event.eventId),
    json: canonicalJson(event),
  }));
  const positionPairs = prepared.finalPositions.map((position) => ({
    ...position,
    key: KEYS.USER_POS(normalizedUser, position.asset),
  }));
  const marginPairs = prepared.marginPosture.map((posture) => ({
    ...posture,
    key: KEYS.USER_LEV(normalizedUser, posture.asset),
  }));
  const transaction = canonicalJson({
    user: normalizedUser,
    batchId: payload.batchId,
    startingBalance: payload.modelInputs.startingBalance,
    finalBalance: prepared.result.finalBalance,
    resultJson,
    positions: positionPairs,
    marginPosture: marginPairs,
    metadataBindings: prepared.metadataBindings,
    events: eventPairs,
    positionPattern: `${KEYS.USER_POS(normalizedUser, 0).replace(/0$/, '')}*`,
    leveragePattern: `${KEYS.USER_LEV(normalizedUser, 0).replace(/0$/, '')}*`,
    replayPattern: `user:${normalizedUser}:hpr:*`,
  });
  const keys = [
    KEYS.HISTORICAL_REPLAY_INDEX(normalizedUser),
    KEYS.HISTORICAL_REPLAY_BATCH(normalizedUser, payload.batchId),
    KEYS.HISTORICAL_REPLAY_EVENTS(normalizedUser, payload.batchId),
    KEYS.USER_ACCOUNT(normalizedUser),
    KEYS.USER_POSITIONS(normalizedUser),
    KEYS.USER_ORDERS(normalizedUser),
    KEYS.USER_CLOIDS(normalizedUser),
    KEYS.USER_FILLS(normalizedUser),
    KEYS.USER_FUNDINGS(normalizedUser),
    KEYS.ORDERS_OPEN,
    KEYS.ORDERS_TRIGGERS,
    KEYS.USERS_ACTIVE,
    KEYS.MARKET_META,
    KEYS.MARKET_ASSET_MAP,
    ...positionPairs.map((position) => position.key),
    ...marginPairs.map((posture) => posture.key),
    ...eventPairs.map((event) => event.key),
  ];
  const raw = await dependencies.redis.eval(HISTORICAL_REPLAY_LUA, keys.length, ...keys, transaction);
  const outcome = parseReplayLuaEnvelope(raw);
  if (outcome.state === 'refused') refuse(outcome.value);
  return validateStoredHistoricalReplay(
    outcome.value,
    normalizedUser,
    payload.batchId,
    dependencies.takerFeeRate,
  );
}

export async function getHistoricalReplay(
  user: string,
  requestedBatchId: string,
  dependencies: Pick<HistoricalReplayDependencies, 'redis' | 'takerFeeRate'> = defaultDependencies,
): Promise<HistoricalReplayResult> {
  const normalizedUser = user.toLowerCase();
  const result = await existingReplay(dependencies.redis, normalizedUser, dependencies.takerFeeRate);
  if (!result || result.batchId !== requestedBatchId) {
    throw new HistoricalReplayError('historical replay not found', 'not_found', 404);
  }
  return result;
}
