import { createHash } from 'node:crypto';
import DecimalModule from 'decimal.js';
import { z } from 'zod';
import { config } from '../config.js';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { getClearinghouseState, getOpenOrders } from './position.js';
import { getHistoricalReplay } from './historical-replay.js';
import {
  cashLedgerEvidenceReceiptSchema,
  cashLedgerEvidenceRequestSchema,
  canonicalJson,
  decodeCanonicalJson,
  type CashLedgerEvidenceRequest,
  type CashLedgerEvidenceReceipt,
  type CashLedgerEvidenceError as WireError,
  type CashLedgerFundingCorrection,
  type CashLedgerFundingEvent,
  domainDigest,
  walletFingerprint,
  CASH_LEDGER_EVIDENCE_V2_SCHEMA,
  CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
  cashLedgerEvidenceV2RequestSchema,
  cashLedgerEvidenceV2ReceiptSchema,
  cashLedgerEvidenceV2ReplayResultSchema,
  cashLedgerEvidenceV2FillSchema,
  cashLedgerEvidenceV2PositionSchema,
  cashLedgerEvidenceV2OrderSchema,
  cashLedgerEvidenceV2FundingEventSchema,
  cashLedgerEvidenceV2FundingCorrectionSchema,
  cashLedgerEvidenceV2SourceInventorySchema,
  encodeCashLedgerEvidenceV2Receipt,
  cashLedgerEvidenceV2SourceDigest,
  cashLedgerEvidenceV2SourceManifestDigest,
  cashLedgerEvidenceV2InventoryDigest,
  cashLedgerEvidenceV2StableStateDigest,
  cashLedgerEvidenceV2ReceiptDigest,
  cashLedgerEvidenceV2EventMemberDigest,
  cashLedgerEvidenceV2CorrectionMemberDigest,
  cashLedgerEvidenceV2ReceiptManifestDigest,
  type CashLedgerEvidenceV2Request,
  type CashLedgerEvidenceV2Receipt,
  type CashLedgerEvidenceV2ProviderIdentity,
  type CashLedgerEvidenceV2FundingEvent,
  type CashLedgerEvidenceV2FundingCorrection,
  type CashLedgerEvidenceV2Order,
  type CashLedgerEvidenceV2Position,
  type CashLedgerEvidenceV2Account,
  type CashLedgerEvidenceV2Error as CashLedgerEvidenceV2WireError,
} from '../types/cash-ledger-evidence.js';
import { historicalReplayResultSchema } from '../types/historical-replay.js';
import { pnlFundingCorrectionId, pnlFundingEventId } from '../worker/funding-worker.js';
import { pnlFundingCorrectionSchema, pnlFundingEventSchema, type PnlFundingEvent } from '../types/pnl.js';

const Decimal = DecimalModule.default ?? DecimalModule;
type DecimalValue = InstanceType<typeof Decimal>;

export type CashLedgerEvidenceErrorCode = WireError['error_code'];
export type CashLedgerEvidenceV2ErrorCode = CashLedgerEvidenceV2WireError['error_code'];

export class CashLedgerEvidenceError extends Error {
  constructor(
    message: string,
    readonly code: CashLedgerEvidenceErrorCode = 'internal',
    readonly status: 400 | 403 | 409 | 500 = 500,
  ) {
    super(message);
    this.name = 'CashLedgerEvidenceError';
  }
}

export interface CashLedgerEvidenceProviderIdentity {
  source_revision: string;
  image_digest: string;
  compose_config_digest: string;
  api_schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_V1';
  funding_interval_ms: number;
  correction_finality_ms: number;
  max_evidence_rows: number;
}

