import { z } from 'zod';

export const HISTORICAL_REPLAY_SCHEMA = 'hypaper-historical-replay/v1' as const;
export const HISTORICAL_REPLAY_SOURCE_SCHEMA = 'hypaper-historical-replay-source/v1' as const;
export const HISTORICAL_REPLAY_EVIDENCE_SCHEMA = 'hypaper-historical-replay-price-evidence/v1' as const;
export const HISTORICAL_REPLAY_MODEL_SCHEMA = 'hypaper-historical-replay-model/v1' as const;
export const HISTORICAL_REPLAY_EVENT_SCHEMA = 'hypaper-historical-replay-event/v1' as const;
export const HISTORICAL_REPLAY_RISK_MARK_SCHEMA = 'hypaper-historical-replay-risk-mark/v1' as const;
export const HISTORICAL_REPLAY_ASSET_BINDING_SCHEMA = 'hypaper-historical-replay-asset-binding/v1' as const;
export const HISTORICAL_REPLAY_FILL_ASSUMPTION = 'l2-vwap-limit-clamp-mid-fallback/v1' as const;

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 digest');
const canonicalDecimalSchema = z.string().regex(
  /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/,
  'must be a canonical non-negative decimal string',
);
const positiveCanonicalDecimalSchema = canonicalDecimalSchema.refine(
  (value) => value !== '0',
  'must be positive',
);
const timestampSchema = z.number().int().nonnegative().safe();
const assetSchema = z.number().int().nonnegative().safe();

export const replaySourceSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_SOURCE_SCHEMA),
  name: z.string().min(1).max(128),
  generatedAt: timestampSchema,
}).strict();

export const replayLevelSchema = z.object({
  px: positiveCanonicalDecimalSchema,
  sz: positiveCanonicalDecimalSchema,
}).strict();

export const replayPriceEvidenceSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_EVIDENCE_SCHEMA),
  evidenceId: z.string().regex(/^hprp[0-9a-f]{64}$/),
  asset: assetSchema,
  coin: z.string().min(1).max(128),
  effectiveAt: timestampSchema,
  requestAt: timestampSchema,
  responseAt: timestampSchema,
  midPx: positiveCanonicalDecimalSchema,
  bids: z.array(replayLevelSchema).optional(),
  asks: z.array(replayLevelSchema).optional(),
  aggressiveLimitPx: positiveCanonicalDecimalSchema,
  side: z.enum(['B', 'A']),
  sz: positiveCanonicalDecimalSchema,
}).strict();

export const replayModelInputsSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_MODEL_SCHEMA),
  feeRate: canonicalDecimalSchema,
  startingBalance: canonicalDecimalSchema,
  feeToken: z.literal('USDC'),
  fillAssumption: z.literal(HISTORICAL_REPLAY_FILL_ASSUMPTION),
}).strict();

export const replayEventSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_EVENT_SCHEMA),
  eventId: z.string().regex(/^hpre[0-9a-f]{64}$/),
  phase: z.enum(['scheduled_entry', 'scheduled_reduction']),
  sequence: z.number().int().nonnegative().safe(),
  asset: assetSchema,
  coin: z.string().min(1).max(128),
  effectiveAt: timestampSchema,
  priceEvidenceId: z.string().regex(/^hprp[0-9a-f]{64}$/),
}).strict();

export const replayRiskMarkSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_RISK_MARK_SCHEMA),
  riskMarkId: z.string().regex(/^hprr[0-9a-f]{64}$/),
  asset: assetSchema,
  coin: z.string().min(1).max(128),
  requestAt: timestampSchema,
  responseAt: timestampSchema,
  markPx: positiveCanonicalDecimalSchema,
}).strict();

export const replayAssetBindingSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_ASSET_BINDING_SCHEMA),
  asset: assetSchema,
  coin: z.string().min(1).max(128),
  marginMode: z.enum(['cross', 'isolated']),
  selectedLeverage: positiveCanonicalDecimalSchema,
  isolatedTargetLeverage: positiveCanonicalDecimalSchema.optional(),
  riskMarkId: z.string().regex(/^hprr[0-9a-f]{64}$/),
}).strict();

