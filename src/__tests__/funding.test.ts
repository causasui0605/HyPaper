import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

const mockConfig = {
  FUNDING_ENABLED: true,
  FUNDING_INTERVAL_MS: 28_800_000,
  FEES_ENABLED: false,
  FEE_RATE_TAKER: '0.00035',
  FEE_RATE_MAKER: '0.0001',
  LOG_LEVEL: 'silent',
};

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

const { FundingWorker, pnlFundingEventId } = await import('../worker/funding-worker.js');
const { getUserFunding } = await import('../engine/funding-history.js');

describe('FundingWorker', () => {
  let worker: InstanceType<typeof FundingWorker>;

  const USER = '0xfundtest';
  const COIN = 'BTC';
  const ASSET = 0;

  beforeEach(() => {
    vi.restoreAllMocks();
    redisMock.flushall();
    mockConfig.FUNDING_ENABLED = true;
    mockConfig.FUNDING_INTERVAL_MS = 28_800_000;
    worker = new FundingWorker();
  });

  async function seedUser(balance: string) {
    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', balance);
  }

  async function setPosition(szi: string, entryPx: string) {
    await redisMock.hset(
      KEYS.USER_POS(USER, ASSET),
      'userId', USER,
      'asset', ASSET.toString(),
      'coin', COIN,
      'szi', szi,
      'entryPx', entryPx,
      'cumFunding', '0',
      'cumFundingSinceOpen', '0',
      'cumFundingSinceChange', '0',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(USER), ASSET.toString());
    await redisMock.sadd(KEYS.USERS_ACTIVE, USER);
  }

  async function setMarketCtx(coin: string, oraclePx: string, funding: string) {
    await redisMock.hset(KEYS.MARKET_CTX(coin),
      'oraclePx', oraclePx,
      'funding', funding,
    );
  }

  it('deducts funding from long position when rate is positive', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    // fundingCharge = 1 * 50000 * 0.0001 = 5
    // balance = 100000 - 5 = 99995
    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBeCloseTo(99995, 2);

    const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
    expect(pos.cumFunding).toBe('5');
    expect(pos.cumFundingSinceOpen).toBe('5');
    expect(pos.cumFundingSinceChange).toBe('5');
  });

  it('uses the oracle price, not the mark price, and canonicalizes source decimals', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000.0', '0.0001000');
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '60000');

    await worker.applyFunding();

    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('99995');
    const [id] = await redisMock.lrange(KEYS.PNL_FUNDING_EVENTS(USER), 0, -1);
    const event = JSON.parse((await redisMock.get(KEYS.PNL_FUNDING_EVENT(USER, id)))!);
    expect(event.oraclePx).toBe('50000');
    expect(event.fundingRate).toBe('0.0001');
    expect(event).not.toHaveProperty('markPx');
  });

  it('atomically stores a canonical immutable funding event', async () => {
    const now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    const fundingTime = Math.floor(now / mockConfig.FUNDING_INTERVAL_MS)
      * mockConfig.FUNDING_INTERVAL_MS;
    const id = pnlFundingEventId(USER, ASSET, fundingTime);
    await expect(redisMock.lrange(KEYS.PNL_FUNDING_EVENTS(USER), 0, -1)).resolves.toEqual([id]);
    const event = JSON.parse((await redisMock.get(KEYS.PNL_FUNDING_EVENT(USER, id)))!);
    expect(event).toEqual({
      schema: 'hypaper_pnl_funding_event_v2',
      kind: 'pnl_funding_event',
      paper: true,
      eventId: id,
      asset: ASSET,
      coin: COIN,
      fundingTime,
      appliedAt: now,
      szi: '1',
      oraclePx: '50000',
      fundingRate: '0.0001',
      fundingCharge: '5',
      source: { kind: 'live_market_context' },
      accountBalanceBefore: '100000',
      accountBalanceAfter: '99995',
      cumFundingBefore: '0',
      cumFundingAfter: '5',
      cumFundingSinceOpenBefore: '0',
      cumFundingSinceOpenAfter: '5',
      cumFundingSinceChangeBefore: '0',
      cumFundingSinceChangeAfter: '5',
    });
  });

  it('adopts an identical same-bucket retry without double charging', async () => {
    const now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();
    await worker.applyFunding();

    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('99995');
    await expect(redisMock.hget(KEYS.USER_POS(USER, ASSET), 'cumFunding')).resolves.toBe('5');
    await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(USER))).resolves.toBe(1);
  });

  it('refuses a same-bucket retry whose immutable source inputs conflict', async () => {
    const now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');
    await worker.applyFunding();
    const fundingTime = Math.floor(now / mockConfig.FUNDING_INTERVAL_MS)
      * mockConfig.FUNDING_INTERVAL_MS;

    await expect(worker.applyFundingEvent({
      userId: USER,
      asset: ASSET,
      coin: COIN,
      fundingTime,
      appliedAt: now + 1,
      expectedSzi: '1',
      oraclePx: '50000',
      fundingRate: '0.0001',
      source: {
        kind: 'verified_backfill',
        oracleSourceSha256: 'a'.repeat(64),
        fundingSourceSha256: 'b'.repeat(64),
      },
    })).rejects.toThrow(/conflicting immutable evidence/);
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('99995');
  });

  it('records the next funding bucket as a second immutable event', async () => {
    let now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();
    now += mockConfig.FUNDING_INTERVAL_MS;
    await worker.applyFunding();

    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('99990');
    await expect(redisMock.hget(KEYS.USER_POS(USER, ASSET), 'cumFunding')).resolves.toBe('10');
    const ids = await redisMock.lrange(KEYS.PNL_FUNDING_EVENTS(USER), 0, -1);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('serves signed local userFunding rows with exact time filtering', async () => {
    let now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');
    await worker.applyFunding();
    const first = Math.floor(now / mockConfig.FUNDING_INTERVAL_MS) * mockConfig.FUNDING_INTERVAL_MS;
    now += mockConfig.FUNDING_INTERVAL_MS;
    await worker.applyFunding();

    await expect(getUserFunding(USER, first + 1, now, redisMock)).resolves.toEqual([{
      time: first + mockConfig.FUNDING_INTERVAL_MS,
      hash: pnlFundingEventId(USER, ASSET, first + mockConfig.FUNDING_INTERVAL_MS),
      delta: {
        type: 'funding', coin: COIN, usdc: '-5', szi: '1', fundingRate: '0.0001',
      },
    }]);
  });

  it('does not let one malformed position suppress an independent valid funding event', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');
    await redisMock.hset(
      KEYS.USER_POS(USER, 1),
      'userId', USER, 'asset', '1', 'coin', 'ETH', 'szi', '1',
      'cumFunding', '0', 'cumFundingSinceOpen', '0', 'cumFundingSinceChange', '0',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(USER), '1');

    await expect(worker.applyFunding()).rejects.toThrow(/ETH is missing funding rate/);
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('99995');
    await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(USER))).resolves.toBe(1);
  });

  it('fails closed without partial writes when the atomic preconditions change', async () => {
    const now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');
    vi.spyOn(redisMock, 'eval').mockResolvedValueOnce(JSON.stringify({
      state: 'refused', value: 'account balance changed before funding commit',
    }));

    await expect(worker.applyFunding()).rejects.toThrow(/account balance changed/);
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('100000');
    await expect(redisMock.hget(KEYS.USER_POS(USER, ASSET), 'cumFunding')).resolves.toBe('0');
    await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(USER))).resolves.toBe(0);
  });

  it('retains immutable funding evidence after ordinary position and funding-state deletion', async () => {
    const now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');
    await worker.applyFunding();
    const [id] = await redisMock.lrange(KEYS.PNL_FUNDING_EVENTS(USER), 0, -1);

    await redisMock.del(
      KEYS.USER_POS(USER, ASSET), KEYS.USER_POSITIONS(USER), KEYS.USER_FUNDINGS(USER),
    );

    await expect(redisMock.get(KEYS.PNL_FUNDING_EVENT(USER, id))).resolves.not.toBeNull();
    await expect(redisMock.lrange(KEYS.PNL_FUNDING_EVENTS(USER), 0, -1)).resolves.toEqual([id]);
  });

  it('credits funding to short position when rate is positive', async () => {
    await seedUser('100000');
    await setPosition('-1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    // fundingCharge = -1 * 50000 * 0.0001 = -5
    // balance = 100000 - (-5) = 100005 (short receives funding)
    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(parseFloat(account.balance)).toBeCloseTo(100005, 2);

    const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
    expect(pos.cumFunding).toBe('-5');
  });

  it('canonically records a negative fractional charge for a short position', async () => {
    const now = 1_800_000_123_456;
    worker = new FundingWorker({ redis: redisMock, now: () => now });
    await seedUser('100000');
    await setPosition('-0.1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('100000.5');
    const [id] = await redisMock.lrange(KEYS.PNL_FUNDING_EVENTS(USER), 0, -1);
    const event = JSON.parse((await redisMock.get(KEYS.PNL_FUNDING_EVENT(USER, id)))!);
    expect(event.fundingCharge).toBe('-0.5');
    expect(event.cumFundingAfter).toBe('-0.5');
  });

  it('updates all cumFunding fields correctly', async () => {
    await seedUser('100000');
    // Start with some existing cumFunding
    await redisMock.hset(
      KEYS.USER_POS(USER, ASSET),
      'userId', USER, 'asset', '0', 'coin', COIN,
      'szi', '2', 'entryPx', '50000',
      'cumFunding', '10',
      'cumFundingSinceOpen', '10',
      'cumFundingSinceChange', '5',
    );
    await redisMock.sadd(KEYS.USER_POSITIONS(USER), '0');
    await redisMock.sadd(KEYS.USERS_ACTIVE, USER);
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    // fundingCharge = 2 * 50000 * 0.0001 = 10
    const pos = await redisMock.hgetall(KEYS.USER_POS(USER, ASSET));
    expect(pos.cumFunding).toBe('20');
    expect(pos.cumFundingSinceOpen).toBe('20');
    expect(pos.cumFundingSinceChange).toBe('15');
  });

  it('does nothing when FUNDING_ENABLED is false', async () => {
    mockConfig.FUNDING_ENABLED = false;
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0.0001');

    await worker.applyFunding();

    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(account.balance).toBe('100000');
  });

  it('skips when funding rate is zero', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    await setMarketCtx(COIN, '50000', '0');

    await worker.applyFunding();

    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(account.balance).toBe('100000');
  });

  it('refuses when funding rate is missing', async () => {
    await seedUser('100000');
    await setPosition('1', '50000');
    // Set market ctx without funding
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'oraclePx', '50000');

    await expect(worker.applyFunding()).rejects.toThrow(/missing funding rate/);

    const account = await redisMock.hgetall(KEYS.USER_ACCOUNT(USER));
    expect(account.balance).toBe('100000');
  });

  it('removes user from USERS_ACTIVE when no positions', async () => {
    await seedUser('100000');
    // Add user as active but with no positions
    await redisMock.sadd(KEYS.USERS_ACTIVE, USER);

    await worker.applyFunding();

    const activeUsers = await redisMock.smembers(KEYS.USERS_ACTIVE);
    expect(activeUsers).not.toContain(USER);
  });

  it('refuses invalid interval and clock inputs before reading active users', async () => {
    const smembers = vi.spyOn(redisMock, 'smembers');
    mockConfig.FUNDING_INTERVAL_MS = 0;
    await expect(worker.applyFunding()).rejects.toThrow(/strictly positive safe integer/);
    expect(smembers).not.toHaveBeenCalled();

    mockConfig.FUNDING_INTERVAL_MS = 28_800_000;
    worker = new FundingWorker({ redis: redisMock, now: () => Number.NaN });
    await expect(worker.applyFunding()).rejects.toThrow(/non-negative safe integer/);
    expect(smembers).not.toHaveBeenCalled();
  });
});
