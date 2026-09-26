import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

// One account's whole life through the real writers, then the real V2 engine:
// replay record -> IOC entry (real placeOrders) -> hourly funding (real
// FundingWorker) -> IOC close (real placeOrders) -> getCashLedgerEvidenceV2.
const redisMock = new RedisMock();
const HOUR = 3_600_000;

vi.mock('../store/redis.js', () => ({ redis: redisMock }));
vi.mock('../config.js', () => ({
  config: {
    FEES_ENABLED: false, FEE_RATE_TAKER: '0.00035', FEE_RATE_MAKER: '0.0001', LOG_LEVEL: 'silent',
    FUNDING_ENABLED: true, FUNDING_INTERVAL_MS: 3_600_000, FUNDING_APPLY_DELAY_MS: 30_000,
    FUNDING_MAX_LATE_MS: 55_000, FUNDING_RETRY_MS: 5_000,
  },
}));
vi.mock('../utils/l2-cache.js', () => ({ getL2Book: vi.fn().mockResolvedValue(null) }));
let idCounter = 0;
vi.mock('../utils/id.js', () => ({
  nextOid: vi.fn(async () => ++idCounter),
  nextTid: vi.fn(async () => ++idCounter),
}));
vi.mock('../worker/index.js', () => ({ eventBus: new EventEmitter() }));
vi.mock('../engine/margin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine/margin.js')>()),
  checkMarginForOrder: vi.fn(async () => true),
}));
vi.mock('../engine/asset.js', () => ({
  getAssetMetadata: vi.fn(async (asset: number) => (asset === 110029
    ? { coin: 'xyz:CL', szDecimals: 3, maxLeverage: 20, onlyIsolated: false }
    : null)),
}));

const { placeOrders } = await import('../engine/order.js');
const { getClearinghouseState, getOpenOrders } = await import('../engine/position.js');
const { FundingWorker } = await import('../worker/funding-worker.js');
const { getCashLedgerEvidenceV2 } = await import('../engine/cash-ledger-evidence.js');

const USER = `0x${'2'.repeat(40)}`;
const ASSET = 110029;
const COIN = 'xyz:CL';

function ioc(isBuy: boolean, px: string, reduceOnly: boolean) {
  return { a: ASSET, b: isBuy, p: px, s: '0.1', r: reduceOnly, t: { limit: { tif: 'Ioc' as const } } };
}

async function liveAccountWithImmediateFills(): Promise<{ replay: Record<string, any>; fixture: any }> {
  const fixture = JSON.parse(readFileSync('plans/fixtures/hypaper_cash_f7_s2_success.json', 'utf8'));
  const replay = { ...fixture.source_inventory.replay.rows[0].source } as Record<string, any>;
  replay.user = USER;
  delete replay.wallet_fingerprint;
  expect(replay.positions).toEqual([]);
  await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', replay.finalBalance, 'createdAt', '500');
  await redisMock.set(KEYS.HISTORICAL_REPLAY_INDEX(USER), replay.batchId);
  await redisMock.set(KEYS.HISTORICAL_REPLAY_BATCH(USER, replay.batchId), JSON.stringify(replay));
  await redisMock.hset(KEYS.MARKET_MIDS, COIN, '94.344');
  await redisMock.hset(KEYS.MARKET_CTX(COIN), 'oraclePx', '94.3', 'funding', '0.0000125', 'markPx', '94.344');

  vi.setSystemTime(HOUR - 100_000);
  const [entry] = await placeOrders(USER, [ioc(true, '95.287', false)], 'na');
  expect(entry).toHaveProperty('filled');

  vi.setSystemTime(HOUR + 35_000);
  await new FundingWorker({ now: () => Date.now() }).applyFunding(HOUR);

  vi.setSystemTime(HOUR + 100_000);
  const [close] = await placeOrders(USER, [ioc(false, '93.4', true)], 'na');
  expect(close).toHaveProperty('filled');
  return { replay, fixture };
}

describe('V2 cash evidence over orders written by the real writer', () => {
  afterEach(() => {
    vi.useRealTimers();
    redisMock.flushall();
  });

  it('accepts an account whose history holds only immediately filled orders', async () => {
    vi.useFakeTimers();
    redisMock.flushall();
    idCounter = 100;
    const { replay, fixture } = await liveAccountWithImmediateFills();
    expect(await redisMock.zrange(KEYS.USER_ORDERS(USER), 0, -1)).toHaveLength(2);

    const request = {
      type: 'getCashLedgerEvidenceV2', user: USER, dex: 'xyz', coins: [COIN],
      coverageStartMs: HOUR, coverageEndMs: HOUR, finalFlatRequired: true,
      scope: 'whole_account_replay_epoch', expectedReplayBatchId: replay.batchId,
    };
    const receipt = await getCashLedgerEvidenceV2(request, {
      redis: redisMock as any,
      historicalReplay: async () => replay,
      clearinghouseState: (user: string) => getClearinghouseState(user),
      openOrders: (user: string) => getOpenOrders(user),
      now: () => 2 * HOUR + 100_000,
      providerIdentity: fixture.provider_identity,
      maxBytes: 1_000_000,
    });
    expect(receipt.source_inventory.orders.rows.map((row: any) => row.source.status)).toEqual(['filled', 'filled']);
    expect(receipt.source_inventory.ordinary_fills.rows).toHaveLength(2);
    expect(receipt.source_inventory.funding_records.rows).toHaveLength(1);
  });

  it('refuses the same account when an immediately filled order is missing from the index', async () => {
    vi.useFakeTimers();
    redisMock.flushall();
    idCounter = 100;
    const { replay, fixture } = await liveAccountWithImmediateFills();
    const [first] = await redisMock.zrange(KEYS.USER_ORDERS(USER), 0, -1);
    const members = (await redisMock.zrange(KEYS.USER_ORDERS(USER), 0, -1)).filter((id) => id !== first);
    await redisMock.del(KEYS.USER_ORDERS(USER));
    for (const id of members) await redisMock.zadd(KEYS.USER_ORDERS(USER), 1, id);
    await expect(getCashLedgerEvidenceV2({
      type: 'getCashLedgerEvidenceV2', user: USER, dex: 'xyz', coins: [COIN],
      coverageStartMs: HOUR, coverageEndMs: HOUR, finalFlatRequired: true,
      scope: 'whole_account_replay_epoch', expectedReplayBatchId: replay.batchId,
    }, {
      redis: redisMock as any,
      historicalReplay: async () => replay,
      clearinghouseState: (user: string) => getClearinghouseState(user),
      openOrders: (user: string) => getOpenOrders(user),
      now: () => 2 * HOUR + 100_000,
      providerIdentity: fixture.provider_identity,
      maxBytes: 1_000_000,
    })).rejects.toThrow(/absent from user order index/);
  });
});
