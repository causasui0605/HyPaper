import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { D, add, sub, mul, div, abs, gt, lt, isZero, neg } from '../utils/math.js';
import DecimalModule from 'decimal.js';
import { getAssetMetadata } from './asset.js';

const Decimal = DecimalModule.default ?? DecimalModule;

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

/** A refused `updateIsolatedMargin`: nothing was written; the message is the HL-shaped error text. */
export class IsolatedMarginRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IsolatedMarginRefusal';
  }
}

/**
 * Compare-and-set commit for `updateIsolatedMargin`. ARGV[1] is a JSON spec:
 * `checks` = [keyIndex, field, present, value] — every hash field the decision read must
 * still hold the value it was read with (`present` false = the field was absent);
 * `members` = the exact position-set membership read; `set` / `target` = key indexes of
 * the position set and of the target leverage hash; `margin` = the new isolated margin.
 * Any drift returns `conflict` and writes nothing; otherwise the single HSET commits.
 */
// Plain decimal text, or the exponent form decimal.js's toString() emits for very small or very
// large values (e.g. "1e-7"): both are written by the engine, both are accepted.
// The exponent is bounded (|e| <= 99) so every accepted operand is finite and every derived
// figure stays far inside decimal.js's range; anything larger is malformed for an account.
const DECIMAL_TEXT = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d{1,2})?$/;

// The authorization arithmetic runs at 1000 significant digits: every accepted operand has at
// most MAX_OPERAND_CHARS characters and |exponent| <= 99, so sums, differences and products are
// exact and only the division by an integer leverage can round (far below any money unit).
const XD = Decimal.clone({ precision: 1000, rounding: Decimal.ROUND_HALF_UP });
type XDec = InstanceType<typeof XD>;
const MAX_OPERAND_CHARS = 200;
const MAX_MAGNITUDE = new XD('1e30');
const MAX_DECIMALS = 60;

/** Strict decimal text → exact Decimal; a missing or malformed value refuses the move. */
function strictDecimal(value: string | undefined, what: string): XDec {
  if (value === undefined || value.length > MAX_OPERAND_CHARS || !DECIMAL_TEXT.test(value)) {
    throw new IsolatedMarginRefusal(`The ${what} is missing or malformed`);
  }
  const parsed = new XD(value);
  if (!parsed.isFinite()) throw new IsolatedMarginRefusal(`The ${what} is not a finite number`);
  // Account figures are bounded (|x| < 1e30, at most 60 decimal places — engine fills store 30
  // significant digits, e.g. 0.0333…3 with 31 places). Every value this action commits is checked
  // against the same bound before the write, so it is always accepted by this reader again.
  if (!parsed.abs().lessThan(MAX_MAGNITUDE) || parsed.decimalPlaces() > MAX_DECIMALS) {
    throw new IsolatedMarginRefusal(`The ${what} is out of range`);
  }
  return parsed;
}

/** Whether text is a bounded (same rules as strictDecimal), strictly positive decimal. */
function boundedPositive(value: string | undefined): boolean {
  if (value === undefined || value.length > MAX_OPERAND_CHARS || !DECIMAL_TEXT.test(value)) return false;
  const parsed = new XD(value);
  return parsed.isFinite() && parsed.greaterThan(0) && parsed.lessThan(MAX_MAGNITUDE)
    && parsed.decimalPlaces() <= MAX_DECIMALS;
}

export const UPDATE_ISOLATED_MARGIN_LUA = `
local spec = cjson.decode(ARGV[1])
for _, c in ipairs(spec.checks) do
  local v = redis.call('HGET', KEYS[c[1]], c[2])
  if c[3] then
    if v ~= c[4] then return 'conflict' end
  else
    if v ~= false then return 'conflict' end
  end
end
if redis.call('SCARD', KEYS[spec.set]) ~= #spec.members then return 'conflict' end
for _, m in ipairs(spec.members) do
  if redis.call('SISMEMBER', KEYS[spec.set], m) ~= 1 then return 'conflict' end
end
redis.call('HSET', KEYS[spec.target], 'isolatedMargin', spec.margin)
return 'applied'
`;

const UPDATE_ISOLATED_MARGIN_ATTEMPTS = 5;
const USD_INT_SCALE = '1000000';


interface MarginCheck { key: string; field: string; value: string | undefined }

/**
 * Hyperliquid `updateIsolatedMargin`: move `ntli / 1e6` USD between the free (withdrawable)
 * balance and the isolated margin of an open isolated position. Positive adds, negative removes.
 * HyPaper's isolated margin is a reservation inside account value, so the account `balance`
 * hash and account value do not move; withdrawable moves by the opposite amount.
 *
 * Removal must leave the margin at or above the transfer margin requirement
 * max(|szi| * mark / leverage, 0.1 * |szi| * mark). Every input to the decision is re-checked
 * in one Lua compare-and-set at commit; a concurrent change retries the decision.
 */