export interface CashLedgerEvidenceRedis {
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  llen(key: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zcard(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
}

export interface CashLedgerEvidenceDependencies {
  redis?: CashLedgerEvidenceRedis;
  historicalReplay?: (user: string, batchId: string) => Promise<unknown>;
  clearinghouseState?: (user: string) => Promise<unknown>;
  openOrders?: (user: string) => Promise<unknown[]>;
  now?: () => number;
  providerIdentity?: CashLedgerEvidenceProviderIdentity;
}

export interface CashLedgerEvidenceV2Dependencies {
  redis?: CashLedgerEvidenceRedis;
  historicalReplay?: (user: string, batchId: string) => Promise<unknown>;
  clearinghouseState?: (user: string) => Promise<unknown>;
  openOrders?: (user: string) => Promise<unknown[]>;
  now?: () => number;
  providerIdentity?: CashLedgerEvidenceV2ProviderIdentity;
  maxBytes?: number;
}

const defaultProviderIdentity = (): CashLedgerEvidenceProviderIdentity => ({
  source_revision: config.HYPAPER_SOURCE_REVISION ?? '',
  image_digest: config.HYPAPER_IMAGE_DIGEST ?? '',
  compose_config_digest: config.HYPAPER_COMPOSE_CONFIG_DIGEST ?? '',
  api_schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_V1',
  funding_interval_ms: config.FUNDING_INTERVAL_MS,
  correction_finality_ms: config.CASH_LEDGER_EVIDENCE_CORRECTION_FINALITY_MS ?? 0,
  max_evidence_rows: config.CASH_LEDGER_EVIDENCE_MAX_ROWS ?? 0,
});

const decimalPattern = /^(?:0|-?(?:[1-9][0-9]*(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9]))$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

const stateSchema = z.object({
  assetPositions: z.array(z.object({
    type: z.literal('oneWay'),
    position: z.object({ coin: z.string().min(1), szi: z.string(), entryPx: z.string(), unrealizedPnl: z.string() }).passthrough(),
  }).strict()),
  crossMarginSummary: z.object({ accountValue: z.string() }).passthrough(),
  marginSummary: z.object({ accountValue: z.string() }).passthrough(),
  time: z.number().int().nonnegative().safe(),
}).passthrough();

const fillSchema = z.object({
  coin: z.string().min(1), px: z.string(), sz: z.string(), side: z.enum(['B', 'A']), closedPnl: z.string(), fee: z.string(),
  time: z.number().int().nonnegative().safe(), startPosition: z.string(), dir: z.string().min(1), hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  oid: z.number().int().nonnegative().safe(), crossed: z.boolean(), tid: z.number().int().nonnegative().safe(), cloid: z.string().optional(), feeToken: z.literal('USDC'),
}).strict();

type ReadSnapshot = {
  account: Record<string, string>; state: unknown; openOrders: unknown[]; replayId: string | null; replayRaw: string | null; replay: unknown | null;
  fills: string[]; fundingIds: string[]; correctionIds: string[]; fundingKeys: string[]; correctionKeys: string[];
  fundingRaws: Array<string | null>; correctionRaws: Array<string | null>;
};

function refuse(message: string, code: CashLedgerEvidenceErrorCode, status: 400 | 403 | 409 | 500 = 409): never {
  throw new CashLedgerEvidenceError(message, code, status);
}

function decimal(value: string, label: string): DecimalValue {
  if (!decimalPattern.test(value)) refuse(`${label} is not canonical`, 'arithmetic');
  const result = new Decimal(value);
  if (!result.isFinite()) refuse(`${label} is not finite`, 'arithmetic');
  return result;
}

function decimalText(value: DecimalValue): string {
  const fixed = value.toFixed();
  if (fixed === '0' || /^-0(?:\.0*)?$/.test(fixed)) return '0';
  const negative = fixed.startsWith('-');
  const body = (negative ? fixed.slice(1) : fixed).replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, '');
  return `${negative ? '-' : ''}${body}`;
}

const hashRaw = (raw: string): string => createHash('sha256').update(raw, 'utf8').digest('hex');

function parseJson(raw: string, label: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { refuse(`${label} is malformed`, 'missing_source'); }
}

function ensureProviderIdentity(identity: CashLedgerEvidenceProviderIdentity): void {
  if (!/^[0-9a-f]{40}$/.test(identity.source_revision) || !/^sha256:[0-9a-f]{64}$/.test(identity.image_digest)
    || !sha256Pattern.test(identity.compose_config_digest) || identity.api_schema_version !== 'HYPAPER_CASH_LEDGER_EVIDENCE_V1'
    || !Number.isSafeInteger(identity.funding_interval_ms) || identity.funding_interval_ms <= 0
    || !Number.isSafeInteger(identity.correction_finality_ms) || identity.correction_finality_ms <= 0
    || !Number.isSafeInteger(identity.max_evidence_rows) || identity.max_evidence_rows <= 0) refuse('provider identity is malformed', 'identity');
}

function validateRequest(value: unknown, identity: CashLedgerEvidenceProviderIdentity): CashLedgerEvidenceRequest {
  const parsed = cashLedgerEvidenceRequestSchema.safeParse(value);
  if (!parsed.success) refuse('invalid evidence request', 'invalid_request', 400);
  ensureProviderIdentity(identity);
  if (parsed.data.coverageEndMs < parsed.data.coverageStartMs || parsed.data.coverageStartMs % identity.funding_interval_ms !== 0 || parsed.data.coverageEndMs % identity.funding_interval_ms !== 0) refuse('coverage is not aligned or reversed', 'invalid_request', 400);
  return parsed.data;
}

function outputSource(source: PnlFundingEvent['source']): CashLedgerFundingEvent['source'] {
  if (source.kind === 'live_market_context') return { kind: source.kind };
  if (source.kind === 'live_boundary_snapshot') return {
    kind: source.kind,
    funding_history_time_ms: source.fundingHistoryTime,
    context_observed_at_ms: source.contextObservedAt,
  };
  return {
    kind: source.kind,
    oracle_source_sha256: source.oracleSourceSha256,
    funding_source_sha256: source.fundingSourceSha256,
  };
}

function eventMember(event: Omit<CashLedgerFundingEvent, 'member_sha256'>): string { return domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_EVENT_MEMBER_V1', event); }
function correctionMember(correction: Omit<CashLedgerFundingCorrection, 'member_sha256'>): string { return domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_CORRECTION_MEMBER_V1', correction); }
export const cashLedgerEvidenceEventMemberDigest = eventMember;
export const cashLedgerEvidenceCorrectionMemberDigest = correctionMember;
export const cashLedgerEvidenceManifestDigest = (manifest: { count: number; member_sha256s: readonly string[] }): string => domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_MANIFEST_V1', manifest);
export { walletFingerprint };

async function capture(user: string, d: Required<CashLedgerEvidenceDependencies>): Promise<ReadSnapshot> {
  const [account, state, openOrders, replayId, fills, fundingIds, correctionIds, fundingKeys, correctionKeys] = await Promise.all([
    d.redis.hgetall(KEYS.USER_ACCOUNT(user)), d.clearinghouseState(user), d.openOrders(user), d.redis.get(KEYS.HISTORICAL_REPLAY_INDEX(user)),
    d.redis.lrange(KEYS.USER_FILLS(user), 0, -1), d.redis.lrange(KEYS.PNL_FUNDING_EVENTS(user), 0, -1), d.redis.lrange(KEYS.PNL_FUNDING_CORRECTIONS(user), 0, -1),
    d.redis.keys(KEYS.PNL_FUNDING_EVENT(user, '*')), d.redis.keys(KEYS.PNL_FUNDING_CORRECTION(user, '*')),
  ]);
  let replayRaw: string | null = null; let replay: unknown | null = null;
  if (replayId !== null) {
    if (!/^hprb[0-9a-f]{64}$/.test(replayId)) refuse('replay identity is malformed', 'identity');
    [replayRaw, replay] = await Promise.all([d.redis.get(KEYS.HISTORICAL_REPLAY_BATCH(user, replayId)), d.historicalReplay(user, replayId)]);
  }
  const [fundingRaws, correctionRaws] = await Promise.all([
    Promise.all(fundingIds.map((id) => d.redis.get(KEYS.PNL_FUNDING_EVENT(user, id)))),
    Promise.all(correctionIds.map((id) => d.redis.get(KEYS.PNL_FUNDING_CORRECTION(user, id)))),
  ]);
  return { account, state, openOrders, replayId, replayRaw, replay, fills, fundingIds, correctionIds, fundingKeys: [...fundingKeys].sort(), correctionKeys: [...correctionKeys].sort(), fundingRaws, correctionRaws };
}

function stableSnapshot(snapshot: ReadSnapshot): string {
  const stableState = snapshot.state !== null && typeof snapshot.state === 'object' && !Array.isArray(snapshot.state)
    ? Object.fromEntries(Object.entries(snapshot.state as Record<string, unknown>).filter(([key]) => key !== 'time'))
    : snapshot.state;
  const safe = JSON.parse(JSON.stringify({ ...snapshot, state: stableState }, (_key, child: unknown) => child === undefined ? null : child)) as unknown;
  return canonicalJson(safe);
}

function checkKeyInventory(ids: readonly string[], keys: readonly string[], expected: (id: string) => string, label: string): void {
  const actual = [...keys].sort(); const wanted = ids.map(expected).sort();
  if (new Set(keys).size !== keys.length || actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) refuse(`${label} index and key inventory disagree`, 'identity');
}

function validateAccount(account: Record<string, string>, user: string): DecimalValue {
  if (account.userId !== user || !account.balance) refuse('account identity is missing or different', 'identity');
  return decimal(account.balance, 'account balance');
}

function validateState(raw: unknown, requested: ReadonlySet<string>, account: DecimalValue): { state: z.infer<typeof stateSchema>; unrealized: string } {
  const parsed = stateSchema.safeParse(raw); if (!parsed.success) refuse('clearinghouse state is malformed', 'missing_source');
  const state = parsed.data; const cross = decimal(state.crossMarginSummary.accountValue, 'cross account value'); const total = decimal(state.marginSummary.accountValue, 'total account value');
  if (!cross.eq(total)) refuse('clearinghouse account values disagree', 'arithmetic');
  for (const wrapper of state.assetPositions) {
    const p = wrapper.position; if (!requested.has(p.coin) || !decimal(p.szi, 'position size').isZero()) refuse('current position is non-flat or unknown', 'flatness');
    decimal(p.entryPx, 'position entry price'); decimal(p.unrealizedPnl, 'position unrealized PnL');
  }
  return { state, unrealized: decimalText(cross.minus(account)) };
}

function validateOrders(raw: unknown[], requested: ReadonlySet<string>): void {
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || typeof (item as { coin?: unknown }).coin !== 'string' || !requested.has((item as { coin: string }).coin)) refuse('open-order inventory has unknown or malformed coin', 'flatness');
  }
  if (raw.length !== 0) refuse('relevant open orders remain', 'flatness');
}

function parseFills(raw: readonly string[], requested: ReadonlySet<string>): { realized: string; fees: string } {
  const tids = new Set<number>(); const hashes = new Set<string>(); let realized = new Decimal(0); let fees = new Decimal(0);
  for (const [index, source] of raw.entries()) {
    const parsed = fillSchema.safeParse(parseJson(source, `ordinary fill ${index}`));
    if (!parsed.success || !requested.has(parsed.data.coin) || tids.has(parsed.data.tid) || hashes.has(parsed.data.hash) || parsed.data.hash !== `0x${parsed.data.tid.toString(16).padStart(64, '0')}`) refuse('ordinary fill inventory is malformed or ambiguous', 'identity');
    decimal(parsed.data.px, 'ordinary fill price'); decimal(parsed.data.sz, 'ordinary fill size');
    const fee = decimal(parsed.data.fee, 'ordinary fee');
    if (fee.isNegative()) refuse('ordinary fee is negative', 'arithmetic');
    realized = realized.plus(decimal(parsed.data.closedPnl, 'ordinary realized PnL')); fees = fees.plus(fee);
    tids.add(parsed.data.tid); hashes.add(parsed.data.hash);
  }
  return { realized: decimalText(realized), fees: decimalText(fees) };
}

async function loadRecords(snapshot: ReadSnapshot, request: CashLedgerEvidenceRequest, interval: number): Promise<{ events: CashLedgerFundingEvent[]; eventRaws: string[]; corrections: CashLedgerFundingCorrection[]; correctionRaws: string[] }> {
  const user = request.user.toLowerCase(); checkKeyInventory(snapshot.fundingIds, snapshot.fundingKeys, (id) => KEYS.PNL_FUNDING_EVENT(user, id), 'funding event'); checkKeyInventory(snapshot.correctionIds, snapshot.correctionKeys, (id) => KEYS.PNL_FUNDING_CORRECTION(user, id), 'funding correction');
  const events: CashLedgerFundingEvent[] = []; const eventRaws: string[] = []; const originalById = new Map<string, { value: ReturnType<typeof pnlFundingEventSchema.parse>; raw: string }>(); let priorApplied = -1;
  for (const [ordinal, id] of snapshot.fundingIds.entries()) {
    const raw = snapshot.fundingRaws[ordinal]; if (raw === null || raw === undefined) refuse('funding event source is missing', 'missing_source');
    const parsed = pnlFundingEventSchema.safeParse(parseJson(raw, `funding event ${ordinal}`));
    if (!parsed.success || parsed.data.eventId !== id || parsed.data.eventId !== pnlFundingEventId(user, parsed.data.asset, parsed.data.fundingTime) || !request.coins.includes(parsed.data.coin) || parsed.data.fundingTime < request.coverageStartMs || parsed.data.fundingTime > request.coverageEndMs || parsed.data.fundingTime % interval !== 0 || parsed.data.appliedAt < parsed.data.fundingTime || parsed.data.appliedAt < priorApplied) refuse('funding event identity or chronology is invalid', 'identity');
    const charge = decimal(parsed.data.fundingCharge, 'funding charge'); if (!charge.eq(decimal(parsed.data.szi, 'funding size').times(decimal(parsed.data.oraclePx, 'oracle price')).times(decimal(parsed.data.fundingRate, 'funding rate'))) || !decimal(parsed.data.accountBalanceBefore, 'event balance before').minus(charge).eq(decimal(parsed.data.accountBalanceAfter, 'event balance after'))) refuse('funding event arithmetic is invalid', 'arithmetic');
    for (const [before, after] of [[parsed.data.cumFundingBefore, parsed.data.cumFundingAfter], [parsed.data.cumFundingSinceOpenBefore, parsed.data.cumFundingSinceOpenAfter], [parsed.data.cumFundingSinceChangeBefore, parsed.data.cumFundingSinceChangeAfter]] as const) if (!decimal(after, 'event cumulative after').eq(decimal(before, 'event cumulative before').plus(charge))) refuse('funding cumulative transition is invalid', 'arithmetic');
    const base = { ordinal, schema: parsed.data.schema, event_id: parsed.data.eventId, asset: parsed.data.asset, coin: parsed.data.coin, funding_time_ms: parsed.data.fundingTime, applied_at_ms: parsed.data.appliedAt, szi: parsed.data.szi, oracle_px: parsed.data.oraclePx, funding_rate: parsed.data.fundingRate, funding_charge: parsed.data.fundingCharge, source: outputSource(parsed.data.source), account_balance_before: parsed.data.accountBalanceBefore, account_balance_after: parsed.data.accountBalanceAfter, cum_funding_before: parsed.data.cumFundingBefore, cum_funding_after: parsed.data.cumFundingAfter, cum_funding_since_open_before: parsed.data.cumFundingSinceOpenBefore, cum_funding_since_open_after: parsed.data.cumFundingSinceOpenAfter, cum_funding_since_change_before: parsed.data.cumFundingSinceChangeBefore, cum_funding_since_change_after: parsed.data.cumFundingSinceChangeAfter, source_record_sha256: hashRaw(raw) } satisfies Omit<CashLedgerFundingEvent, 'member_sha256'>;
    events.push({ ...base, member_sha256: eventMember(base) }); eventRaws.push(raw); originalById.set(id, { value: parsed.data, raw }); priorApplied = parsed.data.appliedAt;
  }
  if (events.length === 0) refuse('funding coverage is empty', 'provisional_incomplete');
  const corrections: CashLedgerFundingCorrection[] = []; const correctionRaws: string[] = []; const usedOriginals = new Set<string>(); let priorCorrection = -1;
  for (const [ordinal, id] of snapshot.correctionIds.entries()) {
    const raw = snapshot.correctionRaws[ordinal]; if (raw === null || raw === undefined) refuse('funding correction source is missing', 'missing_source');
    const parsed = pnlFundingCorrectionSchema.safeParse(parseJson(raw, `funding correction ${ordinal}`)); const original = parsed.success ? originalById.get(parsed.data.originalEventId) : undefined;
    if (!parsed.success || parsed.data.correctionId !== id || !original || usedOriginals.has(parsed.data.originalEventId) || parsed.data.correctionId !== pnlFundingCorrectionId(user, parsed.data.asset, parsed.data.fundingTime, parsed.data.originalEventId) || parsed.data.asset !== original.value.asset || parsed.data.coin !== original.value.coin || parsed.data.fundingTime !== original.value.fundingTime || parsed.data.szi !== original.value.szi || parsed.data.originalFundingCharge !== original.value.fundingCharge || parsed.data.source.originalEventSha256 !== hashRaw(original.raw) || parsed.data.appliedAt < parsed.data.fundingTime || parsed.data.appliedAt < priorCorrection) refuse('funding correction identity is invalid', 'identity');
    const corrected = decimal(parsed.data.correctedFundingCharge, 'corrected funding charge'); const originalCharge = decimal(parsed.data.originalFundingCharge, 'original funding charge'); const delta = decimal(parsed.data.fundingChargeDelta, 'funding charge delta');
    if (delta.isZero() || !corrected.eq(decimal(parsed.data.szi, 'correction size').times(decimal(parsed.data.correctedOraclePx, 'corrected oracle price')).times(decimal(parsed.data.correctedFundingRate, 'corrected funding rate'))) || !delta.eq(corrected.minus(originalCharge)) || !decimal(parsed.data.accountBalanceBefore, 'correction balance before').minus(delta).eq(decimal(parsed.data.accountBalanceAfter, 'correction balance after'))) refuse('funding correction arithmetic is invalid', 'arithmetic');
    for (const [before, after] of [[parsed.data.cumFundingBefore, parsed.data.cumFundingAfter], [parsed.data.cumFundingSinceOpenBefore, parsed.data.cumFundingSinceOpenAfter], [parsed.data.cumFundingSinceChangeBefore, parsed.data.cumFundingSinceChangeAfter]] as const) if (!decimal(after, 'correction cumulative after').eq(decimal(before, 'correction cumulative before').plus(delta))) refuse('correction cumulative transition is invalid', 'arithmetic');
    const base = { ordinal, schema: parsed.data.schema, correction_id: parsed.data.correctionId, original_event_id: parsed.data.originalEventId, asset: parsed.data.asset, coin: parsed.data.coin, funding_time_ms: parsed.data.fundingTime, applied_at_ms: parsed.data.appliedAt, szi: parsed.data.szi, original_funding_charge: parsed.data.originalFundingCharge, corrected_oracle_px: parsed.data.correctedOraclePx, corrected_funding_rate: parsed.data.correctedFundingRate, corrected_funding_charge: parsed.data.correctedFundingCharge, funding_charge_delta: parsed.data.fundingChargeDelta, source: { kind: 'verified_correction' as const, original_event_sha256: parsed.data.source.originalEventSha256, oracle_source_sha256: parsed.data.source.oracleSourceSha256, funding_source_sha256: parsed.data.source.fundingSourceSha256 }, account_balance_before: parsed.data.accountBalanceBefore, account_balance_after: parsed.data.accountBalanceAfter, cum_funding_before: parsed.data.cumFundingBefore, cum_funding_after: parsed.data.cumFundingAfter, cum_funding_since_open_before: parsed.data.cumFundingSinceOpenBefore, cum_funding_since_open_after: parsed.data.cumFundingSinceOpenAfter, cum_funding_since_change_before: parsed.data.cumFundingSinceChangeBefore, cum_funding_since_change_after: parsed.data.cumFundingSinceChangeAfter, source_record_sha256: hashRaw(raw) } satisfies Omit<CashLedgerFundingCorrection, 'member_sha256'>;
    corrections.push({ ...base, member_sha256: correctionMember(base) }); correctionRaws.push(raw); usedOriginals.add(parsed.data.originalEventId); priorCorrection = parsed.data.appliedAt;
  }
  return { events, eventRaws, corrections, correctionRaws };
}

function verifyCoverage(events: CashLedgerFundingEvent[], correctionCount: number, request: CashLedgerEvidenceRequest, identity: CashLedgerEvidenceProviderIdentity): void {
  const boundaries = Math.floor((request.coverageEndMs - request.coverageStartMs) / identity.funding_interval_ms) + 1;
  if (events.length + correctionCount > identity.max_evidence_rows || boundaries * request.coins.length > identity.max_evidence_rows) refuse('evidence exceeds configured row cap', 'row_cap');
  const inventory = new Set(events.map((event) => `${event.coin}\0${event.funding_time_ms}`));
  if (inventory.size !== events.length || events.length !== boundaries * request.coins.length) refuse('funding coverage contains duplicate or extra rows', 'provisional_incomplete');
  for (let time = request.coverageStartMs; time <= request.coverageEndMs; time += identity.funding_interval_ms) for (const coin of request.coins) if (!inventory.has(`${coin}\0${time}`)) refuse('funding coverage is incomplete', 'provisional_incomplete');
}

function replayValues(snapshot: ReadSnapshot, request: CashLedgerEvidenceRequest): { starting: string; final: string; realized: string; fees: string; digest: string } {
  if (!snapshot.replayId || !snapshot.replayRaw || snapshot.replay === null) refuse('immutable replay evidence is missing', 'missing_source');
  const parsed = historicalReplayResultSchema.safeParse(snapshot.replay); if (!parsed.success || parsed.data.user !== request.user.toLowerCase() || parsed.data.batchId !== snapshot.replayId) refuse('immutable replay identity is invalid', 'identity');
  let realized = new Decimal(0); let fees = new Decimal(0); for (const event of parsed.data.events) { if (!request.coins.includes(event.coin)) refuse('replay contains an out-of-scope coin', 'identity'); realized = realized.plus(decimal(event.closedPnl, 'replay realized PnL')); fees = fees.plus(decimal(event.fee, 'replay fee')); }
  const starting = decimal(parsed.data.startingBalance, 'replay starting balance'); const final = decimal(parsed.data.finalBalance, 'replay final balance'); if (!final.eq(starting.plus(realized).minus(fees))) refuse('replay balance does not reconcile', 'arithmetic');
  return { starting: decimalText(starting), final: decimalText(final), realized: decimalText(realized), fees: decimalText(fees), digest: hashRaw(snapshot.replayRaw) };
}

export function cashLedgerEvidenceDefaultIdentity(): CashLedgerEvidenceProviderIdentity { return defaultProviderIdentity(); }

export async function getCashLedgerEvidence(value: unknown, overrides: CashLedgerEvidenceDependencies = {}): Promise<CashLedgerEvidenceReceipt> {
  const d: Required<CashLedgerEvidenceDependencies> = { redis: overrides.redis ?? (redis as unknown as CashLedgerEvidenceRedis), historicalReplay: overrides.historicalReplay ?? getHistoricalReplay, clearinghouseState: overrides.clearinghouseState ?? getClearinghouseState, openOrders: overrides.openOrders ?? getOpenOrders, now: overrides.now ?? Date.now, providerIdentity: overrides.providerIdentity ?? defaultProviderIdentity() };
  const request = validateRequest(value, d.providerIdentity); const user = request.user.toLowerCase(); const first = await capture(user, d); const account = validateAccount(first.account, user); const requested = new Set(request.coins);
  const state = validateState(first.state, requested, account); validateOrders(first.openOrders, requested); const fills = parseFills(first.fills, requested); const replay = replayValues(first, request); const records = await loadRecords(first, request, d.providerIdentity.funding_interval_ms); verifyCoverage(records.events, records.corrections.length, request, d.providerIdentity);
  let effective = new Decimal(0); for (const event of records.events) effective = effective.plus(decimal(event.funding_charge, 'funding charge')); for (const correction of records.corrections) effective = effective.plus(decimal(correction.funding_charge_delta, 'funding correction delta'));
  const unrelatedCashMovement = new Decimal(0);
  const expected = decimal(replay.starting, 'starting balance').plus(decimal(replay.realized, 'replay realized PnL')).minus(decimal(replay.fees, 'replay fees')).plus(decimal(fills.realized, 'ordinary realized PnL')).minus(decimal(fills.fees, 'ordinary fees')).minus(effective).plus(unrelatedCashMovement); const residual = account.minus(expected); if (!residual.isZero()) refuse('settled-USDC residual is nonzero', 'arithmetic'); if (state.unrealized !== '0') refuse('current unrealized PnL is nonzero', 'flatness');
  const second = await capture(user, d); if (stableSnapshot(first) !== stableSnapshot(second)) refuse('mutable evidence changed during derivation', 'stable_read');
  const observed = d.now(); if (!Number.isSafeInteger(observed) || observed < d.providerIdentity.correction_finality_ms) refuse('finality watermark underflows', 'provisional_incomplete'); const watermark = observed - d.providerIdentity.correction_finality_ms; const latest = Math.floor(Math.min(request.coverageEndMs, watermark) / d.providerIdentity.funding_interval_ms) * d.providerIdentity.funding_interval_ms; if (request.coverageEndMs > watermark || latest < request.coverageEndMs) refuse('evidence is provisional or incomplete', 'provisional_incomplete');
  const stateDigest = domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_CLEARINGHOUSE_STATE_V1', first.state); const ordersDigest = domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_OPEN_ORDER_INVENTORY_V1', first.openOrders); const evidenceDigest = domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_SETTLED_USDC_V1', { replay_record_sha256: replay.digest, ordinary_fill_record_sha256s: first.fills.map(hashRaw), funding_event_record_sha256s: records.eventRaws.map(hashRaw), funding_correction_record_sha256s: records.correctionRaws.map(hashRaw), account_record_sha256: hashRaw(canonicalJson(first.account)), clearinghouse_state_sha256: stateDigest, open_order_inventory_sha256: ordersDigest });
  const eventManifest = { count: records.events.length, member_sha256s: records.events.map((event) => event.member_sha256) }; const correctionManifest = { count: records.corrections.length, member_sha256s: records.corrections.map((correction) => correction.member_sha256) };
  const base = { schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_V1' as const, provider_identity: d.providerIdentity, subject: { wallet_fingerprint: walletFingerprint(user), dex: request.dex, coins: request.coins }, coverage: { start_ms: request.coverageStartMs, end_ms: request.coverageEndMs, observed_at_ms: observed, funding_interval_ms: d.providerIdentity.funding_interval_ms, latest_fully_covered_funding_time_ms: latest, correction_finality_watermark_ms: watermark, finality_status: 'final' as const, terminal: true as const, page_count: 1 as const }, funding_events: records.events, funding_corrections: records.corrections, event_manifest: { ...eventManifest, manifest_digest: cashLedgerEvidenceManifestDigest(eventManifest) }, correction_manifest: { ...correctionManifest, manifest_digest: cashLedgerEvidenceManifestDigest(correctionManifest) }, settled_usdc: { currency: 'USDC' as const, starting_balance: replay.starting, replay_final_balance: replay.final, current_balance: decimalText(account), replay_realized_pnl: replay.realized, ordinary_realized_pnl: fills.realized, replay_fees: replay.fees, ordinary_fees: fills.fees, effective_funding_charge: decimalText(effective), unrelated_cash_movement: '0' as const, expected_current_balance: decimalText(expected), residual: '0' as const, evidence_sha256: evidenceDigest }, flatness: { all_positions_zero: true as const, relevant_open_order_count: 0 as const, current_unrealized_pnl: '0' as const, clearinghouse_state_sha256: stateDigest, open_order_inventory_sha256: ordersDigest } };
  return cashLedgerEvidenceReceiptSchema.parse({ ...base, receipt_digest: domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_V1', base) });
}

export function buildCashLedgerEvidenceError(error: CashLedgerEvidenceError): WireError { return { schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_ERROR_V1', status: error.code === 'disabled' ? 'disabled' : error.status === 500 ? 'error' : 'refused', error_code: error.code }; }

// ---------------------------------------------------------------------------
// V2 reconstructible source inventory
// ---------------------------------------------------------------------------

export class CashLedgerEvidenceV2Error extends CashLedgerEvidenceError {
  constructor(
    message: string,
    code: CashLedgerEvidenceV2ErrorCode = 'internal',
    status: 400 | 403 | 409 | 500 = 409,
  ) {
    super(message, code as CashLedgerEvidenceErrorCode, status);
    this.name = 'CashLedgerEvidenceV2Error';
  }
}

const defaultV2ProviderIdentity = (): CashLedgerEvidenceV2ProviderIdentity => ({
  source_revision: config.HYPAPER_SOURCE_REVISION ?? '',
  image_digest: config.HYPAPER_IMAGE_DIGEST ?? '',
  compose_config_digest: config.HYPAPER_COMPOSE_CONFIG_DIGEST ?? '',
  api_schema_version: CASH_LEDGER_EVIDENCE_V2_SCHEMA,
  funding_interval_ms: config.FUNDING_INTERVAL_MS,
  correction_finality_ms: config.CASH_LEDGER_EVIDENCE_CORRECTION_FINALITY_MS ?? 0,
  max_evidence_rows: config.CASH_LEDGER_EVIDENCE_MAX_ROWS ?? 0,
});

function v2Refuse(
  message: string,
  code: CashLedgerEvidenceV2ErrorCode,
  status: 400 | 403 | 409 | 500 = 409,
): never {
  throw new CashLedgerEvidenceV2Error(message, code, status);
}

function ensureV2ProviderIdentity(identity: CashLedgerEvidenceV2ProviderIdentity): void {
  if (!/^[0-9a-f]{40}$/.test(identity.source_revision)
    || !/^sha256:[0-9a-f]{64}$/.test(identity.image_digest)
    || !sha256Pattern.test(identity.compose_config_digest)
    || identity.api_schema_version !== CASH_LEDGER_EVIDENCE_V2_SCHEMA
    || !Number.isSafeInteger(identity.funding_interval_ms) || identity.funding_interval_ms <= 0
    || !Number.isSafeInteger(identity.correction_finality_ms) || identity.correction_finality_ms <= 0
    || !Number.isSafeInteger(identity.max_evidence_rows) || identity.max_evidence_rows <= 0) {
    v2Refuse('provider identity is malformed', 'provenance');
  }
}

function validateV2Request(value: unknown, identity: CashLedgerEvidenceV2ProviderIdentity): CashLedgerEvidenceV2Request {
  const parsed = cashLedgerEvidenceV2RequestSchema.safeParse(value);
  if (!parsed.success) v2Refuse('invalid evidence request', 'invalid_request', 400);
  ensureV2ProviderIdentity(identity);
  if (parsed.data.coverageEndMs < parsed.data.coverageStartMs
    || parsed.data.coverageStartMs % identity.funding_interval_ms !== 0
    || parsed.data.coverageEndMs % identity.funding_interval_ms !== 0) {
    v2Refuse('coverage is not aligned or reversed', 'invalid_request', 400);
  }
  return parsed.data;
}

type V2OrderCapture = { key: string; data: Record<string, string> };

type V2ReadSnapshot = {
  account: Record<string, string>;
  state: unknown;
  openOrders: unknown[];
  replayId: string | null;
  replayRaw: string | null;
  replay: unknown | null;
  fills: string[];
  fundingIds: string[];
  correctionIds: string[];
  fundingKeys: string[];
  correctionKeys: string[];
  positionMembers: string[];
  positionKeys: string[];
  positionRows: Array<{ asset: string; data: Record<string, string> }>;
  orderIds: string[];
  orderKeys: string[];
  orderRows: V2OrderCapture[];
  openMembers: string[];
  triggerMembers: string[];
  activeUsers: string[];
  fundingRaws: Array<string | null>;
  correctionRaws: Array<string | null>;
};

function v2SafeCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) v2Refuse(`${label} count is malformed`, 'identity');
  return value;
}

function v2SortStrings(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function v2CanonicalRaw(raw: string, label: string): unknown {
  try {
    return decodeCanonicalJson(raw);
  } catch {
    v2Refuse(`${label} is malformed`, 'missing_source');
  }
}

function v2NoUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(v2NoUndefined);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, v2NoUndefined(child)]));
  }
  return value;
}

