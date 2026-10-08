import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// In-memory stand-in for the Redis calls the route makes (get / hgetall).
const store = vi.hoisted(() => ({
  strings: new Map<string, string>(),
  hashes: new Map<string, Record<string, string>>(),
}));
const ensureAccount = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../api/middleware/auth.js', () => ({ ensureAccount }));
vi.mock('../store/redis.js', () => ({
  redis: {
    get: vi.fn(async (key: string) => store.strings.get(key) ?? null),
    hget: vi.fn(async (key: string, field: string) => store.hashes.get(key)?.[field] ?? null),
    hgetall: vi.fn(async (key: string) => ({ ...(store.hashes.get(key) ?? {}) })),
  },
}));
vi.mock('../engine/position.js', () => ({
  getClearinghouseState: vi.fn(), getOpenOrders: vi.fn(),
  getFrontendOpenOrders: vi.fn(), getOrderStatus: vi.fn(),
}));
vi.mock('../engine/fill.js', () => ({
  getUserFills: vi.fn(), getUserFillsByTime: vi.fn(),
}));
vi.mock('../engine/funding-history.js', () => ({ getUserFunding: vi.fn() }));
vi.mock('../config.js', () => ({
  config: { HL_API_URL: 'https://example.invalid', LOG_LEVEL: 'silent' },
}));

const { infoRouter } = await import('../api/routes/info.js');
const { KEYS } = await import('../store/keys.js');

// Captured real Hyperliquid answers (2026-10-07) for an address that never traded.
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const TSM = fixture('active-asset-data-xyz-tsm.json'); // isolated 10 upstream
const AAPL = fixture('active-asset-data-xyz-aapl.json'); // cross 20 upstream

const TSM_ASSET = 110_030;
const AAPL_ASSET = 110_007;
const BTC_ASSET = 0;

function seedMarket(): void {
  store.strings.clear();
  store.hashes.clear();
  store.hashes.set(KEYS.MARKET_ASSET_MAP, {
    [String(TSM_ASSET)]: JSON.stringify({ coin: 'xyz:TSM', szDecimals: 3, maxLeverage: 10, onlyIsolated: true }),
    [String(AAPL_ASSET)]: JSON.stringify({ coin: 'xyz:AAPL', szDecimals: 3, maxLeverage: 20, onlyIsolated: false }),
  });
  store.strings.set(KEYS.MARKET_META, JSON.stringify({
    universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }],
  }));
}

function upstream(body: unknown, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

async function ask(user: string, coin: string) {
  const app = new Hono();
  app.route('/info', infoRouter);
  const response = await app.request('/info', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'activeAssetData', user, coin }),
  });
  const text = await response.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// Every test uses its own user address: the route's proxy cache is keyed on the body.
