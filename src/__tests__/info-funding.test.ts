import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const getUserFunding = vi.hoisted(() => vi.fn());
const ensureAccount = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('../engine/funding-history.js', () => ({ getUserFunding }));
vi.mock('../api/middleware/auth.js', () => ({ ensureAccount }));
vi.mock('../store/redis.js', () => ({
  redis: { hgetall: vi.fn(), hget: vi.fn() },
}));
vi.mock('../engine/position.js', () => ({
  getClearinghouseState: vi.fn(), getOpenOrders: vi.fn(),
  getFrontendOpenOrders: vi.fn(), getOrderStatus: vi.fn(),
}));
vi.mock('../engine/fill.js', () => ({
  getUserFills: vi.fn(), getUserFillsByTime: vi.fn(),
}));
vi.mock('../config.js', () => ({
  config: { HL_API_URL: 'https://example.invalid', LOG_LEVEL: 'silent' },
}));

const { infoRouter } = await import('../api/routes/info.js');

describe('local userFunding info route', () => {
  beforeEach(() => vi.clearAllMocks());

  it('never proxies paper userFunding to the upstream exchange', async () => {
    const row = {
      time: 123,
      hash: `hpfe${'a'.repeat(64)}`,
      delta: { type: 'funding', coin: 'xyz:NATGAS', usdc: '-1.25', szi: '10', fundingRate: '0.001' },
    };
    getUserFunding.mockResolvedValueOnce([row]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const app = new Hono();
    app.route('/info', infoRouter);

    const response = await app.request('/info', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'userFunding', user: '0xAbC', startTime: 100, endTime: 200 }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([row]);
    expect(ensureAccount).toHaveBeenCalledWith('0xabc');
    expect(getUserFunding).toHaveBeenCalledWith('0xabc', 100, 200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