function v2StableReadValue(snapshot: V2ReadSnapshot): string {
  const state = snapshot.state !== null && typeof snapshot.state === 'object' && !Array.isArray(snapshot.state)
    ? Object.fromEntries(Object.entries(snapshot.state as Record<string, unknown>).filter(([key]) => key !== 'time'))
    : snapshot.state;
  return canonicalJson(v2NoUndefined({
    account: snapshot.account,
    state,
    openOrders: snapshot.openOrders,
    replayId: snapshot.replayId,
    replayRaw: snapshot.replayRaw,
    replay: snapshot.replay,
    fills: snapshot.fills,
    fundingIds: snapshot.fundingIds,
    correctionIds: snapshot.correctionIds,
    fundingKeys: snapshot.fundingKeys,
    correctionKeys: snapshot.correctionKeys,
    positionMembers: v2SortStrings(snapshot.positionMembers),
    positionKeys: v2SortStrings(snapshot.positionKeys),
    positionRows: [...snapshot.positionRows].sort((left, right) => left.asset.localeCompare(right.asset)),
    orderIds: snapshot.orderIds,
    orderKeys: v2SortStrings(snapshot.orderKeys),
    orderRows: [...snapshot.orderRows].sort((left, right) => left.key.localeCompare(right.key)),
    openMembers: v2SortStrings(snapshot.openMembers),
    triggerMembers: v2SortStrings(snapshot.triggerMembers),
    activeUsers: v2SortStrings(snapshot.activeUsers),
    fundingRaws: snapshot.fundingRaws,
    correctionRaws: snapshot.correctionRaws,
  }));
}

