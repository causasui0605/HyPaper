import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import DecimalModule from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { RedisMock } from './helpers/redis-mock.js';
import { KEYS } from '../store/keys.js';
import { pnlFundingCorrectionId, pnlFundingEventId } from '../worker/funding-worker.js';
import {
  cashLedgerEvidenceCorrectionMemberDigest,
  cashLedgerEvidenceManifestDigest,
  CashLedgerEvidenceError,
  getCashLedgerEvidence,
  CashLedgerEvidenceV2Error,
  getCashLedgerEvidenceV2,
} from '../engine/cash-ledger-evidence.js';
import {
  CASH_LEDGER_EVIDENCE_SCHEMA,
  CASH_LEDGER_EVIDENCE_V2_SCHEMA,
  canonicalJson,
  decodeCashLedgerEvidenceReceipt,
  decodeCashLedgerEvidenceV2Receipt,
  decodeCashLedgerEvidenceV2Request,
  domainDigest,
  encodeCashLedgerEvidenceReceipt,
  encodeCashLedgerEvidenceV2Receipt,
  CashLedgerEvidenceV2CodecError,
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

type V2Fixture = {
  schema_version: string;
  provider_identity: {
    source_revision: string;
    image_digest: string;
    compose_config_digest: string;
    api_schema_version: typeof CASH_LEDGER_EVIDENCE_V2_SCHEMA;
    funding_interval_ms: number;
    correction_finality_ms: number;
    max_evidence_rows: number;
  };
  subject: {
    wallet_fingerprint: string;
    dex: string;
    coins: string[];
    scope: 'whole_account_replay_epoch';
    replay_batch_id: string;
  };
  coverage: { start_ms: number; end_ms: number; observed_at_ms: number };
  source_inventory: any;
};

function readV2Fixture(): V2Fixture {
  return JSON.parse(readFileSync('plans/fixtures/hypaper_cash_f7_s2_success.json', 'utf8')) as V2Fixture;
}

async function seedV2Fixture(redis: RedisMock): Promise<{
  fixture: V2Fixture;
  user: string;
  request: Record<string, unknown>;
  dependencies: any;
}> {
  const fixture = readV2Fixture();
  const inventory = fixture.source_inventory;
  const user = `0x${'1'.repeat(40)}`;
  const account = inventory.account.rows[0].source as Record<string, any>;
  await redis.hset(
    KEYS.USER_ACCOUNT(user),
    'userId', user,
    'balance', account.balance,
    'createdAt', String(account.created_at_ms),
  );
  const replay = { ...inventory.replay.rows[0].source } as Record<string, any>;
  replay.user = user;
  delete replay.wallet_fingerprint;
  await redis.set(KEYS.HISTORICAL_REPLAY_INDEX(user), replay.batchId);
  await redis.set(KEYS.HISTORICAL_REPLAY_BATCH(user, replay.batchId), JSON.stringify(replay));

  for (const row of [...inventory.ordinary_fills.rows].reverse()) {
    await redis.lpush(KEYS.USER_FILLS(user), JSON.stringify(row.source));
  }
  for (const row of inventory.funding_records.rows) {
    await redis.set(KEYS.PNL_FUNDING_EVENT(user, row.identity), row.source.raw_json);
    await redis.rpush(KEYS.PNL_FUNDING_EVENTS(user), row.identity);
  }
  for (const row of inventory.correction_records.rows) {
    await redis.set(KEYS.PNL_FUNDING_CORRECTION(user, row.identity), row.source.raw_json);
    await redis.rpush(KEYS.PNL_FUNDING_CORRECTIONS(user), row.identity);
  }
  for (const row of inventory.orders.rows) {
    const source = row.source as Record<string, any>;
    const data: Record<string, string> = {
      oid: String(source.oid), userId: user, asset: String(source.asset), coin: source.coin,
      isBuy: String(source.side === 'BUY'), sz: source.qty, limitPx: source.limit_px,
      orderType: source.order_type, tif: source.time_in_force, reduceOnly: String(source.reduce_only),
      grouping: source.grouping, status: source.status, filledSz: source.filled_qty,
      avgPx: source.average_fill_px, createdAt: String(source.created_at_ms),
      updatedAt: String(source.updated_at_ms),
    };
    if (source.cl_ord_id !== null) data.cloid = source.cl_ord_id;
    if (source.trigger_px !== null) data.triggerPx = source.trigger_px;
    if (source.tp_sl !== null) data.tpsl = source.tp_sl;
    if (source.is_market !== null) data.isMarket = String(source.is_market);
    const args: string[] = [];
    for (const [key, value] of Object.entries(data)) args.push(key, value);
    await redis.hset(KEYS.ORDER(source.oid), ...args);
    await redis.zadd(KEYS.USER_ORDERS(user), source.created_at_ms, String(source.oid));
  }

  const state = {
    assetPositions: [],
    crossMarginSummary: { accountValue: account.balance },
    marginSummary: { accountValue: account.balance },
    time: 2,
  };
  const dependencies = {
    redis,
    historicalReplay: vi.fn(async () => replay),
    clearinghouseState: vi.fn(async () => state),
    openOrders: vi.fn(async () => [] as unknown[]),
    now: vi.fn(() => fixture.coverage.observed_at_ms),
    providerIdentity: fixture.provider_identity,
    maxBytes: 100_000,
  };
  const request = {
    type: 'getCashLedgerEvidenceV2', user, dex: fixture.subject.dex,
    coins: fixture.subject.coins, coverageStartMs: fixture.coverage.start_ms,
    coverageEndMs: fixture.coverage.end_ms, finalFlatRequired: true,
    scope: fixture.subject.scope, expectedReplayBatchId: fixture.subject.replay_batch_id,
  };
  return { fixture, user, request, dependencies };
}

async function rewriteV2Fill(
  redis: RedisMock,
  user: string,
  tid: number,
  mutate: (source: Record<string, unknown>) => void,
): Promise<void> {
  const key = KEYS.USER_FILLS(user);
  const stored = await redis.lrange(key, 0, -1);
  const rewritten = stored.map((raw) => {
    const source = JSON.parse(raw) as Record<string, unknown>;
    if (source.tid !== tid) return raw;
    mutate(source);
    return JSON.stringify(source);
  });
  await redis.del(key);
  for (const raw of [...rewritten].reverse()) await redis.lpush(key, raw);
}

function independentCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${independentCanonicalJson(child)}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('independent canonical JSON encoding failed');
  return encoded;
}

