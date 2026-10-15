import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { config, extraDexList } from '../../config.js';
import { FEED_LAST_UPDATE_KEY, expectedFeedFamilies } from '../../worker/price-updater.js';

export interface FeedHealth {
  lastUpdateMs: number | null;
  ageMs: number | null;
  stale: boolean;
}

/**
 * Read-only WS feed freshness for the families the CURRENT config expects.
 * Every expected family is listed even if it has never updated (lastUpdateMs
 * null, stale). A family is stale when its last WS update is older than
 * WS_SILENCE_MS. Any stale expected family answers 503. Stored fields for
 * families no longer expected (e.g. a dex removed from EXTRA_DEXS) are listed
 * under `unexpected` and never affect `status`.
 */
export const healthRouter = new Hono();

healthRouter.get('/feeds', async (c) => {
  const now = Date.now();
  const staleAfterMs = config.WS_SILENCE_MS;
  const stored = await redis.hgetall(FEED_LAST_UPDATE_KEY) as Record<string, string>;
  const expected = expectedFeedFamilies(extraDexList(config.EXTRA_DEXS));
  const describe = (raw: string | undefined): FeedHealth => {
    const lastUpdateMs = raw !== undefined && /^[0-9]+$/.test(raw) ? Number(raw) : null;
    const ageMs = lastUpdateMs === null ? null : now - lastUpdateMs;
    return { lastUpdateMs, ageMs, stale: ageMs === null || ageMs > staleAfterMs };
  };

  const feeds: Record<string, FeedHealth> = {};
  for (const family of expected) feeds[family] = describe(stored[family]);
  const unexpected: Record<string, FeedHealth> = {};
  for (const family of Object.keys(stored)) {
    if (!expected.includes(family)) unexpected[family] = describe(stored[family]);
  }

  const anyStale = Object.values(feeds).some((feed) => feed.stale);
  return c.json(
    { status: anyStale ? 'stale' : 'ok', time: now, staleAfterMs, feeds, unexpected },
    anyStale ? 503 : 200,
  );
});