async function captureV2(
  user: string,
  d: Required<Pick<CashLedgerEvidenceV2Dependencies, 'redis' | 'historicalReplay' | 'clearinghouseState' | 'openOrders'>>,
  maxRows: number,
): Promise<V2ReadSnapshot> {
  const [fillCount, fundingCount, correctionCount, orderCount] = await Promise.all([
    d.redis.llen(KEYS.USER_FILLS(user)),
    d.redis.llen(KEYS.PNL_FUNDING_EVENTS(user)),
    d.redis.llen(KEYS.PNL_FUNDING_CORRECTIONS(user)),
    d.redis.zcard(KEYS.USER_ORDERS(user)),
  ]);
  for (const [label, count] of [
    ['ordinary fill', fillCount], ['funding event', fundingCount],
    ['funding correction', correctionCount], ['order', orderCount],
  ] as const) {
    if (v2SafeCount(count, label) > maxRows) v2Refuse(`${label} inventory exceeds row cap`, 'row_cap');
  }

  const [account, state, openOrders, replayId, fills, fundingIds, correctionIds,
    fundingKeys, correctionKeys, positionMembers, positionKeys, orderIds, orderKeys,
    openMembers, triggerMembers, activeUsers] = await Promise.all([
    d.redis.hgetall(KEYS.USER_ACCOUNT(user)),
    d.clearinghouseState(user),
    d.openOrders(user),
    d.redis.get(KEYS.HISTORICAL_REPLAY_INDEX(user)),
    d.redis.lrange(KEYS.USER_FILLS(user), 0, -1),
    d.redis.lrange(KEYS.PNL_FUNDING_EVENTS(user), 0, -1),
    d.redis.lrange(KEYS.PNL_FUNDING_CORRECTIONS(user), 0, -1),
    d.redis.keys(KEYS.PNL_FUNDING_EVENT(user, '*')),
    d.redis.keys(KEYS.PNL_FUNDING_CORRECTION(user, '*')),
    d.redis.smembers(KEYS.USER_POSITIONS(user)),
    d.redis.keys(`${KEYS.USER_POS(user, 0).replace(/0$/, '')}*`),
    d.redis.zrange(KEYS.USER_ORDERS(user), 0, -1),
    d.redis.keys('order:*'),
    d.redis.smembers(KEYS.ORDERS_OPEN),
    d.redis.smembers(KEYS.ORDERS_TRIGGERS),
    d.redis.smembers(KEYS.USERS_ACTIVE),
  ]);

  if (fills.length > maxRows || fundingIds.length > maxRows || correctionIds.length > maxRows
    || orderIds.length > maxRows || fundingKeys.length > maxRows || correctionKeys.length > maxRows
    || positionMembers.length > maxRows || positionKeys.length > maxRows || orderKeys.length > maxRows
    || openMembers.length > maxRows || triggerMembers.length > maxRows || activeUsers.length > maxRows) {
    v2Refuse('source inventory exceeds row cap', 'row_cap');
  }
  if (v2SafeCount(fills.length, 'ordinary fill') !== fillCount
    || v2SafeCount(fundingIds.length, 'funding event') !== fundingCount
    || v2SafeCount(correctionIds.length, 'funding correction') !== correctionCount
    || v2SafeCount(orderIds.length, 'order') !== orderCount) {
    v2Refuse('source index count changed during capture', 'stable_read');
  }

  let replayRaw: string | null = null;
  let replay: unknown | null = null;
  if (replayId !== null) {
    if (!/^hprb[0-9a-f]{64}$/.test(replayId)) v2Refuse('replay identity is malformed', 'identity');
    [replayRaw, replay] = await Promise.all([
      d.redis.get(KEYS.HISTORICAL_REPLAY_BATCH(user, replayId)),
      d.historicalReplay(user, replayId),
    ]);
  }

  const [fundingRaws, correctionRaws, positionRows, orderRows] = await Promise.all([
    Promise.all(fundingIds.map((id) => d.redis.get(KEYS.PNL_FUNDING_EVENT(user, id)))),
    Promise.all(correctionIds.map((id) => d.redis.get(KEYS.PNL_FUNDING_CORRECTION(user, id)))),
    Promise.all(positionMembers.map(async (asset) => ({ asset, data: await d.redis.hgetall(KEYS.USER_POS(user, Number(asset))) }))),
    Promise.all(orderIds.map(async (oid) => ({ key: KEYS.ORDER(Number(oid)), data: await d.redis.hgetall(KEYS.ORDER(Number(oid))) }))),
  ]);
  const allOrderRows = await Promise.all(orderKeys.map(async (key) => ({ key, data: await d.redis.hgetall(key) })));
  return {
    account,
    state,
    openOrders,
    replayId,
    replayRaw,
    replay,
    fills,
    fundingIds,
    correctionIds,
    fundingKeys: v2SortStrings(fundingKeys),
    correctionKeys: v2SortStrings(correctionKeys),
    positionMembers: [...positionMembers],
    positionKeys: v2SortStrings(positionKeys),
    positionRows,
    orderIds: [...orderIds],
    orderKeys: v2SortStrings(orderKeys),
    orderRows: allOrderRows,
    openMembers: v2SortStrings(openMembers),
    triggerMembers: v2SortStrings(triggerMembers),
    activeUsers: v2SortStrings(activeUsers),
    fundingRaws,
    correctionRaws,
  };
}

function v2Decimal(value: string, label: string): DecimalValue {
  if (!decimalPattern.test(value)) v2Refuse(`${label} is not canonical`, 'arithmetic');
  const result = new Decimal(value);
  if (!result.isFinite()) v2Refuse(`${label} is not finite`, 'arithmetic');
  return result;
}

type V2DecimalConstructor = {
  new (value: string | number): DecimalValue;
  clone(options: { precision: number }): V2DecimalConstructor;
};

const v2DecimalBase = Decimal as unknown as V2DecimalConstructor;

function v2Precision(values: readonly string[]): number {
  const digits = values.reduce((total, value) => total + value.replace(/[^0-9]/g, '').length, 0);
  return Math.max(64, digits + 32);
}

function v2Calculate(values: readonly string[], operation: (numbers: DecimalValue[]) => DecimalValue): DecimalValue {
  const Constructor = v2DecimalBase.clone({ precision: v2Precision(values) });
  return operation(values.map((value) => new Constructor(value)));
}

function v2Add(...values: string[]): DecimalValue {
  if (values.length === 0) return v2Calculate(['0'], () => new v2DecimalBase('0'));
  return v2Calculate(values, (numbers) => numbers.slice(1).reduce((sum, value) => sum.plus(value), numbers[0]!));
}

function v2Subtract(left: string, right: string): DecimalValue {
  return v2Calculate([left, right], ([a, b]) => a!.minus(b!));
}

function v2Multiply(...values: string[]): DecimalValue {
  return v2Calculate(values, (numbers) => numbers.slice(1).reduce((product, value) => product.times(value), numbers[0]!));
}

function v2Equal(left: string, right: string): boolean {
  return v2Calculate([left, right], ([a, b]) => a!.minus(b!)).isZero();
}

function v2Divide(left: string, right: string): DecimalValue {
  if (v2Decimal(right, 'division denominator').isZero()) v2Refuse('division by zero', 'arithmetic');
  return v2Calculate([left, right], ([a, b]) => a!.div(b!));
}

function v2Magnitude(value: string): string {
  return v2Calculate([value], ([number]) => number!.abs()).toFixed();
}

type V2PositionState = { quantity: string; entryPx: string };
type V2FillTransition = {
  state: V2PositionState;
  closedPnl: string;
  endPosition: string;
  entryPx: string;
};

/**
 * Rebuild one signed fill transition from its source fields.  The returned
 * entry price is an in-memory weighted average only; it is never published.
 */
function v2FillTransition(
  current: V2PositionState | undefined,
  side: 'B' | 'A',
  sz: string,
  px: string,
  closedPnl: string,
  phase: 'scheduled_entry' | 'scheduled_reduction' | undefined,
): V2FillTransition {
  const before = current?.quantity ?? '0';
  const priorEntry = current?.entryPx ?? '0';
  const beforeValue = v2Decimal(before, 'fill start position');
  const size = v2Decimal(sz, 'fill quantity');
  v2Decimal(px, 'fill price');
  const signed = side === 'B' ? size : v2Calculate([sz], ([number]) => number!.negated());
  const signedText = signed.toFixed();
  const sameDirection = beforeValue.isZero()
    || (beforeValue.gt(0) && signed.gt(0))
    || (beforeValue.lt(0) && signed.lt(0));

  if (phase === 'scheduled_entry' && !beforeValue.isZero()) {
    v2Refuse('replay entry does not start flat', 'arithmetic');
  }
  if (phase === 'scheduled_reduction' && (beforeValue.isZero() || sameDirection)) {
    v2Refuse('replay reduction does not reduce exposure', 'arithmetic');
  }

  const after = v2Add(before, signedText).toFixed();
  if (sameDirection) {
    if (!v2Equal(closedPnl, '0')) v2Refuse('opening fill has nonzero realized PnL', 'arithmetic');
    const entryPx = beforeValue.isZero()
      ? px
      : v2Divide(
        v2Add(
          v2Multiply(v2Magnitude(before), priorEntry).toFixed(),
          v2Multiply(sz, px).toFixed(),
        ).toFixed(),
        v2Magnitude(after),
      ).toFixed();
    return {
      state: { quantity: after, entryPx },
      closedPnl: '0',
      endPosition: after,
      entryPx,
    };
  }

  const priorMagnitude = v2Magnitude(before);
  const closingSize = size.gt(v2Decimal(priorMagnitude, 'fill position magnitude'))
    ? priorMagnitude
    : sz;
  const expectedClosed = beforeValue.gt(0)
    ? v2Multiply(v2Subtract(px, priorEntry).toFixed(), closingSize).toFixed()
    : v2Multiply(v2Subtract(priorEntry, px).toFixed(), closingSize).toFixed();
  if (!v2Equal(closedPnl, expectedClosed)) v2Refuse('fill realized PnL is not reconstructible', 'arithmetic');
  if (phase === 'scheduled_reduction' && size.gt(v2Decimal(priorMagnitude, 'replay position magnitude'))) {
    v2Refuse('replay reduction flips position', 'arithmetic');
  }
  const entryPx = v2Equal(after, '0') || size.gt(v2Decimal(priorMagnitude, 'fill position magnitude'))
    ? (v2Equal(after, '0') ? '0' : px)
    : priorEntry;
  return {
    state: { quantity: after, entryPx },
    closedPnl: expectedClosed,
    endPosition: after,
    entryPx,
  };
}

