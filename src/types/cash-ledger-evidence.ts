import { createHash } from 'node:crypto';
import { z } from 'zod';

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
