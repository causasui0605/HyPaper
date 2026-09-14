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
  type CashLedgerEvidenceRequest,
  type CashLedgerEvidenceReceipt,
  type CashLedgerEvidenceError as WireError,
  type CashLedgerFundingCorrection,
  type CashLedgerFundingEvent,
  domainDigest,
  walletFingerprint,
} from '../types/cash-ledger-evidence.js';
import { historicalReplayResultSchema } from '../types/historical-replay.js';
import { pnlFundingCorrectionId, pnlFundingEventId } from '../worker/funding-worker.js';
import { pnlFundingCorrectionSchema, pnlFundingEventSchema, type PnlFundingEvent } from '../types/pnl.js';

const Decimal = DecimalModule.default ?? DecimalModule;
type DecimalValue = InstanceType<typeof Decimal>;

export type CashLedgerEvidenceErrorCode = WireError['error_code'];

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
