import { z } from 'zod';
import { redis } from '../store/redis.js';
import { KEYS } from '../store/keys.js';
import { getClearinghouseState } from './position.js';
import { getUserExecutionPresencePg } from '../store/pg-queries.js';
import { D } from '../utils/math.js';
import { getHistoricalReplay } from './historical-replay.js';
import type { HistoricalReplayResult } from '../types/historical-replay.js';
import { pnlFundingEventId } from '../worker/funding-worker.js';
import {
  pnlFundingEventSchema,
  type PnlAssetSnapshot,
  type PnlFundingEvent,
  type PnlSnapshot,
} from '../types/pnl.js';

export interface PnlRedis {
  get(key: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  keys(pattern: string): Promise<string[]>;
  zcard(key: string): Promise<number>;
}

export interface PnlDependencies {
  redis: PnlRedis;
  clearinghouseState: (user: string) => Promise<unknown>;
  executionPresencePg: (user: string) => Promise<{ orders: boolean; fills: boolean }>;
  historicalReplay: (user: string, batchId: string) => Promise<HistoricalReplayResult>;
}

const defaultDependencies: PnlDependencies = {
  redis,
  clearinghouseState: getClearinghouseState,
  executionPresencePg: getUserExecutionPresencePg,
  historicalReplay: getHistoricalReplay,
};

const decimalString = z.string().refine((value) => {
  try {
    return D(value).isFinite();
  } catch {
    return false;
  }
}, 'must be a finite decimal string');
const positiveDecimalString = decimalString.refine((value) => D(value).isPositive());
const nonnegativeDecimalString = decimalString.refine((value) => !D(value).isNegative());

const positionSchema = z.object({
  coin: z.string().min(1).max(128),
  szi: decimalString,
  entryPx: decimalString,
  unrealizedPnl: decimalString,
}).passthrough();

const clearinghouseSchema = z.object({
  assetPositions: z.array(z.object({
    type: z.literal('oneWay'),
    position: positionSchema,
  }).strict()),
  crossMarginSummary: z.object({ accountValue: decimalString }).passthrough(),
  marginSummary: z.object({ accountValue: decimalString }).passthrough(),
  time: z.number().int().nonnegative().safe(),
}).passthrough();

const ordinaryFillSchema = z.object({
  coin: z.string().min(1).max(128),
  px: positiveDecimalString,
  sz: positiveDecimalString,
  side: z.enum(['B', 'A']),
  closedPnl: decimalString,
  fee: nonnegativeDecimalString,
  time: z.number().int().nonnegative().safe(),
  startPosition: decimalString,
  dir: z.string().min(1).max(128),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  oid: z.number().int().nonnegative().safe(),
  crossed: z.boolean(),
  tid: z.number().int().nonnegative().safe(),
  cloid: z.string().min(1).max(256).optional(),
  feeToken: z.literal('USDC'),
}).strict();

export class PnlSnapshotError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 409) {
    super(message);
    this.name = 'PnlSnapshotError';
  }
}

function refuse(message: string, status: 400 | 404 | 409 = 409): never {
  throw new PnlSnapshotError(message, status);
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    refuse(`${label} is not valid JSON`);
  }
}

function emptyAsset(coin: string): PnlAssetSnapshot {
  return {
    coin,
    szi: '0',
    entryPx: null,
    markPx: null,
    replayRealizedPnl: '0',
    ordinaryRealizedPnl: '0',
    replayFees: '0',
    ordinaryFees: '0',
    fundingCharge: '0',
    unrealizedPnl: '0',
    totalPnl: '0',
  };
}

function addField(asset: PnlAssetSnapshot, field: keyof Pick<
  PnlAssetSnapshot,
  'replayRealizedPnl' | 'ordinaryRealizedPnl' | 'replayFees' | 'ordinaryFees' | 'fundingCharge'
>, value: string): void {
  asset[field] = D(asset[field]).plus(D(value)).toString();
}

function stableState(state: z.infer<typeof clearinghouseSchema>): string {
  return JSON.stringify({
    assetPositions: state.assetPositions.slice().sort((left, right) =>
      left.position.coin.localeCompare(right.position.coin)),
    crossAccountValue: state.crossMarginSummary.accountValue,
    totalAccountValue: state.marginSummary.accountValue,
  });
}

