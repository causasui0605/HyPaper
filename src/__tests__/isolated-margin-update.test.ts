import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { RedisMock } from './helpers/redis-mock.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

vi.mock('../config.js', () => ({
  config: { DEFAULT_BALANCE: '10000', LOG_LEVEL: 'silent' },
}));

vi.mock('../api/middleware/auth.js', () => ({
  ensureAccount: vi.fn(async () => {}),
}));

vi.mock('../store/pg-sink.js', () => ({
  upsertUser: vi.fn(async () => {}),
  updateUserBalance: vi.fn(async () => {}),
}));

const {
  updateIsolatedMargin,
  IsolatedMarginRefusal,
  UPDATE_ISOLATED_MARGIN_LUA,
} = await import('../engine/margin.js');
const { getClearinghouseState } = await import('../engine/position.js');
const { exchangeRouter } = await import('../api/routes/exchange.js');
const { KEYS } = await import('../store/keys.js');

const USER = '0xpaper';
const ASSET = 110001;
const COIN = 'xyz:NATGAS';

// --- Test double for the Lua compare-and-set. Redis runs a script atomically; the
// double serialises evaluations and applies the same spec semantics as the Lua. ---
type Spec = {
  checks: Array<[number, string, boolean, string]>;
  set: number;
  members: string[];
  target: number;
  margin: string;
};
let evalQueue: Promise<unknown> = Promise.resolve();
async function casDouble(keys: string[], spec: Spec): Promise<string> {
  for (const [index, field, present, value] of spec.checks) {
    const actual = await redisMock.hget(keys[index - 1], field);
    if (present ? actual !== value : actual !== null) return 'conflict';
  }
  const members = await redisMock.smembers(keys[spec.set - 1]);
  if (members.length !== spec.members.length) return 'conflict';
  if (!spec.members.every((m) => members.includes(m))) return 'conflict';
  await redisMock.hset(keys[spec.target - 1], 'isolatedMargin', spec.margin);
  return 'applied';
}
const originalEval = redisMock.eval.bind(redisMock);
const evalSpy = vi.spyOn(redisMock, 'eval').mockImplementation(
  async (script: string, numberOfKeys: number, ...args: string[]) => {
    if (script !== UPDATE_ISOLATED_MARGIN_LUA) return originalEval(script, numberOfKeys, ...args);
    const keys = args.slice(0, numberOfKeys);
    const spec = JSON.parse(args[numberOfKeys]) as Spec;
    const run = evalQueue.then(() => casDouble(keys, spec));
    evalQueue = run.catch(() => undefined);
    return run;
  },
);

function snapshot(): string {
  const internals = redisMock as unknown as Record<string, Map<string, unknown>>;
  const dump = (m: Map<string, unknown>) => [...m.entries()]
    .map(([k, v]) => [k, v instanceof Map ? [...v.entries()].sort() : v instanceof Set ? [...v].sort() : v])
    .sort();
  return JSON.stringify(['store', 'hashes', 'sets', 'sortedSets', 'lists'].map((n) => dump(internals[n])));
}

/** Short 100 xyz:NATGAS at entry = mark = 2.5 (notional 250), isolated at `leverage`. */
async function seed(opts: {
  balance?: string;
  leverage?: string;
  maxLeverage?: number;
  isolatedMargin?: string;
  szi?: string;
} = {}): Promise<void> {
  await redisMock.hset(
    KEYS.MARKET_ASSET_MAP,
    ASSET.toString(),
    JSON.stringify({ coin: COIN, szDecimals: 1, maxLeverage: opts.maxLeverage ?? 2, onlyIsolated: true }),
  );
  await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '2.5');
  await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', opts.balance ?? '1000');
  await redisMock.hset(
    KEYS.USER_LEV(USER, ASSET),
    'leverage', opts.leverage ?? '2',
    'isCross', 'false',
    'isolatedMargin', opts.isolatedMargin ?? '125',
  );
  await redisMock.hset(
    KEYS.USER_POS(USER, ASSET),
    'userId', USER,
    'asset', ASSET.toString(),
    'coin', COIN,
    'szi', opts.szi ?? '-100',
    'entryPx', '2.5',
  );
  await redisMock.sadd(KEYS.USER_POSITIONS(USER), ASSET.toString());
}