function v2NumberString(value: string, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) v2Refuse(`${label} is not a safe integer`, 'identity');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) v2Refuse(`${label} is not a safe integer`, 'identity');
  return parsed;
}

function v2RawHash(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function v2NormalizeReplay(user: string, replayRaw: string | null, replay: unknown | null): CashLedgerEvidenceV2Receipt['source_inventory']['replay']['rows'][number]['source'] {
  if (replayRaw === null || replay === null) v2Refuse('immutable replay evidence is missing', 'missing_source');
  const rawParsed = historicalReplayResultSchema.safeParse(v2CanonicalRaw(replayRaw, 'stored replay'));
  const returnedParsed = historicalReplayResultSchema.safeParse(replay);
  if (!rawParsed.success || !returnedParsed.success
    || rawParsed.data.user !== user || returnedParsed.data.user !== user
    || rawParsed.data.batchId !== returnedParsed.data.batchId
    || canonicalJson(rawParsed.data) !== canonicalJson(returnedParsed.data)) {
    v2Refuse('immutable replay source changed or is malformed', 'source_preimage');
  }
  const { user: _user, ...withoutUser } = returnedParsed.data;
  const source = { ...withoutUser, wallet_fingerprint: walletFingerprint(user) };
  const parsed = cashLedgerEvidenceV2ReplayResultSchema.safeParse(source);
  if (!parsed.success) v2Refuse('sanitized replay source is malformed', 'missing_source');
  return parsed.data;
}

function v2ValidateReplaySource(
  source: CashLedgerEvidenceV2Receipt['source_inventory']['replay']['rows'][number]['source'],
  requested: ReadonlySet<string>,
): void {
  if (source.eventCount !== source.events.length
    || source.eventIds.length !== source.events.length
    || canonicalJson(source.eventIds) !== canonicalJson(source.events.map((event) => event.eventId))
    || source.batchId !== source.replay.batchId
    || source.replay.modelInputs.startingBalance !== source.startingBalance) {
    v2Refuse('replay result identity or event inventory is inconsistent', 'identity');
  }

  const plannedById = new Map(source.replay.events.map((event) => [event.eventId, event]));
  const evidenceById = new Map(source.replay.priceEvidence.map((evidence) => [evidence.evidenceId, evidence]));
  if (plannedById.size !== source.replay.events.length || evidenceById.size !== source.replay.priceEvidence.length) {
    v2Refuse('replay contains duplicate source identities', 'identity');
  }

  const states = new Map<number, V2PositionState>();
  let balance = source.startingBalance;
  let priorRecorded = source.replayedAt;
  for (const [sequence, event] of source.events.entries()) {
    if (event.sequence !== sequence || event.batchId !== source.batchId
      || event.eventId !== source.eventIds[sequence]
      || event.recordedAt < source.replayedAt || event.recordedAt < event.effectiveAt
      || event.recordedAt < priorRecorded || !requested.has(event.coin)) {
      v2Refuse('replay event chronology, identity, or scope is invalid', 'chronology');
    }
    const planned = plannedById.get(event.eventId);
    const evidence = evidenceById.get(event.evidenceId);
    if (planned === undefined || evidence === undefined
      || planned.phase !== event.phase || planned.sequence !== event.sequence
      || planned.asset !== event.asset || planned.coin !== event.coin
      || planned.effectiveAt !== event.effectiveAt
      || planned.priceEvidenceId !== event.evidenceId
      || evidence.asset !== event.asset || evidence.coin !== event.coin
      || evidence.side !== event.side || evidence.sz !== event.sz
      || evidence.aggressiveLimitPx !== event.aggressiveLimitPx) {
      v2Refuse('replay event does not match its declared source evidence', 'source_preimage');
    }
    const current = states.get(event.asset);
    if (!v2Equal(current?.quantity ?? '0', event.startPosition)) {
      v2Refuse('replay fill position transition is invalid', 'arithmetic');
    }
    const transition = v2FillTransition(
      current,
      event.side,
      event.sz,
      event.px,
      event.closedPnl,
      event.phase,
    );
    if (!v2Equal(transition.endPosition, event.endPosition)
      || !v2Equal(transition.entryPx, event.entryPx)) {
      v2Refuse('replay fill transition is not reconstructible', 'arithmetic');
    }
    const expectedFee = v2Multiply(event.sz, event.px, event.feeRate).toFixed();
    if (!v2Equal(expectedFee, event.fee)) v2Refuse('replay fee is not reconstructible', 'arithmetic');
    states.set(event.asset, transition.state);
    balance = v2Add(balance, event.closedPnl, v2Subtract('0', event.fee).toFixed()).toFixed();
    priorRecorded = event.recordedAt;
  }
  if (!v2Equal(balance, source.finalBalance)
    || !v2Equal(source.riskSummary.cashBalance, source.finalBalance)) {
    v2Refuse('replay cash balance does not reconcile', 'arithmetic');
  }

  const finalStates = [...states.entries()].filter(([, state]) => !v2Equal(state.quantity, '0')).sort(([left], [right]) => left - right);
  if (finalStates.length !== source.positions.length) v2Refuse('replay final positions do not reconcile', 'flatness');
  for (const [index, [asset, state]] of finalStates.entries()) {
    const position = source.positions[index];
    if (position === undefined || !requested.has(position.coin) || position.asset !== asset || position.coin !== source.replay.assetBindings.find((binding) => binding.asset === asset)?.coin
      || !v2Equal(position.szi, state.quantity) || !v2Equal(position.entryPx, state.entryPx)) {
      v2Refuse('replay final position projection is inconsistent', 'arithmetic');
    }
  }

  const postureAssets = new Set<number>();
  let unrealized = '0';
  let margin = '0';
  for (const posture of source.marginPosture) {
    if (postureAssets.has(posture.asset)) v2Refuse('replay margin posture contains duplicate assets', 'identity');
    postureAssets.add(posture.asset);
    const state = states.get(posture.asset);
    const quantity = state?.quantity ?? '0';
    const entryPx = state?.entryPx ?? '0';
    if (posture.coin !== source.replay.assetBindings.find((binding) => binding.asset === posture.asset)?.coin
      || !v2Equal(posture.finalSzi, quantity) || !v2Equal(posture.finalEntryPx, entryPx)) {
      v2Refuse('replay margin posture position projection is inconsistent', 'arithmetic');
    }
    unrealized = v2Add(unrealized, posture.unrealizedPnl).toFixed();
    margin = v2Add(margin, posture.marginRequired).toFixed();
  }
  if (!v2Equal(source.riskSummary.unrealizedPnl, unrealized)
    || !v2Equal(source.riskSummary.accountValue, v2Add(source.finalBalance, unrealized).toFixed())
    || !v2Equal(source.riskSummary.marginAvailable, v2Subtract(source.riskSummary.accountValue, margin).toFixed())
    || !v2Equal(source.riskSummary.totalMargin, margin)) {
    v2Refuse('replay risk summary does not reconcile', 'arithmetic');
  }
}

function v2NormalizeFill(user: string, raw: string, ordinal: number): CashLedgerEvidenceV2Receipt['source_inventory']['ordinary_fills']['rows'][number]['source'] {
  const parsedRaw = v2CanonicalRaw(raw, `ordinary fill ${ordinal}`);
  if (parsedRaw === null || typeof parsedRaw !== 'object' || Array.isArray(parsedRaw)) v2Refuse('ordinary fill is malformed', 'missing_source');
  const candidate = { ...(parsedRaw as Record<string, unknown>) };
  if (!Object.prototype.hasOwnProperty.call(candidate, 'cloid')) candidate.cloid = null;
  const parsed = cashLedgerEvidenceV2FillSchema.safeParse(candidate);
  if (!parsed.success || parsed.data.hash !== `0x${parsed.data.tid.toString(16).padStart(64, '0')}`) v2Refuse('ordinary fill identity is malformed', 'identity');
  if (parsed.data.coin.length === 0 || user.length === 0) v2Refuse('ordinary fill identity is malformed', 'identity');
  return parsed.data;
}

function v2NormalizeAccount(account: Record<string, string>, user: string, replayBatchId: string): CashLedgerEvidenceV2Account {
  const allowed = new Set(['userId', 'balance', 'createdAt']);
  if (Object.keys(account).some((key) => !allowed.has(key))
    || Object.keys(account).length !== allowed.size
    || account.userId !== user || account.balance === undefined || account.createdAt === undefined) {
    v2Refuse('account source is missing, foreign, or has unknown fields', 'identity');
  }
  v2Decimal(account.balance, 'account balance');
  const created = v2NumberString(account.createdAt, 'account created_at_ms');
  const result = {
    wallet_fingerprint: walletFingerprint(user),
    currency: 'USDC' as const,
    balance: account.balance,
    created_at_ms: created,
    replay_batch_id: replayBatchId,
  };
  const parsed = cashLedgerEvidenceV2ReceiptSchema.shape.source_inventory.shape.account.shape.rows.element.shape.source.safeParse(result);
  if (!parsed.success) v2Refuse('account source is malformed', 'identity');
  return parsed.data;
}

function v2NormalizeFundingEvent(raw: string, id: string, ordinal: number): CashLedgerEvidenceV2FundingEvent {
  const parsedRaw = v2CanonicalRaw(raw, `funding event ${ordinal}`);
  const parsed = pnlFundingEventSchema.safeParse(parsedRaw);
  if (!parsed.success || parsed.data.eventId !== id) v2Refuse('funding event source identity is invalid', 'identity');
  const source = parsed.data.source;
  const base = {
    ordinal,
    schema: parsed.data.schema,
    event_id: parsed.data.eventId,
    asset: parsed.data.asset,
    coin: parsed.data.coin,
    funding_time_ms: parsed.data.fundingTime,
    applied_at_ms: parsed.data.appliedAt,
    szi: parsed.data.szi,
    oracle_px: parsed.data.oraclePx,
    funding_rate: parsed.data.fundingRate,
    funding_charge: parsed.data.fundingCharge,
    source: source.kind === 'live_market_context' ? { kind: 'live_market_context' as const } : source.kind === 'live_boundary_snapshot' ? {
      kind: 'live_boundary_snapshot' as const,
      funding_history_time_ms: source.fundingHistoryTime,
      context_observed_at_ms: source.contextObservedAt,
    } : {
      kind: 'verified_backfill' as const,
      oracle_source_sha256: source.oracleSourceSha256,
      funding_source_sha256: source.fundingSourceSha256,
    },
    account_balance_before: parsed.data.accountBalanceBefore,
    account_balance_after: parsed.data.accountBalanceAfter,
    cum_funding_before: parsed.data.cumFundingBefore,
    cum_funding_after: parsed.data.cumFundingAfter,
    cum_funding_since_open_before: parsed.data.cumFundingSinceOpenBefore,
    cum_funding_since_open_after: parsed.data.cumFundingSinceOpenAfter,
    cum_funding_since_change_before: parsed.data.cumFundingSinceChangeBefore,
    cum_funding_since_change_after: parsed.data.cumFundingSinceChangeAfter,
    source_record_sha256: v2RawHash(raw),
  } satisfies Omit<CashLedgerEvidenceV2FundingEvent, 'member_sha256'>;
  return { ...base, member_sha256: cashLedgerEvidenceV2EventMemberDigest(base) };
}

function v2NormalizeCorrection(raw: string, id: string, ordinal: number): CashLedgerEvidenceV2FundingCorrection {
  const parsedRaw = v2CanonicalRaw(raw, `funding correction ${ordinal}`);
  const parsed = pnlFundingCorrectionSchema.safeParse(parsedRaw);
  if (!parsed.success || parsed.data.correctionId !== id) v2Refuse('funding correction source identity is invalid', 'identity');
  const base = {
    ordinal,
    schema: parsed.data.schema,
    correction_id: parsed.data.correctionId,
    original_event_id: parsed.data.originalEventId,
    asset: parsed.data.asset,
    coin: parsed.data.coin,
    funding_time_ms: parsed.data.fundingTime,
    applied_at_ms: parsed.data.appliedAt,
    szi: parsed.data.szi,
    original_funding_charge: parsed.data.originalFundingCharge,
    corrected_oracle_px: parsed.data.correctedOraclePx,
    corrected_funding_rate: parsed.data.correctedFundingRate,
    corrected_funding_charge: parsed.data.correctedFundingCharge,
    funding_charge_delta: parsed.data.fundingChargeDelta,
    source: {
      kind: 'verified_correction' as const,
      original_event_sha256: parsed.data.source.originalEventSha256,
      oracle_source_sha256: parsed.data.source.oracleSourceSha256,
      funding_source_sha256: parsed.data.source.fundingSourceSha256,
    },
    account_balance_before: parsed.data.accountBalanceBefore,
    account_balance_after: parsed.data.accountBalanceAfter,
    cum_funding_before: parsed.data.cumFundingBefore,
    cum_funding_after: parsed.data.cumFundingAfter,
    cum_funding_since_open_before: parsed.data.cumFundingSinceOpenBefore,
    cum_funding_since_open_after: parsed.data.cumFundingSinceOpenAfter,
    cum_funding_since_change_before: parsed.data.cumFundingSinceChangeBefore,
    cum_funding_since_change_after: parsed.data.cumFundingSinceChangeAfter,
    source_record_sha256: v2RawHash(raw),
  } satisfies Omit<CashLedgerEvidenceV2FundingCorrection, 'member_sha256'>;
  return { ...base, member_sha256: cashLedgerEvidenceV2CorrectionMemberDigest(base) };
}

function v2CheckRawAccounting(event: CashLedgerEvidenceV2FundingEvent): void {
  const charge = v2Decimal(event.funding_charge, 'funding charge');
  const expected = v2Multiply(event.szi, event.oracle_px, event.funding_rate);
  if (!charge.eq(expected)) v2Refuse('funding charge arithmetic is invalid', 'arithmetic');
  if (!v2Equal(event.account_balance_after, v2Subtract(event.account_balance_before, event.funding_charge).toFixed())) v2Refuse('funding cash transition is invalid', 'arithmetic');
  for (const [before, after] of [
    [event.cum_funding_before, event.cum_funding_after],
    [event.cum_funding_since_open_before, event.cum_funding_since_open_after],
    [event.cum_funding_since_change_before, event.cum_funding_since_change_after],
  ] as const) {
    if (!v2Equal(after, v2Add(before, event.funding_charge).toFixed())) v2Refuse('funding cumulative transition is invalid', 'arithmetic');
  }
}

function v2CheckRawCorrection(correction: CashLedgerEvidenceV2FundingCorrection, originalRaw: string, original: CashLedgerEvidenceV2FundingEvent): void {
  if (correction.original_event_id !== original.event_id
    || correction.source.original_event_sha256 !== v2RawHash(originalRaw)
    || correction.asset !== original.asset || correction.coin !== original.coin
    || correction.funding_time_ms !== original.funding_time_ms || correction.szi !== original.szi
    || correction.original_funding_charge !== original.funding_charge) v2Refuse('funding correction source preimage is invalid', 'source_preimage');
  const corrected = v2Multiply(correction.szi, correction.corrected_oracle_px, correction.corrected_funding_rate);
  if (!v2Equal(correction.corrected_funding_charge, corrected.toFixed())
    || !v2Equal(correction.funding_charge_delta, v2Subtract(correction.corrected_funding_charge, correction.original_funding_charge).toFixed())
    || v2Decimal(correction.funding_charge_delta, 'funding correction delta').isZero()
    || !v2Equal(correction.account_balance_after, v2Subtract(correction.account_balance_before, correction.funding_charge_delta).toFixed())) {
    v2Refuse('funding correction arithmetic is invalid', 'arithmetic');
  }
  for (const [before, after] of [
    [correction.cum_funding_before, correction.cum_funding_after],
    [correction.cum_funding_since_open_before, correction.cum_funding_since_open_after],
    [correction.cum_funding_since_change_before, correction.cum_funding_since_change_after],
  ] as const) {
    if (!v2Equal(after, v2Add(before, correction.funding_charge_delta).toFixed())) v2Refuse('correction cumulative transition is invalid', 'arithmetic');
  }
}

function v2NormalizePosition(asset: string, data: Record<string, string>, user: string, requested: ReadonlySet<string>): CashLedgerEvidenceV2Position {
  const allowed = new Set(['userId', 'asset', 'coin', 'szi', 'entryPx', 'cumFunding', 'cumFundingSinceOpen', 'cumFundingSinceChange']);
  if (Object.keys(data).some((key) => !allowed.has(key)) || data.userId !== user || data.asset !== asset
    || data.coin === undefined || !requested.has(data.coin) || data.szi === undefined || data.entryPx === undefined) {
    v2Refuse('position owner or source fields are invalid', 'owner');
  }
  const szi = v2Decimal(data.szi, 'position size');
  if (szi.isZero()) v2Refuse('stored zero position row is malformed', 'flatness');
  if (!v2Decimal(data.entryPx, 'position entry price').gt(0)) v2Refuse('position entry price is invalid', 'arithmetic');
  const result = { asset: v2NumberString(asset, 'position asset'), coin: data.coin, szi: data.szi, entry_px: data.entryPx };
  const parsed = cashLedgerEvidenceV2PositionSchema.safeParse(result);
  if (!parsed.success) v2Refuse('position source is malformed', 'identity');
  return parsed.data;
}

function v2Boolean(value: string | undefined, label: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  v2Refuse(`${label} is not a strict boolean`, 'identity');
}

function v2OptionalString(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  if (value.length === 0) v2Refuse(`${label} is empty`, 'identity');
  return value;
}

function v2NormalizeOrder(
  id: string,
  data: Record<string, string>,
  user: string,
  requested: ReadonlySet<string>,
  openSet: ReadonlySet<string>,
  triggerSet: ReadonlySet<string>,
): CashLedgerEvidenceV2Order {
  const allowed = new Set(['oid', 'userId', 'asset', 'coin', 'isBuy', 'sz', 'limitPx', 'orderType', 'tif', 'reduceOnly', 'grouping', 'status', 'filledSz', 'avgPx', 'createdAt', 'updatedAt', 'cloid', 'triggerPx', 'tpsl', 'isMarket']);
  if (Object.keys(data).some((key) => !allowed.has(key)) || data.userId !== user || data.oid !== id
    || data.coin === undefined || !requested.has(data.coin) || data.asset === undefined || data.isBuy === undefined
    || data.sz === undefined || data.limitPx === undefined || data.orderType === undefined || data.tif === undefined
    || data.reduceOnly === undefined || data.grouping === undefined || data.status === undefined
    || data.filledSz === undefined || data.avgPx === undefined || data.createdAt === undefined || data.updatedAt === undefined) {
    v2Refuse('order owner or required source fields are invalid', 'owner');
  }
  const oid = v2NumberString(id, 'order oid');
  if (v2NumberString(data.oid, 'order oid') !== oid) v2Refuse('order identity is inconsistent', 'identity');
  const isBuy = v2Boolean(data.isBuy, 'order side');
  const reduceOnly = v2Boolean(data.reduceOnly, 'order reduce_only');
  const qty = v2Decimal(data.sz, 'order quantity');
  const filled = v2Decimal(data.filledSz, 'order filled quantity');
  if (!qty.gt(0) || filled.isNegative() || filled.gt(qty)) v2Refuse('order quantity is invalid', 'arithmetic');
  v2Decimal(data.limitPx, 'order limit price');
  v2Decimal(data.avgPx, 'order average fill price');
  const createdAt = v2NumberString(data.createdAt, 'order created_at_ms');
  const updatedAt = v2NumberString(data.updatedAt, 'order updated_at_ms');
  if (updatedAt < createdAt) v2Refuse('order chronology is invalid', 'chronology');
  const open = openSet.has(id);
  const trigger = triggerSet.has(id);
  if (open && trigger) v2Refuse('order belongs to both active sets', 'membership');
  if (data.status === 'open') {
    if (!open && !trigger) v2Refuse('open order is absent from its active set', 'membership');
    if (data.orderType === 'trigger' && !trigger) v2Refuse('trigger order is absent from trigger set', 'membership');
    if (data.orderType === 'limit' && !open) v2Refuse('limit order is absent from open set', 'membership');
  } else if (open || trigger) {
    v2Refuse('terminal order remains in an active set', 'membership');
  }
  if (data.status === 'open') v2Refuse('nonterminal order prevents final flatness', 'flatness');
  const result = {
    oid,
    coin: data.coin,
    asset: v2NumberString(data.asset, 'order asset'),
    side: isBuy ? 'BUY' as const : 'SELL' as const,
    qty: data.sz,
    filled_qty: data.filledSz,
    average_fill_px: data.avgPx,
    limit_px: data.limitPx,
    order_type: data.orderType,
    time_in_force: data.tif,
    reduce_only: reduceOnly,
    grouping: data.grouping,
    status: data.status,
    created_at_ms: createdAt,
    updated_at_ms: updatedAt,
    cl_ord_id: v2OptionalString(data.cloid, 'order cl_ord_id'),
    trigger_px: data.triggerPx === undefined ? null : data.triggerPx,
    tp_sl: v2OptionalString(data.tpsl, 'order tp_sl') as 'tp' | 'sl' | null,
    is_market: data.isMarket === undefined ? null : v2Boolean(data.isMarket, 'order is_market'),
    open_set_member: open,
    trigger_set_member: trigger,
  };
  const parsed = cashLedgerEvidenceV2OrderSchema.safeParse(result);
  if (!parsed.success) v2Refuse('order source is malformed', 'identity');
  return parsed.data;
}

function v2Collection<K extends 'REPLAY' | 'FILL' | 'FUNDING' | 'CORRECTION' | 'ACCOUNT' | 'POSITION' | 'ORDER'>(
  kind: K,
  rows: Array<{ ordinal: number; identity: string; source: unknown }>,
) {
  const typedRows = rows.map((row) => ({ ...row, source_digest: cashLedgerEvidenceV2SourceDigest(kind, row.source) }));
  const core = {
    count: typedRows.length,
    identities: typedRows.map((row) => row.identity),
    source_digests: typedRows.map((row) => row.source_digest),
  };
  return {
    rows: typedRows,
    manifest: { ...core, manifest_digest: cashLedgerEvidenceV2SourceManifestDigest(core) },
  };
}

function v2CheckCoverage(
  events: readonly CashLedgerEvidenceV2FundingEvent[],
  corrections: readonly CashLedgerEvidenceV2FundingCorrection[],
  request: CashLedgerEvidenceV2Request,
  identity: CashLedgerEvidenceV2ProviderIdentity,
): void {
  const boundaries = Math.floor((request.coverageEndMs - request.coverageStartMs) / identity.funding_interval_ms) + 1;
  if (events.length !== boundaries * request.coins.length) v2Refuse('funding coverage has a gap or duplicate', 'gap');
  const seen = new Set<string>();
  const assetByCoin = new Map<string, number>();
  const coinByAsset = new Map<number, string>();
  let priorApplied = -1;
  for (const [index, event] of events.entries()) {
    if (!request.coins.includes(event.coin) || event.funding_time_ms < request.coverageStartMs
      || event.funding_time_ms > request.coverageEndMs || event.funding_time_ms % identity.funding_interval_ms !== 0
      || event.applied_at_ms < event.funding_time_ms || event.applied_at_ms < priorApplied) v2Refuse('funding chronology or coverage is invalid', 'chronology');
    if ((assetByCoin.has(event.coin) && assetByCoin.get(event.coin) !== event.asset)
      || (coinByAsset.has(event.asset) && coinByAsset.get(event.asset) !== event.coin)) {
      v2Refuse('funding asset and coin identities are inconsistent', 'identity');
    }
    assetByCoin.set(event.coin, event.asset);
    coinByAsset.set(event.asset, event.coin);
    const key = `${event.coin}\0${event.funding_time_ms}`;
    if (seen.has(key)) v2Refuse('funding coverage has a duplicate', 'gap');
    seen.add(key); priorApplied = event.applied_at_ms;
    if (index > 0 && !v2Equal(events[index - 1]!.account_balance_after, event.account_balance_before)) {
      v2Refuse('funding cash transitions have a gap', 'arithmetic');
    }
    v2CheckRawAccounting(event);
  }
  for (let time = request.coverageStartMs; time <= request.coverageEndMs; time += identity.funding_interval_ms) {
    for (const coin of request.coins) if (!seen.has(`${coin}\0${time}`)) v2Refuse('funding coverage has a gap', 'gap');
  }
  const originals = new Map(events.map((event) => [event.event_id, event]));
  const used = new Set<string>();
  let priorCorrection = -1;
  for (const [index, correction] of corrections.entries()) {
    const original = originals.get(correction.original_event_id);
    if (original === undefined || used.has(correction.original_event_id) || correction.applied_at_ms < correction.funding_time_ms || correction.applied_at_ms < priorCorrection) v2Refuse('funding correction chronology or identity is invalid', 'chronology');
    used.add(correction.original_event_id); priorCorrection = correction.applied_at_ms;
    const raw = correction.source_record_sha256; // source preimage is checked by caller with the exact raw row.
    if (raw.length !== 64) v2Refuse('funding correction source is malformed', 'source_preimage');
    if (index > 0 && !v2Equal(corrections[index - 1]!.account_balance_after, correction.account_balance_before)) {
      v2Refuse('correction cash transitions have a gap', 'arithmetic');
    }
  }

  const cashTransitions = [
    ...events.map((event, index) => ({ appliedAt: event.applied_at_ms, index, before: event.account_balance_before, after: event.account_balance_after })),
    ...corrections.map((correction, index) => ({ appliedAt: correction.applied_at_ms, index: events.length + index, before: correction.account_balance_before, after: correction.account_balance_after })),
  ].sort((left, right) => left.appliedAt - right.appliedAt || left.index - right.index);
  for (let index = 1; index < cashTransitions.length; index += 1) {
    if (!v2Equal(cashTransitions[index - 1]!.after, cashTransitions[index]!.before)) {
      v2Refuse('funding and correction cash transitions have a gap', 'arithmetic');
    }
  }

  const cumulativeTransitions = [
    ...events.map((event, index) => ({ appliedAt: event.applied_at_ms, index, asset: event.asset, coin: event.coin, before: [event.cum_funding_before, event.cum_funding_since_open_before, event.cum_funding_since_change_before], after: [event.cum_funding_after, event.cum_funding_since_open_after, event.cum_funding_since_change_after] })),
    ...corrections.map((correction, index) => ({ appliedAt: correction.applied_at_ms, index: events.length + index, asset: correction.asset, coin: correction.coin, before: [correction.cum_funding_before, correction.cum_funding_since_open_before, correction.cum_funding_since_change_before], after: [correction.cum_funding_after, correction.cum_funding_since_open_after, correction.cum_funding_since_change_after] })),
  ].sort((left, right) => left.appliedAt - right.appliedAt || left.index - right.index);
  const priorCumulative = new Map<string, readonly string[]>();
  for (const transition of cumulativeTransitions) {
    const key = `${transition.asset}\0${transition.coin}`;
    const prior = priorCumulative.get(key);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(transition.before)) {
      v2Refuse('funding cumulative transitions have a gap', 'arithmetic');
    }
    priorCumulative.set(key, transition.after);
  }
}

