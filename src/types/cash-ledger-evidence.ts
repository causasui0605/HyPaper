import { createHash } from 'node:crypto';
import { z } from 'zod';
import { historicalReplayResultSchema } from './historical-replay.js';
import { pnlFundingCorrectionSchema, pnlFundingEventSchema } from './pnl.js';

export const CASH_LEDGER_EVIDENCE_SCHEMA = 'HYPAPER_CASH_LEDGER_EVIDENCE_V1' as const;
export const CASH_LEDGER_EVIDENCE_ERROR_SCHEMA = 'HYPAPER_CASH_LEDGER_EVIDENCE_ERROR_V1' as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const asciiText = z.string().min(1).regex(/^[\x21-\x7e]+$/);
const decimalSchema = z.string().regex(
  /^(?:0|-?(?:[1-9][0-9]*(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9]))$/,
  'must be a canonical decimal string',
);
const positiveDecimalSchema = decimalSchema.refine((value) => value !== '0' && !value.startsWith('-'));
const safeIntegerSchema = z.number().int().nonnegative().safe();

export const cashLedgerEvidenceRequestSchema = z.object({
  type: z.literal('getCashLedgerEvidence'),
  user: asciiText,
  dex: asciiText,
  coins: z.array(asciiText).min(1).refine(
    (coins) => new Set(coins).size === coins.length,
    'coins must be unique',
  ).refine(
    (coins) => coins.every((coin, index) => index === 0 || coins[index - 1] < coin),
    'coins must be ASCII-sorted',
  ),
  coverageStartMs: safeIntegerSchema,
  coverageEndMs: safeIntegerSchema,
  finalFlatRequired: z.literal(true),
}).strict();

export type CashLedgerEvidenceRequest = z.infer<typeof cashLedgerEvidenceRequestSchema>;

const providerIdentitySchema = z.object({
  source_revision: z.string().regex(/^[0-9a-f]{40}$/),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  compose_config_digest: sha256Schema,
  api_schema_version: z.literal(CASH_LEDGER_EVIDENCE_SCHEMA),
  funding_interval_ms: z.number().int().positive().safe(),
  correction_finality_ms: z.number().int().positive().safe(),
  max_evidence_rows: z.number().int().positive().safe(),
}).strict();

const subjectSchema = z.object({
  wallet_fingerprint: sha256Schema,
  dex: asciiText,
  coins: z.array(asciiText).min(1).refine(
    (coins) => new Set(coins).size === coins.length
      && coins.every((coin, index) => index === 0 || coins[index - 1] < coin),
    'coins must be unique and ASCII-sorted',
  ),
}).strict();

const coverageSchema = z.object({
  start_ms: safeIntegerSchema,
  end_ms: safeIntegerSchema,
  observed_at_ms: safeIntegerSchema,
  funding_interval_ms: z.number().int().positive().safe(),
  latest_fully_covered_funding_time_ms: safeIntegerSchema,
  correction_finality_watermark_ms: safeIntegerSchema,
  finality_status: z.enum(['final', 'provisional']),
  terminal: z.literal(true),
  page_count: z.literal(1),
}).strict();

const fundingSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('live_market_context') }).strict(),
  z.object({
    kind: z.literal('live_boundary_snapshot'),
    funding_history_time_ms: safeIntegerSchema,
    context_observed_at_ms: safeIntegerSchema,
  }).strict(),
  z.object({
    kind: z.literal('verified_backfill'),
    oracle_source_sha256: sha256Schema,
    funding_source_sha256: sha256Schema,
  }).strict(),
]);

const fundingEventSchema = z.object({
  ordinal: safeIntegerSchema,
  schema: z.string().min(1),
  event_id: z.string().regex(/^hpfe[0-9a-f]{64}$/),
  asset: safeIntegerSchema,
  coin: asciiText,
  funding_time_ms: safeIntegerSchema,
  applied_at_ms: safeIntegerSchema,
  szi: decimalSchema,
  oracle_px: positiveDecimalSchema,
  funding_rate: decimalSchema,
  funding_charge: decimalSchema,
  source: fundingSourceSchema,
  account_balance_before: decimalSchema,
  account_balance_after: decimalSchema,
  cum_funding_before: decimalSchema,
  cum_funding_after: decimalSchema,
  cum_funding_since_open_before: decimalSchema,
  cum_funding_since_open_after: decimalSchema,
  cum_funding_since_change_before: decimalSchema,
  cum_funding_since_change_after: decimalSchema,
  source_record_sha256: sha256Schema,
  member_sha256: sha256Schema,
}).strict();

const correctionSourceSchema = z.object({
  kind: z.literal('verified_correction'),
  original_event_sha256: sha256Schema,
  oracle_source_sha256: sha256Schema,
  funding_source_sha256: sha256Schema,
}).strict();

const fundingCorrectionSchema = z.object({
  ordinal: safeIntegerSchema,
  schema: z.string().min(1),
  correction_id: z.string().regex(/^hpfc[0-9a-f]{64}$/),
  original_event_id: z.string().regex(/^hpfe[0-9a-f]{64}$/),
  asset: safeIntegerSchema,
  coin: asciiText,
  funding_time_ms: safeIntegerSchema,
  applied_at_ms: safeIntegerSchema,
  szi: decimalSchema,
  original_funding_charge: decimalSchema,
  corrected_oracle_px: positiveDecimalSchema,
  corrected_funding_rate: decimalSchema,
  corrected_funding_charge: decimalSchema,
  funding_charge_delta: decimalSchema,
  source: correctionSourceSchema,
  account_balance_before: decimalSchema,
  account_balance_after: decimalSchema,
  cum_funding_before: decimalSchema,
  cum_funding_after: decimalSchema,
  cum_funding_since_open_before: decimalSchema,
  cum_funding_since_open_after: decimalSchema,
  cum_funding_since_change_before: decimalSchema,
  cum_funding_since_change_after: decimalSchema,
  source_record_sha256: sha256Schema,
  member_sha256: sha256Schema,
}).strict();

const manifestSchema = z.object({
  count: safeIntegerSchema,
  member_sha256s: z.array(sha256Schema),
  manifest_digest: sha256Schema,
}).strict();

