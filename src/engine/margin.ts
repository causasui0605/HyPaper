import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, div, abs, gt, lt, isZero, neg } from '../utils/math.js';
import { getAssetMetadata } from './asset.js';

const DEFAULT_LEVERAGE = 20;

function selectedLeverage(lev: Record<string, string>): number {
  return lev.leverage ? parseInt(lev.leverage, 10) : DEFAULT_LEVERAGE;
}

export async function getMarkPrice(coin: string): Promise<string | null> {
  const markPx = await redis.hget(KEYS.MARKET_CTX(coin), 'markPx');
  if (markPx && D(markPx).isFinite() && D(markPx).greaterThan(0)) return markPx;
  return null;
}

export async function calculateAccountValue(userId: string): Promise<string> {
  const balance = await getBalance(userId);
  const unrealizedPnl = await calculateTotalUnrealizedPnl(userId);
  return add(balance, unrealizedPnl);
}

export async function getBalance(userId: string): Promise<string> {
  const balance = await redis.hget(KEYS.USER_ACCOUNT(userId), 'balance');
  return balance ?? '0';
}

export async function calculateTotalUnrealizedPnl(userId: string): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));
  if (positionAssets.length === 0) return '0';

  let totalPnl = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const markPx = await getMarkPrice(pos.coin);
    if (!markPx) throw new Error(`No finite positive mark price for ${pos.coin}`);

    const pnl = calculatePositionUnrealizedPnl(pos.szi, pos.entryPx, markPx);
    totalPnl = add(totalPnl, pnl);
  }

  return totalPnl;
}

export function calculatePositionUnrealizedPnl(szi: string, entryPx: string, markPx: string): string {
  if (isZero(szi)) return '0';
  const isLong = gt(szi, '0');
  const size = abs(szi);
  if (isLong) {
    return mul(sub(markPx, entryPx), size);
  } else {
    return mul(sub(entryPx, markPx), size);
  }
}

export async function calculateTotalMarginUsed(userId: string): Promise<string> {
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));
  if (positionAssets.length === 0) return '0';

  let totalMargin = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const markPx = await getMarkPrice(pos.coin);
    if (!markPx) throw new Error(`No finite positive mark price for ${pos.coin}`);

    const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
    const margin = lev.isCross === 'false' && lev.isolatedMargin && gt(lev.isolatedMargin, '0')
      ? lev.isolatedMargin
      : div(mul(abs(pos.szi), markPx), selectedLeverage(lev).toString());
    totalMargin = add(totalMargin, margin);
  }

  return totalMargin;
}

export async function calculatePositionMarginUsed(
  userId: string,
  asset: number,
  szi: string,
  markPx: string,
): Promise<string> {
  if (isZero(szi)) return '0';
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  if (lev.isCross === 'false' && lev.isolatedMargin && gt(lev.isolatedMargin, '0')) {
    return lev.isolatedMargin;
  }
  const leverage = selectedLeverage(lev);
  const posValue = mul(abs(szi), markPx);
  return div(posValue, leverage.toString());
}

export function adjustedIsolatedMarginAfterFill(
  currentMargin: string,
  currentSzi: string,
  newSzi: string,
  fillPx: string,
  leverage: number,
): string {
  const margin = D(currentMargin);
  const current = D(currentSzi);
  const next = D(newSzi);
  const price = D(fillPx);
  if (!margin.isFinite() || margin.isNegative()) throw new Error('isolated margin must be finite and non-negative');
  if (!current.isFinite() || !next.isFinite()) throw new Error('position size must be finite');
  if (!price.isFinite() || !price.greaterThan(0)) throw new Error('fill price must be finite and positive');
  if (!Number.isSafeInteger(leverage) || leverage < 1) throw new Error('leverage must be a positive integer');

  if (next.isZero()) return '0';
  if (current.isZero() || current.greaterThan(0) !== next.greaterThan(0)) {
    return next.abs().times(price).div(leverage).toString();
  }

  const currentAbs = current.abs();
  const nextAbs = next.abs();
  if (nextAbs.greaterThan(currentAbs)) {
    const added = nextAbs.minus(currentAbs).times(price).div(leverage);
    return margin.plus(added).toString();
  }
  if (nextAbs.lessThan(currentAbs)) {
    return margin.times(nextAbs).div(currentAbs).toString();
  }
  return margin.toString();
}