function v2CheckStateAndFlatness(
  snapshot: V2ReadSnapshot,
  account: CashLedgerEvidenceV2Account,
  requested: ReadonlySet<string>,
  positions: readonly CashLedgerEvidenceV2Position[],
  orders: readonly CashLedgerEvidenceV2Order[],
): void {
  const state = stateSchema.safeParse(snapshot.state);
  if (!state.success) v2Refuse('clearinghouse state is malformed', 'missing_source');
  const cross = v2Decimal(state.data.crossMarginSummary.accountValue, 'clearinghouse account value');
  const margin = v2Decimal(state.data.marginSummary.accountValue, 'margin account value');
  if (!cross.eq(margin) || !cross.eq(account.balance)) v2Refuse('clearinghouse account values disagree', 'arithmetic');
  const stateCoins = new Set<string>();
  for (const wrapper of state.data.assetPositions) {
    if (wrapper.position === undefined || !requested.has(wrapper.position.coin)) v2Refuse('state contains an unknown position', 'identity');
    stateCoins.add(wrapper.position.coin);
    if (!v2Decimal(wrapper.position.szi, 'state position size').isZero()) v2Refuse('current position is non-flat', 'flatness');
  }
  if (positions.length !== 0 || stateCoins.size !== 0) v2Refuse('current position inventory is non-flat', 'flatness');
  if (snapshot.openOrders.length !== 0 || orders.some((order) => order.open_set_member || order.trigger_set_member)) v2Refuse('open order inventory is non-flat', 'flatness');
}