export async function getPnlSnapshot(
  user: string,
  coins: readonly string[],
  dependencies: PnlDependencies = defaultDependencies,
): Promise<PnlSnapshot> {
  const normalizedUser = user.toLowerCase();
  if (coins.length === 0 || new Set(coins).size !== coins.length) {
    refuse('PnL snapshot coins must be non-empty and unique', 400);
  }
  const requested = new Set(coins);
  const assets = new Map(coins.map((coin) => [coin, emptyAsset(coin)]));

  const account = await dependencies.redis.hgetall(KEYS.USER_ACCOUNT(normalizedUser));
  if (account.userId !== normalizedUser || !account.balance || !D(account.balance).isFinite()) {
    refuse('paper account is missing or has a different identity', 404);
  }

  const [rawState, replayBatchId, ordinaryRaw, fundingIds, orderCount] = await Promise.all([
    dependencies.clearinghouseState(normalizedUser),
    dependencies.redis.get(KEYS.HISTORICAL_REPLAY_INDEX(normalizedUser)),
    dependencies.redis.lrange(KEYS.USER_FILLS(normalizedUser), 0, -1),
    dependencies.redis.lrange(KEYS.PNL_FUNDING_EVENTS(normalizedUser), 0, -1),
    dependencies.redis.zcard(KEYS.USER_ORDERS(normalizedUser)),
  ]);
  const state = clearinghouseSchema.parse(rawState);
  if (state.crossMarginSummary.accountValue !== state.marginSummary.accountValue) {
    refuse('cross and total account value disagree');
  }

  const currentPositions = new Map<string, z.infer<typeof positionSchema>>();
  for (const wrapper of state.assetPositions) {
    const position = wrapper.position;
    if (!requested.has(position.coin)) refuse(`held coin ${position.coin} is outside requested PnL scope`);
    if (currentPositions.has(position.coin)) refuse(`duplicate position for ${position.coin}`);
    if (D(position.szi).isZero()) refuse(`zero position for ${position.coin} must be omitted`);
    if (!D(position.entryPx).isPositive()) refuse(`position entry price for ${position.coin} is nonpositive`);
    currentPositions.set(position.coin, position);
  }

  const ordinaryFills = ordinaryRaw.map((raw, index) =>
    ordinaryFillSchema.parse(parseJson(raw, `ordinary fill ${index}`)));
  if (new Set(ordinaryFills.map((fill) => fill.tid)).size !== ordinaryFills.length) {
    refuse('ordinary fill ledger contains duplicate transaction ids');
  }
  if (new Set(ordinaryFills.map((fill) => fill.hash)).size !== ordinaryFills.length) {
    refuse('ordinary fill ledger contains duplicate hashes');
  }
  for (const fill of ordinaryFills) {
    const expectedHash = `0x${fill.tid.toString(16).padStart(64, '0')}`;
    if (fill.hash !== expectedHash) refuse(`ordinary fill ${fill.tid} has a different paper identity`);
  }
  ordinaryFills.sort((left, right) => left.time - right.time || left.tid - right.tid);
  for (const fill of ordinaryFills) {
    const asset = assets.get(fill.coin);
    if (!asset) refuse(`ordinary fill coin ${fill.coin} is outside requested PnL scope`);
    addField(asset, 'ordinaryRealizedPnl', fill.closedPnl);
    addField(asset, 'ordinaryFees', fill.fee);
  }

  if (new Set(fundingIds).size !== fundingIds.length) refuse('funding ledger contains duplicate event ids');
  const fundingKeys = await dependencies.redis.keys(
    KEYS.PNL_FUNDING_EVENT(normalizedUser, '*'),
  );
  const expectedFundingKeys = fundingIds.map((id) => KEYS.PNL_FUNDING_EVENT(normalizedUser, id));
  if (
    fundingKeys.length !== expectedFundingKeys.length
    || fundingKeys.some((key) => !expectedFundingKeys.includes(key))
  ) {
    refuse('funding ledger index and immutable event keys disagree');
  }
  const fundingEvents: PnlFundingEvent[] = [];
  const fundingEventRaw: string[] = [];
  let priorAppliedAt = -1;
  let priorFundingTime = -1;
  for (const [index, id] of fundingIds.entries()) {
    const raw = await dependencies.redis.get(KEYS.PNL_FUNDING_EVENT(normalizedUser, id));
    if (!raw) refuse(`funding event ${id} is missing`);
    const event = pnlFundingEventSchema.parse(parseJson(raw, `funding event ${index}`));
    if (event.eventId !== id) refuse(`funding event ${id} has a different identity`);
    if (event.eventId !== pnlFundingEventId(normalizedUser, event.asset, event.fundingTime)) {
      refuse(`funding event ${id} is not bound to this account, asset, and funding time`);
    }
    if (event.appliedAt < event.fundingTime) refuse(`funding event ${id} predates its funding time`);
    if (event.appliedAt < priorAppliedAt || event.fundingTime < priorFundingTime) {
      refuse(`funding event ${id} is out of immutable ledger order`);
    }
    if (!D(event.fundingCharge).eq(D(event.szi).times(D(event.markPx)).times(D(event.fundingRate)))) {
      refuse(`funding event ${id} charge does not match its model inputs`);
    }
    if (!D(event.accountBalanceAfter).eq(D(event.accountBalanceBefore).minus(D(event.fundingCharge)))) {
      refuse(`funding event ${id} account transition does not reconcile`);
    }
    for (const [before, after, label] of [
      [event.cumFundingBefore, event.cumFundingAfter, 'cumulative'],
      [event.cumFundingSinceOpenBefore, event.cumFundingSinceOpenAfter, 'open cumulative'],
      [event.cumFundingSinceChangeBefore, event.cumFundingSinceChangeAfter, 'change cumulative'],
    ] as const) {
      if (!D(after).eq(D(before).plus(D(event.fundingCharge)))) {
        refuse(`funding event ${id} ${label} transition does not reconcile`);
      }
    }
    priorAppliedAt = event.appliedAt;
    priorFundingTime = event.fundingTime;
    fundingEvents.push(event);
    fundingEventRaw.push(raw);
  }

  let startingBalance: string;
  let replayId: string | null = null;
  let replayFinalBalance: string | null = null;
  let replayRaw: string | null = null;
  const replayAssetCoins = new Map<number, string>();
  if (replayBatchId) {
    replayRaw = await dependencies.redis.get(
      KEYS.HISTORICAL_REPLAY_BATCH(normalizedUser, replayBatchId),
    );
    if (!replayRaw) refuse('historical replay index lacks its immutable batch');
    const replay = await dependencies.historicalReplay(normalizedUser, replayBatchId);
    if (replay.user !== normalizedUser || replay.batchId !== replayBatchId) {
      refuse('historical replay identity does not match the account');
    }
    startingBalance = replay.startingBalance;
    replayId = replay.batchId;
    replayFinalBalance = replay.finalBalance;
    for (const event of replay.events.slice().sort((left, right) => left.sequence - right.sequence)) {
      const asset = assets.get(event.coin);
      if (!asset) refuse(`replay event coin ${event.coin} is outside requested PnL scope`);
      const priorCoin = replayAssetCoins.get(event.asset);
      if (priorCoin !== undefined && priorCoin !== event.coin) {
        refuse(`replay asset ${event.asset} has inconsistent coin identities`);
      }
      replayAssetCoins.set(event.asset, event.coin);
      addField(asset, 'replayRealizedPnl', event.closedPnl);
      addField(asset, 'replayFees', event.fee);
    }
    const replayNet = [...assets.values()].reduce(
      (total, asset) => total.plus(D(asset.replayRealizedPnl)).minus(D(asset.replayFees)),
      D(0),
    );
    if (!D(replay.finalBalance).eq(D(startingBalance).plus(replayNet))) {
      refuse('immutable replay final balance does not reconcile to its event ledger');
    }
    if (fundingEvents.some((event) => event.appliedAt < replay.replayedAt)) {
      refuse('funding ledger contains an event from before the immutable replay import');
    }
    if (ordinaryFills.some((fill) => fill.time < replay.replayedAt)) {
      refuse('ordinary fills contain an event from before the immutable replay import');
    }
  } else {
    const pgPresence = await dependencies.executionPresencePg(normalizedUser);
    const pristine = ordinaryFills.length === 0
      && fundingIds.length === 0
      && currentPositions.size === 0
      && orderCount === 0
      && !pgPresence.orders
      && !pgPresence.fills;
    if (!pristine) refuse('programme activity exists without an immutable starting-balance replay');
    startingBalance = state.crossMarginSummary.accountValue;
  }

  for (const event of fundingEvents) {
    const replayCoin = replayAssetCoins.get(event.asset);
    if (replayCoin === undefined || replayCoin !== event.coin) {
      refuse(`funding event ${event.eventId} does not match immutable replay asset identity`);
    }
    const asset = assets.get(event.coin);
    if (!asset) refuse(`funding event coin ${event.coin} is outside requested PnL scope`);
    addField(asset, 'fundingCharge', event.fundingCharge);
  }

  for (const [coin, position] of currentPositions) {
    const context = await dependencies.redis.hgetall(KEYS.MARKET_CTX(coin));
    if (!context.markPx || !D(context.markPx).isFinite() || !D(context.markPx).isPositive()) {
      refuse(`current mark for ${coin} is missing or invalid`);
    }
    const size = D(position.szi);
    const entry = D(position.entryPx);
    const mark = D(context.markPx);
    const calculated = size.isPositive()
      ? mark.minus(entry).times(size.abs())
      : entry.minus(mark).times(size.abs());
    if (!calculated.eq(D(position.unrealizedPnl))) {
      refuse(`current mark and clearinghouse unrealized PnL disagree for ${coin}`);
    }
    const asset = assets.get(coin)!;
    asset.szi = position.szi;
    asset.entryPx = position.entryPx;
    asset.markPx = context.markPx;
    asset.unrealizedPnl = position.unrealizedPnl;
  }

  const currentUnrealized = [...assets.values()].reduce(
    (total, asset) => total.plus(D(asset.unrealizedPnl)), D(0),
  );
  if (!D(account.balance).plus(currentUnrealized).eq(D(state.crossMarginSummary.accountValue))) {
    refuse('paper cash balance and current unrealized PnL do not reconcile to account value');
  }

  if (replayBatchId) {
    const ordinaryNet = [...assets.values()].reduce(
      (total, asset) => total.plus(D(asset.ordinaryRealizedPnl)).minus(D(asset.ordinaryFees)),
      D(0),
    );
    const fundingTotal = [...assets.values()].reduce(
      (total, asset) => total.plus(D(asset.fundingCharge)), D(0),
    );
    const expectedCash = D(replayFinalBalance!).plus(ordinaryNet).minus(fundingTotal);
    if (!D(account.balance).eq(expectedCash)) {
      refuse('paper cash balance does not reconcile to replay, fills, fees, and funding ledgers');
    }
  }

  for (const asset of assets.values()) {
    asset.totalPnl = D(asset.replayRealizedPnl)
      .plus(D(asset.ordinaryRealizedPnl))
      .minus(D(asset.replayFees))
      .minus(D(asset.ordinaryFees))
      .minus(D(asset.fundingCharge))
      .plus(D(asset.unrealizedPnl))
      .toString();
  }
  const totalPnl = [...assets.values()]
    .reduce((total, asset) => total.plus(D(asset.totalPnl)), D(0))
    .toString();
  const accountDelta = D(state.crossMarginSummary.accountValue).minus(D(startingBalance)).toString();
  if (totalPnl !== accountDelta) {
    refuse(`asset PnL does not reconcile to account value: assets=${totalPnl}, account=${accountDelta}`);
  }

  const [finalAccount, finalStateRaw, finalReplayBatchId, finalOrdinaryRaw, finalFundingIds,
    finalOrderCount, finalFundingKeys, finalReplayRaw, finalFundingEventRaw] = await Promise.all([
    dependencies.redis.hgetall(KEYS.USER_ACCOUNT(normalizedUser)),
    dependencies.clearinghouseState(normalizedUser),
    dependencies.redis.get(KEYS.HISTORICAL_REPLAY_INDEX(normalizedUser)),
    dependencies.redis.lrange(KEYS.USER_FILLS(normalizedUser), 0, -1),
    dependencies.redis.lrange(KEYS.PNL_FUNDING_EVENTS(normalizedUser), 0, -1),
    dependencies.redis.zcard(KEYS.USER_ORDERS(normalizedUser)),
    dependencies.redis.keys(KEYS.PNL_FUNDING_EVENT(normalizedUser, '*')),
    replayBatchId
      ? dependencies.redis.get(KEYS.HISTORICAL_REPLAY_BATCH(normalizedUser, replayBatchId))
      : Promise.resolve(null),
    Promise.all(fundingIds.map((id) =>
      dependencies.redis.get(KEYS.PNL_FUNDING_EVENT(normalizedUser, id)))),
  ]);
  const finalState = clearinghouseSchema.parse(finalStateRaw);
  if (
    finalAccount.userId !== account.userId
    || finalAccount.balance !== account.balance
    || stableState(finalState) !== stableState(state)
    || finalReplayBatchId !== replayBatchId
    || finalReplayRaw !== replayRaw
    || JSON.stringify(finalOrdinaryRaw) !== JSON.stringify(ordinaryRaw)
    || JSON.stringify(finalFundingIds) !== JSON.stringify(fundingIds)
    || JSON.stringify(finalFundingEventRaw) !== JSON.stringify(fundingEventRaw)
    || finalOrderCount !== orderCount
    || JSON.stringify(finalFundingKeys.slice().sort()) !== JSON.stringify(fundingKeys.slice().sort())
  ) {
    refuse('paper account changed while the read-only PnL snapshot was being derived');
  }

  return {
    type: 'pnlSnapshot',
    status: 'ok',
    paper: true,
    pristine: replayBatchId === null,
    asOf: state.time,
    startingBalance,
    accountValue: state.crossMarginSummary.accountValue,
    totalPnl,
    replayBatchId: replayId,
    ordinaryFillCount: ordinaryFills.length,
    fundingEventCount: fundingIds.length,
    assets: coins.map((coin) => assets.get(coin)!),
  };
}
