import { Hono } from 'hono';
import { redis } from '../../store/redis.js';
import { KEYS } from '../../store/keys.js';
import { config } from '../../config.js';
import { getClearinghouseState, getOpenOrders, getFrontendOpenOrders, getOrderStatus } from '../../engine/position.js';
import { getUserFills, getUserFillsByTime } from '../../engine/fill.js';
import { getUserFunding } from '../../engine/funding-history.js';
import { logger } from '../../utils/logger.js';
import { ensureAccount } from '../middleware/auth.js';
import { resolveCoinAsset } from '../../engine/asset.js';

export const infoRouter = new Hono();

// --- Proxy cache ---

interface CacheEntry {
  data: unknown;
  expiry: number;
}

// TTL per proxied type (ms)
const PROXY_TTL: Record<string, number> = {
  meta: 60_000,
  metaAndAssetCtxs: 2_000,
  l2Book: 1_000,
  candleSnapshot: 5_000,
  fundingHistory: 30_000,
  perpsAtOpenInterest: 10_000,
  predictedFundings: 10_000,
};

const DEFAULT_PROXY_TTL = 5_000;
const proxyCache = new Map<string, CacheEntry>();

function getCacheKey(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

// Endpoints proxied to real HL API
const PROXIED_TYPES = new Set(Object.keys(PROXY_TTL));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMetaOnlyIsolated(meta: unknown): unknown {
  if (!isRecord(meta) || !Array.isArray(meta.universe)) return meta;

  let changed = false;
  const universe = meta.universe.map((entry) => {
    if (!isRecord(entry)) return entry;
    if (Object.prototype.hasOwnProperty.call(entry, 'onlyIsolated')) return entry;
    changed = true;
    return { ...entry, onlyIsolated: false };
  });
  return changed ? { ...meta, universe } : meta;
}

/**
 * Builder-dex upstream metadata omits `onlyIsolated` when the value is false.
 * HyPaper exposes an explicit boolean so paper clients can bind margin posture
 * without treating omission as an assumption. Malformed present values remain
 * untouched so downstream validation can continue to fail closed.
 */
export function normalizeBuilderDexOnlyIsolated(
  body: Record<string, unknown>,
  data: unknown,
): unknown {
  if (typeof body.dex !== 'string' || body.dex.length === 0) return data;

  if (body.type === 'meta') return normalizeMetaOnlyIsolated(data);
  if (body.type !== 'metaAndAssetCtxs' || !Array.isArray(data) || data.length === 0) {
    return data;
  }
  const [meta, ...assetCtxs] = data;
  return [normalizeMetaOnlyIsolated(meta), ...assetCtxs];
}

infoRouter.post('/', async (c) => {
  const body = await c.req.json();
  const type: string = body.type;
  const user: string | undefined = body.user?.toLowerCase();

  if (!type) {
    return c.json({ error: 'Missing type' }, 400);
  }

  try {
    // Check if we should proxy to real HL
    if (PROXIED_TYPES.has(type)) {
      return cachedProxyToHL(c, body);
    }

    // For user-specific queries, ensure account exists
    if (user) {
      await ensureAccount(user);
    }

    // Handle locally from Redis
    switch (type) {
      case 'allMids': {
        const mids = await redis.hgetall(KEYS.MARKET_MIDS);
        return c.json(mids);
      }

      case 'clearinghouseState': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const state = await getClearinghouseState(user);
        return c.json(state);
      }

      case 'openOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const orders = await getOpenOrders(user);
        return c.json(orders);
      }

      case 'frontendOpenOrders': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const orders = await getFrontendOpenOrders(user);
        return c.json(orders);
      }

      case 'userFills': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const fills = await getUserFills(user);
        return c.json(fills);
      }

      case 'userFillsByTime': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const fills = await getUserFillsByTime(
          user,
          body.startTime ?? 0,
          body.endTime,
        );
        return c.json(fills);
      }

      case 'userFunding': {
        if (!user) return c.json({ error: 'Missing user' }, 400);
        const history = await getUserFunding(user, body.startTime ?? 0, body.endTime);
        return c.json(history);
      }

      case 'orderStatus': {
        // HL API parity: `oid` may be a numeric order id OR a 0x-hex cloid.
        // A cloid resolves through the per-user cloid index (same map
        // cancelByCloid uses); an unknown cloid is unknownOid, as on HL.
        let oid = body.oid;
        if (typeof oid === 'string' && /^0x[0-9a-fA-F]{32}$/.test(oid)) {
          if (!body.user) return c.json({ error: 'Missing user' }, 400);
          const mapped = await redis.hget(
            KEYS.USER_CLOIDS(String(body.user).toLowerCase()),
            oid.toLowerCase(),
          );
          if (!mapped) return c.json({ status: 'unknownOid' });
          oid = parseInt(mapped, 10);
        }
        const status = await getOrderStatus(oid);
        return c.json(status);
      }

      case 'activeAssetCtx': {
        if (!body.coin) return c.json({ error: 'Missing coin' }, 400);
        const ctx = await redis.hgetall(KEYS.MARKET_CTX(body.coin));
        return c.json({ coin: body.coin, ctx });
      }

      case 'activeAssetData': {
        return activeAssetData(c, body);
      }

      default: {
        // Try to proxy unknown types to HL (with default TTL)
        return cachedProxyToHL(c, body);
      }
    }
  } catch (err) {
    logger.error({ err, type }, 'Info error');
    return c.json({ error: String(err) }, 500);
  }
});