function v2CheckOrderOwnership(snapshot: V2ReadSnapshot, user: string, indexIds: readonly string[]): void {
  const index = new Set(indexIds);
  if (index.size !== indexIds.length) v2Refuse('user order index contains duplicate identities', 'identity');
  if (new Set(snapshot.openMembers).size !== snapshot.openMembers.length
    || new Set(snapshot.triggerMembers).size !== snapshot.triggerMembers.length) {
    v2Refuse('global active order inventory contains duplicate identities', 'identity');
  }
  const openSet = new Set(snapshot.openMembers);
  const triggerSet = new Set(snapshot.triggerMembers);
  for (const id of openSet) if (triggerSet.has(id)) v2Refuse('order belongs to both active sets', 'membership');
  const allKeys = new Set(snapshot.orderKeys);
  for (const id of indexIds) if (!allKeys.has(KEYS.ORDER(v2NumberString(id, 'order oid')))) v2Refuse('user order index points to a missing order', 'owner');
  const rowsById = new Map<string, V2OrderCapture>();
  const seenOwned = new Set<string>();
  for (const row of snapshot.orderRows) {
    const owner = row.data.userId;
    const match = row.key.match(/^order:(\d+)$/);
    if (match === null || owner === undefined) v2Refuse('order key has no safely attributable owner', 'owner');
    const id = match[1]!;
    v2NumberString(id, 'order oid');
    if (rowsById.has(id)) v2Refuse('order key inventory contains duplicate identities', 'identity');
    rowsById.set(id, row);
    if (owner === user) {
      seenOwned.add(id);
      if (!index.has(id)) v2Refuse('owned order is absent from user order index', 'membership');
    }
  }
  for (const id of index) if (!seenOwned.has(id)) v2Refuse('indexed order has a foreign owner', 'owner');
  for (const id of [...snapshot.openMembers, ...snapshot.triggerMembers]) {
    const oid = v2NumberString(id, 'active order oid');
    const row = rowsById.get(id);
    if (row === undefined || row.data.userId === undefined) v2Refuse('global active order has unknown owner', 'owner');
    if (row.data.oid !== id || row.data.status !== 'open') v2Refuse('global active order membership is stale', 'membership');
    if (openSet.has(id) && row.data.orderType !== 'limit') v2Refuse('trigger order is in the ordinary open set', 'membership');
    if (triggerSet.has(id) && row.data.orderType !== 'trigger') v2Refuse('ordinary order is in the trigger set', 'membership');
    if (row.key !== KEYS.ORDER(oid)) v2Refuse('active order identity is inconsistent', 'identity');
  }
}

function v2CheckPositionParity(snapshot: V2ReadSnapshot, user: string): void {
  const members = [...snapshot.positionMembers].sort();
  if (new Set(members).size !== members.length) v2Refuse('user position index contains duplicate identities', 'identity');
  const expectedKeys = members.map((asset) => KEYS.USER_POS(user, v2NumberString(asset, 'position asset'))).sort();
  if (canonicalJson(expectedKeys) !== canonicalJson(snapshot.positionKeys)) v2Refuse('position index and key inventory disagree', 'membership');
  for (const row of snapshot.positionRows) if (row.data.userId !== user) v2Refuse('position hash has a foreign owner', 'owner');
}

function v2RawBytes(snapshot: V2ReadSnapshot): number {
  const values: string[] = [
    ...snapshot.fills,
    ...snapshot.fundingRaws.filter((raw): raw is string => raw !== null),
    ...snapshot.correctionRaws.filter((raw): raw is string => raw !== null),
    snapshot.replayRaw ?? '',
    ...snapshot.orderRows.flatMap((row) => Object.entries(row.data).flat()),
    ...snapshot.positionRows.flatMap((row) => Object.entries(row.data).flat()),
  ];
  return values.reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0);
}

export function cashLedgerEvidenceV2DefaultIdentity(): CashLedgerEvidenceV2ProviderIdentity {
  return defaultV2ProviderIdentity();
}

export function getCashLedgerEvidenceV2MaxBytes(): number {
  return config.CASH_LEDGER_EVIDENCE_V2_MAX_BYTES ?? 0;
}