const settledUsdcSchema = z.object({
  currency: z.literal('USDC'),
  starting_balance: decimalSchema,
  replay_final_balance: decimalSchema,
  current_balance: decimalSchema,
  replay_realized_pnl: decimalSchema,
  ordinary_realized_pnl: decimalSchema,
  replay_fees: decimalSchema,
  ordinary_fees: decimalSchema,
  effective_funding_charge: decimalSchema,
  unrelated_cash_movement: z.literal('0'),
  expected_current_balance: decimalSchema,
  residual: z.literal('0'),
  evidence_sha256: sha256Schema,
}).strict();

const flatnessSchema = z.object({
  all_positions_zero: z.literal(true),
  relevant_open_order_count: z.literal(0),
  current_unrealized_pnl: z.literal('0'),
  clearinghouse_state_sha256: sha256Schema,
  open_order_inventory_sha256: sha256Schema,
}).strict();

export const cashLedgerEvidenceReceiptSchema = z.object({
  schema_version: z.literal(CASH_LEDGER_EVIDENCE_SCHEMA),
  provider_identity: providerIdentitySchema,
  subject: subjectSchema,
  coverage: coverageSchema,
  funding_events: z.array(fundingEventSchema),
  funding_corrections: z.array(fundingCorrectionSchema),
  event_manifest: manifestSchema,
  correction_manifest: manifestSchema,
  settled_usdc: settledUsdcSchema,
  flatness: flatnessSchema,
  receipt_digest: sha256Schema,
}).strict();

export type CashLedgerEvidenceReceipt = z.infer<typeof cashLedgerEvidenceReceiptSchema>;
export type CashLedgerFundingEvent = z.infer<typeof fundingEventSchema>;
export type CashLedgerFundingCorrection = z.infer<typeof fundingCorrectionSchema>;

function eventMemberDigest(event: Omit<CashLedgerFundingEvent, 'member_sha256'>): string {
  return domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_EVENT_MEMBER_V1', event);
}

function correctionMemberDigest(correction: Omit<CashLedgerFundingCorrection, 'member_sha256'>): string {
  return domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_CORRECTION_MEMBER_V1', correction);
}

function validateReceiptSemantics(receipt: CashLedgerEvidenceReceipt): void {
  if (receipt.event_manifest.count !== receipt.funding_events.length
    || receipt.correction_manifest.count !== receipt.funding_corrections.length) {
    throw new Error('receipt manifest count does not match its rows');
  }
  const eventMembers = receipt.funding_events.map(({ member_sha256: _member, ...event }) => eventMemberDigest(event));
  const correctionMembers = receipt.funding_corrections.map(({ member_sha256: _member, ...correction }) => correctionMemberDigest(correction));
  if (eventMembers.some((member, index) => member !== receipt.funding_events[index]?.member_sha256)
    || correctionMembers.some((member, index) => member !== receipt.funding_corrections[index]?.member_sha256)
    || canonicalJson(receipt.event_manifest.member_sha256s) !== canonicalJson(eventMembers)
    || canonicalJson(receipt.correction_manifest.member_sha256s) !== canonicalJson(correctionMembers)
    || receipt.event_manifest.manifest_digest !== domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_MANIFEST_V1', {
      count: receipt.event_manifest.count, member_sha256s: receipt.event_manifest.member_sha256s,
    })
    || receipt.correction_manifest.manifest_digest !== domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_MANIFEST_V1', {
      count: receipt.correction_manifest.count, member_sha256s: receipt.correction_manifest.member_sha256s,
    })) throw new Error('receipt member or manifest digest mismatch');
  if (receipt.funding_events.some((event, index) => event.ordinal !== index)
    || receipt.funding_corrections.some((correction, index) => correction.ordinal !== index)) {
    throw new Error('receipt row ordinals are not contiguous');
  }
}

export const cashLedgerEvidenceErrorSchema = z.object({
  schema_version: z.literal(CASH_LEDGER_EVIDENCE_ERROR_SCHEMA),
  status: z.enum(['disabled', 'refused', 'error']),
  error_code: z.enum([
    'invalid_request',
    'disabled',
    'missing_source',
    'provisional_incomplete',
    'row_cap',
    'identity',
    'arithmetic',
    'flatness',
    'stable_read',
    'internal',
  ]),
}).strict();

export type CashLedgerEvidenceError = z.infer<typeof cashLedgerEvidenceErrorSchema>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeWireValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, normalizeWireValue(child)]),
    );
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonical JSON only permits safe native integers');
    return value;
  }
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('canonical JSON contains an unsupported value');
  }
  return value;
}

/** Recursive ASCII-key-sorted, compact JSON with no trailing newline. */
export function canonicalJson(value: unknown): string {
  const normalized = normalizeWireValue(value);
  const encoded = JSON.stringify(normalized);
  if (encoded === undefined) throw new Error('canonical JSON encoding failed');
  return encoded;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function domainDigest(domain: string, value: unknown): string {
  if (!/^[\x00-\x7f]+$/.test(domain)) throw new Error('digest domain must be ASCII');
  return createHash('sha256')
    .update(`${domain}\n`, 'ascii')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

export function walletFingerprint(user: string): string {
  const normalized = user.toLowerCase();
  if (!/^[\x00-\x7f]+$/.test(normalized)) throw new Error('wallet identity must be ASCII');
  return createHash('sha256')
    .update('HYPAPER_WALLET_FINGERPRINT_V1\n', 'ascii')
    .update(normalized, 'ascii')
    .digest('hex');
}

class JsonReader {
  private offset = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.value();
    this.whitespace();
    if (this.offset !== this.source.length) throw new Error('trailing JSON bytes');
    return value;
  }

  private whitespace(): void {
    while (this.offset < this.source.length && /[\t\n\r ]/.test(this.source[this.offset]!)) this.offset += 1;
  }

  private value(): unknown {
    this.whitespace();
    const char = this.source[this.offset];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"') return this.string();
    if (this.source.startsWith('true', this.offset)) { this.offset += 4; return true; }
    if (this.source.startsWith('false', this.offset)) { this.offset += 5; return false; }
    if (this.source.startsWith('null', this.offset)) { this.offset += 4; return null; }
    return this.number();
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    let escaped = false;
    while (this.offset < this.source.length) {
      const char = this.source[this.offset]!;
      if (escaped) {
        escaped = false;
        this.offset += 1;
        continue;
      }
      if (char === '\\') { escaped = true; this.offset += 1; continue; }
      if (char === '"') {
        this.offset += 1;
        const raw = this.source.slice(start, this.offset);
        const decoded: unknown = JSON.parse(raw);
        if (typeof decoded !== 'string') throw new Error('invalid JSON string');
        return decoded;
      }
      if (char.charCodeAt(0) < 0x20) throw new Error('unescaped JSON control character');
      this.offset += 1;
    }
    throw new Error('unterminated JSON string');
  }

  private number(): number {
    const match = this.source.slice(this.offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) throw new Error('invalid JSON value');
    this.offset += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return value;
  }

  private object(): Record<string, unknown> {
    this.offset += 1;
    const result: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.whitespace();
    if (this.source[this.offset] === '}') { this.offset += 1; return result; }
    while (true) {
      this.whitespace();
      if (this.source[this.offset] !== '"') throw new Error('JSON object key is not a string');
      const key = this.string();
      if (keys.has(key)) throw new Error('duplicate JSON object key');
      keys.add(key);
      this.whitespace();
      if (this.source[this.offset] !== ':') throw new Error('missing JSON object colon');
      this.offset += 1;
      result[key] = this.value();
      this.whitespace();
      if (this.source[this.offset] === '}') { this.offset += 1; return result; }
      if (this.source[this.offset] !== ',') throw new Error('missing JSON object comma');
      this.offset += 1;
    }
  }

  private array(): unknown[] {
    this.offset += 1;
    const result: unknown[] = [];
    this.whitespace();
    if (this.source[this.offset] === ']') { this.offset += 1; return result; }
    while (true) {
      result.push(this.value());
      this.whitespace();
      if (this.source[this.offset] === ']') { this.offset += 1; return result; }
      if (this.source[this.offset] !== ',') throw new Error('missing JSON array comma');
      this.offset += 1;
    }
  }
}

export function decodeCanonicalJson(bytes: Uint8Array | string): unknown {
  const raw = typeof bytes === 'string'
    ? bytes
    : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) throw new Error('UTF-8 BOM is forbidden');
  return new JsonReader(raw).parse();
}

