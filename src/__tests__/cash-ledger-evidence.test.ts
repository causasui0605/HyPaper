import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';
import { pnlFundingCorrectionId, pnlFundingEventId } from '../worker/funding-worker.js';
import {
  cashLedgerEvidenceCorrectionMemberDigest,
  cashLedgerEvidenceManifestDigest,
  CashLedgerEvidenceError,
  getCashLedgerEvidence,
} from '../engine/cash-ledger-evidence.js';
import {
  CASH_LEDGER_EVIDENCE_SCHEMA,
  canonicalJson,
  decodeCashLedgerEvidenceReceipt,
  domainDigest,
  encodeCashLedgerEvidenceReceipt,
  walletFingerprint,
  type CashLedgerEvidenceReceipt,
} from '../types/cash-ledger-evidence.js';

function emptyReceipt(): CashLedgerEvidenceReceipt {
  const withoutDigest = {
    schema_version: CASH_LEDGER_EVIDENCE_SCHEMA,
    provider_identity: {
      source_revision: 'a'.repeat(40),
      image_digest: `sha256:${'b'.repeat(64)}`,
      compose_config_digest: 'c'.repeat(64),
      api_schema_version: CASH_LEDGER_EVIDENCE_SCHEMA,
      funding_interval_ms: 3_600_000,
      correction_finality_ms: 86_400_000,
      max_evidence_rows: 100,
    },
    subject: {
      wallet_fingerprint: walletFingerprint('0xAbC'),
      dex: 'xyz',
      coins: ['xyz:CL'],
    },
    coverage: {
      start_ms: 0,
      end_ms: 0,
      observed_at_ms: 172_800_000,
      funding_interval_ms: 3_600_000,
      latest_fully_covered_funding_time_ms: 0,
      correction_finality_watermark_ms: 86_400_000,
      finality_status: 'final' as const,
      terminal: true as const,
      page_count: 1 as const,
    },
    funding_events: [],
    funding_corrections: [],
    event_manifest: {
      count: 0,
      member_sha256s: [],
      manifest_digest: domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_MANIFEST_V1', {
        count: 0,
        member_sha256s: [],
      }),
    },
    correction_manifest: {
      count: 0,
      member_sha256s: [],
      manifest_digest: domainDigest('HYPAPER_CASH_LEDGER_EVIDENCE_MANIFEST_V1', {
        count: 0,
        member_sha256s: [],
      }),
    },
    settled_usdc: {
      currency: 'USDC' as const,
      starting_balance: '100',
      replay_final_balance: '100',
      current_balance: '100',
      replay_realized_pnl: '0',
      ordinary_realized_pnl: '0',
      replay_fees: '0',
      ordinary_fees: '0',
      effective_funding_charge: '0',
      unrelated_cash_movement: '0' as const,
      expected_current_balance: '100',
      residual: '0' as const,
      evidence_sha256: 'd'.repeat(64),
    },
    flatness: {
      all_positions_zero: true as const,
      relevant_open_order_count: 0 as const,
      current_unrealized_pnl: '0' as const,
      clearinghouse_state_sha256: 'e'.repeat(64),
      open_order_inventory_sha256: 'f'.repeat(64),
    },
  };
  return {
    ...withoutDigest,
    receipt_digest: domainDigest(CASH_LEDGER_EVIDENCE_SCHEMA, withoutDigest),
  };
}

describe('cash ledger evidence codecs', () => {
  it('round-trips exact canonical receipt bytes', () => {
    const receipt = emptyReceipt();
    const bytes = encodeCashLedgerEvidenceReceipt(receipt);
    const text = new TextDecoder().decode(bytes);

    expect(text).toBe(canonicalJson(receipt));
    expect(decodeCashLedgerEvidenceReceipt(bytes)).toEqual(receipt);
  });

  it('rejects noncanonical receipt bytes and digest drift', () => {
    const receipt = emptyReceipt();
    const text = new TextDecoder().decode(encodeCashLedgerEvidenceReceipt(receipt));

    expect(() => decodeCashLedgerEvidenceReceipt(` ${text}`)).toThrow();
    expect(() => decodeCashLedgerEvidenceReceipt(`\ufeff${text}`)).toThrow();
    expect(() => decodeCashLedgerEvidenceReceipt(text.replace('"start_ms":0', '"start_ms":0e0'))).toThrow();
    expect(() => decodeCashLedgerEvidenceReceipt(text.replace(receipt.receipt_digest, '0'.repeat(64)))).toThrow();
  });

  it('uses a lowercased wallet identity without exposing the raw wallet', () => {
    expect(walletFingerprint('0xAbC')).toBe(walletFingerprint('0xabc'));
    expect(JSON.stringify(emptyReceipt())).not.toContain('0xAbC');
  });
});

