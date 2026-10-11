import { logger } from './logger.js';
import { HL_L2_BOOK_TIMEOUT_MS, postHlInfo } from '../worker/hl-upstream.js';

export interface L2Level {
  px: string;
  sz: string;
  n: number;
}

export interface HlL2Book {
  coin: string;
  levels: [L2Level[], L2Level[]]; // [bids, asks]
  time: number;
}

interface CacheEntry {
  book: HlL2Book;
  ts: number;
}

const CACHE_TTL_MS = 2000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<HlL2Book | null>>();

/**
 * Fetch one L2 book from HL, bounded by HL_L2_BOOK_TIMEOUT_MS. A timed-out,
 * non-OK, non-JSON or malformed answer returns null (the caller's existing
 * fallback) and is never cached.
 */
async function fetchL2Book(coin: string): Promise<HlL2Book | null> {
  try {
    const data = await postHlInfo({ type: 'l2Book', coin }, HL_L2_BOOK_TIMEOUT_MS);
    const levels = (data as { levels?: unknown } | null)?.levels;
    if (!Array.isArray(levels) || levels.length !== 2
      || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) {
      logger.warn({ coin }, 'L2 book response is malformed');
      return null;
    }
    return {
      coin,
      levels: levels as [L2Level[], L2Level[]],
      time: Date.now(),
    };
  } catch (err) {
    logger.warn({ err, coin }, 'L2 book fetch error');
    return null;
  }
}

export async function getL2Book(coin: string): Promise<HlL2Book | null> {
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.book;
  }

  // Deduplicate concurrent fetches
  const existing = inflight.get(coin);
  if (existing) return existing;

  const promise = fetchL2Book(coin).then((book) => {
    inflight.delete(coin);
    if (book) {
      cache.set(coin, { book, ts: Date.now() });
    }
    return book;
  });

  inflight.set(coin, promise);
  return promise;
}
