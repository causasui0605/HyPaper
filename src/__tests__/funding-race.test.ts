import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

const mockConfig = {
  FUNDING_ENABLED: true,
  FUNDING_INTERVAL_MS: 3_600_000,
  FUNDING_APPLY_DELAY_MS: 30_000,
  FUNDING_MAX_LATE_MS: 55_000,
  FUNDING_RETRY_MS: 5_000,
  LOG_LEVEL: 'silent',
};

vi.mock('../config.js', () => ({
  config: mockConfig,
}));

const {
  FundingWorker,
  FUNDING_CONTEXT_WINDOW_MS,
  pnlFundingEventId,
} = await import('../worker/funding-worker.js');

// An exact hourly boundary: 1_800_000_000_000 / 3_600_000 = 500_000.
const T = 1_800_000_000_000;

type RateFn = (coin: string, fundingTime: number) => Promise<{ rate: string; observedTime: number }>;

function makeWorker(now: () => number, fundingRateAt: RateFn) {
  return new FundingWorker({ redis: redisMock, now, fundingRateAt });
}

async function seedAccount(user: string, balance: string) {
  await redisMock.hset(KEYS.USER_ACCOUNT(user), 'userId', user, 'balance', balance);
}

async function seedPosition(user: string, asset: number, coin: string, szi: string) {
  await redisMock.hset(
    KEYS.USER_POS(user, asset),
    'userId', user,
    'asset', String(asset),
    'coin', coin,
    'szi', szi,
    'entryPx', '100',
    'cumFunding', '0',
    'cumFundingSinceOpen', '0',
    'cumFundingSinceChange', '0',
  );
  await redisMock.sadd(KEYS.USER_POSITIONS(user), String(asset));
  await redisMock.sadd(KEYS.USERS_ACTIVE, user);
}

async function seedContext(coin: string, oraclePx: string, observedAt: number) {
  await redisMock.hset(KEYS.MARKET_CTX(coin),
    'oraclePx', oraclePx,
    'funding', '0.5',
    'observedAt', String(observedAt),
  );
}

async function storedEvent(user: string, asset: number) {
  const raw = await redisMock.get(KEYS.PNL_FUNDING_EVENT(user, pnlFundingEventId(user, asset, T)));
  return raw === null ? null : JSON.parse(raw);
}

const fixedRate: RateFn = async (_coin, fundingTime) => ({ rate: '0.0001', observedTime: fundingTime });

describe('funding context freshness window', () => {
  const USER = '0xfresh';

  beforeEach(() => {
    vi.restoreAllMocks();
    redisMock.flushall();
    mockConfig.FUNDING_MAX_LATE_MS = 55_000;
  });

  it('accepts a context observed after the attempt started (inside the bound)', async () => {
    // Attempt starts at T+30s; the websocket refreshed the context at T+40s.
    const worker = makeWorker(() => T + 30_000, fixedRate);
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '2');
    await seedContext('BTC', '100', T + 40_000);

    await worker.applyFunding(T, true);

    // charge = 2 * 100 * 0.0001 = 0.02; balance = 1000 - 0.02 = 999.98
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('999.98');
    const event = await storedEvent(USER, 0);
    expect(event.fundingCharge).toBe('0.02');
    expect(event.appliedAt).toBe(T + 30_000);
    expect(event.source).toEqual({
      kind: 'live_boundary_snapshot', fundingHistoryTime: T, contextObservedAt: T + 40_000,
    });
  });

  it('accepts a context observed exactly at the bound', async () => {
    const worker = makeWorker(() => T + 30_000, fixedRate);
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '2');
    await seedContext('BTC', '100', T + FUNDING_CONTEXT_WINDOW_MS);

    await worker.applyFunding(T, true);

    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('999.98');
  });

  it('refuses a stale context observed before the boundary', async () => {
    const worker = makeWorker(() => T + 30_000, fixedRate);
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '2');
    await seedContext('BTC', '100', T - 1);

    await expect(worker.applyFunding(T, true)).rejects.toThrow(/not fresh for the boundary/);
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('1000');
    await expect(storedEvent(USER, 0)).resolves.toBeNull();
  });

  it('refuses a context observed past the bound', async () => {
    const worker = makeWorker(() => T + 30_000, fixedRate);
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '2');
    await seedContext('BTC', '100', T + FUNDING_CONTEXT_WINDOW_MS + 1);

    await expect(worker.applyFunding(T, true)).rejects.toThrow(/not fresh for the boundary/);
    await expect(storedEvent(USER, 0)).resolves.toBeNull();
  });

  it('documents a bound that covers the whole retry window and refuses a config that exceeds it', () => {
    expect(FUNDING_CONTEXT_WINDOW_MS).toBe(120_000);
    expect(FUNDING_CONTEXT_WINDOW_MS).toBeGreaterThan(mockConfig.FUNDING_MAX_LATE_MS);
    mockConfig.FUNDING_MAX_LATE_MS = FUNDING_CONTEXT_WINDOW_MS;
    const worker = new FundingWorker({
      redis: redisMock,
      now: () => T,
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });
    // MAX_LATE (120s) >= INTERVAL is false, so only the window check can refuse.
    expect(() => worker.start()).toThrow(/freshness window/);
  });
});