export async function topUpIsolatedOnlyMargin(
  userId: string,
  asset: number,
  targetLeverageText: string,
): Promise<void> {
  const metadata = await getAssetMetadata(asset);
  if (!metadata) throw new Error(`Unknown asset ${asset}`);
  if (metadata.onlyIsolated !== true) {
    throw new Error(`Asset ${asset} is not isolated-only`);
  }
  if (
    !metadata.maxLeverage
    || !Number.isSafeInteger(metadata.maxLeverage)
    || metadata.maxLeverage < 1
  ) {
    throw new Error(`Asset ${asset} has no valid maxLeverage metadata`);
  }

  let targetLeverage: ReturnType<typeof D>;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(targetLeverageText)) {
    throw new Error('Target leverage must be a finite positive decimal string');
  }
  try {
    targetLeverage = D(targetLeverageText);
  } catch {
    throw new Error('Target leverage must be a finite positive decimal string');
  }
  if (!targetLeverage.isFinite() || !targetLeverage.greaterThan(0)) {
    throw new Error('Target leverage must be a finite positive decimal string');
  }
  if (targetLeverage.greaterThan(metadata.maxLeverage)) {
    throw new Error(`Target leverage exceeds asset maxLeverage ${metadata.maxLeverage}`);
  }

  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  if (lev.isCross !== 'false') {
    throw new Error(`Asset ${asset} is not configured for isolated margin`);
  }
  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  if (!pos.szi || isZero(pos.szi)) throw new Error(`Asset ${asset} has no open position`);
  const markPx = await getMarkPrice(metadata.coin);
  if (!markPx) {
    throw new Error(`Asset ${asset} has no finite positive mark price`);
  }

  const currentMargin = await calculatePositionMarginUsed(userId, asset, pos.szi, markPx);
  const requiredMargin = D(abs(pos.szi)).times(D(markPx)).div(targetLeverage);
  if (requiredMargin.lessThan(D(currentMargin))) {
    throw new Error('topUpIsolatedOnlyMargin cannot remove isolated margin');
  }

  const additionalMargin = requiredMargin.minus(D(currentMargin));
  const availableMargin = D(await calculateAccountValue(userId)).minus(
    D(await calculateTotalMarginUsed(userId)),
  );
  if (additionalMargin.greaterThan(availableMargin)) {
    throw new Error('Insufficient margin for isolated-only top-up');
  }

  await redis.hset(
    KEYS.USER_LEV(userId, asset),
    'isolatedMargin', requiredMargin.toString(),
  );
}

export async function checkMarginForOrder(
  userId: string,
  asset: number,
  isBuy: boolean,
  sz: string,
  px: string,
): Promise<boolean> {
  const accountValue = await calculateAccountValue(userId);
  const currentMarginUsed = await calculateTotalMarginUsed(userId);
  const available = sub(accountValue, currentMarginUsed);

  // Calculate margin needed for this order
  const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
  const leverage = selectedLeverage(lev);

  // Check if this is reducing an existing position
  const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
  const currentSzi = pos.szi ?? '0';

  if (!isZero(currentSzi)) {
    const isLong = gt(currentSzi, '0');
    const isReducing = (isLong && !isBuy) || (!isLong && isBuy);

    if (isReducing) {
      // Reducing a position doesn't require additional margin
      return true;
    }
  }

  const orderNotional = mul(sz, px);
  const marginNeeded = div(orderNotional, leverage.toString());

  return !lt(available, marginNeeded);
}

export function calculateLiquidationPrice(
  szi: string,
  entryPx: string,
  accountValue: string,
  leverage: number,
): string | null {
  if (isZero(szi)) return null;

  const isLong = gt(szi, '0');
  const size = abs(szi);
  const margin = div(mul(size, entryPx), leverage.toString());

  // Maintenance margin is ~half of initial margin
  const maintMarginRate = div('1', (leverage * 2).toString());

  if (isLong) {
    // liqPx = entryPx * (1 - 1/leverage + maintMarginRate)
    // Simplified: price drops enough to eat through margin
    const liqPx = mul(entryPx, sub('1', sub(div('1', leverage.toString()), maintMarginRate)));
    return gt(liqPx, '0') ? liqPx : '0';
  } else {
    const liqPx = mul(entryPx, add('1', sub(div('1', leverage.toString()), maintMarginRate)));
    return liqPx;
  }
}

export function calculateIsolatedLiquidationPrice(
  szi: string,
  entryPx: string,
  isolatedMargin: string,
  maxLeverage: number,
): string | null {
  if (isZero(szi)) return null;
  if (!Number.isSafeInteger(maxLeverage) || maxLeverage < 1) {
    throw new Error('maxLeverage must be a positive integer');
  }

  const size = D(szi).abs();
  const entry = D(entryPx);
  const marginPerUnit = D(isolatedMargin).div(size);
  const maintenanceRate = D(1).div(D(maxLeverage).times(2));
  if (D(szi).greaterThan(0)) {
    const result = entry.minus(marginPerUnit).div(D(1).minus(maintenanceRate));
    return result.greaterThan(0) ? result.toString() : '0';
  }
  return entry.plus(marginPerUnit).div(D(1).plus(maintenanceRate)).toString();
}