export const historicalReplayPayloadSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_SCHEMA),
  source: replaySourceSchema,
  sourceDigest: digestSchema,
  priceEvidence: z.array(replayPriceEvidenceSchema).min(1),
  priceEvidenceDigest: digestSchema,
  modelInputs: replayModelInputsSchema,
  modelInputDigest: digestSchema,
  riskMarkEvidence: z.array(replayRiskMarkSchema).min(1),
  riskMarkEvidenceDigest: digestSchema,
  assetBindings: z.array(replayAssetBindingSchema).min(1),
  events: z.array(replayEventSchema).min(1),
  batchId: z.string().regex(/^hprb[0-9a-f]{64}$/),
}).strict();

export const importHistoricalReplayRequestSchema = z.object({
  type: z.literal('importHistoricalReplay'),
  user: z.string().min(1),
  replay: historicalReplayPayloadSchema,
}).strict();

export const getHistoricalReplayRequestSchema = z.object({
  type: z.literal('getHistoricalReplay'),
  user: z.string().min(1),
  batchId: z.string().regex(/^hprb[0-9a-f]{64}$/),
}).strict();

export type ReplaySource = z.infer<typeof replaySourceSchema>;
export type ReplayPriceEvidence = z.infer<typeof replayPriceEvidenceSchema>;
export type ReplayModelInputs = z.infer<typeof replayModelInputsSchema>;
export type ReplayEvent = z.infer<typeof replayEventSchema>;
export type ReplayRiskMark = z.infer<typeof replayRiskMarkSchema>;
export type ReplayAssetBinding = z.infer<typeof replayAssetBindingSchema>;
export type HistoricalReplayPayload = z.infer<typeof historicalReplayPayloadSchema>;
export type ImportHistoricalReplayRequest = z.infer<typeof importHistoricalReplayRequestSchema>;
export type GetHistoricalReplayRequest = z.infer<typeof getHistoricalReplayRequestSchema>;

export interface HistoricalReplayStoredEvent {
  schema: typeof HISTORICAL_REPLAY_EVENT_SCHEMA;
  kind: 'historical_replay_event';
  paper: true;
  synthetic: true;
  historicalReplay: true;
  historical_replay: true;
  batchId: string;
  eventId: string;
  syntheticFillId: string;
  evidenceId: string;
  sourceDigest: string;
  priceEvidenceDigest: string;
  modelInputDigest: string;
  riskMarkEvidenceDigest: string;
  phase: ReplayEvent['phase'];
  sequence: number;
  asset: number;
  coin: string;
  effectiveAt: number;
  recordedAt: number;
  replayedAt: number;
  side: 'B' | 'A';
  sz: string;
  px: string;
  priceSource: 'vwap' | 'fallback';
  aggressiveLimitPx: string;
  startPosition: string;
  endPosition: string;
  entryPx: string;
  closedPnl: string;
  fee: string;
  feeRate: string;
  feeToken: 'USDC';
  crossed: true;
}

export interface HistoricalReplayResult {
  type: 'historicalReplay';
  status: 'imported';
  paper: true;
  synthetic: true;
  historicalReplay: true;
  historical_replay: true;
  user: string;
  batchId: string;
  sourceDigest: string;
  priceEvidenceDigest: string;
  modelInputDigest: string;
  riskMarkEvidenceDigest: string;
  startingBalance: string;
  finalBalance: string;
  replayedAt: number;
  eventCount: number;
  eventIds: string[];
  replay: HistoricalReplayPayload;
  positions: Array<{
    asset: number;
    coin: string;
    szi: string;
    entryPx: string;
  }>;
  marginPosture: Array<{
    asset: number;
    coin: string;
    marginMode: 'cross' | 'isolated';
    selectedLeverage: string;
    isolatedTargetLeverage?: string;
    isolatedMargin?: string;
    riskMarkId: string;
    riskMarkPx: string;
    finalSzi: string;
    finalEntryPx: string;
    positionNotional: string;
    unrealizedPnl: string;
    marginRequired: string;
  }>;
  riskSummary: {
    cashBalance: string;
    unrealizedPnl: string;
    accountValue: string;
    totalMargin: string;
    marginAvailable: string;
  };
  events: HistoricalReplayStoredEvent[];
}

