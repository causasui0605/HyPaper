import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { getPnlSnapshot, type PnlDependencies } from '../engine/pnl.js';
import { KEYS } from '../store/keys.js';
import { pnlFundingEventId } from '../worker/funding-worker.js';
import type { HistoricalReplayResult } from '../types/historical-replay.js';
import { D } from '../utils/math.js';

const USER = '0xpnltest';
const BATCH = `hprb${'a'.repeat(64)}`;
const NOW = 1_800_000_000_000;
const COINS = ['xyz:CL', 'xyz:NATGAS', 'xyz:BRENTOIL', 'xyz:COPPER'] as const;

type ReplayPnlEvent = {
  sequence: number;
  asset: number;
  coin: string;
  closedPnl: string;
  fee: string;
};

function replayResult(events: ReplayPnlEvent[], startingBalance = '10000'): HistoricalReplayResult {
  const finalBalance = events.reduce(
    (balance, event) => balance.plus(D(event.closedPnl)).minus(D(event.fee)), D(startingBalance),
  ).toString();
  return {
    user: USER,
    batchId: BATCH,
    startingBalance,
    finalBalance,
    replayedAt: NOW - 100_000_000,
    events,
  } as unknown as HistoricalReplayResult;
}

function state(
  accountValue: string,
  positions: Array<{ coin: string; szi: string; entryPx: string; unrealizedPnl: string }> = [],
) {
  return {
    assetPositions: positions.map((position) => ({ type: 'oneWay' as const, position })),
    crossMarginSummary: { accountValue },
    marginSummary: { accountValue },
    time: NOW,
  };
}

function replayEvents(): ReplayPnlEvent[] {
  return [
    { sequence: 0, asset: 0, coin: COINS[0], closedPnl: '10', fee: '1' },
    { sequence: 1, asset: 1, coin: COINS[1], closedPnl: '0', fee: '2' },
    { sequence: 2, asset: 2, coin: COINS[2], closedPnl: '5', fee: '0.5' },
    { sequence: 3, asset: 3, coin: COINS[3], closedPnl: '-3', fee: '0.25' },
  ];
}