describe('funding attempt context snapshot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    redisMock.flushall();
    mockConfig.FUNDING_MAX_LATE_MS = 55_000;
  });

  it('funds 60 positions in one attempt while every context is rewritten during the loop', async () => {
    const users = ['0xsnap0', '0xsnap1', '0xsnap2'];
    const positions: Array<{ user: string; asset: number; coin: string }> = [];
    for (const [u, user] of users.entries()) {
      await seedAccount(user, '1000');
      for (let i = 0; i < 20; i++) {
        const asset = u * 20 + i;
        const coin = `C${asset}`;
        positions.push({ user, asset, coin });
        await seedPosition(user, asset, coin, '1');
        await seedContext(coin, '100', T + 29_000);
      }
    }
    const ctxDirectReads = vi.spyOn(redisMock, 'hgetall');

    // Each fundingHistory call (one per coin) races the websocket/xyz poll: every
    // context is rewritten with a new oracle price and an observation time past
    // the bound. A per-position read would refuse every later position.
    const ctxReads = () => ctxDirectReads.mock.calls
      .filter(([key]) => key.startsWith('market:ctx:')).length;
    let calls = 0;
    let ctxReadsAtFirstCall = -1;
    const racingRate: RateFn = async (_coin, fundingTime) => {
      calls += 1;
      if (calls === 1) ctxReadsAtFirstCall = ctxReads();
      for (const { coin } of positions) {
        await redisMock.hset(KEYS.MARKET_CTX(coin),
          'oraclePx', '999', 'observedAt', String(T + FUNDING_CONTEXT_WINDOW_MS + calls));
      }
      return { rate: '0.0001', observedTime: fundingTime };
    };
    const worker = makeWorker(() => T + 30_000, racingRate);

    await worker.applyFunding(T, true);

    expect(calls).toBe(60);
    for (const { user, asset } of positions) {
      const event = await storedEvent(user, asset);
      // 1 * 100 * 0.0001 = 0.01, priced from the snapshot, not the rewrite.
      expect(event.oraclePx).toBe('100');
      expect(event.fundingCharge).toBe('0.01');
      expect(event.source.contextObservedAt).toBe(T + 29_000);
    }
    for (const user of users) {
      await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(user))).resolves.toBe(20);
      // 1000 - 20 * 0.01 = 999.8
      await expect(redisMock.hget(KEYS.USER_ACCOUNT(user), 'balance')).resolves.toBe('999.8');
    }
    // Every context is read exactly once per attempt, all of them before the
    // loop's first venue call (the mock pipeline replays through hgetall).
    expect(ctxReadsAtFirstCall).toBe(60);
    expect(ctxReads()).toBe(60);
  });

  it('calls fundingHistory once per coin, not once per position', async () => {
    await seedAccount('0xa', '1000');
    await seedAccount('0xb', '1000');
    await seedPosition('0xa', 0, 'BTC', '1');
    await seedPosition('0xb', 0, 'BTC', '-1');
    await seedContext('BTC', '100', T + 29_000);
    const rate = vi.fn(fixedRate);
    const worker = makeWorker(() => T + 30_000, rate);

    await worker.applyFunding(T, true);

    expect(rate).toHaveBeenCalledTimes(1);
    await expect(redisMock.hget(KEYS.USER_ACCOUNT('0xa'), 'balance')).resolves.toBe('999.99');
    await expect(redisMock.hget(KEYS.USER_ACCOUNT('0xb'), 'balance')).resolves.toBe('1000.01');
  });
});