const signedCanonicalDecimalSchema = z.string().regex(
  /^(?:0|-?[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/,
  'must be a canonical signed decimal string',
);

export const historicalReplayStoredEventSchema = z.object({
  schema: z.literal(HISTORICAL_REPLAY_EVENT_SCHEMA),
  kind: z.literal('historical_replay_event'),
  paper: z.literal(true),
  synthetic: z.literal(true),
  historicalReplay: z.literal(true),
  historical_replay: z.literal(true),
  batchId: z.string().regex(/^hprb[0-9a-f]{64}$/),
  eventId: z.string().regex(/^hpre[0-9a-f]{64}$/),
  syntheticFillId: z.string().regex(/^hprf[0-9a-f]{64}$/),
  evidenceId: z.string().regex(/^hprp[0-9a-f]{64}$/),
  sourceDigest: digestSchema,
  priceEvidenceDigest: digestSchema,
  modelInputDigest: digestSchema,
  riskMarkEvidenceDigest: digestSchema,
  phase: z.enum(['scheduled_entry', 'scheduled_reduction']),
  sequence: z.number().int().nonnegative().safe(),
  asset: assetSchema,
  coin: z.string().min(1).max(128),
  effectiveAt: timestampSchema,
  recordedAt: timestampSchema,
  replayedAt: timestampSchema,
  side: z.enum(['B', 'A']),
  sz: positiveCanonicalDecimalSchema,
  px: positiveCanonicalDecimalSchema,
  priceSource: z.enum(['vwap', 'fallback']),
  aggressiveLimitPx: positiveCanonicalDecimalSchema,
  startPosition: signedCanonicalDecimalSchema,
  endPosition: signedCanonicalDecimalSchema,
  entryPx: canonicalDecimalSchema,
  closedPnl: signedCanonicalDecimalSchema,
  fee: canonicalDecimalSchema,
  feeRate: canonicalDecimalSchema,
  feeToken: z.literal('USDC'),
  crossed: z.literal(true),
}).strict();

const storedPositionSchema = z.object({
  asset: assetSchema,
  coin: z.string().min(1).max(128),
  szi: signedCanonicalDecimalSchema.refine((value) => value !== '0'),
  entryPx: positiveCanonicalDecimalSchema,
}).strict();

const storedMarginPostureSchema = z.object({
  asset: assetSchema,
  coin: z.string().min(1).max(128),
  marginMode: z.enum(['cross', 'isolated']),
  selectedLeverage: positiveCanonicalDecimalSchema,
  isolatedTargetLeverage: positiveCanonicalDecimalSchema.optional(),
  isolatedMargin: canonicalDecimalSchema.optional(),
  riskMarkId: z.string().regex(/^hprr[0-9a-f]{64}$/),
  riskMarkPx: positiveCanonicalDecimalSchema,
  finalSzi: signedCanonicalDecimalSchema,
  finalEntryPx: canonicalDecimalSchema,
  positionNotional: canonicalDecimalSchema,
  unrealizedPnl: signedCanonicalDecimalSchema,
  marginRequired: canonicalDecimalSchema,
}).strict();

const storedRiskSummarySchema = z.object({
  cashBalance: canonicalDecimalSchema,
  unrealizedPnl: signedCanonicalDecimalSchema,
  accountValue: positiveCanonicalDecimalSchema,
  totalMargin: canonicalDecimalSchema,
  marginAvailable: canonicalDecimalSchema,
}).strict();

export const historicalReplayResultSchema = z.object({
  type: z.literal('historicalReplay'),
  status: z.literal('imported'),
  paper: z.literal(true),
  synthetic: z.literal(true),
  historicalReplay: z.literal(true),
  historical_replay: z.literal(true),
  user: z.string().min(1),
  batchId: z.string().regex(/^hprb[0-9a-f]{64}$/),
  sourceDigest: digestSchema,
  priceEvidenceDigest: digestSchema,
  modelInputDigest: digestSchema,
  riskMarkEvidenceDigest: digestSchema,
  startingBalance: canonicalDecimalSchema,
  finalBalance: canonicalDecimalSchema,
  replayedAt: timestampSchema,
  eventCount: z.number().int().positive().safe(),
  eventIds: z.array(z.string().regex(/^hpre[0-9a-f]{64}$/)).min(1),
  replay: historicalReplayPayloadSchema,
  positions: z.array(storedPositionSchema),
  marginPosture: z.array(storedMarginPostureSchema).min(1),
  riskSummary: storedRiskSummarySchema,
  events: z.array(historicalReplayStoredEventSchema).min(1),
}).strict();