const USER = '0xabc';
const COIN = 'xyz:CL';
const SECOND_COIN = 'xyz:NATGAS';
const FUNDING_TIME = 3_600_000;
const BATCH_ID = `hprb${'1'.repeat(64)}`;
const REPLAY_EVENT_ID = `hpre${'2'.repeat(64)}`;
const PRICE_EVIDENCE_ID = `hprp${'3'.repeat(64)}`;
const RISK_MARK_ID = `hprr${'4'.repeat(64)}`;
const DIGEST = 'a'.repeat(64);

function replayFixture() {
  const replayEvent = {
    schema: 'hypaper-historical-replay-event/v1', kind: 'historical_replay_event', paper: true,
    synthetic: true, historicalReplay: true, historical_replay: true, batchId: BATCH_ID,
    eventId: REPLAY_EVENT_ID, syntheticFillId: `hprf${'5'.repeat(64)}`, evidenceId: PRICE_EVIDENCE_ID,
    sourceDigest: DIGEST, priceEvidenceDigest: DIGEST, modelInputDigest: DIGEST,
    riskMarkEvidenceDigest: DIGEST, phase: 'scheduled_entry', sequence: 0, asset: 0, coin: COIN,
    effectiveAt: FUNDING_TIME, recordedAt: FUNDING_TIME + 1, replayedAt: FUNDING_TIME,
    side: 'B', sz: '1', px: '100', priceSource: 'fallback', aggressiveLimitPx: '100',
    startPosition: '0', endPosition: '1', entryPx: '100', closedPnl: '0', fee: '0',
    feeRate: '0', feeToken: 'USDC', crossed: true,
  };
  const replay = {
    schema: 'hypaper-historical-replay/v1',
    source: { schema: 'hypaper-historical-replay-source/v1', name: 'fixture', generatedAt: FUNDING_TIME },
    sourceDigest: DIGEST,
    priceEvidence: [{
      schema: 'hypaper-historical-replay-price-evidence/v1', evidenceId: PRICE_EVIDENCE_ID,
      asset: 0, coin: COIN, effectiveAt: FUNDING_TIME, requestAt: FUNDING_TIME,
      responseAt: FUNDING_TIME, midPx: '100', bids: [], asks: [{ px: '100', sz: '1' }],
      aggressiveLimitPx: '100', side: 'B', sz: '1',
    }],
    priceEvidenceDigest: DIGEST,
    modelInputs: {
      schema: 'hypaper-historical-replay-model/v1', feeRate: '0', startingBalance: '10000',
      feeToken: 'USDC', fillAssumption: 'l2-vwap-limit-clamp-mid-fallback/v1',
    },
    modelInputDigest: DIGEST,
    riskMarkEvidence: [{
      schema: 'hypaper-historical-replay-risk-mark/v1', riskMarkId: RISK_MARK_ID, asset: 0,
      coin: COIN, requestAt: FUNDING_TIME, responseAt: FUNDING_TIME, markPx: '100',
    }],
    riskMarkEvidenceDigest: DIGEST,
    assetBindings: [{
      schema: 'hypaper-historical-replay-asset-binding/v1', asset: 0, coin: COIN,
      marginMode: 'cross', selectedLeverage: '3', riskMarkId: RISK_MARK_ID,
    }],
    events: [{
      schema: 'hypaper-historical-replay-event/v1', eventId: REPLAY_EVENT_ID,
      phase: 'scheduled_entry', sequence: 0, asset: 0, coin: COIN, effectiveAt: FUNDING_TIME,
      priceEvidenceId: PRICE_EVIDENCE_ID,
    }],
    batchId: BATCH_ID,
  };
  return {
    type: 'historicalReplay', status: 'imported', paper: true, synthetic: true,
    historicalReplay: true, historical_replay: true, user: USER, batchId: BATCH_ID,
    sourceDigest: DIGEST, priceEvidenceDigest: DIGEST, modelInputDigest: DIGEST,
    riskMarkEvidenceDigest: DIGEST, startingBalance: '10000', finalBalance: '10000',
    replayedAt: FUNDING_TIME, eventCount: 1, eventIds: [REPLAY_EVENT_ID], replay,
    positions: [],
    marginPosture: [{ asset: 0, coin: COIN, marginMode: 'cross', selectedLeverage: '3',
      riskMarkId: RISK_MARK_ID, riskMarkPx: '100', finalSzi: '0', finalEntryPx: '0',
      positionNotional: '0', unrealizedPnl: '0', marginRequired: '0' }],
    riskSummary: { cashBalance: '10000', unrealizedPnl: '0', accountValue: '10000', totalMargin: '0', marginAvailable: '10000' },
    events: [replayEvent],
  };
}