describe('funding retry idempotence', () => {
  const USER = '0xretry';

  beforeEach(() => {
    vi.restoreAllMocks();
    redisMock.flushall();
    mockConfig.FUNDING_MAX_LATE_MS = 55_000;
  });

  it('attempt 2 funds the rest without conflicting immutable evidence', async () => {
    await seedAccount(USER, '1000');
    for (let asset = 0; asset < 10; asset++) {
      await seedPosition(USER, asset, `C${asset}`, '1');
      await seedContext(`C${asset}`, '100', T + 29_000);
    }
    let now = T + 30_000;
    const failOdd: RateFn = async (coin, fundingTime) => {
      if (Number(coin.slice(1)) % 2 === 1) throw new Error(`fundingHistory unavailable for ${coin}`);
      return { rate: '0.0001', observedTime: fundingTime };
    };
    const first = makeWorker(() => now, failOdd);

    await expect(first.applyFunding(T, true)).rejects.toThrow(/5 funding position\(s\) refused/);
    await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(USER))).resolves.toBe(5);
    const firstBytes = new Map<number, string | null>();
    for (let asset = 0; asset < 10; asset += 2) {
      firstBytes.set(asset, await redisMock.get(
        KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, asset, T)),
      ));
    }

    // Between attempts every volatile input moves: oracle price and observation time.
    for (let asset = 0; asset < 10; asset++) {
      await seedContext(`C${asset}`, '200', T + 34_000);
    }
    now = T + 35_000;
    const evalSpy = vi.spyOn(redisMock, 'eval');
    const rate = vi.fn(fixedRate);
    const second = makeWorker(() => now, rate);

    await expect(second.applyFunding(T, true)).resolves.toBeUndefined();

    // Only the five unfunded positions reach the Lua commit or the venue lookup.
    expect(evalSpy).toHaveBeenCalledTimes(5);
    expect(rate.mock.calls.map(([coin]) => coin).sort()).toEqual(['C1', 'C3', 'C5', 'C7', 'C9']);
    await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(USER))).resolves.toBe(10);
    for (const [asset, raw] of firstBytes) {
      await expect(redisMock.get(
        KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, asset, T)),
      )).resolves.toBe(raw);
    }
    const odd = await storedEvent(USER, 1);
    expect(odd.oraclePx).toBe('200');
    expect(odd.fundingCharge).toBe('0.02');
    expect(odd.appliedAt).toBe(T + 35_000);
    // 1000 - 5 * 0.01 - 5 * 0.02 = 999.85
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('999.85');
  });

  it('refuses to skip an existing event that is missing from the immutable ledger index', async () => {
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '1');
    await seedContext('BTC', '100', T + 29_000);
    const worker = makeWorker(() => T + 30_000, fixedRate);
    await worker.applyFunding(T, true);
    await redisMock.del(KEYS.PNL_FUNDING_EVENTS(USER));

    await expect(worker.applyFunding(T, true)).rejects.toThrow(/without immutable ledger index/);
  });

  it('refuses to skip an existing event whose stored bytes are malformed', async () => {
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '1');
    await seedContext('BTC', '100', T + 29_000);
    const id = pnlFundingEventId(USER, 0, T);
    await redisMock.set(KEYS.PNL_FUNDING_EVENT(USER, id), '{"not":"an event"}');
    await redisMock.rpush(KEYS.PNL_FUNDING_EVENTS(USER), id);
    const worker = makeWorker(() => T + 30_000, fixedRate);

    await expect(worker.applyFunding(T, true)).rejects.toThrow(/is malformed/);
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('1000');
  });

  it('refuses to skip an existing event whose stored coin conflicts with the position', async () => {
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '1');
    await seedContext('BTC', '100', T + 29_000);
    const worker = makeWorker(() => T + 30_000, fixedRate);
    await worker.applyFunding(T, true);
    const key = KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 0, T));
    const original = JSON.parse((await redisMock.get(key))!);
    // Same eventId, asset, fundingTime and ledger membership; only the coin differs.
    const tampered = JSON.stringify({ ...original, coin: 'ETH' });
    await redisMock.set(key, tampered);
    const evalSpy = vi.spyOn(redisMock, 'eval');
    const rate = vi.fn(fixedRate);
    const retry = makeWorker(() => T + 35_000, rate);

    await expect(retry.applyFunding(T, true)).rejects.toThrow(/identity conflicts/);
    expect(evalSpy).not.toHaveBeenCalled();
    expect(rate).not.toHaveBeenCalled();
    await expect(redisMock.get(key)).resolves.toBe(tampered);
    // 1000 - 1 * 100 * 0.0001 = 999.99, charged once by attempt 1 only.
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('999.99');
  });
});

