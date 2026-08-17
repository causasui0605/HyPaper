import { createHash } from 'node:crypto';
import { z } from 'zod';
import { D } from '../utils/math.js';

const canonicalDecimal = z.string().regex(
  /^(?:0|-?(?:(?:[1-9][0-9]*)(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9]))$/,
  'must be a canonical decimal string',
);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const correctionInputSchema = z.object({
  asset: z.number().int().nonnegative().safe(),
  coin: z.string().min(1).max(128),
  fundingTime: z.number().int().nonnegative().safe(),
  expectedSzi: canonicalDecimal.refine((value) => value !== '0'),
  correctedOraclePx: canonicalDecimal.refine(
    (value) => !value.startsWith('-') && value !== '0',
  ),
  correctedFundingRate: canonicalDecimal.refine((value) => value !== '0'),
  originalEventSha256: sha256,
  oracleSourceSha256: sha256,
  fundingSourceSha256: sha256,
}).strict();

const correctionManifestSchema = z.object({
  schema: z.literal('hypaper_funding_correction_manifest_v1'),
  paper: z.literal(true),
  user: z.string().regex(/^0x[0-9a-f]{40}$/),
  createdAt: z.number().int().nonnegative().safe(),
  corrections: z.array(correctionInputSchema).min(1).max(10_000),
}).strict();

export type FundingCorrectionManifest = z.infer<typeof correctionManifestSchema>;

export function parseFundingCorrectionManifest(
  bytes: Buffer,
  expectedSha256: string,
  expectedUser: string,
): FundingCorrectionManifest {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new Error('expected SHA-256 is invalid');
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error('funding correction manifest SHA-256 conflicts');
  }
  const manifest = correctionManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (manifest.user !== expectedUser.toLowerCase()) {
    throw new Error('funding correction manifest user conflicts');
  }
  let priorTime = -1;
  let priorAsset = -1;
  for (const row of manifest.corrections) {
    if (row.fundingTime % 3_600_000 !== 0) {
      throw new Error('funding correction time is not an exact UTC hour');
    }
    if (row.fundingTime > manifest.createdAt) {
      throw new Error('funding correction follows manifest creation');
    }
    if (row.fundingTime < priorTime
      || (row.fundingTime === priorTime && row.asset <= priorAsset)) {
      throw new Error('funding corrections are not in strict chronological order');
    }
    priorTime = row.fundingTime;
    priorAsset = row.asset;
  }
  return manifest;
}

export function summarizeFundingCorrectionManifest(
  manifest: FundingCorrectionManifest,
): { correctionCount: number; correctedFundingCharge: string } {
  return {
    correctionCount: manifest.corrections.length,
    correctedFundingCharge: manifest.corrections.reduce(
      (total, row) => total.plus(
        D(row.expectedSzi).times(row.correctedOraclePx).times(row.correctedFundingRate),
      ),
      D(0),
    ).toString(),
  };
}