export async function updateIsolatedMargin(
  userId: string,
  asset: number,
  isBuy: unknown,
  ntli: unknown,
): Promise<{ isolatedMarginBefore: string; isolatedMarginAfter: string }> {
  if (typeof ntli !== 'number' || !Number.isSafeInteger(ntli)) {
    throw new IsolatedMarginRefusal('ntli must be a safe integer');
  }
  if (ntli === 0) throw new IsolatedMarginRefusal('ntli must be non-zero');
  if (typeof isBuy !== 'boolean') throw new IsolatedMarginRefusal('isBuy must be a boolean');
  const metadata = await getAssetMetadata(asset);
  if (!metadata) throw new IsolatedMarginRefusal(`Unknown asset ${asset}`);
  const delta = new XD(ntli).div(USD_INT_SCALE).toFixed();

  for (let attempt = 0; attempt < UPDATE_ISOLATED_MARGIN_ATTEMPTS; attempt += 1) {
    const checks: MarginCheck[] = [];
    const read = async (key: string, field: string): Promise<string | undefined> => {
      const value = (await redis.hget(key, field)) ?? undefined;
      checks.push({ key, field, value });
      return value;
    };

    const accountKey = KEYS.USER_ACCOUNT(userId);
    const balanceText = await read(accountKey, 'balance');
    const balance = strictDecimal(balanceText, 'account balance');
    const setKey = KEYS.USER_POSITIONS(userId);
    const members = [...(await redis.smembers(setKey))].sort();
    const targetLevKey = KEYS.USER_LEV(userId, asset);

    // Every accounting operand is validated as decimal text BEFORE any arithmetic; a missing or
    // malformed one refuses the move (never skipped, never substituted).
    let unrealized = new XD(0);
    let marginUsed = new XD(0);
    let target: { szi: string; mark: string; lev: Record<string, string | undefined> } | null = null;
    for (const member of members) {
      if (!/^(?:0|[1-9]\d*)$/.test(member) || !Number.isSafeInteger(Number(member))) {
        throw new IsolatedMarginRefusal(`Position set holds a malformed asset id ${JSON.stringify(member)}`);
      }
      const memberAsset = Number(member);
      const posKey = KEYS.USER_POS(userId, memberAsset);
      const levKey = KEYS.USER_LEV(userId, memberAsset);
      const sziText = await read(posKey, 'szi');
      const entryPx = await read(posKey, 'entryPx');
      const coin = await read(posKey, 'coin');
      const lev = {
        isCross: await read(levKey, 'isCross'),
        leverage: await read(levKey, 'leverage'),
        isolatedMargin: await read(levKey, 'isolatedMargin'),
      };
      const szi = strictDecimal(sziText, `size of asset ${memberAsset}`);
      if (szi.isZero()) continue;
      const entry = strictDecimal(entryPx, `entry price of asset ${memberAsset}`);
      if (!entry.greaterThan(0)) {
        throw new IsolatedMarginRefusal(`Position on asset ${memberAsset} has a non-positive entry price`);
      }
      if (!coin) throw new IsolatedMarginRefusal(`Position on asset ${memberAsset} has no coin`);
      const markRaw = await read(KEYS.MARKET_CTX(coin), 'markPx');
      const mark = boundedPositive(markRaw) ? markRaw as string : null;
      if (lev.isCross !== undefined && lev.isCross !== 'true' && lev.isCross !== 'false') {
        throw new IsolatedMarginRefusal(`Margin mode of asset ${memberAsset} is malformed`);
      }
      if (lev.leverage !== undefined
        && (!/^[1-9][0-9]*$/.test(lev.leverage) || !Number.isSafeInteger(Number(lev.leverage)))) {
        throw new IsolatedMarginRefusal(`Leverage of asset ${memberAsset} is malformed`);
      }
      const storedMargin = lev.isolatedMargin === undefined || lev.isolatedMargin === ''
        ? null
        : strictDecimal(lev.isolatedMargin, `isolated margin of asset ${memberAsset}`);
      if (storedMargin && storedMargin.isNegative()) {
        throw new IsolatedMarginRefusal(`The isolated margin of asset ${memberAsset} is negative`);
      }
      if (memberAsset === asset) {
        if (coin !== metadata.coin) {
          throw new IsolatedMarginRefusal(`Position coin does not match asset ${asset}`);
        }
        if (!mark) throw new IsolatedMarginRefusal(`Asset ${asset} has no finite positive mark price`);
        target = { szi: szi.toString(), mark, lev };
      }
      if (!mark) throw new IsolatedMarginRefusal(`No finite positive mark price for ${coin}`);
      // signed size × (mark − entry): long gains when mark > entry, short when mark < entry
      unrealized = unrealized.plus(szi.times(new XD(mark).minus(entry)));
      marginUsed = marginUsed.plus(
        lev.isCross === 'false' && storedMargin && storedMargin.greaterThan(0)
          ? storedMargin
          : szi.abs().times(new XD(mark)).div(lev.leverage ? Number(lev.leverage) : DEFAULT_LEVERAGE)
            .toDecimalPlaces(MAX_DECIMALS, Decimal.ROUND_HALF_UP),
      );
    }

    if (!target) throw new IsolatedMarginRefusal(`Asset ${asset} has no open position`);
    if (target.lev.isCross !== 'false') {
      throw new IsolatedMarginRefusal(`Cannot update isolated margin on a cross position for asset ${asset}`);
    }
    // isBuy is required to be a boolean but is not checked against the position side:
    // Hyperliquid's own SDK always sends isBuy true (exchange.update_isolated_margin).
    const leverageText = target.lev.leverage ?? String(DEFAULT_LEVERAGE);
    if (!/^[1-9][0-9]*$/.test(leverageText) || !Number.isSafeInteger(Number(leverageText))) {
      throw new Error(`Stored leverage for asset ${asset} is not a positive integer`);
    }
    const leverage = Number(leverageText);
    const notional = new XD(target.szi).abs().times(new XD(target.mark));
    const stored = target.lev.isolatedMargin;
    // The target's current margin exactly as marginUsed counted it: the stored margin, else the
    // derived reservation notional / leverage taken at MAX_DECIMALS places (half up). The committed
    // margin is exactly that plus ntli/1e6 (no other rounding), and must itself be readable.
    const currentExact = stored && new XD(stored).greaterThan(0)
      ? new XD(stored)
      : notional.div(leverage).toDecimalPlaces(MAX_DECIMALS, Decimal.ROUND_HALF_UP);
    const committed = currentExact.plus(new XD(delta));
    const actualChange = committed.minus(currentExact);
    if (!committed.abs().lessThan(MAX_MAGNITUDE) || committed.decimalPlaces() > MAX_DECIMALS) {
      throw new IsolatedMarginRefusal('The new isolated margin would be out of range');
    }
    if (!notional.isFinite() || !currentExact.isFinite() || !committed.isFinite()
      || !unrealized.isFinite() || !marginUsed.isFinite()) {
      throw new IsolatedMarginRefusal('An account figure is not a finite value');
    }
    if (ntli > 0) {
      const withdrawable = balance.plus(unrealized).minus(marginUsed);
      if (!withdrawable.isFinite()) {
        throw new IsolatedMarginRefusal('Withdrawable balance is not a finite value');
      }
      if (actualChange.greaterThan(withdrawable)) {
        throw new IsolatedMarginRefusal('Insufficient withdrawable balance to add isolated margin');
      }
    } else {
      const initialMargin = notional.div(leverage);
      const tenPercent = notional.times('0.1');
      const requirement = initialMargin.greaterThan(tenPercent) ? initialMargin : tenPercent;
      if (committed.lessThan(requirement)) {
        throw new IsolatedMarginRefusal(
          `Removal would leave isolated margin below the transfer margin requirement ${requirement.toDecimalPlaces(6, Decimal.ROUND_UP).toFixed()}`,
        );
      }
    }
    const newMargin = committed.toFixed();

    const keys: string[] = [];
    const keyIndex = (key: string): number => {
      const found = keys.indexOf(key);
      if (found >= 0) return found + 1;
      keys.push(key);
      return keys.length;
    };
    const spec = {
      checks: checks.map((c) => [keyIndex(c.key), c.field, c.value !== undefined, c.value ?? '']),
      set: keyIndex(setKey),
      members,
      target: keyIndex(targetLevKey),
      margin: newMargin,
    };
    const outcome = await redis.eval(UPDATE_ISOLATED_MARGIN_LUA, keys.length, ...keys, JSON.stringify(spec));
    if (outcome === 'applied') {
      return { isolatedMarginBefore: currentExact.toFixed(), isolatedMarginAfter: newMargin };
    }
    if (outcome !== 'conflict') throw new Error(`Unexpected updateIsolatedMargin commit result ${String(outcome)}`);
  }
  throw new IsolatedMarginRefusal('Account state changed concurrently; updateIsolatedMargin not applied');
}