export function encodeCashLedgerEvidenceReceipt(receipt: CashLedgerEvidenceReceipt): Uint8Array {
  const parsed = cashLedgerEvidenceReceiptSchema.parse(receipt);
  validateReceiptSemantics(parsed);
  const { receipt_digest: _digest, ...withoutDigest } = parsed;
  const expected = domainDigest(CASH_LEDGER_EVIDENCE_SCHEMA, withoutDigest);
  if (parsed.receipt_digest !== expected) throw new Error('receipt_digest does not match canonical receipt bytes');
  return canonicalJsonBytes(parsed);
}

export function decodeCashLedgerEvidenceReceipt(bytes: Uint8Array | string): CashLedgerEvidenceReceipt {
  const raw = typeof bytes === 'string'
    ? bytes
    : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = cashLedgerEvidenceReceiptSchema.parse(decodeCanonicalJson(raw));
  validateReceiptSemantics(parsed);
  const { receipt_digest: _digest, ...withoutDigest } = parsed;
  if (domainDigest(CASH_LEDGER_EVIDENCE_SCHEMA, withoutDigest) !== parsed.receipt_digest) {
    throw new Error('receipt_digest does not match canonical receipt bytes');
  }
  if (canonicalJson(parsed) !== raw) throw new Error('receipt bytes are not canonical');
  return parsed;
}

export const requestSchema = cashLedgerEvidenceRequestSchema;
export const receiptSchema = cashLedgerEvidenceReceiptSchema;
export const errorSchema = cashLedgerEvidenceErrorSchema;

// V2 is deliberately a separate wire contract.  Keep every V1 export above
// unchanged: consumers must opt into this schema explicitly.
export const CASH_LEDGER_EVIDENCE_V2_SCHEMA = 'HYPAPER_CASH_LEDGER_EVIDENCE_V2' as const;
export const CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA = 'HYPAPER_CASH_LEDGER_EVIDENCE_ERROR_V2' as const;
// These aliases make the versioning explicit for callers that group schema
// constants by the object they describe.
export const CASH_LEDGER_EVIDENCE_V2_ERROR_SCHEMA = CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA;
export const CASH_LEDGER_SOURCE_INVENTORY_V2_SCHEMA = 'HYPAPER_CASH_SOURCE_INVENTORY_V2' as const;
export const CASH_LEDGER_SOURCE_MANIFEST_V2_DOMAIN = 'HYPAPER_CASH_SOURCE_MANIFEST_V2' as const;
export const CASH_LEDGER_V2_EVENT_MEMBER_DOMAIN = 'HYPAPER_CASH_LEDGER_EVIDENCE_EVENT_MEMBER_V2' as const;
export const CASH_LEDGER_V2_CORRECTION_MEMBER_DOMAIN = 'HYPAPER_CASH_LEDGER_EVIDENCE_CORRECTION_MEMBER_V2' as const;
export const CASH_LEDGER_V2_EVIDENCE_MANIFEST_DOMAIN = 'HYPAPER_CASH_LEDGER_EVIDENCE_MANIFEST_V2' as const;
export const CASH_LEDGER_V2_STABLE_STATE_DOMAIN = 'HYPAPER_CASH_STABLE_STATE_V2' as const;

const v2ScopeSchema = z.literal('whole_account_replay_epoch');
const v2CoinsSchema = z.array(asciiText).min(1).refine(
  (coins) => new Set(coins).size === coins.length
    && coins.every((coin, index) => index === 0 || coins[index - 1] < coin),
  'coins must be unique and ASCII-sorted',
);

export const cashLedgerEvidenceV2RequestSchema = z.object({
  type: z.literal('getCashLedgerEvidenceV2'),
  user: asciiText,
  dex: asciiText,
  coins: v2CoinsSchema,
  coverageStartMs: safeIntegerSchema,
  coverageEndMs: safeIntegerSchema,
  finalFlatRequired: z.literal(true),
  scope: v2ScopeSchema,
  expectedReplayBatchId: z.string().regex(/^hprb[0-9a-f]{64}$/),
}).strict();

export type CashLedgerEvidenceV2Request = z.infer<typeof cashLedgerEvidenceV2RequestSchema>;

const v2ProviderIdentitySchema = z.object({
  source_revision: z.string().regex(/^[0-9a-f]{40}$/),
  image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  compose_config_digest: sha256Schema,
  api_schema_version: z.literal(CASH_LEDGER_EVIDENCE_V2_SCHEMA),
  funding_interval_ms: z.number().int().positive().safe(),
  correction_finality_ms: z.number().int().positive().safe(),
  max_evidence_rows: z.number().int().positive().safe(),
}).strict();