export async function getCashLedgerEvidenceV2(
  value: unknown,
  overrides: CashLedgerEvidenceV2Dependencies = {},
): Promise<CashLedgerEvidenceV2Receipt> {
  const d = {
    redis: overrides.redis ?? (redis as unknown as CashLedgerEvidenceRedis),
    historicalReplay: overrides.historicalReplay ?? getHistoricalReplay,
    clearinghouseState: overrides.clearinghouseState ?? getClearinghouseState,
    openOrders: overrides.openOrders ?? getOpenOrders,
    now: overrides.now ?? Date.now,
    providerIdentity: overrides.providerIdentity ?? defaultV2ProviderIdentity(),
    maxBytes: overrides.maxBytes ?? config.CASH_LEDGER_EVIDENCE_V2_MAX_BYTES ?? 0,
  };
  const request = validateV2Request(value, d.providerIdentity);
  if (!Number.isSafeInteger(d.maxBytes) || d.maxBytes <= 0) v2Refuse('V2 byte cap is unavailable', 'provenance');
  const user = request.user.toLowerCase();
  const first = await captureV2(user, d, d.providerIdentity.max_evidence_rows);
  if (first.replayId === null || first.replayRaw === null || first.replay === null) v2Refuse('immutable replay evidence is missing', 'missing_source');
  if (first.replayId !== request.expectedReplayBatchId) v2Refuse('replay batch identity does not match request', 'identity');
  const replaySource = v2NormalizeReplay(user, first.replayRaw, first.replay);
  if (replaySource.batchId !== request.expectedReplayBatchId) v2Refuse('replay batch identity is invalid', 'identity');
  v2ValidateReplaySource(replaySource, new Set(request.coins));

  const accountSource = v2NormalizeAccount(first.account, user, request.expectedReplayBatchId);
  const requested = new Set(request.coins);
  v2CheckPositionParity(first, user);
  const openSet = new Set(first.openMembers);
  const triggerSet = new Set(first.triggerMembers);
  v2CheckOrderOwnership(first, user, first.orderIds);
  const positions = first.positionRows
    .map((row) => v2NormalizePosition(row.asset, row.data, user, requested))
    .sort((left, right) => left.asset - right.asset);
  const orderRowsById = new Map(first.orderRows.map((row) => [row.key.slice('order:'.length), row.data]));
  const orders = first.orderIds
    .map((id) => v2NormalizeOrder(id, orderRowsById.get(id) ?? {}, user, requested, openSet, triggerSet))
    .sort((left, right) => left.oid - right.oid);
  v2CheckStateAndFlatness(first, accountSource, requested, positions, orders);

  const fills = first.fills.map((raw, ordinal) => v2NormalizeFill(user, raw, ordinal));
  const tids = new Set<number>();
  const fillPositions = new Map<string, V2PositionState>();
  for (const position of replaySource.positions) {
    if (fillPositions.has(position.coin)) v2Refuse('replay final position identity is ambiguous', 'identity');
    fillPositions.set(position.coin, { quantity: position.szi, entryPx: position.entryPx });
  }
  const fillQuantities = new Map<string, string>(
    [...fillPositions.entries()].map(([coin, state]) => [coin, state.quantity]),
  );
  let ordinaryRealized = '0';
  let ordinaryFees = '0';
  let ordinaryCash = replaySource.finalBalance;
  for (const fill of [...fills].reverse()) {
    if (!requested.has(fill.coin) || tids.has(fill.tid)) v2Refuse('ordinary fill identity or coin is invalid', 'identity');
    tids.add(fill.tid);
    const current = fillPositions.get(fill.coin);
    const before = current?.quantity ?? '0';
    if (!v2Equal(before, fill.startPosition)) v2Refuse('ordinary fill position transition is invalid', 'arithmetic');
    const transition = v2FillTransition(current, fill.side, fill.sz, fill.px, fill.closedPnl, undefined);
    fillPositions.set(fill.coin, transition.state);
    fillQuantities.set(fill.coin, transition.endPosition);
    ordinaryRealized = v2Add(ordinaryRealized, transition.closedPnl).toFixed();
    ordinaryFees = v2Add(ordinaryFees, fill.fee).toFixed();
    ordinaryCash = v2Add(ordinaryCash, fill.closedPnl, v2Subtract('0', fill.fee).toFixed()).toFixed();
  }
  for (const coin of request.coins) if (!v2Equal(fillQuantities.get(coin) ?? '0', '0')) v2Refuse('ordinary fill quantity residual is nonzero', 'flatness');
  for (const [coin, quantity] of fillQuantities) if (!requested.has(coin) || !v2Equal(quantity, '0')) v2Refuse('ordinary fill quantity residual is nonzero', 'flatness');

  const fundingIds = first.fundingIds;
  const correctionIds = first.correctionIds;
  if (new Set(fundingIds).size !== fundingIds.length || new Set(correctionIds).size !== correctionIds.length) v2Refuse('funding source index has duplicate identities', 'identity');
  if (canonicalJson(fundingIds.map((id) => KEYS.PNL_FUNDING_EVENT(user, id)).sort()) !== canonicalJson(first.fundingKeys)) v2Refuse('funding index and key inventory disagree', 'membership');
  if (canonicalJson(correctionIds.map((id) => KEYS.PNL_FUNDING_CORRECTION(user, id)).sort()) !== canonicalJson(first.correctionKeys)) v2Refuse('correction index and key inventory disagree', 'membership');
  const fundingEvents = fundingIds.map((id, ordinal) => {
    const raw = first.fundingRaws[ordinal];
    if (raw === null) v2Refuse('funding source is missing', 'missing_source');
    return v2NormalizeFundingEvent(raw, id, ordinal);
  });
  const corrections = correctionIds.map((id, ordinal) => {
    const raw = first.correctionRaws[ordinal];
    if (raw === null) v2Refuse('funding correction source is missing', 'missing_source');
    return v2NormalizeCorrection(raw, id, ordinal);
  });
  v2CheckCoverage(fundingEvents, corrections, request, d.providerIdentity);
  const originalRawById = new Map(fundingEvents.map((event, index) => [event.event_id, first.fundingRaws[index]!]))
  for (const correction of corrections) {
    const original = fundingEvents.find((event) => event.event_id === correction.original_event_id);
    const originalRaw = originalRawById.get(correction.original_event_id);
    if (original === undefined || originalRaw === undefined) v2Refuse('funding correction original is missing', 'source_preimage');
    v2CheckRawCorrection(correction, originalRaw, original);
  }
  let effectiveFunding = '0';
  for (const event of fundingEvents) effectiveFunding = v2Add(effectiveFunding, event.funding_charge).toFixed();
  for (const correction of corrections) effectiveFunding = v2Add(effectiveFunding, correction.funding_charge_delta).toFixed();

  let replayRealized = '0';
  let replayFees = '0';
  for (const event of replaySource.events) {
    if (!requested.has(event.coin)) v2Refuse('replay contains an out-of-scope coin', 'identity');
    replayRealized = v2Add(replayRealized, event.closedPnl).toFixed();
    replayFees = v2Add(replayFees, event.fee).toFixed();
  }
  if (!v2Equal(replaySource.finalBalance, v2Add(replaySource.startingBalance, replayRealized, v2Subtract('0', replayFees).toFixed()).toFixed())) v2Refuse('replay balance does not reconcile', 'arithmetic');
  if (!v2Equal(ordinaryCash, v2Add(replaySource.finalBalance, ordinaryRealized, v2Subtract('0', ordinaryFees).toFixed()).toFixed())) v2Refuse('ordinary cash transitions do not reconcile', 'arithmetic');
  const expected = v2Add(replaySource.startingBalance, replayRealized, v2Subtract('0', replayFees).toFixed(), ordinaryRealized, v2Subtract('0', ordinaryFees).toFixed(), v2Subtract('0', effectiveFunding).toFixed()).toFixed();
  const residual = v2Subtract(accountSource.balance, expected);
  if (!residual.isZero()) v2Refuse('settled-USDC source inventory does not reconcile', 'source_preimage');

  const now = d.now();
  if (!Number.isSafeInteger(now) || now < d.providerIdentity.correction_finality_ms) v2Refuse('finality watermark is unavailable', 'finality');
  const watermark = now - d.providerIdentity.correction_finality_ms;
  if (request.coverageEndMs > watermark) v2Refuse('evidence is provisional or incomplete', 'finality');
  const latest = Math.floor(Math.min(request.coverageEndMs, watermark) / d.providerIdentity.funding_interval_ms) * d.providerIdentity.funding_interval_ms;

  const collections = {
    replay: v2Collection('REPLAY', [{ ordinal: 0, identity: replaySource.batchId, source: replaySource }]),
    ordinary_fills: v2Collection('FILL', fills.map((source, ordinal) => ({ ordinal, identity: String(source.tid), source }))),
    funding_records: v2Collection('FUNDING', first.fundingRaws.map((raw, ordinal) => {
      if (raw === null) v2Refuse('funding source is missing', 'missing_source');
      return { ordinal, identity: fundingEvents[ordinal]!.event_id, source: { raw_json: raw } };
    })),
    correction_records: v2Collection('CORRECTION', first.correctionRaws.map((raw, ordinal) => {
      if (raw === null) v2Refuse('funding correction source is missing', 'missing_source');
      return { ordinal, identity: corrections[ordinal]!.correction_id, source: { raw_json: raw } };
    })),
    account: v2Collection('ACCOUNT', [{ ordinal: 0, identity: accountSource.wallet_fingerprint, source: accountSource }]),
    positions: v2Collection('POSITION', positions.map((source, ordinal) => ({ ordinal, identity: String(source.asset), source }))),
    orders: v2Collection('ORDER', orders.map((source, ordinal) => ({ ordinal, identity: String(source.oid), source }))),
  };
  const collectionNames = ['replay', 'ordinary_fills', 'funding_records', 'correction_records', 'account', 'positions', 'orders'] as const;
  const topCore = { count: collectionNames.length, identities: [...collectionNames], source_digests: collectionNames.map((name) => collections[name].manifest.manifest_digest) };
  const topManifest = { ...topCore, manifest_digest: cashLedgerEvidenceV2SourceManifestDigest(topCore) };
  const inventoryBase = { schema_version: 'HYPAPER_CASH_SOURCE_INVENTORY_V2' as const, ...collections, manifest: topManifest };
  const inventory = { ...inventoryBase, inventory_digest: cashLedgerEvidenceV2InventoryDigest(inventoryBase) };
  const stableState = {
    wallet_fingerprint: accountSource.wallet_fingerprint,
    currency: accountSource.currency,
    balance: accountSource.balance,
    positions: positions,
    orders: orders,
  };
  const eventManifestCore = { count: fundingEvents.length, member_sha256s: fundingEvents.map((event) => event.member_sha256) };
  const correctionManifestCore = { count: corrections.length, member_sha256s: corrections.map((correction) => correction.member_sha256) };
  const base = {
    schema_version: CASH_LEDGER_EVIDENCE_V2_SCHEMA,
    provider_identity: d.providerIdentity,
    subject: {
      wallet_fingerprint: accountSource.wallet_fingerprint,
      dex: request.dex,
      coins: request.coins,
      scope: request.scope,
      replay_batch_id: request.expectedReplayBatchId,
    },
    coverage: {
      start_ms: request.coverageStartMs,
      end_ms: request.coverageEndMs,
      observed_at_ms: now,
      funding_interval_ms: d.providerIdentity.funding_interval_ms,
      latest_fully_covered_funding_time_ms: latest,
      correction_finality_watermark_ms: watermark,
      finality_status: 'final' as const,
      terminal: true as const,
      page_count: 1 as const,
    },
    funding_events: fundingEvents,
    funding_corrections: corrections,
    event_manifest: { ...eventManifestCore, manifest_digest: cashLedgerEvidenceV2ReceiptManifestDigest(eventManifestCore) },
    correction_manifest: { ...correctionManifestCore, manifest_digest: cashLedgerEvidenceV2ReceiptManifestDigest(correctionManifestCore) },
    settled_usdc: {
      currency: 'USDC' as const,
      starting_balance: replaySource.startingBalance,
      replay_final_balance: replaySource.finalBalance,
      current_balance: accountSource.balance,
      replay_realized_pnl: replayRealized,
      ordinary_realized_pnl: ordinaryRealized,
      replay_fees: replayFees,
      ordinary_fees: ordinaryFees,
      effective_funding_charge: effectiveFunding,
      unrelated_cash_movement: '0' as const,
      expected_current_balance: expected,
      residual: '0' as const,
      evidence_sha256: inventory.inventory_digest,
    },
    flatness: {
      all_positions_zero: true as const,
      relevant_open_order_count: 0 as const,
      current_unrealized_pnl: '0' as const,
      clearinghouse_state_sha256: cashLedgerEvidenceV2StableStateDigest(stableState),
      open_order_inventory_sha256: collections.orders.manifest.manifest_digest,
    },
    source_inventory: inventory,
  };
  const receipt = cashLedgerEvidenceV2ReceiptSchema.parse({
    ...base,
    receipt_digest: domainDigest(CASH_LEDGER_EVIDENCE_V2_SCHEMA, base),
  });
  const rawBytes = v2RawBytes(first);
  if (rawBytes > d.maxBytes) v2Refuse('source inventory exceeds byte cap', 'byte_cap');
  let encoded: Uint8Array;
  try {
    encoded = encodeCashLedgerEvidenceV2Receipt(receipt);
  } catch {
    v2Refuse('V2 receipt is not internally reconstructible', 'arithmetic');
  }
  if (encoded.byteLength > d.maxBytes) v2Refuse('receipt exceeds byte cap', 'byte_cap');
  const second = await captureV2(user, d, d.providerIdentity.max_evidence_rows);
  if (v2StableReadValue(first) !== v2StableReadValue(second)) v2Refuse('mutable evidence changed during derivation', 'stable_read');
  return receipt;
}

export function buildCashLedgerEvidenceV2Error(error: CashLedgerEvidenceError): CashLedgerEvidenceV2WireError {
  const codes: readonly CashLedgerEvidenceV2ErrorCode[] = [
    'invalid_request', 'disabled', 'missing_source', 'provisional_incomplete', 'row_cap', 'byte_cap',
    'identity', 'owner', 'membership', 'arithmetic', 'flatness', 'stable_read', 'source_preimage',
    'chronology', 'finality', 'gap', 'provenance', 'internal',
  ];
  const code = codes.includes(error.code as CashLedgerEvidenceV2ErrorCode)
    ? error.code as CashLedgerEvidenceV2ErrorCode
    : 'internal';
  return {
    schema_version: CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA,
    status: code === 'disabled' ? 'disabled' : error.status === 500 ? 'error' : 'refused',
    error_code: code,
  };
}

export {
  cashLedgerEvidenceV2SourceDigest,
  cashLedgerEvidenceV2SourceManifestDigest,
  cashLedgerEvidenceV2InventoryDigest,
  cashLedgerEvidenceV2StableStateDigest,
  cashLedgerEvidenceV2ReceiptDigest,
  cashLedgerEvidenceV2EventMemberDigest,
  cashLedgerEvidenceV2CorrectionMemberDigest,
  cashLedgerEvidenceV2ReceiptManifestDigest,
};
