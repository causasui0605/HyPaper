import { readFileSync } from 'node:fs';
import { redis } from '../store/redis.js';
import { FundingWorker } from '../worker/funding-worker.js';
import { parseFundingBackfill, summarizeFundingBackfill } from '../engine/funding-backfill.js';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--apply')) throw new Error('refusing without --apply');
  if (process.env.HYPAPER_FUNDING_BACKFILL_ENABLED !== 'true') {
    throw new Error('HYPAPER_FUNDING_BACKFILL_ENABLED must be exactly true');
  }
  const expectedSha256 = argument('--expected-sha256');
  const expectedUser = argument('--user');
  const bytes = readFileSync(0);
  const manifest = parseFundingBackfill(bytes, expectedSha256, expectedUser);
  const worker = new FundingWorker();
  let applied = 0;
  let retries = 0;
  for (const event of manifest.events) {
    const outcome = await worker.applyFundingEvent({
      userId: manifest.user,
      asset: event.asset,
      coin: event.coin,
      fundingTime: event.fundingTime,
      appliedAt: Date.now(),
      expectedSzi: event.expectedSzi,
      oraclePx: event.oraclePx,
      fundingRate: event.fundingRate,
      source: {
        kind: 'verified_backfill',
        oracleSourceSha256: event.oracleSourceSha256,
        fundingSourceSha256: event.fundingSourceSha256,
      },
    });
    if (outcome === 'applied') applied += 1;
    if (outcome === 'retry') retries += 1;
  }
  process.stdout.write(`${JSON.stringify({
    status: 'ok',
    paper: true,
    user: manifest.user,
    applied,
    retries,
    ...summarizeFundingBackfill(manifest),
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
