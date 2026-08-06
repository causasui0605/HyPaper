import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { KEYS } from '../store/keys.js';
import {
  getHistoricalReplay,
  HISTORICAL_REPLAY_LUA,
  importHistoricalReplay,
  prepareHistoricalReplay,
  effectiveReplayTakerFee,
  validateHistoricalReplayPayload,
} from '../engine/historical-replay.js';
import {
  HISTORICAL_REPLAY_ASSET_BINDING_SCHEMA,
  HISTORICAL_REPLAY_EVENT_SCHEMA,
  HISTORICAL_REPLAY_EVIDENCE_SCHEMA,
  HISTORICAL_REPLAY_FILL_ASSUMPTION,
  HISTORICAL_REPLAY_MODEL_SCHEMA,
  HISTORICAL_REPLAY_RISK_MARK_SCHEMA,
  HISTORICAL_REPLAY_SCHEMA,
  HISTORICAL_REPLAY_SOURCE_SCHEMA,
  type HistoricalReplayPayload,
} from '../types/historical-replay.js';

const USER = '0xabc';
const NOW = 1_800_000_000_000;
const HISTORICAL = 1_700_000_000_000;
const FEE_RATE = '0.001';

// Deliberately independent from the production canonicalization implementation.
function independentCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map((key) => (
      `${JSON.stringify(key)}:${independentCanonical((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function independentHash(value: unknown): string {
  return createHash('sha256').update(Buffer.from(independentCanonical(value), 'utf8')).digest('hex');
}

function omit(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([candidate]) => candidate !== key));
}

function resign(payload: HistoricalReplayPayload): HistoricalReplayPayload {
  payload.sourceDigest = independentHash(payload.source);
  payload.modelInputDigest = independentHash(payload.modelInputs);

  const evidenceIds = new Map<string, string>();
  for (const evidence of payload.priceEvidence) {
    const old = evidence.evidenceId;
    evidence.evidenceId = `hprp${independentHash(omit(evidence, 'evidenceId'))}`;
    evidenceIds.set(old, evidence.evidenceId);
  }
  for (const event of payload.events) {
    event.priceEvidenceId = evidenceIds.get(event.priceEvidenceId) ?? event.priceEvidenceId;
  }
  payload.priceEvidenceDigest = independentHash(payload.priceEvidence);

  const riskIds = new Map<string, string>();
  for (const riskMark of payload.riskMarkEvidence) {
    const old = riskMark.riskMarkId;
    riskMark.riskMarkId = `hprr${independentHash(omit(riskMark, 'riskMarkId'))}`;
    riskIds.set(old, riskMark.riskMarkId);
  }
  for (const binding of payload.assetBindings) {
    binding.riskMarkId = riskIds.get(binding.riskMarkId) ?? binding.riskMarkId;
  }
  payload.riskMarkEvidenceDigest = independentHash(payload.riskMarkEvidence);

  for (const event of payload.events) {
    event.eventId = `hpre${independentHash({
      event: omit(event, 'eventId'),
      sourceDigest: payload.sourceDigest,
      priceEvidenceDigest: payload.priceEvidenceDigest,
      modelInputDigest: payload.modelInputDigest,
    })}`;
  }
  payload.batchId = `hprb${independentHash({
    schema: payload.schema,
    sourceDigest: payload.sourceDigest,
    priceEvidenceDigest: payload.priceEvidenceDigest,
    modelInputDigest: payload.modelInputDigest,
    riskMarkEvidenceDigest: payload.riskMarkEvidenceDigest,
    assetBindings: payload.assetBindings,
    eventIds: payload.events.map((event) => event.eventId),
  })}`;
  return payload;
}

interface BuildOptions {
  fullClose?: boolean;
  multiAsset?: boolean;
  entryAsks?: Array<{ px: string; sz: string }>;
  emptyEntryAsks?: boolean;
  feeRate?: string;
  startingBalance?: string;
}

function buildPayload(options: BuildOptions = {}): HistoricalReplayPayload {
  const entryEvidence = {
    schema: HISTORICAL_REPLAY_EVIDENCE_SCHEMA,
    evidenceId: 'hprp'.padEnd(68, '0'),
    asset: 0,
    coin: 'CL',
    effectiveAt: HISTORICAL,
    requestAt: HISTORICAL + 1_000,
    responseAt: HISTORICAL + 2_000,
    midPx: '100',
    asks: options.emptyEntryAsks ? [] : options.entryAsks ?? [],
    aggressiveLimitPx: options.entryAsks ? '101' : '105',
    side: 'B' as const,
    sz: '10',
  };
  const reductionSize = options.fullClose ? '10' : '2';
  const priceEvidence: HistoricalReplayPayload['priceEvidence'] = [
    entryEvidence,
    {
      schema: HISTORICAL_REPLAY_EVIDENCE_SCHEMA,
      evidenceId: 'hprp'.padEnd(68, '1'),
      asset: 0,
      coin: 'CL',
      effectiveAt: HISTORICAL + 10_000,
      requestAt: HISTORICAL + 11_000,
      responseAt: HISTORICAL + 12_000,
      midPx: '110',
      bids: [],
      aggressiveLimitPx: '105',
      side: 'A',
      sz: reductionSize,
    },
  ];
  const events: HistoricalReplayPayload['events'] = [
    {
      schema: HISTORICAL_REPLAY_EVENT_SCHEMA,
      eventId: 'hpre'.padEnd(68, '0'),
      phase: 'scheduled_entry',
      sequence: 0,
      asset: 0,
      coin: 'CL',
      effectiveAt: HISTORICAL,
      priceEvidenceId: priceEvidence[0].evidenceId,
    },
    {
      schema: HISTORICAL_REPLAY_EVENT_SCHEMA,
      eventId: 'hpre'.padEnd(68, '1'),
      phase: 'scheduled_reduction',
      sequence: 1,
      asset: 0,
      coin: 'CL',
      effectiveAt: HISTORICAL + 10_000,
      priceEvidenceId: priceEvidence[1].evidenceId,
    },
  ];
  const riskMarkEvidence: HistoricalReplayPayload['riskMarkEvidence'] = [{
    schema: HISTORICAL_REPLAY_RISK_MARK_SCHEMA,
    riskMarkId: 'hprr'.padEnd(68, '0'),
    asset: 0,
    coin: 'CL',
    requestAt: NOW - 2_000,
    responseAt: NOW - 1_000,
    markPx: '120',
  }];
  const assetBindings: HistoricalReplayPayload['assetBindings'] = [{
    schema: HISTORICAL_REPLAY_ASSET_BINDING_SCHEMA,
    asset: 0,
    coin: 'CL',
    marginMode: 'isolated',
    selectedLeverage: '10',
    isolatedTargetLeverage: '3',
    riskMarkId: riskMarkEvidence[0].riskMarkId,
  }];

  if (options.multiAsset) {
    priceEvidence.splice(1, 0, {
      schema: HISTORICAL_REPLAY_EVIDENCE_SCHEMA,
      evidenceId: 'hprp'.padEnd(68, '2'),
      asset: 1,
      coin: 'HG',
      effectiveAt: HISTORICAL + 5_000,
      requestAt: HISTORICAL + 6_000,
      responseAt: HISTORICAL + 7_000,
      midPx: '200',
      bids: [],
      aggressiveLimitPx: '195',
      side: 'A',
      sz: '5',
    }, {
      schema: HISTORICAL_REPLAY_EVIDENCE_SCHEMA,
      evidenceId: 'hprp'.padEnd(68, '3'),
      asset: 1,
      coin: 'HG',
      effectiveAt: HISTORICAL + 15_000,
      requestAt: HISTORICAL + 16_000,
      responseAt: HISTORICAL + 17_000,
      midPx: '190',
      asks: [],
      aggressiveLimitPx: '195',
      side: 'B',
      sz: '1',
    });
    events.splice(1, 0, {
      schema: HISTORICAL_REPLAY_EVENT_SCHEMA,
      eventId: 'hpre'.padEnd(68, '2'),
      phase: 'scheduled_entry',
      sequence: 1,
      asset: 1,
      coin: 'HG',
      effectiveAt: HISTORICAL + 5_000,
      priceEvidenceId: priceEvidence[1].evidenceId,
    });
    events[2].sequence = 2;
    events.push({
      schema: HISTORICAL_REPLAY_EVENT_SCHEMA,
      eventId: 'hpre'.padEnd(68, '3'),
      phase: 'scheduled_reduction',
      sequence: 3,
      asset: 1,
      coin: 'HG',
      effectiveAt: HISTORICAL + 15_000,
      priceEvidenceId: priceEvidence[2].evidenceId,
    });
    riskMarkEvidence.push({
      schema: HISTORICAL_REPLAY_RISK_MARK_SCHEMA,
      riskMarkId: 'hprr'.padEnd(68, '1'),
      asset: 1,
      coin: 'HG',
      requestAt: NOW - 2_000,
      responseAt: NOW - 1_000,
      markPx: '195',
    });
    assetBindings.push({
      schema: HISTORICAL_REPLAY_ASSET_BINDING_SCHEMA,
      asset: 1,
      coin: 'HG',
      marginMode: 'cross',
      selectedLeverage: '20',
      riskMarkId: riskMarkEvidence[1].riskMarkId,
    });
  }

  return resign({
    schema: HISTORICAL_REPLAY_SCHEMA,
    source: {
      schema: HISTORICAL_REPLAY_SOURCE_SCHEMA,
      name: 'CO-M17-test-programme',
      generatedAt: NOW - 500,
    },
    sourceDigest: ''.padEnd(64, '0'),
    priceEvidence,
    priceEvidenceDigest: ''.padEnd(64, '0'),
    modelInputs: {
      schema: HISTORICAL_REPLAY_MODEL_SCHEMA,
      feeRate: options.feeRate ?? FEE_RATE,
      startingBalance: options.startingBalance ?? '10000',
      feeToken: 'USDC',
      fillAssumption: HISTORICAL_REPLAY_FILL_ASSUMPTION,
    },
    modelInputDigest: ''.padEnd(64, '0'),
    riskMarkEvidence,
    riskMarkEvidenceDigest: ''.padEnd(64, '0'),
    assetBindings,
    events,
    batchId: 'hprb'.padEnd(68, '0'),
  });
}

type Stored = { type: 'string' | 'hash' | 'set' | 'zset' | 'list'; value: unknown };

class ReplayRedisFake {
  readonly data = new Map<string, Stored>();
  evalCalls = 0;
  raceReason: string | null = null;
  throwOnEval = false;
  evalEnvelope: string | null = null;

  constructor(balance = '10000') {
    this.hash(KEYS.USER_ACCOUNT(USER), { userId: USER, balance, createdAt: '1' });
  }

  string(key: string, value: string): void { this.data.set(key, { type: 'string', value }); }
  hash(key: string, value: Record<string, string>): void { this.data.set(key, { type: 'hash', value: { ...value } }); }
  set(key: string, values: string[]): void { this.data.set(key, { type: 'set', value: new Set(values) }); }
  zset(key: string, values: string[]): void { this.data.set(key, { type: 'zset', value: [...values] }); }
  list(key: string, values: string[]): void { this.data.set(key, { type: 'list', value: [...values] }); }
  allKeys(): string[] { return [...this.data.keys()].sort(); }

  async get(key: string): Promise<string | null> {
    const item = this.data.get(key);
    return item?.type === 'string' ? item.value as string : null;
  }
  async hget(key: string, field: string): Promise<string | null> {
    const item = this.data.get(key);
    return item?.type === 'hash' ? (item.value as Record<string, string>)[field] ?? null : null;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    const item = this.data.get(key);
    return item?.type === 'hash' ? { ...(item.value as Record<string, string>) } : {};
  }
  async smembers(key: string): Promise<string[]> {
    const item = this.data.get(key);
    return item?.type === 'set' ? [...item.value as Set<string>] : [];
  }
  async sismember(key: string, member: string): Promise<number> {
    const item = this.data.get(key);
    return item?.type === 'set' && (item.value as Set<string>).has(member) ? 1 : 0;
  }
  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
    return this.allKeys().filter((key) => regex.test(key));
  }
  async zcard(key: string): Promise<number> {
    const item = this.data.get(key);
    return item?.type === 'zset' ? (item.value as string[]).length : 0;
  }
  async hlen(key: string): Promise<number> { return Object.keys(await this.hgetall(key)).length; }
  async llen(key: string): Promise<number> {
    const item = this.data.get(key);
    return item?.type === 'list' ? (item.value as string[]).length : 0;
  }

  async eval(_script: string, keyCount: number, ...args: string[]): Promise<string> {
    this.evalCalls += 1;
    if (this.throwOnEval) throw new Error('simulated transaction failure');
    if (this.evalEnvelope !== null) return this.evalEnvelope;
    if (this.raceReason) return JSON.stringify({ state: 'refused', value: this.raceReason });
    const keys = args.slice(0, keyCount);
    const transaction = JSON.parse(args[keyCount]) as {
      user: string;
      batchId: string;
      startingBalance: string;
      finalBalance: string;
      resultJson: string;
      positions: Array<{ key: string; asset: number; coin: string; szi: string; entryPx: string }>;
      marginPosture: Array<{ key: string; marginMode: string; selectedLeverage: string; isolatedMargin?: string }>;
      events: Array<{ key: string; eventId: string; json: string }>;
    };
    const existing = await this.get(keys[0]);
    if (existing) {
      if (existing !== transaction.batchId) return JSON.stringify({ state: 'refused', value: 'different batch' });
      return JSON.stringify({ state: 'retry', value: await this.get(keys[1]) });
    }
    const account = await this.hgetall(keys[3]);
    if (account.balance !== transaction.startingBalance) {
      return JSON.stringify({ state: 'refused', value: 'account balance changed before commit' });
    }

    this.hash(keys[3], { ...account, balance: transaction.finalBalance });
    for (const position of transaction.positions) {
      this.hash(position.key, {
        userId: transaction.user,
        asset: String(position.asset),
        coin: position.coin,
        szi: position.szi,
        entryPx: position.entryPx,
        cumFunding: '0',
        cumFundingSinceOpen: '0',
        cumFundingSinceChange: '0',
      });
    }
    this.set(keys[4], transaction.positions.map((position) => String(position.asset)));
    for (const posture of transaction.marginPosture) {
      this.hash(posture.key, posture.marginMode === 'isolated'
        ? { leverage: posture.selectedLeverage, isCross: 'false', isolatedMargin: posture.isolatedMargin! }
        : { leverage: posture.selectedLeverage, isCross: 'true' });
    }
    if (transaction.positions.length) this.set(keys[11], [transaction.user]);
    this.string(keys[0], transaction.batchId);
    this.string(keys[1], transaction.resultJson);
    this.list(keys[2], transaction.events.map((event) => event.eventId));
    for (const event of transaction.events) this.string(event.key, event.json);
    return JSON.stringify({ state: 'imported', value: transaction.resultJson });
  }
}

function dependencies(redis = new ReplayRedisFake(), pg = { orders: false, fills: false }) {
  return {
    redis,
    getUserExecutionPresencePg: vi.fn(async () => pg),
    getAssetMetadata: vi.fn(async (asset: number) => asset === 0
      ? { coin: 'CL', szDecimals: 2, maxLeverage: 10, onlyIsolated: true }
      : { coin: 'HG', szDecimals: 2, maxLeverage: 20, onlyIsolated: false }),
    now: () => NOW,
    takerFeeRate: FEE_RATE,
  };
}

describe('historical replay validation and arithmetic', () => {
  it('uses independently computed canonical digests and unambiguous deterministic IDs', async () => {
    const payload = buildPayload();
    expect(validateHistoricalReplayPayload(payload, FEE_RATE)).toEqual(payload);
    expect(payload.sourceDigest).toBe(independentHash(payload.source));
    expect(payload.priceEvidence[0].evidenceId).toMatch(/^hprp[0-9a-f]{64}$/);
    expect(payload.events[0].eventId).toMatch(/^hpre[0-9a-f]{64}$/);
    expect(payload.batchId).toMatch(/^hprb[0-9a-f]{64}$/);
    const prepared = await prepareHistoricalReplay(USER, payload, dependencies());
    expect(prepared.result.events[0].syntheticFillId).toMatch(/^hprf[0-9a-f]{64}$/);
    expect(prepared.result.events[0].syntheticFillId).toBe(
      `hprf${independentHash({ batchId: payload.batchId, eventId: payload.events[0].eventId, sequence: 0 })}`,
    );
  });

  it('matches hand-derived partial reduction PnL, fee, balance, position and isolated margin', async () => {
    const prepared = await prepareHistoricalReplay(USER, buildPayload(), dependencies());
    expect(prepared.result.positions).toEqual([{ asset: 0, coin: 'CL', szi: '8', entryPx: '100' }]);
    expect(prepared.result.events.map(({ closedPnl, fee }) => ({ closedPnl, fee }))).toEqual([
      { closedPnl: '0', fee: '1' },
      { closedPnl: '20', fee: '0.22' },
    ]);
    expect(prepared.result.finalBalance).toBe('10018.78');
    expect(prepared.result.marginPosture[0]).toMatchObject({
      marginMode: 'isolated', selectedLeverage: '10', isolatedTargetLeverage: '3', isolatedMargin: '320', riskMarkPx: '120',
      finalSzi: '8', finalEntryPx: '100', positionNotional: '960', unrealizedPnl: '160', marginRequired: '320',
    });
    expect(prepared.result.riskSummary).toEqual({
      cashBalance: '10018.78',
      unrealizedPnl: '160',
      accountValue: '10178.78',
      totalMargin: '320',
      marginAvailable: '9858.78',
    });
  });

  it('mirrors ordinary matcher effective taker fees when fees are enabled or disabled', async () => {
    expect(effectiveReplayTakerFee(true, FEE_RATE)).toBe(FEE_RATE);
    expect(effectiveReplayTakerFee(false, FEE_RATE)).toBe('0');

    const disabledPayload = buildPayload({ feeRate: '0' });
    const disabled = dependencies();
    disabled.takerFeeRate = '0';
    const prepared = await prepareHistoricalReplay(USER, disabledPayload, disabled);
    expect(prepared.result.events.map((event) => event.fee)).toEqual(['0', '0']);
    expect(prepared.result.finalBalance).toBe('10020');
    expect(() => validateHistoricalReplayPayload(buildPayload(), '0')).toThrow(/feeRate/);
    expect(() => validateHistoricalReplayPayload(disabledPayload, FEE_RATE)).toThrow(/feeRate/);
  });

  it('handles a full close and preserves a zero isolated-margin posture', async () => {
    const prepared = await prepareHistoricalReplay(USER, buildPayload({ fullClose: true }), dependencies());
    expect(prepared.result.positions).toEqual([]);
    expect(prepared.result.finalBalance).toBe('10097.9');
    expect(prepared.result.marginPosture[0].isolatedMargin).toBe('0');
  });

  it('replays multiple assets in one global chronology', async () => {
    const prepared = await prepareHistoricalReplay(USER, buildPayload({ multiAsset: true }), dependencies());
    expect(prepared.result.eventCount).toBe(4);
    expect(prepared.result.positions).toEqual([
      { asset: 0, coin: 'CL', szi: '8', entryPx: '100' },
      { asset: 1, coin: 'HG', szi: '-4', entryPx: '200' },
    ]);
    expect(prepared.result.finalBalance).toBe('10027.59');
    expect(prepared.result.marginPosture[1]).toMatchObject({ marginMode: 'cross', selectedLeverage: '20' });
    expect(prepared.result.marginPosture[1]).not.toHaveProperty('isolatedMargin');
  });

  it('uses the existing L2 VWAP limit clamp and empty-side mid fallback', async () => {
    const vwap = await prepareHistoricalReplay(USER, buildPayload({
      entryAsks: [{ px: '100', sz: '4' }, { px: '102', sz: '2' }],
    }), dependencies());
    expect(vwap.result.events[0]).toMatchObject({ px: '100.6', priceSource: 'vwap' });

    const fallback = await prepareHistoricalReplay(USER, buildPayload({ emptyEntryAsks: true }), dependencies());
    expect(fallback.result.events[0]).toMatchObject({ px: '100', priceSource: 'fallback' });
  });

  it.each([
    ['asks on buy', (payload: HistoricalReplayPayload) => { delete payload.priceEvidence[0].asks; }],
    ['bids on sell', (payload: HistoricalReplayPayload) => { delete payload.priceEvidence[1].bids; }],
  ])('fails closed when the executed L2 side omits %s', async (_label, omitSide) => {
    const payload = buildPayload();
    omitSide(payload);
    resign(payload);
    await expect(prepareHistoricalReplay(USER, payload, dependencies())).rejects.toThrow(/executed (asks|bids) side/);
  });

  it.each([
    ['unknown field', (payload: any) => { payload.events[0].oid = 7; }],
    ['venue hash field', (payload: any) => { payload.priceEvidence[0].hash = '0xvenue'; }],
    ['noncanonical decimal', (payload: any) => { payload.priceEvidence[0].sz = '10.0'; }],
    ['bad evidence time', (payload: any) => { payload.priceEvidence[0].responseAt = payload.priceEvidence[0].effectiveAt + 60_001; }],
    ['bad bid ordering', (payload: any) => { payload.priceEvidence[1].bids = [{ px: '100', sz: '1' }, { px: '101', sz: '1' }]; }],
    ['duplicate sequence', (payload: any) => { payload.events[1].sequence = 0; }],
    ['reduction increase', (payload: any) => { payload.priceEvidence[1].side = 'B'; payload.priceEvidence[1].aggressiveLimitPx = '115'; }],
    ['position flip', (payload: any) => { payload.priceEvidence[1].sz = '11'; }],
    ['bad isolated target', (payload: any) => { payload.assetBindings[0].isolatedTargetLeverage = '4'; }],
    ['duplicate asset binding', (payload: any) => { payload.assetBindings.push({ ...payload.assetBindings[0] }); }],
  ])('rejects %s', async (_label, mutate) => {
    const payload = buildPayload();
    mutate(payload);
    // Unknown fields are intentionally not stripped; all other mutations are re-signed
    // so their semantic checks, not stale digests, are exercised.
    if (_label !== 'unknown field' && _label !== 'venue hash field') resign(payload);
    await expect(prepareHistoricalReplay(USER, payload, dependencies())).rejects.toThrow();
  });

  it('rejects every digest and deterministic ID independently', () => {
    for (const field of ['sourceDigest', 'priceEvidenceDigest', 'modelInputDigest', 'riskMarkEvidenceDigest', 'batchId'] as const) {
      const payload = buildPayload();
      payload[field] = `${payload[field].slice(0, -1)}f` as never;
      expect(() => validateHistoricalReplayPayload(payload, FEE_RATE)).toThrow();
    }
    for (const [collection, id] of [['priceEvidence', 'evidenceId'], ['riskMarkEvidence', 'riskMarkId'], ['events', 'eventId']] as const) {
      const payload = buildPayload() as any;
      payload[collection][0][id] = `${payload[collection][0][id].slice(0, -1)}f`;
      expect(() => validateHistoricalReplayPayload(payload, FEE_RATE)).toThrow();
    }
  });

  it.each([
    ['evidenceId', (payload: HistoricalReplayPayload) => payload.priceEvidence.push({ ...payload.priceEvidence[0] })],
    ['riskMarkId', (payload: HistoricalReplayPayload) => payload.riskMarkEvidence.push({ ...payload.riskMarkEvidence[0] })],
    ['eventId', (payload: HistoricalReplayPayload) => payload.events.push({ ...payload.events[0] })],
  ])('rejects duplicate %s values before import', (_label, duplicate) => {
    const payload = buildPayload();
    duplicate(payload);
    expect(() => validateHistoricalReplayPayload(payload, FEE_RATE)).toThrow(/duplicate/);
  });

  it('requires exact configured fee, asset metadata, margin mode, max leverage and fresh risk mark', async () => {
    expect(() => validateHistoricalReplayPayload(buildPayload(), '0.002')).toThrow(/feeRate/);
    const stale = buildPayload();
    stale.riskMarkEvidence[0].responseAt = NOW - 60_001;
    stale.riskMarkEvidence[0].requestAt = NOW - 61_001;
    resign(stale);
    await expect(prepareHistoricalReplay(USER, stale, dependencies())).rejects.toThrow(/contemporaneous/);

    const wrongMeta = dependencies();
    wrongMeta.getAssetMetadata.mockResolvedValue({ coin: 'CL', szDecimals: 2, maxLeverage: 20, onlyIsolated: true });
    await expect(prepareHistoricalReplay(USER, buildPayload(), wrongMeta)).rejects.toThrow(/selectedLeverage/);

    const cross = buildPayload();
    cross.assetBindings[0].marginMode = 'cross';
    delete cross.assetBindings[0].isolatedTargetLeverage;
    resign(cross);
    await expect(prepareHistoricalReplay(USER, cross, dependencies())).rejects.toThrow(/isolated-only/);
  });

  it('requires source.generatedAt at or after every risk-mark response', async () => {
    const payload = buildPayload();
    payload.source.generatedAt = payload.riskMarkEvidence[0].responseAt - 1;
    resign(payload);
    await expect(prepareHistoricalReplay(USER, payload, dependencies())).rejects.toThrow(/risk mark evidence/);
  });

  it('accepts the exact margin=account-value boundary and exposes its derivation', async () => {
    const prepared = await prepareHistoricalReplay(
      USER,
      buildPayload({ startingBalance: '141.22' }),
      dependencies(),
    );
    expect(prepared.result.riskSummary).toEqual({
      cashBalance: '160',
      unrealizedPnl: '160',
      accountValue: '320',
      totalMargin: '320',
      marginAvailable: '0',
    });
  });

  it('rejects negative final cash, nonpositive account value, and margin above account value', async () => {
    const negativeCash = buildPayload({ startingBalance: '0' });
    negativeCash.priceEvidence[1].midPx = '90';
    negativeCash.priceEvidence[1].aggressiveLimitPx = '85';
    resign(negativeCash);
    await expect(prepareHistoricalReplay(USER, negativeCash, dependencies())).rejects.toThrow(/cash balance is negative/);

    const nonpositiveAccount = buildPayload({ startingBalance: '100' });
    nonpositiveAccount.riskMarkEvidence[0].markPx = '1';
    resign(nonpositiveAccount);
    await expect(prepareHistoricalReplay(USER, nonpositiveAccount, dependencies())).rejects.toThrow(/account value is nonpositive/);

    await expect(
      prepareHistoricalReplay(USER, buildPayload({ startingBalance: '100' }), dependencies()),
    ).rejects.toThrow(/margin exceeds/);
  });
});

describe('historical replay first-import transaction', () => {
  it('atomically imports, reports status, retries identically and never populates ordinary order/fill state', async () => {
    const redis = new ReplayRedisFake();
    const deps = dependencies(redis);
    const payload = buildPayload();
    const imported = await importHistoricalReplay(USER, payload, deps);
    expect(imported.finalBalance).toBe('10018.78');
    expect(await redis.hget(KEYS.USER_LEV(USER, 0), 'isolatedMargin')).toBe('320');
    expect(await redis.hget(KEYS.USER_POS(USER, 0), 'szi')).toBe('8');
    expect(await redis.get(KEYS.HISTORICAL_REPLAY_EVENT(USER, payload.events[0].eventId))).not.toBeNull();
    expect(await getHistoricalReplay(USER, payload.batchId, { redis, takerFeeRate: FEE_RATE })).toEqual(imported);
    expect(await importHistoricalReplay(USER, payload, deps)).toEqual(imported);
    expect(redis.evalCalls).toBe(1);

    expect(await redis.zcard(KEYS.USER_ORDERS(USER))).toBe(0);
    expect(await redis.hlen(KEYS.USER_CLOIDS(USER))).toBe(0);
    expect(await redis.llen(KEYS.USER_FILLS(USER))).toBe(0);
    expect(await redis.llen(KEYS.USER_FUNDINGS(USER))).toBe(0);
    expect(await redis.get(KEYS.SEQ_OID)).toBeNull();
    expect(await redis.get(KEYS.SEQ_TID)).toBeNull();
    expect(imported.replay).toEqual(payload);
    expect(imported.events[0]).toMatchObject({
      paper: true, synthetic: true, historicalReplay: true,
      effectiveAt: HISTORICAL, recordedAt: NOW, replayedAt: NOW,
    });
    expect(imported.events[0].recordedAt).not.toBe(imported.events[0].effectiveAt);
  });

  it('refuses a different later batch', async () => {
    const redis = new ReplayRedisFake();
    const deps = dependencies(redis);
    await importHistoricalReplay(USER, buildPayload(), deps);
    const different = buildPayload({ fullClose: true });
    await expect(importHistoricalReplay(USER, different, deps)).rejects.toThrow(/different/);
  });

  it('fails closed on malformed stored replay JSON', async () => {
    const redis = new ReplayRedisFake();
    const deps = dependencies(redis);
    const payload = buildPayload();
    await importHistoricalReplay(USER, payload, deps);
    redis.string(KEYS.HISTORICAL_REPLAY_BATCH(USER, payload.batchId), '{malformed');
    await expect(
      getHistoricalReplay(USER, payload.batchId, { redis, takerFeeRate: FEE_RATE }),
    ).rejects.toThrow(/integrity validation/);
  });

  it.each([
    ['identity', (result: any) => { result.user = '0xother'; }],
    ['count', (result: any) => { result.eventCount += 1; }],
    ['event', (result: any) => { result.events[0].px = '99'; }],
    ['position', (result: any) => { result.positions[0].szi = '7'; }],
    ['margin', (result: any) => { result.marginPosture[0].marginRequired = '319'; }],
    ['risk summary', (result: any) => { result.riskSummary.accountValue = '1'; }],
    ['payload digest', (result: any) => { result.replay.sourceDigest = 'f'.repeat(64); }],
  ])('fails closed on valid-JSON stored %s tampering', async (_label, tamper) => {
    const redis = new ReplayRedisFake();
    const deps = dependencies(redis);
    const payload = buildPayload();
    await importHistoricalReplay(USER, payload, deps);
    const key = KEYS.HISTORICAL_REPLAY_BATCH(USER, payload.batchId);
    const decoded = JSON.parse((await redis.get(key))!);
    tamper(decoded);
    redis.string(key, JSON.stringify(decoded));
    await expect(
      getHistoricalReplay(USER, payload.batchId, { redis, takerFeeRate: FEE_RATE }),
    ).rejects.toThrow(/integrity validation/);
  });

  const redisPreconditions: Array<[string, (redis: ReplayRedisFake) => void]> = [
    ['position set', (client) => client.set(KEYS.USER_POSITIONS(USER), ['0'])],
    ['orphan position hash', (client) => client.hash(KEYS.USER_POS(USER, 9), { szi: '1' })],
    ['leverage hash', (client) => client.hash(KEYS.USER_LEV(USER, 0), { leverage: '10' })],
    ['user order zset', (client) => client.zset(KEYS.USER_ORDERS(USER), ['1'])],
    ['cloid hash', (client) => client.hash(KEYS.USER_CLOIDS(USER), { c: '1' })],
    ['fill list', (client) => client.list(KEYS.USER_FILLS(USER), ['fill'])],
    ['funding list', (client) => client.list(KEYS.USER_FUNDINGS(USER), ['funding'])],
    ['unknown replay key', (client) => client.string(`user:${USER}:hpr:orphan`, 'x')],
    ['active user', (client) => client.set(KEYS.USERS_ACTIVE, [USER])],
    ['global order', (client) => { client.set(KEYS.ORDERS_OPEN, ['1']); client.hash(KEYS.ORDER(1), { userId: USER }); }],
    ['orphan order hash', (client) => client.hash(KEYS.ORDER(7), { userId: USER })],
  ];

  it.each(redisPreconditions)('refuses non-empty Redis source: %s', async (_label, seed) => {
    const redis = new ReplayRedisFake();
    seed(redis);
    await expect(importHistoricalReplay(USER, buildPayload(), dependencies(redis))).rejects.toThrow();
    expect(redis.evalCalls).toBe(0);
  });

  it.each([
    ['account identity', () => { const client = new ReplayRedisFake(); client.hash(KEYS.USER_ACCOUNT(USER), { userId: '0xother', balance: '10000' }); return client; }],
    ['account balance', () => new ReplayRedisFake('9999')],
  ])('refuses mismatched %s', async (_label, makeRedis) => {
    await expect(importHistoricalReplay(USER, buildPayload(), dependencies(makeRedis()))).rejects.toThrow();
  });

  it.each([{ orders: true, fills: false }, { orders: false, fills: true }])(
    'refuses ordinary Postgres presence $orders/$fills',
    async (presence) => {
      const redis = new ReplayRedisFake();
      await expect(importHistoricalReplay(USER, buildPayload(), dependencies(redis, presence))).rejects.toThrow(/Postgres/);
      expect(redis.evalCalls).toBe(0);
    },
  );

  it('refuses an EVAL-time race without writes', async () => {
    const redis = new ReplayRedisFake();
    redis.raceReason = 'ordinary fills changed before commit';
    const before = redis.allKeys();
    await expect(importHistoricalReplay(USER, buildPayload(), dependencies(redis))).rejects.toThrow(/fills changed/);
    expect(redis.allKeys()).toEqual(before);
    expect(await redis.hget(KEYS.USER_ACCOUNT(USER), 'balance')).toBe('10000');
  });

  it('rejects infeasible replay risk before entering the Redis mutation boundary', async () => {
    const redis = new ReplayRedisFake('100');
    await expect(
      importHistoricalReplay(USER, buildPayload({ startingBalance: '100' }), dependencies(redis)),
    ).rejects.toThrow(/margin exceeds/);
    expect(redis.evalCalls).toBe(0);
    expect(await redis.hget(KEYS.USER_ACCOUNT(USER), 'balance')).toBe('100');
  });

  it('surfaces transaction failure with no partial state', async () => {
    const redis = new ReplayRedisFake();
    redis.throwOnEval = true;
    const before = redis.allKeys();
    await expect(importHistoricalReplay(USER, buildPayload(), dependencies(redis))).rejects.toThrow(/transaction failure/);
    expect(redis.allKeys()).toEqual(before);
    expect(await redis.hget(KEYS.USER_ACCOUNT(USER), 'balance')).toBe('10000');
  });

  it.each([
    'not-json',
    JSON.stringify({ state: 'imported' }),
    JSON.stringify({ state: 'imported', value: '{}', extra: true }),
    JSON.stringify({ state: 'unknown', value: '{}' }),
  ])('fails closed on malformed Lua envelope %#', async (envelope) => {
    const redis = new ReplayRedisFake();
    redis.evalEnvelope = envelope;
    await expect(
      importHistoricalReplay(USER, buildPayload(), dependencies(redis)),
    ).rejects.toThrow(/invalid envelope/);
    expect(await redis.hget(KEYS.USER_ACCOUNT(USER), 'balance')).toBe('10000');
  });

  it('strictly validates a race-retry immutable result before returning it', async () => {
    const redis = new ReplayRedisFake();
    const payload = buildPayload();
    const prepared = await prepareHistoricalReplay(USER, payload, dependencies());
    const tampered = structuredClone(prepared.result);
    tampered.riskSummary.accountValue = '1';
    redis.evalEnvelope = JSON.stringify({
      state: 'retry',
      value: JSON.stringify(tampered),
    });
    await expect(
      importHistoricalReplay(USER, payload, dependencies(redis)),
    ).rejects.toThrow(/integrity validation/);
    expect(await redis.hget(KEYS.USER_ACCOUNT(USER), 'balance')).toBe('10000');
  });

  it('documents the one-script prevalidation/AOF boundary and rechecks all mutable sources', () => {
    expect(HISTORICAL_REPLAY_LUA).toContain('All validation ends above');
    for (const command of ['SCARD', 'ZCARD', 'HLEN', 'LLEN', 'SISMEMBER', 'SMEMBERS', "KEYS', transaction.positionPattern", "KEYS', transaction.leveragePattern", "KEYS', transaction.replayPattern"]) {
      expect(HISTORICAL_REPLAY_LUA).toContain(command);
    }
    expect(HISTORICAL_REPLAY_LUA.indexOf("HSET', KEYS[4], 'balance'")).toBeGreaterThan(
      HISTORICAL_REPLAY_LUA.indexOf('All validation ends above'),
    );
  });
});
