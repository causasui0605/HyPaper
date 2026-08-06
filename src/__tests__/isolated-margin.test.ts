import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';

const redisMock = new RedisMock();

vi.mock('../store/redis.js', () => ({
  redis: redisMock,
}));

const { topUpIsolatedOnlyMargin } = await import('../engine/margin.js');
const { getClearinghouseState } = await import('../engine/position.js');
const { updateLeverage } = await import('../engine/order.js');
const { KEYS } = await import('../store/keys.js');

const USER = '0xpaper';
const ASSET = 110001;

async function seedIsolatedPosition(balance = '1000'): Promise<void> {
  await redisMock.hset(
    KEYS.MARKET_ASSET_MAP,
    ASSET.toString(),
    JSON.stringify({
      coin: 'xyz:NATGAS',
      szDecimals: 1,
      maxLeverage: 10,
      onlyIsolated: true,
    }),
  );
  await redisMock.hset(KEYS.MARKET_MIDS, 'xyz:NATGAS', '2.6');
  await redisMock.hset(KEYS.MARKET_CTX('xyz:NATGAS'), 'markPx', '2.5');
  await redisMock.hset(KEYS.USER_ACCOUNT(USER), 'balance', balance);
  await redisMock.hset(
    KEYS.USER_LEV(USER, ASSET),
    'leverage', '10',
    'isCross', 'false',
  );
  await redisMock.hset(
    KEYS.USER_POS(USER, ASSET),
    'userId', USER,
    'asset', ASSET.toString(),
    'coin', 'xyz:NATGAS',
    'szi', '100',
    'entryPx', '2.5',
  );
  await redisMock.sadd(KEYS.USER_POSITIONS(USER), ASSET.toString());
}

describe('isolated-only margin top-up', () => {
  beforeEach(() => {
    redisMock.flushall();
  });

  it('targets effective leverage without changing selected venue leverage', async () => {
    await seedIsolatedPosition();

    await topUpIsolatedOnlyMargin(USER, ASSET, '3');
    const state = await getClearinghouseState(USER);
    const position = state.assetPositions[0].position;

    expect(position.leverage).toEqual({
      type: 'isolated',
      value: 10,
      rawUsd: '83.3333333333333333333333333333',
    });
    expect(position.marginUsed).toBe('83.3333333333333333333333333333');
    expect(state.crossMaintenanceMarginUsed).toBe('12.5');
    expect(state.withdrawable).toBe('916.666666666666666666666666667');
  });

  it('is idempotent at an unchanged mark and target', async () => {
    await seedIsolatedPosition();
    await topUpIsolatedOnlyMargin(USER, ASSET, '3');
    await topUpIsolatedOnlyMargin(USER, ASSET, '3');
    await expect(
      redisMock.hget(KEYS.USER_LEV(USER, ASSET), 'isolatedMargin'),
    ).resolves.toBe('83.3333333333333333333333333333');
  });

  it('cannot resurrect stale isolated margin across a cross-mode trade', async () => {
    await seedIsolatedPosition();
    await topUpIsolatedOnlyMargin(USER, ASSET, '3');

    await updateLeverage(USER, ASSET, true, 10);
    await expect(
      redisMock.hget(KEYS.USER_LEV(USER, ASSET), 'isolatedMargin'),
    ).resolves.toBe('0');

    await redisMock.hset(KEYS.USER_POS(USER, ASSET), 'szi', '200');
    await updateLeverage(USER, ASSET, false, 10);

    const state = await getClearinghouseState(USER);
    expect(state.assetPositions[0].position.marginUsed).toBe('50');
    expect(state.assetPositions[0].position.leverage.rawUsd).toBe('50');
    expect(state.withdrawable).toBe('950');
  });

  it('preserves topped-up margin for an unchanged isolated setting', async () => {
    await seedIsolatedPosition();
    await topUpIsolatedOnlyMargin(USER, ASSET, '3');

    await updateLeverage(USER, ASSET, false, 10);

    await expect(
      redisMock.hget(KEYS.USER_LEV(USER, ASSET), 'isolatedMargin'),
    ).resolves.toBe('83.3333333333333333333333333333');
  });

  it('refuses target leverage above venue metadata and insufficient collateral', async () => {
    await seedIsolatedPosition('30');
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '11')).rejects.toThrow(
      'exceeds asset maxLeverage 10',
    );
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '3')).rejects.toThrow(
      'Insufficient margin for isolated-only top-up',
    );
  });

  it('refuses non-isolated-only metadata', async () => {
    await seedIsolatedPosition();
    await redisMock.hset(
      KEYS.MARKET_ASSET_MAP,
      ASSET.toString(),
      JSON.stringify({
        coin: 'xyz:NATGAS',
        szDecimals: 1,
        maxLeverage: 10,
        onlyIsolated: false,
      }),
    );
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '3')).rejects.toThrow(
      'is not isolated-only',
    );
  });

  it('refuses cross mode, absent positions, and margin removal', async () => {
    await seedIsolatedPosition();
    await redisMock.hset(KEYS.USER_LEV(USER, ASSET), 'isCross', 'true');
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '3')).rejects.toThrow(
      'is not configured for isolated margin',
    );

    await redisMock.hset(KEYS.USER_LEV(USER, ASSET), 'isCross', 'false');
    await redisMock.del(KEYS.USER_POS(USER, ASSET));
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '3')).rejects.toThrow(
      'has no open position',
    );

    await seedIsolatedPosition();
    await redisMock.hset(KEYS.USER_LEV(USER, ASSET), 'isolatedMargin', '100');
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '3')).rejects.toThrow(
      'cannot remove isolated margin',
    );
  });

  it('refuses zero, exponent, and hexadecimal target leverage text', async () => {
    await seedIsolatedPosition();
    for (const value of ['0', '3e0', '0x3']) {
      await expect(topUpIsolatedOnlyMargin(USER, ASSET, value)).rejects.toThrow(
        'finite positive decimal string',
      );
    }
  });

  it('never substitutes mid when mark is missing', async () => {
    await seedIsolatedPosition();
    await redisMock.del(KEYS.MARKET_CTX('xyz:NATGAS'));
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '3')).rejects.toThrow(
      'has no finite positive mark price',
    );
    await expect(getClearinghouseState(USER)).rejects.toThrow(
      'No finite positive mark price for xyz:NATGAS',
    );
  });

  it('refuses a zero mark and missing max-leverage metadata', async () => {
    await seedIsolatedPosition();
    await redisMock.hset(KEYS.MARKET_CTX('xyz:NATGAS'), 'markPx', '0');
    await expect(topUpIsolatedOnlyMargin(USER, ASSET, '3')).rejects.toThrow(
      'has no finite positive mark price',
    );
    await expect(getClearinghouseState(USER)).rejects.toThrow(
      'No finite positive mark price for xyz:NATGAS',
    );

    await redisMock.hset(KEYS.MARKET_CTX('xyz:NATGAS'), 'markPx', '2.5');
    await redisMock.hset(
      KEYS.MARKET_ASSET_MAP,
      ASSET.toString(),
      JSON.stringify({ coin: 'xyz:NATGAS', szDecimals: 1, onlyIsolated: true }),
    );
    await expect(getClearinghouseState(USER)).rejects.toThrow(
      'has no valid maxLeverage metadata',
    );
  });
});
