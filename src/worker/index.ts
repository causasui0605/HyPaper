import { EventEmitter } from 'node:events';
import { config, extraDexList } from '../config.js';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import { HlWebSocketClient } from './ws-client.js';
import { PriceUpdater } from './price-updater.js';
import { OrderMatcher } from './order-matcher.js';
import { FundingWorker } from './funding-worker.js';
import type { HlMeta, HlAssetCtx } from '../types/hl.js';
import { mainDexMarkSubscriptions } from '../engine/asset.js';

export const eventBus = new EventEmitter();

export class Worker {
  private wsClient: HlWebSocketClient | null = null;
  private priceUpdater: PriceUpdater;
  private orderMatcher: OrderMatcher;
  private fundingWorker: FundingWorker;

  constructor() {
    this.orderMatcher = new OrderMatcher(eventBus);
    this.fundingWorker = new FundingWorker();
    this.priceUpdater = new PriceUpdater(() => {
      // Fire-and-forget match on every price update
      this.orderMatcher.matchAll();
    }, eventBus);

    this.wsClient = new HlWebSocketClient((channel, data) => {
      this.priceUpdater.handleMessage(channel, data);
    });
  }

  async start(): Promise<void> {
    logger.info('Starting worker...');

    // Fetch initial meta + prices from HL HTTP API
    const mainMeta = await this.seedMarketData();

    // Connect WebSocket and subscribe
    this.wsClient!.connect();
    this.wsClient!.subscribe({ type: 'allMids' });
    for (const subscription of mainDexMarkSubscriptions(mainMeta)) {
      this.wsClient!.subscribe(subscription);
    }
    for (const dex of extraDexList(config.EXTRA_DEXS)) {
      // Builder-deployed perp dex mids stream on the same channel, keyed by
      // the dex-prefixed coin names (e.g. "xyz:CL").
      this.wsClient!.subscribe({ type: 'allMids', dex });
    }

    this.fundingWorker.start();
    this.startExtraDexCtxRefresh();

    logger.info('Worker started');
  }

  private extraDexTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Poll metaAndAssetCtxs for each configured builder dex: refreshes mids,
   * mark/oracle/funding ctx (the funding worker reads MARKET_CTX), and the
   * wire-asset registry. A polling belt in addition to the per-dex allMids
   * WS subscription; the main dex path is untouched.
   */
  private startExtraDexCtxRefresh(): void {
    const dexs = extraDexList(config.EXTRA_DEXS);
    if (dexs.length === 0 || this.extraDexTimer) return;
    this.extraDexTimer = setInterval(() => {
      for (const dex of dexs) {
        this.seedExtraDex(dex).catch((err) => {
          logger.error({ err, dex }, 'Extra-dex ctx refresh failed');
        });
      }
    }, config.EXTRA_DEX_CTX_REFRESH_MS);
  }

  /**
   * Seed one builder dex: wire-asset registry (asset id = 100000 +
   * dexIndex*10000 + universe index, dexIndex from the perpDexs listing) plus
   * per-coin ctx and mids. Fails loud: an unknown dex name aborts startup.
   */
  private async seedExtraDex(dex: string): Promise<void> {
    const dexsRes = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'perpDexs' }),
    });
    const perpDexs = await dexsRes.json() as Array<{ name?: string } | null>;
    const dexIndex = perpDexs.findIndex((d) => d?.name === dex);
    if (dexIndex < 1) {
      throw new Error(`builder dex ${dex} not present in perpDexs listing`);
    }

    const ctxRes = await fetch(`${config.HL_API_URL}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs', dex }),
    });
    const [dexMeta, assetCtxs] = await ctxRes.json() as [HlMeta, HlAssetCtx[]];

    const mids: Record<string, string> = {};
    const registry = redis.pipeline();
    for (let i = 0; i < dexMeta.universe.length; i++) {
      const entry = dexMeta.universe[i];
      const wireAsset = 100_000 + dexIndex * 10_000 + i;
      registry.hset(KEYS.MARKET_ASSET_MAP, String(wireAsset), JSON.stringify({
        coin: entry.name,
        szDecimals: entry.szDecimals,
        maxLeverage: entry.maxLeverage,
        onlyIsolated: entry.onlyIsolated === true,
      }));
      const ctx = assetCtxs[i];
      if (!ctx) continue;
      const livePx = ctx.midPx ?? ctx.markPx;
      if (livePx) mids[entry.name] = livePx;
      registry.hset(KEYS.MARKET_CTX(entry.name),
        'markPx', ctx.markPx ?? '',
        'midPx', ctx.midPx ?? '',
        'oraclePx', ctx.oraclePx ?? '',
        'funding', ctx.funding ?? '',
        'openInterest', ctx.openInterest ?? '',
        'prevDayPx', ctx.prevDayPx ?? '',
        'dayNtlVlm', ctx.dayNtlVlm ?? '',
        'premium', ctx.premium ?? '',
        'coin', entry.name,
      );
    }
    await registry.exec();
    await this.priceUpdater.seedMids(mids);
    logger.info({ dex, dexIndex, assets: dexMeta.universe.length }, 'Seeded builder dex');
  }

  private async seedMarketData(): Promise<HlMeta> {
    try {
      // Fetch meta (universe info)
      const metaRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'meta' }),
      });
      const meta: HlMeta = await metaRes.json() as HlMeta;
      await redis.set(KEYS.MARKET_META, JSON.stringify(meta));
      logger.info({ assets: meta.universe.length }, 'Seeded market meta');

      // Fetch metaAndAssetCtxs for initial prices
      const ctxRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      const ctxData = await ctxRes.json() as [HlMeta, HlAssetCtx[]];
      const assetCtxs = ctxData[1];

      // Build initial mids from the best live price available.
      const mids: Record<string, string> = {};
      for (let i = 0; i < meta.universe.length && i < assetCtxs.length; i++) {
        const coin = meta.universe[i].name;
        const ctx = assetCtxs[i];
        const livePx = ctx.midPx ?? ctx.markPx;
        if (livePx) {
          mids[coin] = livePx;
        }
        // Store asset context
        await redis.hset(KEYS.MARKET_CTX(coin),
          'markPx', ctx.markPx ?? '',
          'midPx', ctx.midPx ?? '',
          'oraclePx', ctx.oraclePx ?? '',
          'funding', ctx.funding ?? '',
          'openInterest', ctx.openInterest ?? '',
          'prevDayPx', ctx.prevDayPx ?? '',
          'dayNtlVlm', ctx.dayNtlVlm ?? '',
          'premium', ctx.premium ?? '',
        );
      }

      await this.priceUpdater.seedMids(mids);

      // Fetch allMids for current mid prices
      const midsRes = await fetch(`${config.HL_API_URL}/info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'allMids' }),
      });
      const allMids = await midsRes.json() as Record<string, string>;
      await this.priceUpdater.seedMids(allMids);

      for (const dex of extraDexList(config.EXTRA_DEXS)) {
        await this.seedExtraDex(dex);
      }
      return meta;
    } catch (err) {
      logger.error({ err }, 'Failed to seed market data');
      throw err;
    }
  }

  stop(): void {
    if (this.extraDexTimer) {
      clearInterval(this.extraDexTimer);
      this.extraDexTimer = null;
    }
    this.fundingWorker.stop();
    this.wsClient?.close();
    logger.info('Worker stopped');
  }
}