function independentDigest(domain: string, value: unknown): string {
  return createHash('sha256')
    .update(`${domain}\n`, 'ascii')
    .update(independentCanonicalJson(value), 'utf8')
    .digest('hex');
}

describe('cash ledger evidence V2 reconstructible source', () => {
  it('round-trips the immutable success fixture byte-for-byte', () => {
    const bytes = readFileSync('plans/fixtures/hypaper_cash_f7_s2_success.json');
    const payload = bytes.subarray(0, -1);
    const receipt = decodeCashLedgerEvidenceV2Receipt(payload);
    expect(Buffer.from(encodeCashLedgerEvidenceV2Receipt(receipt))).toEqual(Buffer.from(payload));
    expect(receipt.schema_version).toBe(CASH_LEDGER_EVIDENCE_V2_SCHEMA);
  });

  it('preserves absent and present ordinary-fill cloid shapes through every V2 digest layer', async () => {
    const absentRedis = new RedisMock();
    const absentSeeded = await seedV2Fixture(absentRedis);
    await rewriteV2Fill(absentRedis, absentSeeded.user, 14, (source) => { delete source.cloid; });
    const absent = await getCashLedgerEvidenceV2(absentSeeded.request, absentSeeded.dependencies);

    const presentRedis = new RedisMock();
    const presentSeeded = await seedV2Fixture(presentRedis);
    await rewriteV2Fill(presentRedis, presentSeeded.user, 14, (source) => { source.cloid = 'present-fill~'; });
    const present = await getCashLedgerEvidenceV2(presentSeeded.request, presentSeeded.dependencies);

    const absentFill = absent.source_inventory.ordinary_fills.rows.find((row) => row.identity === '14')!;
    const presentFill = present.source_inventory.ordinary_fills.rows.find((row) => row.identity === '14')!;
    expect(Object.prototype.hasOwnProperty.call(absentFill.source, 'cloid')).toBe(false);
    expect(independentCanonicalJson(absentFill.source)).not.toContain('cloid');
    expect(presentFill.source.cloid).toBe('present-fill~');
    expect(independentCanonicalJson(presentFill.source)).toContain('"cloid":"present-fill~"');

    for (const receipt of [absent, present]) {
      const fill = receipt.source_inventory.ordinary_fills.rows.find((row) => row.identity === '14')!;
      const collection = receipt.source_inventory.ordinary_fills;
      const collectionCore = {
        count: collection.rows.length,
        identities: collection.rows.map((row) => row.identity),
        source_digests: collection.rows.map((row) => row.source_digest),
      };
      const { inventory_digest: _inventoryDigest, ...inventoryWithoutDigest } = receipt.source_inventory;
      const { receipt_digest: _receiptDigest, ...receiptWithoutDigest } = receipt;
      expect(fill.source_digest).toBe(independentDigest('HYPAPER_CASH_SOURCE_FILL_V2', fill.source));
      expect(collection.manifest.manifest_digest).toBe(independentDigest('HYPAPER_CASH_SOURCE_MANIFEST_V2', collectionCore));
      expect(receipt.source_inventory.inventory_digest).toBe(independentDigest('HYPAPER_CASH_SOURCE_INVENTORY_V2', inventoryWithoutDigest));
      expect(receipt.settled_usdc.evidence_sha256).toBe(receipt.source_inventory.inventory_digest);
      expect(receipt.receipt_digest).toBe(independentDigest('HYPAPER_CASH_LEDGER_EVIDENCE_V2', receiptWithoutDigest));
      expect(Buffer.from(encodeCashLedgerEvidenceV2Receipt(receipt)).toString('utf8')).toBe(independentCanonicalJson(receipt));
    }

    expect(absentFill.source_digest).not.toBe(presentFill.source_digest);
    expect(absent.source_inventory.ordinary_fills.manifest.manifest_digest)
      .not.toBe(present.source_inventory.ordinary_fills.manifest.manifest_digest);
    expect(absent.source_inventory.inventory_digest).not.toBe(present.source_inventory.inventory_digest);
    expect(absent.settled_usdc.evidence_sha256).not.toBe(present.settled_usdc.evidence_sha256);
    expect(absent.receipt_digest).not.toBe(present.receipt_digest);
  });

  it('refuses null, empty, non-ASCII, control, and non-string ordinary-fill cloids', async () => {
    const invalidValues: Array<{ name: string; value: unknown }> = [
      { name: 'explicit null', value: null },
      { name: 'empty', value: '' },
      { name: 'non-ASCII', value: 'fill-é' },
      { name: 'control character', value: 'fill-\n' },
      { name: 'non-string', value: 14 },
    ];
    for (const { name, value } of invalidValues) {
      const redis = new RedisMock();
      const seeded = await seedV2Fixture(redis);
      await rewriteV2Fill(redis, seeded.user, 14, (source) => { source.cloid = value; });
      let error: unknown;
      try {
        await getCashLedgerEvidenceV2(seeded.request, seeded.dependencies);
      } catch (caught) {
        error = caught;
      }
      expect(error, name).toBeInstanceOf(CashLedgerEvidenceV2Error);
      expect(error, name).toMatchObject({ code: 'identity' });
    }
  });

  it('samples observed_at_ms after stable comparison and performs no reads afterward', async () => {
    const redis = new RedisMock();
    const seeded = await seedV2Fixture(redis);
    const callOrder: string[] = [];
    const readsAfterObserved: string[] = [];
    let observed = false;
    let stateCalls = 0;

    const readMethods = new Set(['get', 'hgetall', 'lrange', 'llen', 'smembers', 'zrange', 'zcard', 'keys']);
    const instrumentedRedis = new Proxy(redis, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof property !== 'string' || !readMethods.has(property) || typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (observed) readsAfterObserved.push(property);
          return value.apply(target, args);
        };
      },
    });
    seeded.dependencies.redis = instrumentedRedis;

    const originalState = seeded.dependencies.clearinghouseState;
    seeded.dependencies.clearinghouseState = vi.fn(async (...args: unknown[]) => {
      if (observed) readsAfterObserved.push('clearinghouseState');
      const state = await originalState(...args) as Record<string, unknown>;
      stateCalls += 1;
      if (stateCalls !== 2) return state;
      const secondState = { ...state };
      Object.defineProperty(secondState, 'time', {
        configurable: true,
        enumerable: true,
        get: () => {
          callOrder.push('stable-compare');
          return 2;
        },
      });
      callOrder.push('capture-2-complete');
      return secondState;
    });
    const originalOpenOrders = seeded.dependencies.openOrders;
    seeded.dependencies.openOrders = vi.fn(async (...args: unknown[]) => {
      if (observed) readsAfterObserved.push('openOrders');
      return originalOpenOrders(...args);
    });
    const originalReplay = seeded.dependencies.historicalReplay;
    seeded.dependencies.historicalReplay = vi.fn(async (...args: unknown[]) => {
      if (observed) readsAfterObserved.push('historicalReplay');
      return originalReplay(...args);
    });
    seeded.dependencies.now = vi.fn(() => {
      callOrder.push('observed');
      observed = true;
      return seeded.fixture.coverage.observed_at_ms;
    });

    const receipt = await getCashLedgerEvidenceV2(seeded.request, seeded.dependencies);
    const captureComplete = callOrder.indexOf('capture-2-complete');
    const stableCompare = callOrder.indexOf('stable-compare');
    const observation = callOrder.indexOf('observed');
    expect(receipt.coverage.observed_at_ms).toBe(seeded.fixture.coverage.observed_at_ms);
    expect(stateCalls).toBe(2);
    expect(captureComplete).toBeGreaterThanOrEqual(0);
    expect(stableCompare).toBeGreaterThan(captureComplete);
    expect(observation).toBeGreaterThan(stableCompare);
    expect(readsAfterObserved).toEqual([]);
  });

  it('reconstructs the complete fixture-shaped account without mutation', async () => {
    const redis = new RedisMock();
    const { fixture, request, dependencies } = await seedV2Fixture(redis);
    const writes = [
      vi.spyOn(redis, 'set'), vi.spyOn(redis, 'hset'), vi.spyOn(redis, 'rpush'),
      vi.spyOn(redis, 'lpush'), vi.spyOn(redis, 'del'), vi.spyOn(redis, 'sadd'),
      vi.spyOn(redis, 'srem'), vi.spyOn(redis, 'zadd'),
    ];
    const receipt = await getCashLedgerEvidenceV2(request, dependencies);
    const expected = readFileSync('plans/fixtures/hypaper_cash_f7_s2_success.json').subarray(0, -1);
    expect(Buffer.from(encodeCashLedgerEvidenceV2Receipt(receipt))).toEqual(Buffer.from(expected));
    expect(receipt.settled_usdc.ordinary_fees).toBe('-0.25');
    expect(receipt.source_inventory.positions.rows).toEqual([]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    expect(fixture.subject.replay_batch_id).toBe(receipt.subject.replay_batch_id);
  });

  it('verifies every exact zero-tolerance check in the expected manifest', async () => {
    const Decimal = DecimalModule.default ?? DecimalModule;
    const text = (value: string): string => new Decimal(value).toFixed();
    const redis = new RedisMock();
    const { request, dependencies } = await seedV2Fixture(redis);
    const receipt = await getCashLedgerEvidenceV2(request, dependencies);
    const expected = JSON.parse(readFileSync('plans/fixtures/hypaper_cash_f7_s2_expected.json', 'utf8')) as {
      checks: Array<{ id: string; expected: unknown; tolerance?: string }>;
      fixture: { bytes: number; sha256: string };
    };
    const payload = encodeCashLedgerEvidenceV2Receipt(receipt);
    expect(payload.byteLength).toBe(expected.fixture.bytes);
    expect(createHash('sha256').update(payload).digest('hex')).toBe(expected.fixture.sha256);

    const replay = receipt.source_inventory.replay.rows[0]!.source;
    const fills = receipt.source_inventory.ordinary_fills.rows;
    const funding = receipt.funding_events;
    const corrections = receipt.funding_corrections;
    const account = receipt.source_inventory.account.rows[0]!.source;
    const orders = receipt.source_inventory.orders.rows;
    const replayEvents = replay.events;
    const replayPayload = replay.replay;
    const cashTransitions = (starting: string, events: readonly { closedPnl: string; fee: string }[]): string[][] => {
      let balance = starting;
      return events.map((event) => {
        const before = balance;
        balance = text(new Decimal(balance).plus(event.closedPnl).minus(event.fee).toFixed());
        return [before, balance];
      });
    };
    const quantityTransitions = new Map<string, string[][]>();
    for (const fill of [...fills].reverse()) {
      const transitions = quantityTransitions.get(fill.source.coin) ?? [];
      transitions.push([fill.source.startPosition, text(new Decimal(fill.source.startPosition).plus(
        fill.source.side === 'B' ? fill.source.sz : `-${fill.source.sz}`,
      ).toFixed())]);
      quantityTransitions.set(fill.source.coin, transitions);
    }
    const rawFunding = receipt.source_inventory.funding_records.rows.map((row) => JSON.parse(row.source.raw_json) as Record<string, unknown>);
    const rawCorrections = receipt.source_inventory.correction_records.rows.map((row) => JSON.parse(row.source.raw_json) as Record<string, unknown>);
    const externalCashTransitions = [
      ...funding.map((event, index) => ({
        time: rawFunding[index]!.appliedAt as number,
        before: event.account_balance_before,
        after: event.account_balance_after,
      })),
      ...corrections.map((correction, index) => ({
        time: rawCorrections[index]!.appliedAt as number,
        before: correction.account_balance_before,
        after: correction.account_balance_after,
      })),
    ].sort((left, right) => left.time - right.time);
    let ordinaryBalance = replay.finalBalance;
    let externalIndex = 0;
    const ordinaryCashTransitions: string[][] = [];
    for (const fill of [...fills].reverse()) {
      while (externalIndex < externalCashTransitions.length
        && externalCashTransitions[externalIndex]!.time < fill.source.time) {
        const transition = externalCashTransitions[externalIndex]!;
        expect(ordinaryBalance).toBe(transition.before);
        ordinaryBalance = transition.after;
        externalIndex += 1;
      }
      const before = ordinaryBalance;
      ordinaryBalance = text(new Decimal(ordinaryBalance).plus(fill.source.closedPnl).minus(fill.source.fee).toFixed());
      ordinaryCashTransitions.push([before, ordinaryBalance]);
    }
    const timestampInventory = {
      'account.created_at_ms': [account.created_at_ms],
      'correction_records.raw_json.appliedAt': rawCorrections.map((row) => row.appliedAt),
      'correction_records.raw_json.fundingTime': rawCorrections.map((row) => row.fundingTime),
      'funding_records.raw_json.appliedAt': rawFunding.map((row) => row.appliedAt),
      'funding_records.raw_json.fundingTime': rawFunding.map((row) => row.fundingTime),
      'orders.created_at_ms': orders.map((row) => Number(row.source.created_at_ms)),
      'orders.updated_at_ms': orders.map((row) => Number(row.source.updated_at_ms)),
      'ordinary_fills.time': fills.map((row) => row.source.time),
      'replay.events.effectiveAt': replayPayload.events.map((row) => row.effectiveAt),
      'replay.priceEvidence.effectiveAt': replayPayload.priceEvidence.map((row) => row.effectiveAt),
      'replay.priceEvidence.requestAt': replayPayload.priceEvidence.map((row) => row.requestAt),
      'replay.priceEvidence.responseAt': replayPayload.priceEvidence.map((row) => row.responseAt),
      'replay.riskMarkEvidence.requestAt': replayPayload.riskMarkEvidence.map((row) => row.requestAt),
      'replay.riskMarkEvidence.responseAt': replayPayload.riskMarkEvidence.map((row) => row.responseAt),
      'replay.source.generatedAt': [replayPayload.source.generatedAt],
      'replay_result.events.effectiveAt': replayEvents.map((row) => row.effectiveAt),
      'replay_result.events.recordedAt': replayEvents.map((row) => row.recordedAt),
      'replay_result.events.replayedAt': replayEvents.map((row) => row.replayedAt),
      'replay_result.replayedAt': [replay.replayedAt],
    };
    const actual = new Map<string, unknown>([
      ['replay_realized_pnl', receipt.settled_usdc.replay_realized_pnl],
      ['replay_fees', receipt.settled_usdc.replay_fees],
      ['replay_final_balance', receipt.settled_usdc.replay_final_balance],
      ['ordinary_realized_pnl', receipt.settled_usdc.ordinary_realized_pnl],
      ['ordinary_fees', receipt.settled_usdc.ordinary_fees],
      ['original_funding_charges', funding.map((event) => event.funding_charge)],
      ['corrected_funding_charge', corrections.map((correction) => correction.corrected_funding_charge)[0]],
      ['correction_delta', corrections.map((correction) => correction.funding_charge_delta)[0]],
      ['effective_funding_charge', receipt.settled_usdc.effective_funding_charge],
      ['expected_current_balance', receipt.settled_usdc.expected_current_balance],
      ['residual', receipt.settled_usdc.residual],
      ['quantity_final_CL', quantityTransitions.get('xyz:CL')?.at(-1)?.[1]],
      ['quantity_final_NATGAS', quantityTransitions.get('xyz:NATGAS')?.at(-1)?.[1]],
      ['quantity_transitions_CL', quantityTransitions.get('xyz:CL')],
      ['quantity_transitions_NATGAS', quantityTransitions.get('xyz:NATGAS')],
      ['replay_cash_transitions', cashTransitions(replay.startingBalance, replayEvents)],
      ['ordinary_cash_transitions', ordinaryCashTransitions],
      ['funding_cash_transitions', funding.map((event) => [event.account_balance_before, event.account_balance_after])],
      ['correction_cash_transitions', corrections.map((correction) => [correction.account_balance_before, correction.account_balance_after])],
      ['funding_cumulative_transitions', funding.map((event) => [event.cum_funding_before, event.cum_funding_after])],
      ['correction_cumulative_transitions', corrections.map((correction) => [correction.cum_funding_before, correction.cum_funding_after])],
      ['coverage_watermark_ms', receipt.coverage.correction_finality_watermark_ms],
      ['latest_fully_covered_funding_time_ms', receipt.coverage.latest_fully_covered_funding_time_ms],
      ['source_timestamp_inventory', timestampInventory],
      ['observation_and_coverage_clock_inventory', {
        'coverage.correction_finality_watermark_ms': [receipt.coverage.correction_finality_watermark_ms],
        'coverage.end_ms': [receipt.coverage.end_ms],
        'coverage.latest_fully_covered_funding_time_ms': [receipt.coverage.latest_fully_covered_funding_time_ms],
        'coverage.observed_at_ms': [receipt.coverage.observed_at_ms],
        'coverage.start_ms': [receipt.coverage.start_ms],
      }],
      ['replay_batch_id', receipt.subject.replay_batch_id],
      ['replay_event_ids', replay.eventIds],
      ['ordinary_fill_ids', fills.map((row) => row.identity)],
      ['positions_empty', receipt.source_inventory.positions.rows.map((row) => row.source)],
      ['orders_terminal', orders.map((row) => row.source.status)],
      ['source_digest_replay', receipt.source_inventory.replay.rows.map((row) => row.source_digest)],
      ['source_digest_fills', fills.map((row) => row.source_digest)],
      ['source_digest_funding', receipt.source_inventory.funding_records.rows.map((row) => row.source_digest)],
      ['source_digest_corrections', receipt.source_inventory.correction_records.rows.map((row) => row.source_digest)],
      ['source_digest_account', receipt.source_inventory.account.rows.map((row) => row.source_digest)],
      ['source_digest_positions', receipt.source_inventory.positions.rows.map((row) => row.source_digest)],
      ['source_digest_orders', orders.map((row) => row.source_digest)],
      ['funding_member_digests', funding.map((event) => event.member_sha256)],
      ['correction_member_digests', corrections.map((correction) => correction.member_sha256)],
      ['manifest_replay', receipt.source_inventory.replay.manifest.manifest_digest],
      ['manifest_ordinary_fills', receipt.source_inventory.ordinary_fills.manifest.manifest_digest],
      ['manifest_funding_records', receipt.source_inventory.funding_records.manifest.manifest_digest],
      ['manifest_correction_records', receipt.source_inventory.correction_records.manifest.manifest_digest],
      ['manifest_account', receipt.source_inventory.account.manifest.manifest_digest],
      ['manifest_positions', receipt.source_inventory.positions.manifest.manifest_digest],
      ['manifest_orders', receipt.source_inventory.orders.manifest.manifest_digest],
      ['inventory_manifest', receipt.source_inventory.manifest.manifest_digest],
      ['inventory_digest', receipt.source_inventory.inventory_digest],
      ['stable_state_digest', receipt.flatness.clearinghouse_state_sha256],
      ['event_manifest', receipt.event_manifest.manifest_digest],
      ['correction_manifest', receipt.correction_manifest.manifest_digest],
      ['receipt_digest', receipt.receipt_digest],
    ]);
    expect(expected.checks).toHaveLength(52);
    for (const check of expected.checks) {
      expect(check.tolerance ?? '0').toBe('0');
      expect(actual.has(check.id)).toBe(true);
      expect(canonicalJson(actual.get(check.id))).toBe(canonicalJson(check.expected));
    }
  });

  it('continues ordinary reconstruction from a non-flat replay final position', async () => {
    const redis = new RedisMock();
    const seeded = await seedV2Fixture(redis);
    const replayKey = KEYS.HISTORICAL_REPLAY_BATCH(seeded.user, seeded.request.expectedReplayBatchId as string);
    const replay = JSON.parse((await redis.get(replayKey))!) as Record<string, any>;
    replay.events = [replay.events[0]];
    replay.eventCount = 1;
    replay.eventIds = [replay.eventIds[0]];
    replay.replay.events = [replay.replay.events[0]];
    replay.replay.priceEvidence = [replay.replay.priceEvidence[0]];
    replay.finalBalance = '9999.5';
    replay.positions = [{ asset: 110029, coin: 'xyz:CL', szi: '1', entryPx: '100' }];
    replay.marginPosture = [{
      ...replay.marginPosture[0], finalSzi: '1', finalEntryPx: '100',
      positionNotional: '101', unrealizedPnl: '1', marginRequired: '10.1',
    }];
    replay.riskSummary = {
      cashBalance: '9999.5', unrealizedPnl: '1', accountValue: '10000.5',
      totalMargin: '10.1', marginAvailable: '9990.4',
    };
    await redis.set(replayKey, JSON.stringify(replay));
    seeded.dependencies.historicalReplay.mockResolvedValue(replay);

    const storedFills = await redis.lrange(KEYS.USER_FILLS(seeded.user), 0, -1);
    const clClose = JSON.parse(storedFills.find((raw) => JSON.parse(raw).tid === 13)!);
    clClose.startPosition = '1';
    clClose.sz = '1';
    clClose.closedPnl = '49.5';
    clClose.fee = '-0.03125';
    const natGasClose = storedFills.find((raw) => JSON.parse(raw).tid === 14)!;
    const natGasOpen = storedFills.find((raw) => JSON.parse(raw).tid === 12)!;
    await redis.del(KEYS.USER_FILLS(seeded.user));
    for (const raw of [natGasOpen, natGasClose, JSON.stringify(clClose)]) {
      await redis.lpush(KEYS.USER_FILLS(seeded.user), raw);
    }

    const currentBalance = '10047.15625';
    await redis.hset(KEYS.USER_ACCOUNT(seeded.user), 'balance', currentBalance);
    seeded.dependencies.clearinghouseState.mockResolvedValue({
      assetPositions: [],
      crossMarginSummary: { accountValue: currentBalance },
      marginSummary: { accountValue: currentBalance },
      time: 2,
    });
    const receipt = await getCashLedgerEvidenceV2(seeded.request, seeded.dependencies);
    expect(receipt.source_inventory.replay.rows[0]!.source.positions).toEqual([
      { asset: 110029, coin: 'xyz:CL', szi: '1', entryPx: '100' },
    ]);
    expect(receipt.settled_usdc.ordinary_realized_pnl).toBe('48.5');
    expect(receipt.settled_usdc.ordinary_fees).toBe('-0.15625');
    expect(receipt.settled_usdc.current_balance).toBe(currentBalance);
    expect(receipt.source_inventory.positions.rows).toEqual([]);
  });

  it('rejects the hostile fee mutation as an unreconstructible source', async () => {
    const bytes = readFileSync('plans/fixtures/hypaper_cash_f7_s2_success.json');
    const receipt = JSON.parse(bytes.toString('utf8')) as any;
    receipt.source_inventory.ordinary_fills.rows[0].source.fee = '-0.0624';
    expect(() => decodeCashLedgerEvidenceV2Receipt(canonicalJson(receipt))).toThrow();

    const redis = new RedisMock();
    const seeded = await seedV2Fixture(redis);
    const fillKey = KEYS.USER_FILLS(seeded.user);
    const fills = await redis.lrange(fillKey, 0, -1);
    const first = JSON.parse(fills[0]!);
    first.fee = '-0.0624';
    await redis.del(fillKey);
    for (const raw of [...fills].reverse()) {
      await redis.lpush(fillKey, raw === fills[0] ? JSON.stringify(first) : raw);
    }
    await expect(getCashLedgerEvidenceV2(seeded.request, seeded.dependencies)).rejects.toMatchObject({ code: 'source_preimage' });
  });

  it('returns a typed redacted source-preimage error for member and manifest tampering', () => {
    const bytes = readFileSync('plans/fixtures/hypaper_cash_f7_s2_success.json');
    const receipt = JSON.parse(bytes.toString('utf8')) as any;
    receipt.source_inventory.ordinary_fills.rows[0].source_digest = '0'.repeat(64);
    let memberError: unknown;
    try { decodeCashLedgerEvidenceV2Receipt(canonicalJson(receipt)); } catch (error) { memberError = error; }
    expect(memberError).toBeInstanceOf(CashLedgerEvidenceV2CodecError);
    expect((memberError as CashLedgerEvidenceV2CodecError).code).toBe('source_preimage');

    const manifest = JSON.parse(bytes.toString('utf8')) as any;
    manifest.source_inventory.orders.manifest.manifest_digest = '0'.repeat(64);
    let manifestError: unknown;
    try { decodeCashLedgerEvidenceV2Receipt(canonicalJson(manifest)); } catch (error) { manifestError = error; }
    expect(manifestError).toBeInstanceOf(CashLedgerEvidenceV2CodecError);
    expect((manifestError as CashLedgerEvidenceV2CodecError).code).toBe('source_preimage');
  });

  it('refuses owner, index, active-membership, optional-field, chronology, finality, byte-cap, and flatness drift', async () => {
    const expectCode = async (
      mutate: (seeded: Awaited<ReturnType<typeof seedV2Fixture>> & { redis: RedisMock }) => Promise<void>,
      code: string,
    ): Promise<void> => {
      const redis = new RedisMock();
      const seeded = await seedV2Fixture(redis);
      await mutate({ ...seeded, redis });
      await expect(getCashLedgerEvidenceV2(seeded.request, seeded.dependencies)).rejects.toMatchObject({ code });
    };

    await expectCode(async ({ redis }) => {
      await redis.hset(KEYS.ORDER(21), 'userId', `0x${'f'.repeat(40)}`);
    }, 'owner');
    await expectCode(async ({ redis, user }) => {
      await redis.del(KEYS.USER_ORDERS(user));
    }, 'membership');
    await expectCode(async ({ redis }) => {
      await redis.sadd(KEYS.ORDERS_OPEN, '21');
    }, 'membership');
    await expectCode(async ({ redis }) => {
      await redis.hset(KEYS.ORDER(21), 'isMarket', 'not-a-boolean');
    }, 'identity');
    await expectCode(async ({ redis }) => {
      await redis.hset(KEYS.ORDER(21), 'updatedAt', '2899999');
    }, 'chronology');
    await expectCode(async ({ dependencies }) => {
      dependencies.now.mockReturnValue(3_700_000);
    }, 'finality');
    await expectCode(async ({ dependencies }) => {
      dependencies.maxBytes = 100;
    }, 'byte_cap');
    await expectCode(async ({ dependencies }) => {
      dependencies.clearinghouseState.mockResolvedValue({
        assetPositions: [{ type: 'oneWay', position: { coin: 'xyz:CL', szi: '1', entryPx: '150', unrealizedPnl: '0' } }],
        crossMarginSummary: { accountValue: '9999.235' },
        marginSummary: { accountValue: '9999.235' },
        time: 2,
      });
    }, 'flatness');
    await expectCode(async ({ redis, user }) => {
      await redis.sadd(KEYS.USER_POSITIONS(user), '110029');
      await redis.hset(KEYS.USER_POS(user, 110029),
        'userId', user, 'asset', '110029', 'coin', 'xyz:CL', 'szi', '0',
        'entryPx', '150', 'cumFunding', '0', 'cumFundingSinceOpen', '0', 'cumFundingSinceChange', '0');
    }, 'flatness');
  });

  it('rejects noncanonical and duplicate V2 request bytes before schema use', () => {
    const fixture = readV2Fixture();
    const requestValue = {
      type: 'getCashLedgerEvidenceV2', user: `0x${'1'.repeat(40)}`, dex: fixture.subject.dex,
      coins: fixture.subject.coins, coverageStartMs: fixture.coverage.start_ms,
      coverageEndMs: fixture.coverage.end_ms, finalFlatRequired: true,
      scope: fixture.subject.scope, expectedReplayBatchId: fixture.subject.replay_batch_id,
    };
    const request = canonicalJson(requestValue);
    expect(decodeCashLedgerEvidenceV2Request(request)).toMatchObject({ type: 'getCashLedgerEvidenceV2' });
    expect(() => decodeCashLedgerEvidenceV2Request(` ${request}`)).toThrow();
    expect(() => decodeCashLedgerEvidenceV2Request(request.replace('"dex":"xyz"', '"dex":"xyz","dex":"xyz"'))).toThrow();
    expect(() => decodeCashLedgerEvidenceV2Request(request.replace('"coverageStartMs":3600000', '"coverageStartMs":3600000e0'))).toThrow();
  });

  it('fails closed before per-record fanout when the row cap is exceeded', async () => {
    const redis = new RedisMock();
    const seeded = await seedV2Fixture(redis);
    seeded.dependencies.providerIdentity.max_evidence_rows = 1;
    await expect(getCashLedgerEvidenceV2(seeded.request, seeded.dependencies)).rejects.toMatchObject({ code: 'row_cap' });
    expect(seeded.dependencies.historicalReplay).not.toHaveBeenCalled();
  });

  it('refuses a torn second inventory read', async () => {
    const redis = new RedisMock();
    const seeded = await seedV2Fixture(redis);
    let stateRead = 0;
    seeded.dependencies.clearinghouseState.mockImplementation(async () => ({
      assetPositions: [],
      crossMarginSummary: { accountValue: stateRead === 0 ? '9999.235' : '9999.234' },
      marginSummary: { accountValue: stateRead === 0 ? '9999.235' : '9999.234' },
      time: stateRead++ === 0 ? 1 : 2,
    }));
    await expect(getCashLedgerEvidenceV2(seeded.request, seeded.dependencies)).rejects.toMatchObject({ code: 'stable_read' });
  });

  it('preserves exact long-precision signed rebate arithmetic', async () => {
    const redis = new RedisMock();
    const seeded = await seedV2Fixture(redis);
    const fills = await redis.lrange(KEYS.USER_FILLS(seeded.user), 0, -1);
    const first = JSON.parse(fills[0]!);
    first.fee = '-0.00000000000000000000000000000000000001';
    await redis.del(KEYS.USER_FILLS(seeded.user));
    for (const raw of [...fills].reverse()) {
      const value = raw === fills[0] ? JSON.stringify(first) : raw;
      await redis.lpush(KEYS.USER_FILLS(seeded.user), value);
    }
    await expect(getCashLedgerEvidenceV2(seeded.request, seeded.dependencies)).rejects.toMatchObject({ code: 'source_preimage' });
  });

  it('computes the long-precision funding product exactly without ambient rounding', () => {
    const Decimal = (DecimalModule.default ?? DecimalModule).clone({ precision: 128 });
    const product = new Decimal('123456789012345678901234567890123456789')
      .times('0.00000000000000000000000000000000000001')
      .times('-0.1')
      .toFixed();
    expect(product).toBe('-0.123456789012345678901234567890123456789');
  });

  it('re-derives funding and correction identities deterministically', () => {
    const asset = 110029;
    const eventId = pnlFundingEventId(USER, asset, FUNDING_TIME);
    const expectedEventId = `hpfe${createHash('sha256').update(`${USER}\0${asset}\0${FUNDING_TIME}`).digest('hex')}`;
    expect(eventId).toBe(expectedEventId);
    const correctionId = pnlFundingCorrectionId(USER, asset, FUNDING_TIME, eventId);
    const expectedCorrectionId = `hpfc${createHash('sha256').update(`${USER}\0${asset}\0${FUNDING_TIME}\0${eventId}`).digest('hex')}`;
    expect(correctionId).toBe(expectedCorrectionId);
    expect(pnlFundingEventId(USER, asset, FUNDING_TIME)).toBe(eventId);
    expect(pnlFundingCorrectionId(USER, asset, FUNDING_TIME, eventId)).toBe(correctionId);
  });
});
