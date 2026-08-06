import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();
const mockConfig = vi.hoisted(() => ({
  DEFAULT_BALANCE: '10000',
  LOG_LEVEL: 'silent',
  HISTORICAL_REPLAY_ENABLED: false,
  FEE_RATE_TAKER: '0.00035',
}));

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../api/middleware/auth.js', () => ({
  ensureAccount: vi.fn(async () => {}),
}));

vi.mock('../engine/order.js', () => ({
  placeOrders: vi.fn(async () => []),
  cancelOrders: vi.fn(async () => []),
  cancelByCloid: vi.fn(async () => []),
  updateLeverage: vi.fn(async () => {}),
}));

vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(async () => {}),
  updateUserBalance: vi.fn(async () => {}),
}));

vi.mock('../engine/historical-replay.js', () => ({
  HistoricalReplayError: class HistoricalReplayError extends Error {},
  importHistoricalReplay: vi.fn(),
  getHistoricalReplay: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

const { exchangeRouter } = await import('../api/routes/exchange.js');
const { hypaperRouter } = await import('../api/routes/hypaper.js');

describe('route validation', () => {
  beforeEach(() => {
    redisMock.flushall();
    mockConfig.HISTORICAL_REPLAY_ENABLED = false;
  });

  it('rejects NaN order sizes on /exchange', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);

    const res = await app.request('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: '0xabc',
        action: {
          type: 'order',
          orders: [
            {
              a: 0,
              b: true,
              p: '50000',
              s: 'NaN',
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'err',
      response: 'Size and price must be finite positive numbers',
    });
  });

  it('rejects Infinity order prices on /exchange', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);

    const res = await app.request('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: '0xabc',
        action: {
          type: 'order',
          orders: [
            {
              a: 0,
              b: true,
              p: 'Infinity',
              s: '1',
              r: false,
              t: { limit: { tif: 'Gtc' } },
            },
          ],
          grouping: 'na',
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'err',
      response: 'Size and price must be finite positive numbers',
    });
  });

  it('rejects non-string isolated-only target leverage on /exchange', async () => {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);

    const res = await app.request('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet: '0xabc',
        action: {
          type: 'topUpIsolatedOnlyMargin',
          asset: 110001,
          leverage: 3,
        },
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      status: 'err',
      response: 'topUpIsolatedOnlyMargin requires asset (integer), leverage (decimal string)',
    });
  });

  it('accepts an isolated-only target leverage decimal string', async () => {
    const asset = 110001;
    const wallet = '0xabc';
    await redisMock.hset(
      KEYS.MARKET_ASSET_MAP,
      asset.toString(),
      JSON.stringify({
        coin: 'xyz:NATGAS',
        szDecimals: 1,
        maxLeverage: 10,
        onlyIsolated: true,
      }),
    );
    await redisMock.hset(KEYS.MARKET_CTX('xyz:NATGAS'), 'markPx', '2.5');
    await redisMock.hset(KEYS.USER_ACCOUNT(wallet), 'balance', '1000');
    await redisMock.hset(
      KEYS.USER_LEV(wallet, asset),
      'leverage', '10',
      'isCross', 'false',
    );
    await redisMock.hset(
      KEYS.USER_POS(wallet, asset),
      'coin', 'xyz:NATGAS',
      'szi', '100',
      'entryPx', '2.5',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(wallet), asset.toString());

    const app = new Hono();
    app.route('/exchange', exchangeRouter);
    const res = await app.request('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        wallet,
        action: {
          type: 'topUpIsolatedOnlyMargin',
          asset,
          leverage: '3',
        },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      response: { type: 'default' },
    });
    await expect(
      redisMock.hget(KEYS.USER_LEV(wallet, asset), 'isolatedMargin'),
    ).resolves.toBe('83.3333333333333333333333333333');
  });

  it('rejects NaN balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: Number.NaN,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing or invalid balance (must be a finite non-negative number)',
    });
  });

  it('rejects negative balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: -1,
      }),
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'Missing or invalid balance (must be a finite non-negative number)',
    });
  });

  it('accepts valid finite non-negative balances on /hypaper setBalance', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'setBalance',
        user: '0xabc',
        balance: 123.45,
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'ok',
      balance: '123.45',
    });
    await expect(redisMock.hget(KEYS.USER_ACCOUNT('0xabc'), 'balance')).resolves.toBe('123.45');
  });

  it('refuses historical replay routes while the strict opt-in is disabled', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);

    for (const type of ['importHistoricalReplay', 'getHistoricalReplay']) {
      const res = await app.request('/hypaper', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, user: '0xabc', unexpected: true }),
      });
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({
        type: 'historicalReplay',
        status: 'disabled',
        paper: true,
        synthetic: true,
        historicalReplay: true,
      });
    }
  });

  it('strictly rejects extra status-route fields after opt-in', async () => {
    mockConfig.HISTORICAL_REPLAY_ENABLED = true;
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'getHistoricalReplay',
        user: '0xabc',
        batchId: `hprb${'0'.repeat(64)}`,
        oid: 7,
      }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      type: 'historicalReplay',
      status: 'refused',
      paper: true,
      synthetic: true,
      historicalReplay: true,
    });
  });

  it('requires batchId on the opted-in historical replay status route', async () => {
    mockConfig.HISTORICAL_REPLAY_ENABLED = true;
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'getHistoricalReplay', user: '0xabc' }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      type: 'historicalReplay',
      status: 'refused',
      historicalReplay: true,
    });
  });
});
