import { createHash } from 'node:crypto';
import { z } from 'zod';
import { D } from '../utils/math.js';

const canonicalDecimal = z.string().regex(
  /^(?:0|-?(?:(?:[1-9][0-9]*)(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9]))$/,
  'must be a canonical decimal string',
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const fundingBackfillEventSchema = z.object({
  asset: z.number().int().nonnegative().safe(),
  coin: z.string().min(1).max(128),
  fundingTime: z.number().int().nonnegative().safe(),
  expectedSzi: canonicalDecimal.refine((value) => value !== '0'),
  oraclePx: canonicalDecimal.refine((value) => !value.startsWith('-') && value !== '0'),
  fundingRate: canonicalDecimal.refine((value) => value !== '0'),
  oracleSourceSha256: sha256,
  fundingSourceSha256: sha256,
}).strict();

const fundingBackfillSchema = z.object({
  schema: z.literal('hypaper_funding_backfill_v1'),
  paper: z.literal(true),
  user: z.string().regex(/^0x[0-9a-f]{40}$/),
  createdAt: z.number().int().nonnegative().safe(),
  events: z.array(fundingBackfillEventSchema).min(1).max(10_000),
}).strict();

export type FundingBackfill = z.infer<typeof fundingBackfillSchema>;

export interface FundingBackfillSummary {
  eventCount: number;
  fundingCharge: string;
  fundingCashflow: string;
}

export function parseFundingBackfill(
  bytes: Buffer,
  expectedSha256: string,
  expectedUser: string,
): FundingBackfill {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('expected SHA-256 is invalid');
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256) throw new Error('funding backfill SHA-256 conflicts');
  const manifest = fundingBackfillSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (manifest.user !== expectedUser.toLowerCase()) throw new Error('funding backfill user conflicts');

  const identities = new Set<string>();
  let priorTime = -1;
  let priorAsset = -1;
  for (const event of manifest.events) {
    if (event.fundingTime % 3_600_000 !== 0) throw new Error('funding time is not an exact UTC hour');
    if (event.fundingTime > manifest.createdAt) throw new Error('funding event follows manifest creation');
    if (event.fundingTime < priorTime
      || (event.fundingTime === priorTime && event.asset <= priorAsset)) {
      throw new Error('funding backfill events are not in strict chronological order');
    }
    const identity = `${event.asset}\0${event.fundingTime}`;
    if (identities.has(identity)) throw new Error('funding backfill event identity repeats');
    identities.add(identity);
    priorTime = event.fundingTime;
    priorAsset = event.asset;
  }
  return manifest;
}

export function summarizeFundingBackfill(manifest: FundingBackfill): FundingBackfillSummary {
  const fundingCharge = manifest.events.reduce(
    (total, event) => total.plus(D(event.expectedSzi).times(event.oraclePx).times(event.fundingRate)),
    D(0),
  );
  return {
    eventCount: manifest.events.length,
    fundingCharge: fundingCharge.toString(),
    fundingCashflow: fundingCharge.negated().toString(),
  };
}
