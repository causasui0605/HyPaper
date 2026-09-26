import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../config.js', () => ({
  config: { FEES_ENABLED: false, FEE_RATE_TAKER: '0.00035', FEE_RATE_MAKER: '0.0001', LOG_LEVEL: 'silent' },
}));
vi.mock('../utils/l2-cache.js', () => ({ getL2Book: vi.fn().mockResolvedValue(null) }));
let idCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++idCounter),
  nextTid: vi.fn(async () => ++idCounter),
}));
vi.mock('../worker/index.js', () => ({ eventBus: new EventEmitter() }));
vi.mock('../engine/margin.js', () => ({ checkMarginForOrder: vi.fn(async () => true) }));
vi.mock('../engine/asset.js', () => ({
  getAssetMetadata: vi.fn(async (asset: number) => (asset === 110029
    ? { coin: 'xyz:CL', szDecimals: 3, maxLeverage: 20, onlyIsolated: false }
    : null)),
}));

const { placeOrders } = await import('../engine/order.js');
const { getOpenOrders, getFrontendOpenOrders } = await import('../engine/position.js');

const USER = '0xindex';
const ASSET = 110029;
const COIN = 'xyz:CL';

function order(isBuy: boolean, px: string, tif: 'Ioc' | 'Gtc' | 'Alo') {
  return { a: ASSET, b: isBuy, p: px, s: '0.1', r: false, t: { limit: { tif } } };
}

async function indexed(): Promise<string[]> {
  return redisMock.zrange(KEYS.USER_ORDERS(USER), 0, -1);
}

describe('user order index', () => {
  beforeEach(async () => {
    redisMock.flushall();
    idCounter = 100;
    await redisMock.hset(KEYS.MARKET_MIDS, COIN, '94.344');
    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '100000');
  });

  it('indexes an IOC order that fills immediately', async () => {
    const [status] = await placeOrders(USER, [order(true, '95.287', 'Ioc')], 'na');
    const oid = (status as { filled: { oid: number } }).filled.oid;
    expect(await indexed()).toEqual([String(oid)]);
    const data = await redisMock.hgetall(KEYS.ORDER(oid));
    expect(data.status).toBe('filled');
    expect(data.userId).toBe(USER);
  });

  it('indexes a GTC order that crosses and fills immediately', async () => {
    const [status] = await placeOrders(USER, [order(true, '95', 'Gtc')], 'na');
    const oid = (status as { filled: { oid: number } }).filled.oid;
    expect(await indexed()).toEqual([String(oid)]);
  });

  it('indexes resting GTC, ALO and trigger orders exactly once', async () => {
    const statuses = await placeOrders(USER, [
      order(true, '90', 'Gtc'),
      order(true, '90', 'Alo'),
      {
        a: ASSET, b: false, p: '80', s: '0.1', r: true,
        t: { limit: { tif: 'Gtc' }, trigger: { isMarket: true, triggerPx: '80', tpsl: 'sl' } },
      },
    ], 'na');
    const oids = statuses.map((status) => String((status as { resting: { oid: number } }).resting.oid));
    const members = await indexed();
    expect([...members].sort()).toEqual([...oids].sort());
    expect(new Set(members).size).toBe(members.length);
  });

  it('writes nothing for an IOC order that cannot fill', async () => {
    const [status] = await placeOrders(USER, [order(true, '90', 'Ioc')], 'na');
    expect(status).toEqual({ error: 'IOC order could not be filled' });
    expect(await indexed()).toEqual([]);
    expect(await redisMock.keys('order:*')).toEqual([]);
  });

  it('keeps open-order views limited to open orders', async () => {
    await placeOrders(USER, [order(true, '95.287', 'Ioc'), order(true, '90', 'Gtc')], 'na');
    const members = await indexed();
    expect(members).toHaveLength(2);
    const open = await getOpenOrders(USER);
    const frontend = await getFrontendOpenOrders(USER);
    expect(open.map((row) => row.limitPx)).toEqual(['90']);
    expect(frontend.map((row) => row.limitPx)).toEqual(['90']);
  });
});
