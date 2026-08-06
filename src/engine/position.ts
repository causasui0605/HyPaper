import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import {
  calculateAccountValue,
  getBalance,
  calculateTotalUnrealizedPnl,
  calculateTotalMarginUsed,
  calculatePositionUnrealizedPnl,
  calculatePositionMarginUsed,
  calculateLiquidationPrice,
  calculateIsolatedLiquidationPrice,
  getMarkPrice,
} from './margin.js';
import { getAssetMetadata } from './asset.js';
import { abs, sub, mul, div, isZero, gt, D } from '../utils/math.js';
import type { HlClearinghouseState, HlAssetPosition } from '../types/hl.js';

export async function getClearinghouseState(userId: string): Promise<HlClearinghouseState> {
  const balance = await getBalance(userId);
  const positionAssets = await redis.smembers(KEYS.USER_POSITIONS(userId));

  const assetPositions: HlAssetPosition[] = [];
  let totalNtlPos = '0';
  let totalMarginUsed = '0';
  let totalUnrealizedPnl = '0';
  let totalMaintenanceMarginUsed = '0';

  for (const assetStr of positionAssets) {
    const asset = parseInt(assetStr, 10);
    const pos = await redis.hgetall(KEYS.USER_POS(userId, asset));
    if (!pos.szi || isZero(pos.szi)) continue;

    const coin = pos.coin;
    const markPx = await getMarkPrice(coin);
    if (!markPx) throw new Error(`No finite positive mark price for ${coin}`);

    const lev = await redis.hgetall(KEYS.USER_LEV(userId, asset));
    const leverage = lev.leverage ? parseInt(lev.leverage, 10) : 20;
    const isCross = lev.isCross !== 'false';

    const posValue = mul(abs(pos.szi), markPx);
    const unrealizedPnl = calculatePositionUnrealizedPnl(pos.szi, pos.entryPx, markPx);
    const marginUsed = await calculatePositionMarginUsed(userId, asset, pos.szi, markPx);
    const metadata = await getAssetMetadata(asset);
    if (
      !metadata?.maxLeverage
      || !Number.isSafeInteger(metadata.maxLeverage)
      || metadata.maxLeverage < 1
    ) {
      throw new Error(`Asset ${asset} has no valid maxLeverage metadata`);
    }
    const maxLeverage = metadata.maxLeverage;

    const accountValue = await calculateAccountValue(userId);
    const liqPx = isCross
      ? calculateLiquidationPrice(pos.szi, pos.entryPx, accountValue, leverage)
      : calculateIsolatedLiquidationPrice(pos.szi, pos.entryPx, marginUsed, maxLeverage);

    const roe = isZero(marginUsed)
      ? '0'
      : div(unrealizedPnl, marginUsed);

    totalNtlPos = D(totalNtlPos).plus(D(posValue)).toString();
    totalMarginUsed = D(totalMarginUsed).plus(D(marginUsed)).toString();
    totalUnrealizedPnl = D(totalUnrealizedPnl).plus(D(unrealizedPnl)).toString();
    totalMaintenanceMarginUsed = D(totalMaintenanceMarginUsed)
      .plus(D(posValue).div(D(maxLeverage).times(2)))
      .toString();

    assetPositions.push({
      type: 'oneWay',
      position: {
        coin,
        szi: pos.szi,
        entryPx: pos.entryPx,
        positionValue: posValue,
        unrealizedPnl,
        returnOnEquity: roe,
        liquidationPx: liqPx,
        leverage: isCross
          ? { type: 'cross', value: leverage }
          : { type: 'isolated', value: leverage, rawUsd: marginUsed },
        cumFunding: {
          allTime: pos.cumFunding ?? '0',
          sinceOpen: pos.cumFundingSinceOpen ?? '0',
          sinceChange: pos.cumFundingSinceChange ?? '0',
        },
        maxLeverage,
        marginUsed,
      },
    });
  }

  const accountValue = D(balance).plus(D(totalUnrealizedPnl)).toString();
  const withdrawable = sub(accountValue, totalMarginUsed);

  return {
    assetPositions,
    crossMarginSummary: {
      accountValue,
      totalNtlPos,
      totalRawUsd: balance,
      totalMarginUsed,
    },
    marginSummary: {
      accountValue,
      totalNtlPos,
      totalRawUsd: balance,
      totalMarginUsed,
    },
    crossMaintenanceMarginUsed: totalMaintenanceMarginUsed,
    withdrawable: gt(withdrawable, '0') ? withdrawable : '0',
    time: Date.now(),
  };
}

export async function getOpenOrders(userId: string) {
  const oids = await redis.zrange(KEYS.USER_ORDERS(userId), 0, -1);
  const orders = [];

  for (const oidStr of oids) {
    const oid = parseInt(oidStr, 10);
    const data = await redis.hgetall(KEYS.ORDER(oid));
    if (!data.oid || data.status !== 'open') continue;

    orders.push({
      coin: data.coin,
      side: data.isBuy === 'true' ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid,
      timestamp: parseInt(data.createdAt, 10),
      origSz: data.sz,
      cloid: data.cloid || undefined,
    });
  }

  return orders;
}

export async function getFrontendOpenOrders(userId: string) {
  const oids = await redis.zrange(KEYS.USER_ORDERS(userId), 0, -1);
  const orders = [];

  for (const oidStr of oids) {
    const oid = parseInt(oidStr, 10);
    const data = await redis.hgetall(KEYS.ORDER(oid));
    if (!data.oid || data.status !== 'open') continue;

    orders.push({
      coin: data.coin,
      side: data.isBuy === 'true' ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid,
      timestamp: parseInt(data.createdAt, 10),
      origSz: data.sz,
      cloid: data.cloid || undefined,
      tif: data.tif,
      orderType: data.orderType === 'trigger' ? 'Stop' : 'Limit',
      triggerPx: data.triggerPx || undefined,
      triggerCondition: data.tpsl || undefined,
      isPositionTpsl: data.grouping === 'positionTpsl',
      reduceOnly: data.reduceOnly === 'true',
    });
  }

  return orders;
}

export async function getOrderStatus(oid: number) {
  const data = await redis.hgetall(KEYS.ORDER(oid));
  if (!data.oid) {
    return { status: 'unknownOid' };
  }

  return {
    status: 'order',
    order: {
      coin: data.coin,
      side: data.isBuy === 'true' ? 'B' : 'A',
      limitPx: data.limitPx,
      sz: data.sz,
      oid: parseInt(data.oid, 10),
      timestamp: parseInt(data.createdAt, 10),
      origSz: data.sz,
      cloid: data.cloid || undefined,
      tif: data.tif,
      orderType: data.orderType === 'trigger' ? 'Stop' : 'Limit',
      triggerPx: data.triggerPx || undefined,
      triggerCondition: data.tpsl || undefined,
      isPositionTpsl: data.grouping === 'positionTpsl',
      reduceOnly: data.reduceOnly === 'true',
      status: data.status,
      statusTimestamp: parseInt(data.updatedAt, 10),
    },
  };
}