export const cashLedgerEvidenceV2ProviderIdentitySchema = v2ProviderIdentitySchema;
export type CashLedgerEvidenceV2ProviderIdentity = z.infer<typeof v2ProviderIdentitySchema>;

const v2SubjectSchema = z.object({
  wallet_fingerprint: sha256Schema,
  dex: asciiText,
  coins: v2CoinsSchema,
  scope: v2ScopeSchema,
  replay_batch_id: z.string().regex(/^hprb[0-9a-f]{64}$/),
}).strict();

const v2CoverageSchema = z.object({
  start_ms: safeIntegerSchema,
  end_ms: safeIntegerSchema,
  observed_at_ms: safeIntegerSchema,
  funding_interval_ms: z.number().int().positive().safe(),
  latest_fully_covered_funding_time_ms: safeIntegerSchema,
  correction_finality_watermark_ms: safeIntegerSchema,
  finality_status: z.enum(['final', 'provisional']),
  terminal: z.literal(true),
  page_count: z.literal(1),
}).strict();

const v2FundingSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('live_market_context') }).strict(),
  z.object({
    kind: z.literal('live_boundary_snapshot'),
    funding_history_time_ms: safeIntegerSchema,
    context_observed_at_ms: safeIntegerSchema,
  }).strict(),
  z.object({
    kind: z.literal('verified_backfill'),
    oracle_source_sha256: sha256Schema,
    funding_source_sha256: sha256Schema,
  }).strict(),
]);

const v2FundingEventSchema = z.object({
  ordinal: safeIntegerSchema,
  schema: z.string().min(1),
  event_id: z.string().regex(/^hpfe[0-9a-f]{64}$/),
  asset: safeIntegerSchema,
  coin: asciiText,
  funding_time_ms: safeIntegerSchema,
  applied_at_ms: safeIntegerSchema,
  szi: decimalSchema,
  oracle_px: positiveDecimalSchema,
  funding_rate: decimalSchema,
  funding_charge: decimalSchema,
  source: v2FundingSourceSchema,
  account_balance_before: decimalSchema,
  account_balance_after: decimalSchema,
  cum_funding_before: decimalSchema,
  cum_funding_after: decimalSchema,
  cum_funding_since_open_before: decimalSchema,
  cum_funding_since_open_after: decimalSchema,
  cum_funding_since_change_before: decimalSchema,
  cum_funding_since_change_after: decimalSchema,
  source_record_sha256: sha256Schema,
  member_sha256: sha256Schema,
}).strict();

const v2CorrectionSourceSchema = z.object({
  kind: z.literal('verified_correction'),
  original_event_sha256: sha256Schema,
  oracle_source_sha256: sha256Schema,
  funding_source_sha256: sha256Schema,
}).strict();

const v2FundingCorrectionSchema = z.object({
  ordinal: safeIntegerSchema,
  schema: z.string().min(1),
  correction_id: z.string().regex(/^hpfc[0-9a-f]{64}$/),
  original_event_id: z.string().regex(/^hpfe[0-9a-f]{64}$/),
  asset: safeIntegerSchema,
  coin: asciiText,
  funding_time_ms: safeIntegerSchema,
  applied_at_ms: safeIntegerSchema,
  szi: decimalSchema,
  original_funding_charge: decimalSchema,
  corrected_oracle_px: positiveDecimalSchema,
  corrected_funding_rate: decimalSchema,
  corrected_funding_charge: decimalSchema,
  funding_charge_delta: decimalSchema,
  source: v2CorrectionSourceSchema,
  account_balance_before: decimalSchema,
  account_balance_after: decimalSchema,
  cum_funding_before: decimalSchema,
  cum_funding_after: decimalSchema,
  cum_funding_since_open_before: decimalSchema,
  cum_funding_since_open_after: decimalSchema,
  cum_funding_since_change_before: decimalSchema,
  cum_funding_since_change_after: decimalSchema,
  source_record_sha256: sha256Schema,
  member_sha256: sha256Schema,
}).strict();

export const cashLedgerEvidenceV2FundingEventSchema = v2FundingEventSchema;
export const cashLedgerEvidenceV2FundingCorrectionSchema = v2FundingCorrectionSchema;
export type CashLedgerEvidenceV2FundingEvent = z.infer<typeof v2FundingEventSchema>;
export type CashLedgerEvidenceV2FundingCorrection = z.infer<typeof v2FundingCorrectionSchema>;

const v2ReplayResultSchema = historicalReplayResultSchema
  .omit({ user: true })
  .extend({ wallet_fingerprint: sha256Schema })
  .strict();
export const cashLedgerEvidenceV2ReplayResultSchema = v2ReplayResultSchema;
export type CashLedgerEvidenceV2ReplayResult = z.infer<typeof v2ReplayResultSchema>;

const v2FillSchema = z.object({
  coin: asciiText,
  px: positiveDecimalSchema,
  sz: positiveDecimalSchema,
  side: z.enum(['B', 'A']),
  time: safeIntegerSchema,
  startPosition: decimalSchema,
  dir: z.string().min(1).regex(/^[\x20-\x7e]+$/),
  closedPnl: decimalSchema,
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  oid: safeIntegerSchema,
  crossed: z.boolean(),
  fee: decimalSchema,
  tid: safeIntegerSchema,
  cloid: z.string().min(1).regex(/^[\x20-\x7e]+$/).optional(),
  feeToken: z.literal('USDC'),
}).strict();
export const cashLedgerEvidenceV2FillSchema = v2FillSchema;
export type CashLedgerEvidenceV2Fill = z.infer<typeof v2FillSchema>;

const v2AccountSchema = z.object({
  wallet_fingerprint: sha256Schema,
  currency: z.literal('USDC'),
  balance: decimalSchema,
  created_at_ms: safeIntegerSchema,
  replay_batch_id: z.string().regex(/^hprb[0-9a-f]{64}$/),
}).strict();

const v2PositionSchema = z.object({
  asset: safeIntegerSchema,
  coin: asciiText,
  szi: decimalSchema,
  entry_px: positiveDecimalSchema,
}).strict();