describe('funding pipeline command-level failures', () => {
  const USER = '0xmixed';

  beforeEach(() => {
    vi.restoreAllMocks();
    redisMock.flushall();
    mockConfig.FUNDING_MAX_LATE_MS = 55_000;
  });

  it('a WRONGTYPE market context fails only its own position; the others are funded', async () => {
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '1');
    await seedPosition(USER, 1, 'BAD', '1');
    await seedPosition(USER, 2, 'ETH', '2');
    await seedContext('BTC', '100', T + 29_000);
    await seedContext('ETH', '50', T + 29_000);
    const realHgetall = redisMock.hgetall.bind(redisMock);
    vi.spyOn(redisMock, 'hgetall').mockImplementation(async (key: string) => {
      if (key === KEYS.MARKET_CTX('BAD')) {
        throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      }
      return realHgetall(key);
    });
    const worker = makeWorker(() => T + 30_000, fixedRate);

    await expect(worker.applyFunding(T, true)).rejects.toThrow(
      /1 funding position\(s\) refused: funding market context snapshot failed: WRONGTYPE/,
    );
    await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(USER))).resolves.toBe(2);
    expect(await storedEvent(USER, 1)).toBeNull();
    expect((await storedEvent(USER, 0)).fundingCharge).toBe('0.01');
    expect((await storedEvent(USER, 2)).fundingCharge).toBe('0.01');
    // 1000 - 1 * 100 * 0.0001 - 2 * 50 * 0.0001 = 999.98
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('999.98');
  });

  it('a WRONGTYPE recorded-event key fails only its own position', async () => {
    await seedAccount(USER, '1000');
    await seedPosition(USER, 0, 'BTC', '1');
    await seedPosition(USER, 1, 'ETH', '1');
    await seedContext('BTC', '100', T + 29_000);
    await seedContext('ETH', '100', T + 29_000);
    const badKey = KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 1, T));
    const realGet = redisMock.get.bind(redisMock);
    vi.spyOn(redisMock, 'get').mockImplementation(async (key: string) => {
      if (key === badKey) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
      return realGet(key);
    });
    const worker = makeWorker(() => T + 30_000, fixedRate);

    await expect(worker.applyFunding(T, true)).rejects.toThrow(
      /1 funding position\(s\) refused: funding position snapshot failed: WRONGTYPE/,
    );
    await expect(redisMock.llen(KEYS.PNL_FUNDING_EVENTS(USER))).resolves.toBe(1);
    expect((await storedEvent(USER, 0)).fundingCharge).toBe('0.01');
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('999.99');
  });
});