describe('activeAssetData answers the paper leverage setting', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    seedMarket();
  });

  it('returns a stored isolated setting with every other field from upstream', async () => {
    const user = '0x7e0e000000000000000000000000000000000a01';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2', isCross: 'false', isolatedMargin: '0' });
    upstream({ ...TSM, user });

    const { status, body } = await ask(user, 'xyz:TSM');

    expect(status).toBe(200);
    expect(body).toEqual({ ...TSM, user, leverage: { type: 'isolated', value: 2, rawUsd: '0' } });
  });

  it('returns a stored cross setting on a main-dex coin without rawUsd', async () => {
    const user = '0x7e0e000000000000000000000000000000000a02';
    store.hashes.set(KEYS.USER_LEV(user, BTC_ASSET), { leverage: '5', isCross: 'true' });
    const btc = { ...AAPL, user, coin: 'BTC' };
    upstream(btc);

    const { body } = await ask(user, 'BTC');

    expect(body).toEqual({ ...btc, leverage: { type: 'cross', value: 5 } });
  });

  it('returns a non-zero isolated margin verbatim as rawUsd', async () => {
    const user = '0x7e0e000000000000000000000000000000000a03';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2', isCross: 'false', isolatedMargin: '320.5' });
    upstream({ ...TSM, user });

    const { body } = await ask(user, 'xyz:TSM');

    expect(body.leverage).toEqual({ type: 'isolated', value: 2, rawUsd: '320.5' });
  });

  it('defaults rawUsd to "0" when no isolated margin is stored', async () => {
    const user = '0x7e0e000000000000000000000000000000000a04';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2', isCross: 'false' });
    upstream({ ...TSM, user });

    const { body } = await ask(user, 'xyz:TSM');

    expect(body.leverage).toEqual({ type: 'isolated', value: 2, rawUsd: '0' });
  });

  it('matches the user address case-insensitively', async () => {
    const user = '0x7e0e000000000000000000000000000000000a05';
    store.hashes.set(KEYS.USER_LEV(user, AAPL_ASSET), { leverage: '2', isCross: 'false', isolatedMargin: '0' });
    upstream({ ...AAPL, user });

    const { body } = await ask(user.toUpperCase().replace('0X', '0x'), 'xyz:AAPL');

    expect(body.leverage).toEqual({ type: 'isolated', value: 2, rawUsd: '0' });
  });

  it('returns the upstream body unchanged when no setting is stored', async () => {
    const user = '0x7e0e000000000000000000000000000000000a06';
    upstream({ ...TSM, user });

    const { status, body } = await ask(user, 'xyz:TSM');

    expect(status).toBe(200);
    expect(body).toEqual({ ...TSM, user });
  });

  it('returns the upstream body unchanged for a coin HyPaper does not know', async () => {
    const user = '0x7e0e000000000000000000000000000000000a07';
    const unknown = { ...TSM, user, coin: 'xyz:NOPE' };
    upstream(unknown);

    const { body } = await ask(user, 'xyz:NOPE');

    expect(body).toEqual(unknown);
  });

  it('returns the upstream body unchanged for a coin listed twice in the asset map', async () => {
    const user = '0x7e0e000000000000000000000000000000000a08';
    store.hashes.set(KEYS.MARKET_ASSET_MAP, {
      ...store.hashes.get(KEYS.MARKET_ASSET_MAP),
      '110099': JSON.stringify({ coin: 'xyz:TSM', szDecimals: 3 }),
    });
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2', isCross: 'false' });
    upstream({ ...TSM, user });

    const { body } = await ask(user, 'xyz:TSM');

    expect(body).toEqual({ ...TSM, user });
  });

  it('refuses with 502 when the upstream body has an unexpected shape', async () => {
    const user = '0x7e0e000000000000000000000000000000000a09';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2', isCross: 'false' });
    upstream({ user, coin: 'xyz:TSM', leverage: { type: 'isolated', value: 10 } });

    const { status, body } = await ask(user, 'xyz:TSM');

    expect(status).toBe(502);
    expect(body).toEqual({ error: expect.stringContaining('unexpected shape') });
  });

  it('refuses with 502 when the upstream body names another coin', async () => {
    const user = '0x7e0e000000000000000000000000000000000a10';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2', isCross: 'false' });
    upstream({ ...AAPL, user });

    const { status } = await ask(user, 'xyz:TSM');

    expect(status).toBe(502);
  });

  it('refuses with 502 when the stored leverage is not a positive integer', async () => {
    const user = '0x7e0e000000000000000000000000000000000a11';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2.5', isCross: 'false' });
    const spy = upstream({ ...TSM, user });

    const { status } = await ask(user, 'xyz:TSM');

    expect(status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses with 502 when a stored setting has an empty leverage field, before any upstream fetch', async () => {
    const user = '0x7e0e000000000000000000000000000000000a12';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '', isCross: 'false' });
    const spy = upstream({ ...TSM, user });

    const { status } = await ask(user, 'xyz:TSM');

    expect(status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses with 502 when the upstream body is not JSON (stored setting present)', async () => {
    const user = '0x7e0e000000000000000000000000000000000a13';
    store.hashes.set(KEYS.USER_LEV(user, TSM_ASSET), { leverage: '2', isCross: 'false' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }));

    const { status, body } = await ask(user, 'xyz:TSM');

    expect(status).toBe(502);
    expect(body).toEqual({ error: expect.stringContaining('could not be decoded') });
  });

  it('keeps ordinary proxy behaviour for a non-JSON upstream body when no setting is stored', async () => {
    const user = '0x7e0e000000000000000000000000000000000a14';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('not json', { status: 200 }));

    const { status } = await ask(user, 'xyz:TSM');

    // Unchanged: the same unhandled-rejection 500 as any other proxied type with a bad body.
    expect(status).toBe(500);
  });
});