const v2OrderSchema = z.object({
  oid: safeIntegerSchema,
  coin: asciiText,
  asset: safeIntegerSchema,
  side: z.enum(['BUY', 'SELL']),
  qty: positiveDecimalSchema,
  filled_qty: decimalSchema,
  average_fill_px: decimalSchema,
  limit_px: positiveDecimalSchema,
  order_type: z.enum(['limit', 'trigger']),
  time_in_force: z.enum(['Gtc', 'Ioc', 'Alo']),
  reduce_only: z.boolean(),
  grouping: z.enum(['na', 'normalTpsl', 'positionTpsl']),
  status: z.enum(['open', 'filled', 'cancelled', 'triggered', 'rejected']),
  created_at_ms: safeIntegerSchema,
  updated_at_ms: safeIntegerSchema,
  cl_ord_id: z.string().min(1).nullable(),
  trigger_px: positiveDecimalSchema.nullable(),
  tp_sl: z.enum(['tp', 'sl']).nullable(),
  is_market: z.boolean().nullable(),
  open_set_member: z.boolean(),
  trigger_set_member: z.boolean(),
}).strict();

export const cashLedgerEvidenceV2AccountSchema = v2AccountSchema;
export const cashLedgerEvidenceV2PositionSchema = v2PositionSchema;
export const cashLedgerEvidenceV2OrderSchema = v2OrderSchema;
export type CashLedgerEvidenceV2Account = z.infer<typeof v2AccountSchema>;
export type CashLedgerEvidenceV2Position = z.infer<typeof v2PositionSchema>;
export type CashLedgerEvidenceV2Order = z.infer<typeof v2OrderSchema>;

const v2RawFundingSchema = z.object({ raw_json: z.string().min(1) }).strict();
const v2RawCorrectionSchema = z.object({ raw_json: z.string().min(1) }).strict();
const v2SourceDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const v2SourceRowBaseSchema = z.object({
  ordinal: safeIntegerSchema,
  identity: asciiText,
  source_digest: v2SourceDigestSchema,
}).strict();

function v2SourceRowSchema<S extends z.ZodTypeAny>(source: S) {
  return v2SourceRowBaseSchema.extend({ source }).strict();
}

const v2SourceManifestSchema = z.object({
  count: safeIntegerSchema,
  identities: z.array(asciiText),
  source_digests: z.array(v2SourceDigestSchema),
  manifest_digest: v2SourceDigestSchema,
}).strict();

const v2SourceCollection = <S extends z.ZodTypeAny>(source: S) => z.object({
  rows: z.array(v2SourceRowSchema(source)),
  manifest: v2SourceManifestSchema,
}).strict();

const v2ReplayCollectionSchema = v2SourceCollection(v2ReplayResultSchema);
const v2FillCollectionSchema = v2SourceCollection(v2FillSchema);
const v2FundingCollectionSchema = v2SourceCollection(v2RawFundingSchema);
const v2CorrectionCollectionSchema = v2SourceCollection(v2RawCorrectionSchema);
const v2AccountCollectionSchema = v2SourceCollection(v2AccountSchema);
const v2PositionCollectionSchema = v2SourceCollection(v2PositionSchema);
const v2OrderCollectionSchema = v2SourceCollection(v2OrderSchema);

export const cashLedgerEvidenceV2SourceManifestSchema = v2SourceManifestSchema;
export const cashLedgerEvidenceV2ReplayCollectionSchema = v2ReplayCollectionSchema;
export const cashLedgerEvidenceV2FillCollectionSchema = v2FillCollectionSchema;
export const cashLedgerEvidenceV2FundingCollectionSchema = v2FundingCollectionSchema;
export const cashLedgerEvidenceV2CorrectionCollectionSchema = v2CorrectionCollectionSchema;
export const cashLedgerEvidenceV2AccountCollectionSchema = v2AccountCollectionSchema;
export const cashLedgerEvidenceV2PositionCollectionSchema = v2PositionCollectionSchema;
export const cashLedgerEvidenceV2OrderCollectionSchema = v2OrderCollectionSchema;

const v2SourceInventorySchema = z.object({
  schema_version: z.literal(CASH_LEDGER_SOURCE_INVENTORY_V2_SCHEMA),
  replay: v2ReplayCollectionSchema,
  ordinary_fills: v2FillCollectionSchema,
  funding_records: v2FundingCollectionSchema,
  correction_records: v2CorrectionCollectionSchema,
  account: v2AccountCollectionSchema,
  positions: v2PositionCollectionSchema,
  orders: v2OrderCollectionSchema,
  manifest: v2SourceManifestSchema,
  inventory_digest: v2SourceDigestSchema,
}).strict();

export const cashLedgerEvidenceV2SourceInventorySchema = v2SourceInventorySchema;
export type CashLedgerEvidenceV2SourceInventory = z.infer<typeof v2SourceInventorySchema>;

const v2SettledUsdcSchema = z.object({
  currency: z.literal('USDC'),
  starting_balance: decimalSchema,
  replay_final_balance: decimalSchema,
  current_balance: decimalSchema,
  replay_realized_pnl: decimalSchema,
  ordinary_realized_pnl: decimalSchema,
  replay_fees: decimalSchema,
  ordinary_fees: decimalSchema,
  effective_funding_charge: decimalSchema,
  unrelated_cash_movement: z.literal('0'),
  expected_current_balance: decimalSchema,
  residual: z.literal('0'),
  evidence_sha256: v2SourceDigestSchema,
}).strict();

const v2FlatnessSchema = z.object({
  all_positions_zero: z.literal(true),
  relevant_open_order_count: z.literal(0),
  current_unrealized_pnl: z.literal('0'),
  clearinghouse_state_sha256: v2SourceDigestSchema,
  open_order_inventory_sha256: v2SourceDigestSchema,
}).strict();

export const cashLedgerEvidenceV2ReceiptSchema = z.object({
  schema_version: z.literal(CASH_LEDGER_EVIDENCE_V2_SCHEMA),
  provider_identity: v2ProviderIdentitySchema,
  subject: v2SubjectSchema,
  coverage: v2CoverageSchema,
  funding_events: z.array(v2FundingEventSchema),
  funding_corrections: z.array(v2FundingCorrectionSchema),
  event_manifest: z.object({
    count: safeIntegerSchema,
    member_sha256s: z.array(sha256Schema),
    manifest_digest: sha256Schema,
  }).strict(),
  correction_manifest: z.object({
    count: safeIntegerSchema,
    member_sha256s: z.array(sha256Schema),
    manifest_digest: sha256Schema,
  }).strict(),
  settled_usdc: v2SettledUsdcSchema,
  flatness: v2FlatnessSchema,
  source_inventory: v2SourceInventorySchema,
  receipt_digest: sha256Schema,
}).strict();

