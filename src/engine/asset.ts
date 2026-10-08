import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import type { HlMeta } from '../types/hl.js';

const BUILDER_DEX_ASSET_BASE = 100_000;

export interface AssetMetadata {
  coin: string;
  szDecimals: number;
  maxLeverage?: number;
  onlyIsolated?: boolean;
}

export function mainDexMarkSubscriptions(meta: HlMeta): Array<{
  type: 'activeAssetCtx';
  coin: string;
}> {
  const seen = new Set<string>();
  return meta.universe.map((entry, index) => {
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new Error(`main-dex metadata entry ${index} has no valid coin name`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`main-dex metadata contains duplicate coin ${entry.name}`);
    }
    seen.add(entry.name);
    return { type: 'activeAssetCtx', coin: entry.name };
  });
}

export async function getAssetMetadata(asset: number): Promise<AssetMetadata | null> {
  if (!Number.isSafeInteger(asset) || asset < 0) return null;

  if (asset >= BUILDER_DEX_ASSET_BASE) {
    const raw = await redis.hget(KEYS.MARKET_ASSET_MAP, String(asset));
    if (!raw) return null;
    return JSON.parse(raw) as AssetMetadata;
  }

  const metaRaw = await redis.get(KEYS.MARKET_META);
  if (!metaRaw) return null;
  const meta: HlMeta = JSON.parse(metaRaw);
  if (asset >= meta.universe.length) return null;
  const entry = meta.universe[asset];
  return {
    coin: entry.name,
    szDecimals: entry.szDecimals,
    maxLeverage: entry.maxLeverage,
    onlyIsolated: entry.onlyIsolated,
  };
}

/**
 * The wire asset index of `coin`, or null when HyPaper cannot resolve it uniquely.
 * Builder-dex coins (`dex:NAME`) resolve through `market:assetmap` (exactly one entry
 * whose `coin` equals `coin`); main-dex coins resolve to their position in the stored
 * main `meta` universe.
 */
export async function resolveCoinAsset(coin: string): Promise<number | null> {
  if (typeof coin !== 'string' || coin.length === 0) return null;

  if (coin.includes(':')) {
    const entries = await redis.hgetall(KEYS.MARKET_ASSET_MAP);
    const matches: number[] = [];
    for (const [asset, raw] of Object.entries(entries ?? {}) as Array<[string, unknown]>) {
      if (typeof raw !== 'string') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (
        typeof parsed === 'object' && parsed !== null &&
        (parsed as { coin?: unknown }).coin === coin
      ) {
        const index = Number(asset);
        if (Number.isSafeInteger(index) && index >= BUILDER_DEX_ASSET_BASE) matches.push(index);
      }
    }
    return matches.length === 1 ? matches[0] : null;
  }

  const metaRaw = await redis.get(KEYS.MARKET_META);
  if (!metaRaw) return null;
  const meta: HlMeta = JSON.parse(metaRaw);
  const indexes = meta.universe
    .map((entry, index) => (entry.name === coin ? index : -1))
    .filter((index) => index >= 0);
  return indexes.length === 1 ? indexes[0] : null;
}
