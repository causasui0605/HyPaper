import { z } from 'zod';

export const PNL_FUNDING_EVENT_SCHEMA = 'hypaper_pnl_funding_event_v2' as const;

const canonicalDecimal = z.string().regex(
  /^(?:0|-?(?:(?:[1-9][0-9]*)(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9]))$/,
  'must be a canonical decimal string',
);
const positiveCanonicalDecimal = canonicalDecimal.refine((value) => !value.startsWith('-') && value !== '0');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const fundingSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('live_market_context'),
  }).strict(),
  z.object({
    kind: z.literal('verified_backfill'),
    oracleSourceSha256: sha256,
    fundingSourceSha256: sha256,
  }).strict(),
]);

export const pnlFundingEventSchema = z.object({
  schema: z.literal(PNL_FUNDING_EVENT_SCHEMA),
  kind: z.literal('pnl_funding_event'),
  paper: z.literal(true),
  eventId: z.string().regex(/^hpfe[0-9a-f]{64}$/),
  asset: z.number().int().nonnegative().safe(),
  coin: z.string().min(1).max(128),
  fundingTime: z.number().int().nonnegative().safe(),
  appliedAt: z.number().int().nonnegative().safe(),
  szi: canonicalDecimal,
  oraclePx: positiveCanonicalDecimal,
  fundingRate: canonicalDecimal,
  fundingCharge: canonicalDecimal,
  source: fundingSourceSchema,
  accountBalanceBefore: canonicalDecimal,
  accountBalanceAfter: canonicalDecimal,
  cumFundingBefore: canonicalDecimal,
  cumFundingAfter: canonicalDecimal,
  cumFundingSinceOpenBefore: canonicalDecimal,
  cumFundingSinceOpenAfter: canonicalDecimal,
  cumFundingSinceChangeBefore: canonicalDecimal,
  cumFundingSinceChangeAfter: canonicalDecimal,
}).strict();

export type PnlFundingEvent = z.infer<typeof pnlFundingEventSchema>;

export const getPnlSnapshotRequestSchema = z.object({
  type: z.literal('getPnlSnapshot'),
  user: z.string().min(1),
  coins: z.array(z.string().min(1).max(128)).min(1).max(64)
    .refine((coins) => new Set(coins).size === coins.length, 'coins must be unique'),
}).strict();

export interface PnlAssetSnapshot {
  coin: string;
  szi: string;
  entryPx: string | null;
  markPx: string | null;
  replayRealizedPnl: string;
  ordinaryRealizedPnl: string;
  replayFees: string;
  ordinaryFees: string;
  fundingCharge: string;
  unrealizedPnl: string;
  totalPnl: string;
}

export interface PnlSnapshot {
  type: 'pnlSnapshot';
  status: 'ok';
  paper: true;
  pristine: boolean;
  asOf: number;
  startingBalance: string;
  accountValue: string;
  totalPnl: string;
  replayBatchId: string | null;
  ordinaryFillCount: number;
  fundingEventCount: number;
  assets: PnlAssetSnapshot[];
}