export type CashLedgerEvidenceV2Receipt = z.infer<typeof cashLedgerEvidenceV2ReceiptSchema>;
export type CashLedgerEvidenceV2SettledUsdc = z.infer<typeof v2SettledUsdcSchema>;

export const cashLedgerEvidenceV2ErrorSchema = z.object({
  schema_version: z.literal(CASH_LEDGER_EVIDENCE_ERROR_V2_SCHEMA),
  status: z.enum(['disabled', 'refused', 'error']),
  error_code: z.enum([
    'invalid_request', 'disabled', 'missing_source', 'provisional_incomplete',
    'row_cap', 'byte_cap', 'identity', 'owner', 'membership', 'arithmetic',
    'flatness', 'stable_read', 'source_preimage', 'chronology', 'finality',
    'gap', 'provenance', 'internal',
  ]),
}).strict();

export type CashLedgerEvidenceV2Error = z.infer<typeof cashLedgerEvidenceV2ErrorSchema>;

/** Typed, redacted failure for a V2 receipt that cannot be reconstructed. */
export class CashLedgerEvidenceV2CodecError extends Error {
  constructor(
    message: string,
    readonly code: CashLedgerEvidenceV2Error['error_code'] = 'internal',
    readonly status: 400 | 409 | 500 = 409,
  ) {
    super(message);
    this.name = 'CashLedgerEvidenceV2CodecError';
  }
}

export function cashLedgerEvidenceV2SourceDigest(
  kind: 'REPLAY' | 'FILL' | 'FUNDING' | 'CORRECTION' | 'ACCOUNT' | 'POSITION' | 'ORDER',
  source: unknown,
): string {
  return domainDigest(`HYPAPER_CASH_SOURCE_${kind}_V2`, source);
}

export function cashLedgerEvidenceV2SourceManifestDigest(value: {
  count: number;
  identities: readonly string[];
  source_digests: readonly string[];
}): string {
  return domainDigest(CASH_LEDGER_SOURCE_MANIFEST_V2_DOMAIN, value);
}

export function cashLedgerEvidenceV2InventoryDigest(value: unknown): string {
  return domainDigest(CASH_LEDGER_SOURCE_INVENTORY_V2_SCHEMA, value);
}

export function cashLedgerEvidenceV2StableStateDigest(value: unknown): string {
  return domainDigest(CASH_LEDGER_V2_STABLE_STATE_DOMAIN, value);
}

export function cashLedgerEvidenceV2ReceiptDigest(value: unknown): string {
  return domainDigest(CASH_LEDGER_EVIDENCE_V2_SCHEMA, value);
}

export function cashLedgerEvidenceV2EventMemberDigest(
  event: Omit<CashLedgerEvidenceV2FundingEvent, 'member_sha256'>,
): string {
  return domainDigest(CASH_LEDGER_V2_EVENT_MEMBER_DOMAIN, event);
}

export function cashLedgerEvidenceV2CorrectionMemberDigest(
  correction: Omit<CashLedgerEvidenceV2FundingCorrection, 'member_sha256'>,
): string {
  return domainDigest(CASH_LEDGER_V2_CORRECTION_MEMBER_DOMAIN, correction);
}

export function cashLedgerEvidenceV2ReceiptManifestDigest(value: {
  count: number;
  member_sha256s: readonly string[];
}): string {
  return domainDigest(CASH_LEDGER_V2_EVIDENCE_MANIFEST_DOMAIN, value);
}

function v2RawSha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function v2ParsedRaw(raw: string, correction: boolean): unknown {
  let parsed: unknown;
  try {
    // The strict reader catches duplicate keys and unsafe native integers while
    // retaining the exact source text for the published raw_json field.
    parsed = decodeCanonicalJson(raw);
  } catch {
    throw new Error('funding source raw_json is malformed');
  }
  const schema = correction ? pnlFundingCorrectionSchema : pnlFundingEventSchema;
  if (!schema.safeParse(parsed).success) throw new Error('funding source raw_json does not match its closed schema');
  return parsed;
}

function v2WithoutDigest<T extends { receipt_digest: string }>(value: T): Omit<T, 'receipt_digest'> {
  const { receipt_digest: _digest, ...withoutDigest } = value;
  return withoutDigest;
}

function v2WithoutInventoryDigest(value: CashLedgerEvidenceV2SourceInventory): Omit<CashLedgerEvidenceV2SourceInventory, 'inventory_digest'> {
  const { inventory_digest: _digest, ...withoutDigest } = value;
  return withoutDigest;
}

function v2SourceCollectionCore(rows: readonly { identity: string; source_digest: string }[]) {
  return {
    count: rows.length,
    identities: rows.map((row) => row.identity),
    source_digests: rows.map((row) => row.source_digest),
  };
}

function v2ValidateCollection(
  kind: 'REPLAY' | 'FILL' | 'FUNDING' | 'CORRECTION' | 'ACCOUNT' | 'POSITION' | 'ORDER',
  collection: { rows: Array<{ ordinal: number; identity: string; source: unknown; source_digest: string }>; manifest: { count: number; identities: string[]; source_digests: string[]; manifest_digest: string } },
): void {
  if (collection.manifest.count !== collection.rows.length
    || collection.manifest.identities.length !== collection.rows.length
    || collection.manifest.source_digests.length !== collection.rows.length) {
    throw new Error('source collection manifest count does not match rows');
  }
  const rows = collection.rows;
  for (const [ordinal, row] of rows.entries()) {
    if (row.ordinal !== ordinal || row.identity.length === 0) throw new Error('source collection ordinals are not contiguous');
    if (row.source_digest !== cashLedgerEvidenceV2SourceDigest(kind, row.source)) throw new Error('source digest mismatch');
    if (collection.manifest.identities[ordinal] !== row.identity
      || collection.manifest.source_digests[ordinal] !== row.source_digest) throw new Error('source collection manifest mismatch');
  }
  const core = v2SourceCollectionCore(rows);
  if (collection.manifest.manifest_digest !== cashLedgerEvidenceV2SourceManifestDigest(core)) {
    throw new Error('source collection manifest digest mismatch');
  }
}