async function seedOther(opts: { szi?: string; leverage?: string }): Promise<void> {
  // A second, cross position on another asset of the same wallet.
  const other = 110002;
  const fields: string[] = ['userId', USER, 'asset', other.toString(), 'coin', 'xyz:OTHER', 'entryPx', '10'];
  if (opts.szi !== undefined || !('szi' in opts)) fields.push('szi', opts.szi ?? '1');
  await redisMock.hset(KEYS.USER_POS(USER, other), ...fields);
  await redisMock.hset(KEYS.USER_LEV(USER, other), 'isCross', 'true', 'leverage', opts.leverage ?? '5');
  await redisMock.hset(KEYS.MARKET_CTX('xyz:OTHER'), 'markPx', '10');
  await redisMock.sadd(KEYS.USER_POSITIONS(USER), other.toString());
}

async function storedMargin(): Promise<string | null> {
  return redisMock.hget(KEYS.USER_LEV(USER, ASSET), 'isolatedMargin');
}

describe('updateIsolatedMargin', () => {
  beforeEach(() => {
    redisMock.flushall();
    evalSpy.mockClear();
  });

  it('adds 5 USD: margin +5, withdrawable -5, account value unchanged, liquidation moves', async () => {
    await seed();
    const before = await getClearinghouseState(USER);
    expect(before.assetPositions[0].position.marginUsed).toBe('125');
    // short liqPx = (entry + margin/|szi|) / (1 + 1/(2*maxLev)) = (2.5 + 1.25) / 1.25 = 3
    expect(before.assetPositions[0].position.liquidationPx).toBe('3');
    expect(before.withdrawable).toBe('875');

    await expect(updateIsolatedMargin(USER, ASSET, false, 5_000_000)).resolves.toEqual({
      isolatedMarginBefore: '125',
      isolatedMarginAfter: '130',
    });

    const after = await getClearinghouseState(USER);
    const position = after.assetPositions[0].position;
    expect(position.marginUsed).toBe('130');
    expect(position.leverage).toEqual({ type: 'isolated', value: 2, rawUsd: '130' });
    // (2.5 + 1.3) / 1.25 = 3.04
    expect(position.liquidationPx).toBe('3.04');
    expect(after.marginSummary.totalMarginUsed).toBe('130');
    expect(after.withdrawable).toBe('870');
    expect(after.marginSummary.accountValue).toBe('1000');
    expect(before.marginSummary.accountValue).toBe('1000');
    // activeAssetData's rawUsd reads this stored field.
    await expect(storedMargin()).resolves.toBe('130');
    await expect(redisMock.hget(KEYS.USER_ACCOUNT(USER), 'balance')).resolves.toBe('1000');
  });

  it('removes within the requirement with the mirror effects, down to exactly the requirement', async () => {
    // 2x: requirement = max(250 / 2, 0.1 * 250) = 125
    await seed({ isolatedMargin: '130' });
    await updateIsolatedMargin(USER, ASSET, false, -5_000_000);
    const state = await getClearinghouseState(USER);
    expect(state.assetPositions[0].position.marginUsed).toBe('125');
    expect(state.assetPositions[0].position.liquidationPx).toBe('3');
    expect(state.withdrawable).toBe('875');
    expect(state.marginSummary.accountValue).toBe('1000');

    const unchanged = snapshot();
    await expect(updateIsolatedMargin(USER, ASSET, false, -1)).rejects.toThrow(
      'below the transfer margin requirement 125',
    );
    expect(snapshot()).toBe(unchanged);
  });

  it('uses the 10% floor when it exceeds initial margin', async () => {
    // 20x: initial 250 / 20 = 12.5, 10% floor 25 -> requirement 25
    await seed({ leverage: '20', maxLeverage: 20, isolatedMargin: '30' });
    const unchanged = snapshot();
    await expect(updateIsolatedMargin(USER, ASSET, false, -5_000_001)).rejects.toThrow(
      'below the transfer margin requirement 25',
    );
    expect(snapshot()).toBe(unchanged);
    await updateIsolatedMargin(USER, ASSET, false, -5_000_000);
    await expect(storedMargin()).resolves.toBe('25');
  });

  it('derives the current margin when none is stored and moves by ntli exactly', async () => {
    await seed({ isolatedMargin: '0' });
    await updateIsolatedMargin(USER, ASSET, false, 1);
    await expect(storedMargin()).resolves.toBe('125.000001');

    await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'balance', '10000');
    await redisMock.hset(KEYS.USER_LEV(USER, ASSET), 'isolatedMargin', '1234.56789012345678901234567891');
    await updateIsolatedMargin(USER, ASSET, false, 1_000_000_000);
    // 31 significant digits: no rounding at the ambient 30-digit precision.
    await expect(storedMargin()).resolves.toBe('2234.56789012345678901234567891');
  });

  it('refuses an add above withdrawable and accepts exactly withdrawable', async () => {
    await seed();
    const unchanged = snapshot();
    await expect(updateIsolatedMargin(USER, ASSET, false, 875_000_001)).rejects.toThrow(
      'Insufficient withdrawable balance',
    );
    expect(snapshot()).toBe(unchanged);
    await updateIsolatedMargin(USER, ASSET, false, 875_000_000);
    await expect(storedMargin()).resolves.toBe('1000');
    expect((await getClearinghouseState(USER)).withdrawable).toBe('0');
  });

  it('refuses every invalid request with no Redis change', async () => {
    const cases: Array<[string, () => Promise<void>, () => Promise<unknown>, string]> = [
      ['unknown asset', async () => {}, () => updateIsolatedMargin(USER, 110999, false, 1), 'Unknown asset 110999'],
      ['non-integer asset', async () => {}, () => updateIsolatedMargin(USER, 1.5, false, 1), 'Unknown asset'],
      ['no position', async () => {
        await redisMock.del(KEYS.USER_POS(USER, ASSET));
        await redisMock.srem(KEYS.USER_POSITIONS(USER), ASSET.toString());
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'has no open position'],
      ['zero-size position', async () => {
        await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'szi', '0');
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'has no open position'],
      ['cross position', async () => {
        await redisMock.hset(KEYS.USER_LEV(USER, ASSET), 'isCross', 'true');
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'on a cross position'],
      ['cross by default', async () => {
        await redisMock.del(KEYS.USER_LEV(USER, ASSET));
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'on a cross position'],
      ['ntli zero', async () => {}, () => updateIsolatedMargin(USER, ASSET, false, 0), 'ntli must be non-zero'],
      ['ntli fractional', async () => {}, () => updateIsolatedMargin(USER, ASSET, false, 1.5), 'safe integer'],
      ['ntli unsafe', async () => {}, () => updateIsolatedMargin(USER, ASSET, false, 2 ** 53), 'safe integer'],
      ['ntli string', async () => {}, () => updateIsolatedMargin(USER, ASSET, false, '5000000'), 'safe integer'],
      ['isBuy string', async () => {}, () => updateIsolatedMargin(USER, ASSET, 'false', 1), 'isBuy must be a boolean'],
      ['missing entry price', async () => {
        await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'entryPx', '');
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'entry price of asset 110001 is missing or malformed'],
      ['malformed entry price', async () => {
        await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'entryPx', 'NaN');
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'entry price of asset 110001 is missing or malformed'],
      ['another position without a size', async () => {
        await seedOther({ szi: undefined });
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'size of asset 110002 is missing or malformed'],
      ['another position with a malformed size', async () => {
        await seedOther({ szi: 'abc' });
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'size of asset 110002 is missing or malformed'],
      ['another cross position with malformed leverage', async () => {
        await seedOther({ leverage: 'NaN' });
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'Leverage of asset 110002 is malformed'],
      ['malformed balance', async () => {
        await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'balance', 'NaN');
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'account balance is missing or malformed'],
      ['infinite mark on another position (removal)', async () => {
        await seedOther({});
        await redisMock.hset(KEYS.MARKET_CTX('xyz:OTHER'), 'markPx', '1e9999999999999999');
      }, () => updateIsolatedMargin(USER, ASSET, false, -5_000_000), 'No finite positive mark price for xyz:OTHER'],
      ['infinite size on another position', async () => {
        await seedOther({ szi: '1e9999999999999999' });
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'size of asset 110002 is missing or malformed'],
      ['malformed mark', async () => {
        await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', 'abc');
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'no finite positive mark price'],
      ['missing mark', async () => {
        await redisMock.del(KEYS.MARKET_CTX(COIN));
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'no finite positive mark price'],
      ['zero mark', async () => {
        await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '0');
      }, () => updateIsolatedMargin(USER, ASSET, false, 1), 'no finite positive mark price'],
      ['removal below requirement', async () => {}, () => updateIsolatedMargin(USER, ASSET, false, -1),
        'below the transfer margin requirement'],
    ];
    for (const [name, arrange, act, message] of cases) {
      redisMock.flushall();
      await seed();
      await arrange();
      const unchanged = snapshot();
      const outcome = act();
      await expect(outcome, name).rejects.toBeInstanceOf(IsolatedMarginRefusal);
      await expect(outcome, name).rejects.toThrow(message);
      expect(snapshot(), name).toBe(unchanged);
    }
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('accepts isBuy true on a short position (the HL SDK always sends true)', async () => {
    await seed();
    await updateIsolatedMargin(USER, ASSET, true, 5_000_000);
    await expect(storedMargin()).resolves.toBe('130');
  });

  it('stores fixed-point margins: a removal to a tiny requirement, then an add, both succeed', async () => {
    // size 0.2, mark/entry 0.000001, leverage 2: requirement max(0.0000001, 0.00000002) = 0.0000001.
    await seed({ szi: '-0.2', isolatedMargin: '0.0000011' });
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '0.000001');
    await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'entryPx', '0.000001');
    await updateIsolatedMargin(USER, ASSET, true, -1);
    await expect(storedMargin()).resolves.toBe('0.0000001');
    await updateIsolatedMargin(USER, ASSET, true, 1);
    await expect(storedMargin()).resolves.toBe('0.0000011');
  });

  it('accepts an engine-written exponent value on another position', async () => {
    await seed();
    await seedOther({});
    await redisMock.hset(KEYS.USER_POS(USER, 110002), 'szi', '1e-7');
    await updateIsolatedMargin(USER, ASSET, true, 5_000_000);
    await expect(storedMargin()).resolves.toBe('130');
  });

  it('authorizes adds at full precision (no 30-digit rounding of stored margin)', async () => {
    await seed({ isolatedMargin: '124.999999000000000000000000000001' });
    const unchanged = snapshot();
    // withdrawable = 1000 − 124.999999000000000000000000000001 = 875.000000999999999999999999999999
    await expect(updateIsolatedMargin(USER, ASSET, false, 875_000_001)).rejects.toThrow('Insufficient withdrawable');
    expect(snapshot()).toBe(unchanged);
    await updateIsolatedMargin(USER, ASSET, false, 875_000_000);
    await expect(storedMargin()).resolves.toBe('999.999999000000000000000000000001');
  });

  it('a derived non-terminating margin is taken at 60 places and moves by ntli exactly', async () => {
    // size 100 short, entry/mark 2.5, leverage 3, no stored margin: 250/3 at 60 places (half up).
    await seed({ leverage: '3', maxLeverage: 3, isolatedMargin: '0' });
    const third = '3'.repeat(60);
    await updateIsolatedMargin(USER, ASSET, true, 5_000_000);
    await expect(storedMargin()).resolves.toBe(`88.${third}`);
    // removing the full 5 returns to 83.(60 threes), just below the exact requirement 250/3: refused
    await expect(updateIsolatedMargin(USER, ASSET, true, -5_000_000)).rejects.toThrow('transfer margin requirement');
    await updateIsolatedMargin(USER, ASSET, true, -4_999_999);
    await expect(storedMargin()).resolves.toBe(`83.333334${'3'.repeat(54)}`);
  });

  it('an add on a derived margin never commits more than withdrawable', async () => {
    // leverage 6: reservation 250/6 = 41.66…67 (60 places); balance 46.6666668 → withdrawable
    // 5.00000013…; adding 5 commits 46.66…67 (< 46.6666668); adding 5.000001 is refused.
    await seed({ leverage: '6', maxLeverage: 6, isolatedMargin: '0', balance: '46.6666668' });
    const unchanged = snapshot();
    await expect(updateIsolatedMargin(USER, ASSET, true, 5_000_001)).rejects.toThrow('Insufficient withdrawable');
    expect(snapshot()).toBe(unchanged);
    await updateIsolatedMargin(USER, ASSET, true, 5_000_000);
    await expect(storedMargin()).resolves.toBe(`46.${'6'.repeat(59)}7`);
  });

  it('refuses a commit that would not be readable back, with no write', async () => {
    // long 1e20 at entry 1, mark 1e20, leverage 2: derived margin 5e39 is out of range
    await seed({ szi: '100000000000000000000', isolatedMargin: '0' });
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '1e20');
    await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'entryPx', '1');
    const unchanged = snapshot();
    await expect(updateIsolatedMargin(USER, ASSET, true, 5_000_000)).rejects.toThrow('out of range');
    expect(snapshot()).toBe(unchanged);
  });

  it('accepts an engine fill margin with 31 decimal places', async () => {
    // e.g. size 1 at mark 0.1, leverage 3 → the fill path stores 0.0333…3 (30 significant digits)
    await seed({ isolatedMargin: '0.0333333333333333333333333333333' });
    await updateIsolatedMargin(USER, ASSET, true, 1_000_000);
    await expect(storedMargin()).resolves.toBe('1.0333333333333333333333333333333');
  });

  it('refuses operands whose sums could not be read back (magnitude and decimal places)', async () => {
    for (const [field, value] of [['isolatedMargin', '1'.repeat(31)], ['isolatedMargin', '0.' + '1'.repeat(61)]]) {
      redisMock.flushall();
      await seed();
      await redisMock.hset(KEYS.USER_LEV(USER, ASSET), field, value);
      const unchanged = snapshot();
      await expect(updateIsolatedMargin(USER, ASSET, true, 1), value).rejects.toThrow('out of range');
      expect(snapshot(), value).toBe(unchanged);
    }
  });

  it('refuses an out-of-range mark (magnitude or decimal places) with no write', async () => {
    for (const mark of ['1e30', '0.' + '1'.repeat(61)]) {
      redisMock.flushall();
      await seed({ szi: '-0.000000000000000000000000000001', isolatedMargin: '1' });
      await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', mark);
      const unchanged = snapshot();
      await expect(updateIsolatedMargin(USER, ASSET, true, 5_000_000), mark).rejects.toThrow('no finite positive mark price');
      expect(snapshot(), mark).toBe(unchanged);
    }
  });

  it('refuses a negative stored isolated margin with no write', async () => {
    await seed({ isolatedMargin: '-1' });
    const unchanged = snapshot();
    await expect(updateIsolatedMargin(USER, ASSET, true, 5_000_000)).rejects.toThrow('is negative');
    expect(snapshot()).toBe(unchanged);
  });

  it('accepts isBuy true on a long position', async () => {
    await seed({ szi: '100' });
    await updateIsolatedMargin(USER, ASSET, true, 5_000_000);
    await expect(storedMargin()).resolves.toBe('130');
  });

  it('commits exactly one of two concurrent adds whose sum exceeds withdrawable', async () => {
    await seed();
    // withdrawable 875: each 500 fits alone, both together do not.
    const results = await Promise.allSettled([
      updateIsolatedMargin(USER, ASSET, false, 500_000_000),
      updateIsolatedMargin(USER, ASSET, false, 500_000_000),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(IsolatedMarginRefusal);
    expect(String(rejected[0].reason)).toContain('Insufficient withdrawable balance');
    await expect(storedMargin()).resolves.toBe('625');
    expect((await getClearinghouseState(USER)).withdrawable).toBe('375');
    // Both decided on the same snapshot; the loser's commit hit the compare-and-set and retried.
    expect(evalSpy).toHaveBeenCalledTimes(2);
  });

  it('refuses a commit whose read state changed and retries on fresh state', async () => {
    await seed();
    let first = true;
    evalSpy.mockImplementationOnce(async (script: string, numberOfKeys: number, ...args: string[]) => {
      // Another writer moves the mark between decision and commit.
      if (first) {
        first = false;
        await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', '2.6');
      }
      const keys = args.slice(0, numberOfKeys);
      expect(script).toBe(UPDATE_ISOLATED_MARGIN_LUA);
      return casDouble(keys, JSON.parse(args[numberOfKeys]) as Spec);
    });
    await updateIsolatedMargin(USER, ASSET, false, 5_000_000);
    expect(evalSpy).toHaveBeenCalledTimes(2);
    await expect(storedMargin()).resolves.toBe('130');
  });
});

describe('/exchange updateIsolatedMargin', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  async function post(action: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const app = new Hono();
    app.route('/exchange', exchangeRouter);
    const res = await app.request('/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: USER, action }),
    });
    return { status: res.status, body: await res.json() };
  }

  it('returns the HL default response on success', async () => {
    await seed();
    await expect(post({ type: 'updateIsolatedMargin', asset: ASSET, isBuy: false, ntli: 5_000_000 }))
      .resolves.toEqual({ status: 200, body: { status: 'ok', response: { type: 'default' } } });
    await expect(storedMargin()).resolves.toBe('130');
  });

  it('refuses a malformed mark with the HL error shape (HTTP 200) and changes nothing', async () => {
    await seed();
    await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', 'abc');
    const unchanged = snapshot();
    const res = await post({ type: 'updateIsolatedMargin', asset: ASSET, isBuy: false, ntli: 5_000_000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'err' });
    expect(snapshot()).toBe(unchanged);
  });

  it('refuses out-of-range magnitudes with HTTP 200 err and changes nothing', async () => {
    for (const big of ['1e9000000000000000', '1e100']) {
      redisMock.flushall();
      await seed({ szi: big, isolatedMargin: '0' });
      await redisMock.hset(KEYS.MARKET_CTX(COIN), 'markPx', big);
      await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'entryPx', big);
      const unchanged = snapshot();
      const res = await post({ type: 'updateIsolatedMargin', asset: ASSET, isBuy: true, ntli: 5_000_000 });
      expect(res.status, big).toBe(200);
      expect(res.body, big).toMatchObject({ status: 'err' });
      expect(snapshot(), big).toBe(unchanged);
    }
  });

  it('returns HL error shape on refusal and changes nothing', async () => {
    await seed();
    const unchanged = snapshot();
    await expect(post({ type: 'updateIsolatedMargin', asset: ASSET, isBuy: false, ntli: 0 }))
      .resolves.toEqual({ status: 200, body: { status: 'err', response: 'ntli must be non-zero' } });
    await expect(post({ type: 'updateIsolatedMargin', asset: ASSET, isBuy: false, ntli: -1 }))
      .resolves.toEqual({
        status: 200,
        body: {
          status: 'err',
          response: 'Removal would leave isolated margin below the transfer margin requirement 125',
        },
      });
    expect(snapshot()).toBe(unchanged);
  });
});