function evidenceDependencies(redis: RedisMock, replay = replayFixture()) {
  const eventId = pnlFundingEventId(USER, 0, FUNDING_TIME);
  return {
    redis,
    historicalReplay: vi.fn(async () => replay),
    clearinghouseState: vi.fn(async () => ({
      assetPositions: [] as unknown[], crossMarginSummary: { accountValue: '9999' },
      marginSummary: { accountValue: '9999' }, time: 2_000_000,
    })),
    openOrders: vi.fn(async () => [] as unknown[]),
    now: vi.fn(() => 4_000_000),
    providerIdentity: {
      source_revision: 'a'.repeat(40), image_digest: `sha256:${'b'.repeat(64)}`,
      compose_config_digest: 'c'.repeat(64), api_schema_version: 'HYPAPER_CASH_LEDGER_EVIDENCE_V1' as const,
      funding_interval_ms: 3_600_000, correction_finality_ms: 100, max_evidence_rows: 20,
    },
    eventId,
  };
}

async function seedEvidence(redis: RedisMock): Promise<void> {
  const d = evidenceDependencies(redis);
  await redis.hset(KEYS.USER_ACCOUNT(USER), 'userId', USER, 'balance', '9999');
  await redis.set(KEYS.HISTORICAL_REPLAY_INDEX(USER), BATCH_ID);
  await redis.set(KEYS.HISTORICAL_REPLAY_BATCH(USER, BATCH_ID), JSON.stringify(replayFixture()));
  const event = {
    schema: 'hypaper_pnl_funding_event_v2', kind: 'pnl_funding_event', paper: true,
    eventId: d.eventId, asset: 0, coin: COIN, fundingTime: FUNDING_TIME, appliedAt: FUNDING_TIME + 1,
    szi: '1', oraclePx: '100', fundingRate: '0.01', fundingCharge: '1', source: { kind: 'live_market_context' },
    accountBalanceBefore: '10000', accountBalanceAfter: '9999', cumFundingBefore: '0', cumFundingAfter: '1',
    cumFundingSinceOpenBefore: '0', cumFundingSinceOpenAfter: '1', cumFundingSinceChangeBefore: '0', cumFundingSinceChangeAfter: '1',
  };
  await redis.set(KEYS.PNL_FUNDING_EVENT(USER, d.eventId), JSON.stringify(event));
  await redis.rpush(KEYS.PNL_FUNDING_EVENTS(USER), d.eventId);
}

const sha256Text = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