function v2ValidateSourceIdentity(inventory: CashLedgerEvidenceV2SourceInventory): void {
  const replay = inventory.replay.rows;
  const fills = inventory.ordinary_fills.rows;
  const funding = inventory.funding_records.rows;
  const corrections = inventory.correction_records.rows;
  const accounts = inventory.account.rows;
  const positions = inventory.positions.rows;
  const orders = inventory.orders.rows;
  if (replay.length !== 1 || replay[0]?.identity !== replay[0]?.source.batchId) throw new Error('replay source identity mismatch');
  if (fills.some((row) => row.identity !== String(row.source.tid))) throw new Error('fill source identity mismatch');
  if (funding.some((row) => {
    try { return row.identity !== String((v2ParsedRaw((row.source as { raw_json: string }).raw_json, false) as { eventId: string }).eventId); } catch { return true; }
  })) throw new Error('funding source identity mismatch');
  if (corrections.some((row) => {
    try { return row.identity !== String((v2ParsedRaw((row.source as { raw_json: string }).raw_json, true) as { correctionId: string }).correctionId); } catch { return true; }
  })) throw new Error('correction source identity mismatch');
  if (accounts.length !== 1 || accounts[0]?.identity !== accounts[0]?.source.wallet_fingerprint) throw new Error('account source identity mismatch');
  if (positions.some((row) => row.identity !== String(row.source.asset))) throw new Error('position source identity mismatch');
  if (orders.some((row) => row.identity !== String(row.source.oid))) throw new Error('order source identity mismatch');
}

function v2ValidateNormalizedRawLinks(receipt: CashLedgerEvidenceV2Receipt): void {
  const fundingRows = receipt.source_inventory.funding_records.rows;
  const correctionRows = receipt.source_inventory.correction_records.rows;
  if (fundingRows.length !== receipt.funding_events.length || correctionRows.length !== receipt.funding_corrections.length) {
    throw new Error('normalized funding rows do not match source rows');
  }
  for (const [ordinal, row] of fundingRows.entries()) {
    const raw = (row.source as { raw_json: string }).raw_json;
    const parsed = v2ParsedRaw(raw, false) as Record<string, unknown>;
    const event = receipt.funding_events[ordinal];
    if (event === undefined || event.ordinal !== ordinal || event.event_id !== parsed.eventId
      || event.source_record_sha256 !== v2RawSha256(raw)) throw new Error('funding normalized source mismatch');
    const source = parsed.source as Record<string, unknown>;
    const expected = {
      ordinal,
      schema: parsed.schema,
      event_id: parsed.eventId,
      asset: parsed.asset,
      coin: parsed.coin,
      funding_time_ms: parsed.fundingTime,
      applied_at_ms: parsed.appliedAt,
      szi: parsed.szi,
      oracle_px: parsed.oraclePx,
      funding_rate: parsed.fundingRate,
      funding_charge: parsed.fundingCharge,
      source: source.kind === 'live_market_context' ? { kind: 'live_market_context' } : source.kind === 'live_boundary_snapshot' ? {
        kind: 'live_boundary_snapshot',
        funding_history_time_ms: source.fundingHistoryTime,
        context_observed_at_ms: source.contextObservedAt,
      } : {
        kind: 'verified_backfill',
        oracle_source_sha256: source.oracleSourceSha256,
        funding_source_sha256: source.fundingSourceSha256,
      },
      account_balance_before: parsed.accountBalanceBefore,
      account_balance_after: parsed.accountBalanceAfter,
      cum_funding_before: parsed.cumFundingBefore,
      cum_funding_after: parsed.cumFundingAfter,
      cum_funding_since_open_before: parsed.cumFundingSinceOpenBefore,
      cum_funding_since_open_after: parsed.cumFundingSinceOpenAfter,
      cum_funding_since_change_before: parsed.cumFundingSinceChangeBefore,
      cum_funding_since_change_after: parsed.cumFundingSinceChangeAfter,
      source_record_sha256: v2RawSha256(raw),
    };
    const { member_sha256: _member, ...actual } = event;
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('funding normalized source fields drifted');
  }
  for (const [ordinal, row] of correctionRows.entries()) {
    const raw = (row.source as { raw_json: string }).raw_json;
    const parsed = v2ParsedRaw(raw, true) as Record<string, unknown>;
    const correction = receipt.funding_corrections[ordinal];
    if (correction === undefined || correction.ordinal !== ordinal || correction.correction_id !== parsed.correctionId
      || correction.source_record_sha256 !== v2RawSha256(raw)) throw new Error('correction normalized source mismatch');
    const source = parsed.source as Record<string, string>;
    const expected = {
      ordinal,
      schema: parsed.schema,
      correction_id: parsed.correctionId,
      original_event_id: parsed.originalEventId,
      asset: parsed.asset,
      coin: parsed.coin,
      funding_time_ms: parsed.fundingTime,
      applied_at_ms: parsed.appliedAt,
      szi: parsed.szi,
      original_funding_charge: parsed.originalFundingCharge,
      corrected_oracle_px: parsed.correctedOraclePx,
      corrected_funding_rate: parsed.correctedFundingRate,
      corrected_funding_charge: parsed.correctedFundingCharge,
      funding_charge_delta: parsed.fundingChargeDelta,
      source: {
        kind: 'verified_correction',
        original_event_sha256: source.originalEventSha256,
        oracle_source_sha256: source.oracleSourceSha256,
        funding_source_sha256: source.fundingSourceSha256,
      },
      account_balance_before: parsed.accountBalanceBefore,
      account_balance_after: parsed.accountBalanceAfter,
      cum_funding_before: parsed.cumFundingBefore,
      cum_funding_after: parsed.cumFundingAfter,
      cum_funding_since_open_before: parsed.cumFundingSinceOpenBefore,
      cum_funding_since_open_after: parsed.cumFundingSinceOpenAfter,
      cum_funding_since_change_before: parsed.cumFundingSinceChangeBefore,
      cum_funding_since_change_after: parsed.cumFundingSinceChangeAfter,
      source_record_sha256: v2RawSha256(raw),
    };
    const { member_sha256: _member, ...actual } = correction;
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error('correction normalized source fields drifted');
  }
}

