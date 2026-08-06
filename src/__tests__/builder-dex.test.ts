import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../store/redis.js', () => {
  const store = new Map<string, Map<string, string>>();
  const plain = new Map<string, string>();
  return {
    redis: {
      async get(k: string) { return plain.get(k) ?? null; },
      async set(k: string, v: string) { plain.set(k, v); },
      async hget(k: string, f: string) { return store.get(k)?.get(f) ?? null; },
      async hset(k: string, ...pairs: string[]) {
        const h = store.get(k) ?? new Map<string, string>();
        for (let i = 0; i < pairs.length; i += 2) h.set(pairs[i], pairs[i + 1]);
        store.set(k, h);
      },
      __plain: plain,
      __store: store,
    },
  };
});

import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { resolveAssetCoin, getAssetDecimals } from '../engine/order.js';
import { getAssetMetadata, mainDexMarkSubscriptions } from '../engine/asset.js';

const MAIN_META = JSON.stringify({
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
  ],
});

describe('builder-dex asset resolution', () => {
  beforeEach(async () => {
    await redis.set(KEYS.MARKET_META, MAIN_META);
    // dexIndex 1, universe index 29 => wire asset 110029 (hand-derived:
    // 100000 + 1*10000 + 29)
    await redis.hset(
      KEYS.MARKET_ASSET_MAP,
      '110029',
      JSON.stringify({
        coin: 'xyz:CL',
        szDecimals: 2,
        maxLeverage: 20,
        onlyIsolated: false,
      }),
    );
  });

  it('resolves main-dex assets from meta exactly as before', async () => {
    expect(await resolveAssetCoin(0)).toBe('BTC');
    expect(await resolveAssetCoin(1)).toBe('ETH');
    expect(await getAssetDecimals(1)).toBe(4);
    expect(await getAssetMetadata(0)).toEqual({
      coin: 'BTC',
      szDecimals: 5,
      maxLeverage: 40,
      onlyIsolated: undefined,
    });
  });

  it('resolves a registered builder-dex wire asset', async () => {
    expect(await resolveAssetCoin(110029)).toBe('xyz:CL');
    expect(await getAssetDecimals(110029)).toBe(2);
    expect(await getAssetMetadata(110029)).toEqual({
      coin: 'xyz:CL',
      szDecimals: 2,
      maxLeverage: 20,
      onlyIsolated: false,
    });
  });

  it('refuses an unregistered builder-dex wire asset', async () => {
    expect(await resolveAssetCoin(110030)).toBeNull();
    expect(await getAssetDecimals(110030)).toBe(0);
  });

  it('does not treat builder ids as main-universe indexes', async () => {
    // 100000 would previously fall off the end of meta.universe and return
    // null anyway, but must now consult the registry, not the main meta.
    expect(await resolveAssetCoin(100000)).toBeNull();
  });

  it('builds one coin-scoped mark subscription per main-dex asset', () => {
    const meta = JSON.parse(MAIN_META);
    expect(mainDexMarkSubscriptions(meta)).toEqual([
      { type: 'activeAssetCtx', coin: 'BTC' },
      { type: 'activeAssetCtx', coin: 'ETH' },
    ]);
  });

  it('refuses malformed or duplicate main-dex mark subscriptions', () => {
    expect(() => mainDexMarkSubscriptions({
      universe: [{ name: '', szDecimals: 1, maxLeverage: 10 }],
    })).toThrow('has no valid coin name');
    expect(() => mainDexMarkSubscriptions({
      universe: [
        { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
        { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
      ],
    })).toThrow('duplicate coin BTC');
  });
});