async function seedCorrectionEvidence(redis: RedisMock): Promise<{
  correction: Record<string, unknown>;
  correctionId: string;
  originalRaw: string;
}> {
  await seedEvidence(redis);
  const originalEventId = pnlFundingEventId(USER, 0, FUNDING_TIME);
  const originalRaw = await redis.get(KEYS.PNL_FUNDING_EVENT(USER, originalEventId));
  if (originalRaw === null) throw new Error('correction fixture requires its original event');
  const correctionId = pnlFundingCorrectionId(USER, 0, FUNDING_TIME, originalEventId);
  const correction = {
    schema: 'hypaper_pnl_funding_correction_v1', kind: 'pnl_funding_correction', paper: true,
    correctionId, originalEventId, asset: 0, coin: COIN, fundingTime: FUNDING_TIME,
    appliedAt: FUNDING_TIME + 2, szi: '1', originalFundingCharge: '1', correctedOraclePx: '200',
    correctedFundingRate: '0.01', correctedFundingCharge: '2', fundingChargeDelta: '1',
    source: {
      kind: 'verified_correction', originalEventSha256: sha256Text(originalRaw),
      oracleSourceSha256: 'b'.repeat(64), fundingSourceSha256: 'c'.repeat(64),
    },
    accountBalanceBefore: '9999', accountBalanceAfter: '9998',
    cumFundingBefore: '1', cumFundingAfter: '2',
    cumFundingSinceOpenBefore: '1', cumFundingSinceOpenAfter: '2',
    cumFundingSinceChangeBefore: '1', cumFundingSinceChangeAfter: '2',
  };
  await redis.set(KEYS.PNL_FUNDING_CORRECTION(USER, correctionId), JSON.stringify(correction));
  await redis.rpush(KEYS.PNL_FUNDING_CORRECTIONS(USER), correctionId);
  await redis.hset(KEYS.USER_ACCOUNT(USER), 'balance', '9998');
  return { correction, correctionId, originalRaw };
}

function correctionDependencies(redis: RedisMock) {
  const dependencies = evidenceDependencies(redis);
  dependencies.clearinghouseState.mockResolvedValue({
    assetPositions: [], crossMarginSummary: { accountValue: '9998' },
    marginSummary: { accountValue: '9998' }, time: 2_000_000,
  });
  return dependencies;
}

async function seedTwoCoinEvidence(redis: RedisMock): Promise<void> {
  await seedEvidence(redis);
  const eventId = pnlFundingEventId(USER, 1, FUNDING_TIME);
  const event = {
    schema: 'hypaper_pnl_funding_event_v2', kind: 'pnl_funding_event', paper: true,
    eventId, asset: 1, coin: SECOND_COIN, fundingTime: FUNDING_TIME, appliedAt: FUNDING_TIME + 2,
    szi: '1', oraclePx: '100', fundingRate: '0.01', fundingCharge: '1', source: { kind: 'live_market_context' },
    accountBalanceBefore: '9999', accountBalanceAfter: '9998', cumFundingBefore: '1', cumFundingAfter: '2',
    cumFundingSinceOpenBefore: '1', cumFundingSinceOpenAfter: '2', cumFundingSinceChangeBefore: '1', cumFundingSinceChangeAfter: '2',
  };
  await redis.set(KEYS.PNL_FUNDING_EVENT(USER, eventId), JSON.stringify(event));
  await redis.rpush(KEYS.PNL_FUNDING_EVENTS(USER), eventId);
  await redis.hset(KEYS.USER_ACCOUNT(USER), 'balance', '9998');
}

function receiptBytesWithRecomputedDigest(receipt: CashLedgerEvidenceReceipt): string {
  const { receipt_digest: _receiptDigest, ...withoutDigest } = receipt;
  return canonicalJson({
    ...receipt,
    receipt_digest: domainDigest(CASH_LEDGER_EVIDENCE_SCHEMA, withoutDigest),
  });
}

function cloneReceipt(receipt: CashLedgerEvidenceReceipt): CashLedgerEvidenceReceipt {
  return JSON.parse(JSON.stringify(receipt)) as CashLedgerEvidenceReceipt;
}

