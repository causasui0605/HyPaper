import { EventEmitter } from 'node:events';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { logger } from '../utils/logger.js';
import type { HlAllMids, HlActiveAssetCtx, HlL2Book } from '../types/hl.js';

export type PriceUpdateCallback = () => void;

/**
 * Redis hash of WS feed freshness. Field = subscription family, value = the
 * epoch-ms arrival time of the latest WS update for that family:
 *   `allMids`          main-dex allMids
 *   `allMids:<dex>`    a builder dex's allMids (coins prefixed `<dex>:`)
 *   `activeAssetCtx`   the main-dex mark (activeAssetCtx) subscriptions
 * Only WS updates write it; HTTP seeding and polling never do, so a frozen
 * socket shows up as an ageing timestamp.
 */
export const FEED_LAST_UPDATE_KEY = 'market:feeds:lastUpdate';

const coinDex = (coin: string): string | null => {
  const idx = coin.indexOf(':');
  return idx > 0 ? coin.slice(0, idx) : null;
};

export const feedFamily = (channel: string, dex: string | null): string =>
  dex ? `${channel}:${dex}` : channel;

/** The families a worker with these extra dexs is expected to keep fresh. */
export const expectedFeedFamilies = (extraDexs: string[]): string[] => [
  'allMids',
  ...extraDexs.map((dex) => feedFamily('allMids', dex)),
  'activeAssetCtx',
];

export class PriceUpdater {
  private onUpdate: PriceUpdateCallback;
  private eventBus: EventEmitter;

  constructor(onUpdate: PriceUpdateCallback, eventBus: EventEmitter) {
    this.onUpdate = onUpdate;
    this.eventBus = eventBus;
  }

  async handleMessage(channel: string, data: unknown): Promise<void> {
    switch (channel) {
      case 'allMids':
        await this.handleAllMids(data as HlAllMids);
        break;
      case 'activeAssetCtx':
        await this.handleActiveAssetCtx(data as HlActiveAssetCtx);
        break;
      case 'l2Book':
        await this.handleL2Book(data as HlL2Book);
        break;
    }
  }

  private async handleAllMids(data: HlAllMids): Promise<void> {
    const mids = data.mids;
    if (!mids || typeof mids !== 'object') return;

    const entries = Object.entries(mids);
    if (entries.length === 0) return;

    const pipeline = redis.pipeline();
    const args: string[] = [];
    for (const [coin, px] of entries) {
      args.push(coin, px);
    }
    pipeline.hset(KEYS.MARKET_MIDS, ...args);
    const now = Date.now().toString();
    const families = new Set(entries.map(([coin]) => feedFamily('allMids', coinDex(coin))));
    const feedArgs: string[] = [];
    for (const family of families) feedArgs.push(family, now);
    pipeline.hset(FEED_LAST_UPDATE_KEY, ...feedArgs);
    await pipeline.exec();

    this.eventBus.emit('mids', { mids });
    this.onUpdate();
  }

  private async handleActiveAssetCtx(data: HlActiveAssetCtx): Promise<void> {
    if (!data.coin || !data.ctx) return;

    const ctx = data.ctx;
    const pipeline = redis.pipeline();
    const now = Date.now().toString();
    pipeline.hset(KEYS.MARKET_CTX(data.coin),
      'markPx', ctx.markPx ?? '',
      'midPx', ctx.midPx ?? '',
      'oraclePx', ctx.oraclePx ?? '',
      'funding', ctx.funding ?? '',
      'openInterest', ctx.openInterest ?? '',
      'prevDayPx', ctx.prevDayPx ?? '',
      'dayNtlVlm', ctx.dayNtlVlm ?? '',
      'premium', ctx.premium ?? '',
      'observedAt', now,
    );
    pipeline.hset(FEED_LAST_UPDATE_KEY, feedFamily('activeAssetCtx', coinDex(data.coin)), now);

    const livePx = ctx.midPx ?? ctx.markPx;
    if (livePx) {
      pipeline.hset(KEYS.MARKET_MIDS, data.coin, livePx);
    }

    await pipeline.exec();

    if (livePx) {
      this.eventBus.emit('mids', { mids: { [data.coin]: livePx } });
      this.onUpdate();
    }
  }

  private async handleL2Book(data: HlL2Book): Promise<void> {
    if (!data.coin) return;
    await redis.set(KEYS.MARKET_L2(data.coin), JSON.stringify(data));
    this.eventBus.emit('l2book', { coin: data.coin, levels: data.levels, time: data.time });
  }

  async seedMids(mids: Record<string, string>): Promise<void> {
    const entries = Object.entries(mids);
    if (entries.length === 0) return;

    const args: string[] = [];
    for (const [coin, px] of entries) {
      args.push(coin, px);
    }
    await redis.hset(KEYS.MARKET_MIDS, ...args);
    logger.info({ count: entries.length }, 'Seeded mids');
  }
}