describe('read-only programme PnL snapshots', () => {
  let redis: RedisMock;
  let currentState: ReturnType<typeof state>;
  let replay: HistoricalReplayResult;
  let pgPresence: { orders: boolean; fills: boolean };
  let dependencies: PnlDependencies;

  beforeEach(async () => {
    redis = new RedisMock();
    currentState = state('10000');
    replay = replayResult(replayEvents());
    pgPresence = { orders: false, fills: false };
    dependencies = {
      redis,
      clearinghouseState: vi.fn(async () => currentState),
      executionPresencePg: vi.fn(async () => pgPresence),
      historicalReplay: vi.fn(async () => replay),
    };
    await redis.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '10000');
  });

  async function enableReplay(): Promise<void> {
    await redis.set(KEYS.HISTORICAL_REPLAY_INDEX(USER), BATCH);
    await redis.set(KEYS.HISTORICAL_REPLAY_BATCH(USER, BATCH), 'immutable-replay');
  }

  async function addOrdinaryFill(
    coin: string, closedPnl: string, fee: string, time: number, tid: number,
  ): Promise<void> {
    await redis.lpush(KEYS.USER_FILLS(USER), JSON.stringify({
      coin, px: '100', sz: '1', side: 'B', time, startPosition: '0', dir: 'Open Long',
      closedPnl, hash: `0x${tid.toString(16).padStart(64, '0')}`, oid: tid,
      crossed: true, fee, tid, feeToken: 'USDC',
    }));
  }

  async function addFundingEvent(
    asset: number, coin: string, fundingCharge: string, sequence: number,
  ): Promise<string> {
    const fundingTime = NOW - 28_800_000 * (2 - sequence);
    const eventId = pnlFundingEventId(USER, asset, fundingTime);
    const szi = asset === 3 ? '-1' : '2';
    const markPx = asset === 3 ? '50' : '100';
    const fundingRate = D(fundingCharge).div(D(szi).times(D(markPx))).toString();
    const event = {
      schema: 'hypaper_pnl_funding_event_v1', kind: 'pnl_funding_event', paper: true,
      eventId, asset, coin, fundingTime, appliedAt: fundingTime + 1,
      szi, markPx, fundingRate, fundingCharge,
      accountBalanceBefore: '10000',
      accountBalanceAfter: D(10000).minus(D(fundingCharge)).toString(),
      cumFundingBefore: '0', cumFundingAfter: fundingCharge,
      cumFundingSinceOpenBefore: '0', cumFundingSinceOpenAfter: fundingCharge,
      cumFundingSinceChangeBefore: '0', cumFundingSinceChangeAfter: fundingCharge,
    };
    await redis.set(KEYS.PNL_FUNDING_EVENT(USER, eventId), JSON.stringify(event));
    await redis.rpush(KEYS.PNL_FUNDING_EVENTS(USER), eventId);
    return eventId;
  }

  it('reports a pristine never-traded flat account as exact zero without any write', async () => {
    const writeSpies = [
      vi.spyOn(redis, 'set'), vi.spyOn(redis, 'hset'), vi.spyOn(redis, 'lpush'),
      vi.spyOn(redis, 'rpush'), vi.spyOn(redis, 'del'), vi.spyOn(redis, 'eval'),
    ];

    const snapshot = await getPnlSnapshot(USER, COINS, dependencies);

    expect(snapshot).toEqual({
      type: 'pnlSnapshot', status: 'ok', paper: true, pristine: true,
      asOf: NOW, startingBalance: '10000', accountValue: '10000', totalPnl: '0',
      replayBatchId: null, ordinaryFillCount: 0, fundingEventCount: 0,
      assets: COINS.map((coin) => ({
        coin, szi: '0', entryPx: null, markPx: null,
        replayRealizedPnl: '0', ordinaryRealizedPnl: '0',
        replayFees: '0', ordinaryFees: '0', fundingCharge: '0',
        unrealizedPnl: '0', totalPnl: '0',
      })),
    });
    for (const spy of writeSpies) expect(spy).not.toHaveBeenCalled();
    expect(dependencies.historicalReplay).not.toHaveBeenCalled();
  });

  it('exactly aggregates replay, ordinary fills, funding, and current unrealized PnL', async () => {
    await enableReplay();
    await addOrdinaryFill(COINS[0], '3', '0.5', NOW - 20, 2);
    await addOrdinaryFill(COINS[1], '-1', '0.25', NOW - 10, 3);
    await addFundingEvent(0, COINS[0], '1', 0);
    await addFundingEvent(3, COINS[3], '-0.5', 1);
    await redis.hset(KEYS.MARKET_CTX(COINS[0]), 'markPx', '110');
    await redis.hset(KEYS.MARKET_CTX(COINS[1]), 'markPx', '21');
    await redis.hset(KEYS.USER_ACCOUNT(USER), 'balance', '10009');
    currentState = state('10024', [
      { coin: COINS[0], szi: '2', entryPx: '100', unrealizedPnl: '20' },
      { coin: COINS[1], szi: '-5', entryPx: '20', unrealizedPnl: '-5' },
    ]);

    const snapshot = await getPnlSnapshot(USER, COINS, dependencies);

    expect(snapshot).toMatchObject({
      pristine: false, startingBalance: '10000', accountValue: '10024',
      totalPnl: '24', replayBatchId: BATCH, ordinaryFillCount: 2, fundingEventCount: 2,
    });
    expect(snapshot.assets.map((asset) => ({
      coin: asset.coin, funding: asset.fundingCharge, unrealized: asset.unrealizedPnl,
      total: asset.totalPnl,
    }))).toEqual([
      { coin: COINS[0], funding: '1', unrealized: '20', total: '30.5' },
      { coin: COINS[1], funding: '0', unrealized: '-5', total: '-8.25' },
      { coin: COINS[2], funding: '0', unrealized: '0', total: '4.5' },
      { coin: COINS[3], funding: '-0.5', unrealized: '0', total: '-2.75' },
    ]);
    expect(dependencies.historicalReplay).toHaveBeenCalledWith(USER, BATCH);
  });

  it('retains cumulative realized net PnL after the programme returns flat', async () => {
    await enableReplay();
    replay = replayResult([
      { sequence: 0, asset: 0, coin: COINS[0], closedPnl: '12', fee: '2' },
      { sequence: 1, asset: 1, coin: COINS[1], closedPnl: '0', fee: '0' },
      { sequence: 2, asset: 2, coin: COINS[2], closedPnl: '0', fee: '0' },
      { sequence: 3, asset: 3, coin: COINS[3], closedPnl: '0', fee: '0' },
    ]);
    await addOrdinaryFill(COINS[0], '5', '1', NOW - 10, 1);
    await addFundingEvent(0, COINS[0], '0.5', 0);
    await redis.hset(KEYS.USER_ACCOUNT(USER), 'balance', '10013.5');
    currentState = state('10013.5');

    const snapshot = await getPnlSnapshot(USER, COINS, dependencies);

    expect(snapshot.totalPnl).toBe('13.5');
    expect(snapshot.assets[0]).toMatchObject({
      szi: '0', markPx: null, replayRealizedPnl: '12', replayFees: '2',
      ordinaryRealizedPnl: '5', ordinaryFees: '1', fundingCharge: '0.5', totalPnl: '13.5',
    });
  });

  it('refuses activity without the immutable programme starting-balance replay', async () => {
    await addOrdinaryFill(COINS[0], '0', '1', NOW - 10, 1);
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(
      /activity exists without an immutable starting-balance replay/,
    );
  });

  it('refuses any total that does not exactly reconcile to account value', async () => {
    await enableReplay();
    currentState = state('10008.24');
    await redis.hset(KEYS.USER_ACCOUNT(USER), 'balance', '10008.24');
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(
      /does not reconcile/,
    );
  });

  it('refuses unknown, duplicate, zero, and mark-inconsistent current positions', async () => {
    await enableReplay();
    const valid = { coin: COINS[0], szi: '1', entryPx: '100', unrealizedPnl: '10' };
    for (const positions of [
      [{ ...valid, coin: 'xyz:UNKNOWN' }],
      [valid, valid],
      [{ ...valid, szi: '0' }],
    ]) {
      currentState = state('10018.25', positions);
      await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow();
    }
    await redis.hset(KEYS.MARKET_CTX(COINS[0]), 'markPx', '109');
    currentState = state('10018.25', [valid]);
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(/unrealized PnL disagree/);
  });

  it('refuses malformed, orphaned, duplicate, or replay-identity-mismatched funding evidence', async () => {
    await enableReplay();
    const id = await addFundingEvent(0, COINS[0], '1', 0);
    await redis.rpush(KEYS.PNL_FUNDING_EVENTS(USER), id);
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(/duplicate event ids/);

    redis = new RedisMock();
    dependencies.redis = redis;
    await redis.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '10000');
    await enableReplay();
    await addFundingEvent(0, COINS[0], '1', 0);
    await redis.set(KEYS.PNL_FUNDING_EVENT(USER, `hpfe${'f'.repeat(64)}`), '{}');
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(/index and immutable event keys disagree/);

    await redis.del(KEYS.PNL_FUNDING_EVENT(USER, `hpfe${'f'.repeat(64)}`));
    const [validId] = await redis.lrange(KEYS.PNL_FUNDING_EVENTS(USER), 0, -1);
    const raw = JSON.parse((await redis.get(KEYS.PNL_FUNDING_EVENT(USER, validId)))!);
    raw.coin = COINS[1];
    await redis.set(KEYS.PNL_FUNDING_EVENT(USER, validId), JSON.stringify(raw));
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(/replay asset identity/);
  });

  it('recomputes every funding charge and refuses any internally inconsistent event', async () => {
    await enableReplay();
    const id = await addFundingEvent(0, COINS[0], '1', 0);
    const event = JSON.parse((await redis.get(KEYS.PNL_FUNDING_EVENT(USER, id)))!);
    event.fundingRate = '0.006';
    await redis.set(KEYS.PNL_FUNDING_EVENT(USER, id), JSON.stringify(event));

    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(
      /charge does not match its model inputs/,
    );
  });

  it('refuses funding or ordinary execution evidence dated before the replay import', async () => {
    await enableReplay();
    replay.replayedAt = NOW;
    await addFundingEvent(0, COINS[0], '1', 0);
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(/funding ledger.*before/);

    redis = new RedisMock();
    dependencies.redis = redis;
    await redis.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '10000');
    await enableReplay();
    await addOrdinaryFill(COINS[0], '0', '0', NOW - 1, 1);
    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(/ordinary fills.*before/);
  });

  it('refuses a torn read if the paper state changes during derivation', async () => {
    const first = state('10000');
    const second = state('10001');
    vi.mocked(dependencies.clearinghouseState)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    await expect(getPnlSnapshot(USER, COINS, dependencies)).rejects.toThrow(/changed while/);
  });
});