describe('cash ledger evidence derivation', () => {
  it('reconciles a hand-computable ORACLE funding charge and remains read-only', async () => {
    const redis = new RedisMock();
    await seedEvidence(redis);
    const dependencies = evidenceDependencies(redis);
    const writes = [vi.spyOn(redis, 'set'), vi.spyOn(redis, 'hset'), vi.spyOn(redis, 'rpush'), vi.spyOn(redis, 'del')];
    const receipt = await getCashLedgerEvidence({
      type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN],
      coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true,
    }, dependencies);
    expect(receipt.settled_usdc).toMatchObject({
      starting_balance: '10000', replay_final_balance: '10000', current_balance: '9999',
      effective_funding_charge: '1', expected_current_balance: '9999', residual: '0',
    });
    expect(receipt.funding_events[0]?.oracle_px).toBe('100');
    expect(receipt.funding_events[0]?.funding_charge).toBe('1');
    expect(() => encodeCashLedgerEvidenceReceipt(receipt)).not.toThrow();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it('replays a valid non-empty correction with bound hashes, transitions, and manifest', async () => {
    const redis = new RedisMock();
    const fixture = await seedCorrectionEvidence(redis);
    const receipt = await getCashLedgerEvidence({
      type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN],
      coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true,
    }, correctionDependencies(redis));
    const correction = receipt.funding_corrections[0];
    expect(correction).toBeDefined();
    expect(correction).toMatchObject({
      ordinal: 0, correction_id: fixture.correctionId, original_event_id: fixture.correction.originalEventId,
      original_funding_charge: '1', corrected_oracle_px: '200', corrected_funding_rate: '0.01',
      corrected_funding_charge: '2', funding_charge_delta: '1', account_balance_before: '9999',
      account_balance_after: '9998', cum_funding_before: '1', cum_funding_after: '2',
      cum_funding_since_open_before: '1', cum_funding_since_open_after: '2',
      cum_funding_since_change_before: '1', cum_funding_since_change_after: '2',
      source: {
        kind: 'verified_correction', original_event_sha256: sha256Text(fixture.originalRaw),
        oracle_source_sha256: 'b'.repeat(64), funding_source_sha256: 'c'.repeat(64),
      },
    });
    if (correction === undefined) throw new Error('correction row is missing');
    const { member_sha256: member, ...withoutMember } = correction;
    expect(member).toBe(cashLedgerEvidenceCorrectionMemberDigest(withoutMember));
    expect(receipt.correction_manifest).toMatchObject({
      count: 1, member_sha256s: [member],
      manifest_digest: cashLedgerEvidenceManifestDigest({ count: 1, member_sha256s: [member] }),
    });
    expect(receipt.settled_usdc).toMatchObject({
      effective_funding_charge: '2', current_balance: '9998', expected_current_balance: '9998', residual: '0',
    });
    expect(encodeCashLedgerEvidenceReceipt(receipt)).toEqual(expect.any(Uint8Array));
  });

  it('reproduces the settled-USDC equation with replay fees counted once', async () => {
    const redis = new RedisMock();
    await seedEvidence(redis);
    const replay = replayFixture();
    replay.finalBalance = '9999';
    replay.events[0]!.fee = '1';
    replay.riskSummary.cashBalance = '9999';
    replay.riskSummary.accountValue = '9999';
    replay.riskSummary.marginAvailable = '9999';
    await redis.set(KEYS.HISTORICAL_REPLAY_BATCH(USER, BATCH_ID), JSON.stringify(replay));

    const eventKey = KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 0, FUNDING_TIME));
    const event = JSON.parse((await redis.get(eventKey))!);
    event.accountBalanceBefore = '9999';
    event.accountBalanceAfter = '9998';
    await redis.set(eventKey, JSON.stringify(event));
    await redis.hset(KEYS.USER_ACCOUNT(USER), 'balance', '9998');

    const dependencies = evidenceDependencies(redis, replay);
    dependencies.clearinghouseState.mockResolvedValue({
      assetPositions: [], crossMarginSummary: { accountValue: '9998' },
      marginSummary: { accountValue: '9998' }, time: 2_000_000,
    });
    const receipt = await getCashLedgerEvidence({
      type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN],
      coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true,
    }, dependencies);

    expect(receipt.settled_usdc).toMatchObject({
      starting_balance: '10000', replay_final_balance: '9999', replay_realized_pnl: '0',
      replay_fees: '1', effective_funding_charge: '1', current_balance: '9998',
      expected_current_balance: '9998', residual: '0',
    });
  });

  it('ignores only volatile clearinghouse time across the stable double read', async () => {
    const redis = new RedisMock();
    await seedEvidence(redis);
    const dependencies = evidenceDependencies(redis);
    let time = 2_000_000;
    dependencies.clearinghouseState.mockImplementation(async () => ({
      assetPositions: [], crossMarginSummary: { accountValue: '9999' },
      marginSummary: { accountValue: '9999' }, time: time++,
    }));

    await expect(getCashLedgerEvidence({
      type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN],
      coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true,
    }, dependencies)).resolves.toMatchObject({ flatness: { all_positions_zero: true } });
  });

  it('refuses missing ORACLE fields, empty coverage, and torn reads', async () => {
    const redis = new RedisMock();
    await seedEvidence(redis);
    const dependencies = evidenceDependencies(redis);
    const raw = JSON.parse((await redis.get(KEYS.PNL_FUNDING_EVENT(USER, dependencies.eventId)))!);
    delete raw.oraclePx;
    await redis.set(KEYS.PNL_FUNDING_EVENT(USER, dependencies.eventId), JSON.stringify(raw));
    await expect(getCashLedgerEvidence({ type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true }, dependencies)).rejects.toMatchObject({ code: 'identity' });
    await redis.del(KEYS.PNL_FUNDING_EVENT(USER, dependencies.eventId), KEYS.PNL_FUNDING_EVENTS(USER));
    await expect(getCashLedgerEvidence({ type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true }, dependencies)).rejects.toMatchObject({ code: 'provisional_incomplete' });
    await seedEvidence(redis);
    let calls = 0;
    dependencies.clearinghouseState.mockImplementation(async () => ({
      assetPositions: [], crossMarginSummary: { accountValue: calls++ === 0 ? '9999' : '9998' },
      marginSummary: { accountValue: calls === 1 ? '9999' : '9998' }, time: 2_000_000,
    }));
    await expect(getCashLedgerEvidence({ type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true }, dependencies)).rejects.toBeInstanceOf(CashLedgerEvidenceError);
  });

  it('refuses duplicate, gapped, oversized, orphaned, and arithmetically inconsistent evidence', async () => {
    const request = { type: 'getCashLedgerEvidence' as const, user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true as const };
    const duplicateRedis = new RedisMock(); await seedEvidence(duplicateRedis); const duplicate = evidenceDependencies(duplicateRedis);
    await duplicateRedis.rpush(KEYS.PNL_FUNDING_EVENTS(USER), duplicate.eventId);
    await expect(getCashLedgerEvidence(request, duplicate)).rejects.toMatchObject({ code: 'identity' });

    const gapRedis = new RedisMock(); await seedEvidence(gapRedis); const gap = evidenceDependencies(gapRedis);
    await expect(getCashLedgerEvidence({ ...request, coverageEndMs: FUNDING_TIME * 2 }, gap)).rejects.toMatchObject({ code: 'provisional_incomplete' });

    const capRedis = new RedisMock(); await seedEvidence(capRedis); const cap = evidenceDependencies(capRedis);
    cap.providerIdentity.max_evidence_rows = 1;
    await expect(getCashLedgerEvidence({ ...request, coins: ['xyz:CL', 'xyz:NATGAS'] }, cap)).rejects.toMatchObject({ code: 'row_cap' });

    const orphanRedis = new RedisMock(); await seedEvidence(orphanRedis); const orphan = evidenceDependencies(orphanRedis);
    const orphanId = `hpfc${'9'.repeat(64)}`;
    await orphanRedis.rpush(KEYS.PNL_FUNDING_CORRECTIONS(USER), orphanId);
    await expect(getCashLedgerEvidence(request, orphan)).rejects.toMatchObject({ code: 'identity' });

    const arithmeticRedis = new RedisMock(); await seedEvidence(arithmeticRedis); const arithmetic = evidenceDependencies(arithmeticRedis);
    const eventRaw = JSON.parse((await arithmeticRedis.get(KEYS.PNL_FUNDING_EVENT(USER, arithmetic.eventId)))!);
    eventRaw.fundingCharge = '2';
    await arithmeticRedis.set(KEYS.PNL_FUNDING_EVENT(USER, arithmetic.eventId), JSON.stringify(eventRaw));
    await expect(getCashLedgerEvidence(request, arithmetic)).rejects.toMatchObject({ code: 'arithmetic' });
  });

  it('refuses provisional finality and non-flat open-order state', async () => {
    const redis = new RedisMock(); await seedEvidence(redis); const provisional = evidenceDependencies(redis);
    provisional.now.mockReturnValue(100);
    await expect(getCashLedgerEvidence({ type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true }, provisional)).rejects.toMatchObject({ code: 'provisional_incomplete' });

    const ordersRedis = new RedisMock(); await seedEvidence(ordersRedis); const orders = evidenceDependencies(ordersRedis);
    orders.openOrders.mockResolvedValue([{ coin: COIN, oid: 1 }]);
    await expect(getCashLedgerEvidence({ type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true }, orders)).rejects.toMatchObject({ code: 'flatness' });
  });

  it('refuses a held requested position even when unrealized PnL is zero', async () => {
    const redis = new RedisMock(); await seedEvidence(redis); const held = evidenceDependencies(redis);
    held.clearinghouseState.mockResolvedValue({
      assetPositions: [{ type: 'oneWay', position: { coin: COIN, szi: '1', entryPx: '100', unrealizedPnl: '0' } }],
      crossMarginSummary: { accountValue: '9999' }, marginSummary: { accountValue: '9999' }, time: 2_000_000,
    });
    await expect(getCashLedgerEvidence({ type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true }, held)).rejects.toMatchObject({ code: 'flatness' });
  });

  it('refuses correction source-hash, orphan, duplicate, and arithmetic drift', async () => {
    const request = { type: 'getCashLedgerEvidence' as const, user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true as const };
    const scenarios: Array<{ name: string; code: string; mutate?: (correction: Record<string, unknown>) => void; duplicate?: boolean }> = [
      { name: 'original source hash', code: 'identity', mutate: (correction) => { correction.source = { ...(correction.source as Record<string, unknown>), originalEventSha256: 'd'.repeat(64) }; } },
      { name: 'orphan original', code: 'identity', mutate: (correction) => { correction.originalEventId = `hpfe${'e'.repeat(64)}`; } },
      { name: 'duplicate correction index', code: 'identity', duplicate: true },
      { name: 'correction arithmetic', code: 'arithmetic', mutate: (correction) => { correction.fundingChargeDelta = '2'; } },
    ];
    for (const scenario of scenarios) {
      const redis = new RedisMock();
      const fixture = await seedCorrectionEvidence(redis);
      const correction = JSON.parse(JSON.stringify(fixture.correction)) as Record<string, unknown>;
      scenario.mutate?.(correction);
      await redis.set(KEYS.PNL_FUNDING_CORRECTION(USER, fixture.correctionId), JSON.stringify(correction));
      if (scenario.duplicate) await redis.rpush(KEYS.PNL_FUNDING_CORRECTIONS(USER), fixture.correctionId);
      await expect(getCashLedgerEvidence(request, correctionDependencies(redis)), scenario.name).rejects.toMatchObject({ code: scenario.code });
    }
  });

  it('rejects manifest reorder, count parity, and digest drift during receipt decode', async () => {
    const redis = new RedisMock();
    await seedTwoCoinEvidence(redis);
    const receipt = await getCashLedgerEvidence({
      type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN, SECOND_COIN],
      coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true,
    }, correctionDependencies(redis));
    expect(receipt.event_manifest.count).toBe(2);

    const reordered = cloneReceipt(receipt);
    reordered.event_manifest.member_sha256s.reverse();
    expect(() => decodeCashLedgerEvidenceReceipt(receiptBytesWithRecomputedDigest(reordered))).toThrow();

    const countDrift = cloneReceipt(receipt);
    countDrift.event_manifest.count = 1;
    expect(() => decodeCashLedgerEvidenceReceipt(receiptBytesWithRecomputedDigest(countDrift))).toThrow();

    const digestDrift = cloneReceipt(receipt);
    digestDrift.event_manifest.manifest_digest = '0'.repeat(64);
    expect(() => decodeCashLedgerEvidenceReceipt(receiptBytesWithRecomputedDigest(digestDrift))).toThrow();
  });

  it('refuses unexplained set/reset cash residuals', async () => {
    const request = { type: 'getCashLedgerEvidence' as const, user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true as const };
    for (const balance of ['10000', '9998']) {
      const redis = new RedisMock();
      await seedEvidence(redis);
      await redis.hset(KEYS.USER_ACCOUNT(USER), 'balance', balance);
      const dependencies = evidenceDependencies(redis);
      dependencies.clearinghouseState.mockResolvedValue({
        assetPositions: [], crossMarginSummary: { accountValue: balance },
        marginSummary: { accountValue: balance }, time: 2_000_000,
      });
      await expect(getCashLedgerEvidence(request, dependencies)).rejects.toMatchObject({ code: 'arithmetic' });
    }
  });

  it('rejects float/bool coercion and noncanonical decimal source or receipt values', async () => {
    const request = { type: 'getCashLedgerEvidence' as const, user: USER, dex: 'xyz', coins: [COIN], coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true as const };
    const requestRedis = new RedisMock(); await seedEvidence(requestRedis);
    const requestDependencies = evidenceDependencies(requestRedis);
    await expect(getCashLedgerEvidence({ ...request, coverageStartMs: FUNDING_TIME + 0.5 }, requestDependencies)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(getCashLedgerEvidence({ ...request, finalFlatRequired: false }, requestDependencies)).rejects.toMatchObject({ code: 'invalid_request' });

    const floatRedis = new RedisMock(); await seedEvidence(floatRedis);
    const floatRaw = JSON.parse((await floatRedis.get(KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 0, FUNDING_TIME))))!);
    floatRaw.oraclePx = 100;
    await floatRedis.set(KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 0, FUNDING_TIME)), JSON.stringify(floatRaw));
    await expect(getCashLedgerEvidence(request, evidenceDependencies(floatRedis))).rejects.toMatchObject({ code: 'identity' });

    const decimalRedis = new RedisMock(); await seedEvidence(decimalRedis);
    const decimalRaw = JSON.parse((await decimalRedis.get(KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 0, FUNDING_TIME))))!);
    decimalRaw.fundingRate = '1e-2';
    await decimalRedis.set(KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 0, FUNDING_TIME)), JSON.stringify(decimalRaw));
    await expect(getCashLedgerEvidence(request, evidenceDependencies(decimalRedis))).rejects.toMatchObject({ code: 'identity' });

    const badReceipt = emptyReceipt();
    badReceipt.settled_usdc.starting_balance = '1.0';
    expect(() => decodeCashLedgerEvidenceReceipt(receiptBytesWithRecomputedDigest(badReceipt))).toThrow();
  });

  it('refuses duplicate same-coin funding-time ties', async () => {
    const redis = new RedisMock(); await seedEvidence(redis);
    const tiedId = pnlFundingEventId(USER, 1, FUNDING_TIME);
    const tiedRaw = JSON.parse((await redis.get(KEYS.PNL_FUNDING_EVENT(USER, pnlFundingEventId(USER, 0, FUNDING_TIME))))!);
    tiedRaw.eventId = tiedId;
    tiedRaw.asset = 1;
    await redis.set(KEYS.PNL_FUNDING_EVENT(USER, tiedId), JSON.stringify(tiedRaw));
    await redis.rpush(KEYS.PNL_FUNDING_EVENTS(USER), tiedId);
    await expect(getCashLedgerEvidence({
      type: 'getCashLedgerEvidence', user: USER, dex: 'xyz', coins: [COIN],
      coverageStartMs: FUNDING_TIME, coverageEndMs: FUNDING_TIME, finalFlatRequired: true,
    }, evidenceDependencies(redis))).rejects.toMatchObject({ code: 'provisional_incomplete' });
  });
});
