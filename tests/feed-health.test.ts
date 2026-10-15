import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from '../src/__tests__/helpers/redis-mock.js';

process.env.EXTRA_DEXS = 'xyz';
process.env.WS_SILENCE_MS = '30000';

const redisMock = new RedisMock();
vi.mock('../src/store/redis.js', () => ({ redis: redisMock }));

const { app } = await import('../src/api/server.js');
const { PriceUpdater, FEED_LAST_UPDATE_KEY } = await import('../src/worker/price-updater.js');

const T0 = Date.UTC(2026, 9, 15, 8, 32, 0);

interface FeedsBody {
  status: string;
  time: number;
  staleAfterMs: number;
  feeds: Record<string, { lastUpdateMs: number | null; ageMs: number | null; stale: boolean }>;
  unexpected: Record<string, { lastUpdateMs: number | null; ageMs: number | null; stale: boolean }>;
}

async function getFeeds(): Promise<{ code: number; body: FeedsBody }> {
  const res = await app.request('/health/feeds');
  return { code: res.status, body: await res.json() as FeedsBody };
}

describe('WS feed freshness', () => {
  beforeEach(() => {
    redisMock.flushall();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the last WS update per subscription family', async () => {
    const updater = new PriceUpdater(vi.fn(), new EventEmitter());
    await updater.handleMessage('allMids', { mids: { BTC: '1', ETH: '2' } });
    vi.setSystemTime(T0 + 5);
    await updater.handleMessage('allMids', { mids: { 'xyz:CL': '60' } });
    vi.setSystemTime(T0 + 9);
    await updater.handleMessage('activeAssetCtx', { coin: 'BTC', ctx: { markPx: '1' } });
    // HTTP seeding is not a WS update and never refreshes a family.
    vi.setSystemTime(T0 + 100);
    await updater.seedMids({ BTC: '3', 'xyz:CL': '61' });

    expect(await redisMock.hgetall(FEED_LAST_UPDATE_KEY)).toEqual({
      allMids: String(T0),
      'allMids:xyz': String(T0 + 5),
      activeAssetCtx: String(T0 + 9),
    });
  });

  it('reports fresh feeds with their ages', async () => {
    await redisMock.hset(FEED_LAST_UPDATE_KEY,
      'allMids', String(T0 - 1_000),
      'allMids:xyz', String(T0 - 30_000),
      'activeAssetCtx', String(T0),
    );
    const { code, body } = await getFeeds();
    expect(code).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      time: T0,
      staleAfterMs: 30_000,
      feeds: {
        allMids: { lastUpdateMs: T0 - 1_000, ageMs: 1_000, stale: false },
        'allMids:xyz': { lastUpdateMs: T0 - 30_000, ageMs: 30_000, stale: false },
        activeAssetCtx: { lastUpdateMs: T0, ageMs: 0, stale: false },
      },
      unexpected: {},
    });
  });

  it('ignores the frozen timestamp of a dex no longer in EXTRA_DEXS', async () => {
    // "abc" was configured on an earlier run; only "xyz" is configured now.
    await redisMock.hset(FEED_LAST_UPDATE_KEY,
      'allMids', String(T0),
      'allMids:xyz', String(T0),
      'activeAssetCtx', String(T0),
      'allMids:abc', String(T0 - 86_400_000),
    );
    const { code, body } = await getFeeds();
    expect(code).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.keys(body.feeds)).toEqual(['allMids', 'allMids:xyz', 'activeAssetCtx']);
    expect(body.unexpected).toEqual({
      'allMids:abc': { lastUpdateMs: T0 - 86_400_000, ageMs: 86_400_000, stale: true },
    });
  });

  it('reports a frozen feed and a never-updated feed as stale', async () => {
    await redisMock.hset(FEED_LAST_UPDATE_KEY,
      'allMids', String(T0 - 6 * 3_600_000),
      'allMids:xyz', String(T0 - 2_000),
    );
    const { code, body } = await getFeeds();
    expect(code).toBe(503);
    expect(body.status).toBe('stale');
    expect(body.feeds).toEqual({
      allMids: { lastUpdateMs: T0 - 21_600_000, ageMs: 21_600_000, stale: true },
      'allMids:xyz': { lastUpdateMs: T0 - 2_000, ageMs: 2_000, stale: false },
      activeAssetCtx: { lastUpdateMs: null, ageMs: null, stale: true },
    });
  });

  it('treats one millisecond past the limit as stale', async () => {
    await redisMock.hset(FEED_LAST_UPDATE_KEY,
      'allMids', String(T0 - 30_001),
      'allMids:xyz', String(T0),
      'activeAssetCtx', String(T0),
    );
    const { code, body } = await getFeeds();
    expect(code).toBe(503);
    expect(body.feeds.allMids).toEqual({ lastUpdateMs: T0 - 30_001, ageMs: 30_001, stale: true });
  });

  it('keeps the plain /health response unchanged', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', time: T0 });
  });
});