function v2ValidateReceiptSemanticsUnchecked(receipt: CashLedgerEvidenceV2Receipt): void {
  const inventory = receipt.source_inventory;
  v2ValidateCollection('REPLAY', inventory.replay);
  v2ValidateCollection('FILL', inventory.ordinary_fills);
  v2ValidateCollection('FUNDING', inventory.funding_records);
  v2ValidateCollection('CORRECTION', inventory.correction_records);
  v2ValidateCollection('ACCOUNT', inventory.account);
  v2ValidateCollection('POSITION', inventory.positions);
  v2ValidateCollection('ORDER', inventory.orders);
  v2ValidateSourceIdentity(inventory);
  const collectionNames = ['replay', 'ordinary_fills', 'funding_records', 'correction_records', 'account', 'positions', 'orders'] as const;
  const topCore = {
    count: collectionNames.length,
    identities: [...collectionNames],
    source_digests: collectionNames.map((name) => inventory[name].manifest.manifest_digest),
  };
  if (inventory.manifest.count !== topCore.count
    || canonicalJson(inventory.manifest.identities) !== canonicalJson(topCore.identities)
    || canonicalJson(inventory.manifest.source_digests) !== canonicalJson(topCore.source_digests)
    || inventory.manifest.manifest_digest !== cashLedgerEvidenceV2SourceManifestDigest(topCore)) {
    throw new Error('source inventory top manifest mismatch');
  }
  if (inventory.inventory_digest !== cashLedgerEvidenceV2InventoryDigest(v2WithoutInventoryDigest(inventory))) {
    throw new Error('source inventory digest mismatch');
  }
  if (receipt.subject.replay_batch_id !== inventory.replay.rows[0]?.source.batchId) throw new Error('replay batch identity mismatch');
  if (inventory.replay.rows[0]?.source.wallet_fingerprint !== receipt.subject.wallet_fingerprint
    || inventory.account.rows[0]?.source.wallet_fingerprint !== receipt.subject.wallet_fingerprint
    || inventory.account.rows[0]?.source.replay_batch_id !== receipt.subject.replay_batch_id) {
    throw new Error('source subject identity mismatch');
  }
  if (inventory.positions.rows.length !== 0
    || inventory.positions.rows.some((row) => row.source.szi === '0')) throw new Error('final position inventory is not empty');
  if (inventory.orders.rows.some((row) => row.source.status === 'open'
    || row.source.open_set_member || row.source.trigger_set_member)) throw new Error('final order inventory is not flat');
  if (receipt.settled_usdc.evidence_sha256 !== inventory.inventory_digest) throw new Error('settled evidence digest mismatch');
  if (receipt.event_manifest.count !== receipt.funding_events.length
    || receipt.correction_manifest.count !== receipt.funding_corrections.length) throw new Error('receipt funding manifest count mismatch');
  const eventMembers = receipt.funding_events.map(({ member_sha256: _member, ...event }) => cashLedgerEvidenceV2EventMemberDigest(event));
  const correctionMembers = receipt.funding_corrections.map(({ member_sha256: _member, ...correction }) => cashLedgerEvidenceV2CorrectionMemberDigest(correction));
  if (canonicalJson(eventMembers) !== canonicalJson(receipt.event_manifest.member_sha256s)
    || canonicalJson(correctionMembers) !== canonicalJson(receipt.correction_manifest.member_sha256s)
    || receipt.event_manifest.manifest_digest !== cashLedgerEvidenceV2ReceiptManifestDigest({ count: eventMembers.length, member_sha256s: eventMembers })
    || receipt.correction_manifest.manifest_digest !== cashLedgerEvidenceV2ReceiptManifestDigest({ count: correctionMembers.length, member_sha256s: correctionMembers })) {
    throw new Error('receipt funding member or manifest digest mismatch');
  }
  if (receipt.funding_events.some((event, index) => event.ordinal !== index)
    || receipt.funding_corrections.some((correction, index) => correction.ordinal !== index)) throw new Error('receipt funding ordinals are not contiguous');
  const account = inventory.account.rows[0]?.source;
  if (account === undefined || receipt.settled_usdc.current_balance !== account.balance) throw new Error('account balance projection mismatch');
  const stableState = {
    wallet_fingerprint: account.wallet_fingerprint,
    currency: account.currency,
    balance: account.balance,
    positions: inventory.positions.rows.map((row) => row.source),
    orders: inventory.orders.rows.map((row) => row.source),
  };
  if (receipt.flatness.clearinghouse_state_sha256 !== cashLedgerEvidenceV2StableStateDigest(stableState)
    || receipt.flatness.open_order_inventory_sha256 !== inventory.orders.manifest.manifest_digest) throw new Error('flatness digest mismatch');
  v2ValidateNormalizedRawLinks(receipt);
}

function v2ValidateReceiptSemantics(receipt: CashLedgerEvidenceV2Receipt): void {
  try {
    v2ValidateReceiptSemanticsUnchecked(receipt);
  } catch (error) {
    if (error instanceof CashLedgerEvidenceV2CodecError || error instanceof z.ZodError) throw error;
    throw new CashLedgerEvidenceV2CodecError(
      error instanceof Error ? error.message : 'V2 receipt source validation failed',
      'source_preimage',
    );
  }
}

export function encodeCashLedgerEvidenceV2Request(request: CashLedgerEvidenceV2Request): Uint8Array {
  return canonicalJsonBytes(cashLedgerEvidenceV2RequestSchema.parse(request));
}

export function decodeCashLedgerEvidenceV2Request(bytes: Uint8Array | string): CashLedgerEvidenceV2Request {
  const raw = typeof bytes === 'string'
    ? bytes
    : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = cashLedgerEvidenceV2RequestSchema.parse(decodeCanonicalJson(raw));
  if (canonicalJson(parsed) !== raw) throw new Error('request bytes are not canonical');
  return parsed;
}

export function encodeCashLedgerEvidenceV2Receipt(receipt: CashLedgerEvidenceV2Receipt): Uint8Array {
  const parsed = cashLedgerEvidenceV2ReceiptSchema.parse(receipt);
  v2ValidateReceiptSemantics(parsed);
  if (parsed.receipt_digest !== domainDigest(CASH_LEDGER_EVIDENCE_V2_SCHEMA, v2WithoutDigest(parsed))) {
    throw new Error('V2 receipt_digest does not match canonical receipt bytes');
  }
  return canonicalJsonBytes(parsed);
}

export function decodeCashLedgerEvidenceV2Receipt(bytes: Uint8Array | string): CashLedgerEvidenceV2Receipt {
  const raw = typeof bytes === 'string'
    ? bytes
    : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = cashLedgerEvidenceV2ReceiptSchema.parse(decodeCanonicalJson(raw));
  v2ValidateReceiptSemantics(parsed);
  if (domainDigest(CASH_LEDGER_EVIDENCE_V2_SCHEMA, v2WithoutDigest(parsed)) !== parsed.receipt_digest) {
    throw new Error('V2 receipt_digest does not match canonical receipt bytes');
  }
  if (canonicalJson(parsed) !== raw) throw new Error('V2 receipt bytes are not canonical');
  return parsed;
}