async function cachedProxyToHL(c: any, body: Record<string, unknown>) {
  return c.json(await fetchProxied(body));
}

/** The upstream HL `/info` answer for `body`, through the proxy cache. */
async function fetchProxied(body: Record<string, unknown>): Promise<unknown> {
  const key = getCacheKey(body);
  const now = Date.now();

  const cached = proxyCache.get(key);
  if (cached && cached.expiry > now) {
    return cached.data;
  }

  const res = await fetch(`${config.HL_API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rawData = await res.json();
  const data = normalizeBuilderDexOnlyIsolated(body, rawData);

  const ttl = PROXY_TTL[body.type as string] ?? DEFAULT_PROXY_TTL;
  proxyCache.set(key, { data, expiry: now + ttl });

  // Evict expired entries periodically (keep map from growing unbounded)
  if (proxyCache.size > 500) {
    for (const [k, v] of proxyCache) {
      if (v.expiry <= now) proxyCache.delete(k);
    }
  }

  return data;
}

function isUpstreamActiveAssetData(value: unknown, coin: string): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const pair = (v: unknown) => Array.isArray(v) && v.length === 2;
  return (
    typeof value.user === 'string' &&
    value.coin === coin &&
    isRecord(value.leverage) &&
    pair(value.maxTradeSzs) &&
    pair(value.availableToTrade) &&
    typeof value.markPx === 'string'
  );
}

/**
 * `activeAssetData`: the upstream answer, with `leverage` replaced by the paper
 * setting stored by `updateLeverage` when HyPaper holds one for (user, coin). Every
 * other field stays the upstream value (it describes the mainnet account). Without a
 * stored setting, or for a coin HyPaper cannot resolve uniquely, the upstream answer is
 * returned unchanged, as for any other proxied type.
 */
async function activeAssetData(c: any, body: Record<string, unknown>) {
  const coin = body.coin;
  const rawUser = body.user;
  if (typeof coin !== 'string' || typeof rawUser !== 'string') {
    return cachedProxyToHL(c, body);
  }
  const asset = await resolveCoinAsset(coin);
  const stored = asset === null
    ? null
    : await redis.hgetall(KEYS.USER_LEV(rawUser.toLowerCase(), asset));
  // Fall back to the proxy only when no setting is stored; a present but invalid
  // setting refuses (it must never silently become the mainnet answer).
  if (!stored || !Object.prototype.hasOwnProperty.call(stored, 'leverage')) {
    return cachedProxyToHL(c, body);
  }
  const value = /^[1-9][0-9]*$/.test(String(stored.leverage)) ? Number(stored.leverage) : NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return c.json({ error: `stored leverage for ${coin} is not a positive integer` }, 502);
  }
  let upstream: unknown;
  try {
    upstream = await fetchProxied(body);
  } catch (err) {
    return c.json({ error: `upstream activeAssetData for ${coin} could not be decoded: ${String(err)}` }, 502);
  }
  if (!isUpstreamActiveAssetData(upstream, coin)) {
    return c.json({ error: `upstream activeAssetData for ${coin} has an unexpected shape` }, 502);
  }
  const isCross = stored.isCross !== 'false';
  const leverage = isCross
    ? { type: 'cross', value }
    : { type: 'isolated', value, rawUsd: stored.isolatedMargin ?? '0' };
  return c.json({ ...upstream, leverage });
}
