import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();
const mockConfig = vi.hoisted(() => ({
  DEFAULT_BALANCE: '10000',
  LOG_LEVEL: 'silent',
  HISTORICAL_REPLAY_ENABLED: false,
  PNL_SNAPSHOT_ENABLED: false,
  CASH_LEDGER_EVIDENCE_ENABLED: false,
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

vi.mock('../engine/pnl.js', () => ({
  PnlSnapshotError: class PnlSnapshotError extends Error {
    constructor(message: string, readonly status = 409) {
      super(message);
    }
  },
  getPnlSnapshot: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

const { exchangeRouter } = await import('../api/routes/exchange.js');
const { hypaperRouter } = await import('../api/routes/hypaper.js');
const { ensureAccount } = await import('../api/middleware/auth.js');
const { getPnlSnapshot, PnlSnapshotError } = await import('../engine/pnl.js');

describe('route validation', () => {
  beforeEach(() => {
    redisMock.flushall();
    vi.clearAllMocks();
    mockConfig.HISTORICAL_REPLAY_ENABLED = false;
    mockConfig.PNL_SNAPSHOT_ENABLED = false;
    mockConfig.CASH_LEDGER_EVIDENCE_ENABLED = false;
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

  it('returns the strict disabled evidence envelope before ensureAccount', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'getCashLedgerEvidence', user: '0xAbC', dex: 'xyz', coins: ['xyz:CL'],
        coverageStartMs: 0, coverageEndMs: 0, finalFlatRequired: true,
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_ERROR_V1', status: 'disabled', error_code: 'disabled',
    });
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  it('rejects hostile evidence requests without account access', async () => {
    mockConfig.CASH_LEDGER_EVIDENCE_ENABLED = true;
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'getCashLedgerEvidence', user: '0xabc', dex: 'xyz', coins: ['xyz:CL', 'xyz:CL'],
        coverageStartMs: 0, coverageEndMs: 0, finalFlatRequired: true, extra: true,
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_ERROR_V1', status: 'refused', error_code: 'invalid_request',
    });
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  it('redacts provider identity errors and never reaches ensureAccount', async () => {
    mockConfig.CASH_LEDGER_EVIDENCE_ENABLED = true;
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'getCashLedgerEvidence', user: '0xSecret', dex: 'xyz', coins: ['xyz:CL'],
        coverageStartMs: 0, coverageEndMs: 0, finalFlatRequired: true,
      }),
    });
    expect(res.status).toBe(409);
    const response = await res.json();
    expect(response).toEqual({
      schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_ERROR_V1', status: 'refused', error_code: 'identity',
    });
    expect(JSON.stringify(response)).not.toContain('0xSecret');
    expect(ensureAccount).not.toHaveBeenCalled();
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

  it('refuses the read-only PnL snapshot route while strict opt-in is disabled', async () => {
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'getPnlSnapshot', user: '0xAbC', coins: ['xyz:CL'] }),
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      type: 'pnlSnapshot', status: 'disabled', paper: true,
    });
    expect(ensureAccount).not.toHaveBeenCalled();
    expect(getPnlSnapshot).not.toHaveBeenCalled();
  });

  it('serves an opted-in PnL snapshot without creating or mutating an account', async () => {
    mockConfig.PNL_SNAPSHOT_ENABLED = true;
    vi.mocked(getPnlSnapshot).mockResolvedValue({
      type: 'pnlSnapshot', status: 'ok', paper: true, pristine: true,
      asOf: 1, startingBalance: '10000', accountValue: '10000', totalPnl: '0',
      replayBatchId: null, ordinaryFillCount: 0, fundingEventCount: 0,
      assets: [],
    });
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'getPnlSnapshot', user: '0xAbC',
        coins: ['xyz:CL', 'xyz:NATGAS', 'xyz:BRENTOIL', 'xyz:COPPER'],
      }),
    });
    expect(res.status).toBe(200);
    expect(getPnlSnapshot).toHaveBeenCalledWith('0xabc', [
      'xyz:CL', 'xyz:NATGAS', 'xyz:BRENTOIL', 'xyz:COPPER',
    ]);
    expect(ensureAccount).not.toHaveBeenCalled();
  });

  it('strictly rejects malformed PnL snapshot requests before any account mutation', async () => {
    mockConfig.PNL_SNAPSHOT_ENABLED = true;
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    for (const body of [
      { type: 'getPnlSnapshot', user: '0xabc', coins: [] },
      { type: 'getPnlSnapshot', user: '0xabc', coins: ['xyz:CL', 'xyz:CL'] },
      { type: 'getPnlSnapshot', user: '0xabc', coins: ['xyz:CL'], oid: 7 },
    ]) {
      const res = await app.request('/hypaper', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        type: 'pnlSnapshot', status: 'refused', paper: true,
      });
    }
    expect(ensureAccount).not.toHaveBeenCalled();
    expect(getPnlSnapshot).not.toHaveBeenCalled();
  });

  it('returns a fail-closed PnL refusal without leaking the account identity', async () => {
    mockConfig.PNL_SNAPSHOT_ENABLED = true;
    vi.mocked(getPnlSnapshot).mockRejectedValue(new PnlSnapshotError('reconciliation refused', 409));
    const app = new Hono();
    app.route('/hypaper', hypaperRouter);
    const res = await app.request('/hypaper', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'getPnlSnapshot', user: '0xSecret', coins: ['xyz:CL'] }),
    });
    expect(res.status).toBe(409);
    const response = await res.json();
    expect(response).toEqual({
      type: 'pnlSnapshot', status: 'refused', paper: true, error: 'reconciliation refused',
    });
    expect(JSON.stringify(response)).not.toContain('0xSecret');
    expect(JSON.stringify(response)).not.toContain('0xsecret');
    expect(ensureAccount).not.toHaveBeenCalled();
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
