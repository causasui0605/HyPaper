import { readFileSync } from 'node:fs';
import { redis } from '../store/redis.js';
import { FundingWorker } from '../worker/funding-worker.js';
import {
  parseFundingCorrectionManifest,
  summarizeFundingCorrectionManifest,
} from '../engine/funding-correction.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--apply')) throw new Error('refusing without --apply');
  if (process.env.HYPAPER_FUNDING_CORRECTION_ENABLED !== 'true') {
    throw new Error('HYPAPER_FUNDING_CORRECTION_ENABLED must be exactly true');
  }
  const expectedSha256 = argument('--expected-sha256');
  const expectedUser = argument('--user');
  const manifest = parseFundingCorrectionManifest(readFileSync(0), expectedSha256, expectedUser);
  const worker = new FundingWorker();
  let applied = 0;
  let retries = 0;
  for (const row of manifest.corrections) {
    const outcome = await worker.applyFundingCorrection({
      userId: manifest.user,
      asset: row.asset,
      coin: row.coin,
      fundingTime: row.fundingTime,
      appliedAt: Date.now(),
      expectedSzi: row.expectedSzi,
      correctedOraclePx: row.correctedOraclePx,
      correctedFundingRate: row.correctedFundingRate,
      source: {
        kind: 'verified_correction',
        originalEventSha256: row.originalEventSha256,
        oracleSourceSha256: row.oracleSourceSha256,
        fundingSourceSha256: row.fundingSourceSha256,
      },
    });
    if (outcome === 'applied') applied += 1;
    else retries += 1;
  }
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    paper: true,
    user: manifest.user,
    applied,
    retries,
    ...summarizeFundingCorrectionManifest(manifest),
  })}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    redis.disconnect();
  });
