import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { parseFundingBackfill, summarizeFundingBackfill } from '../engine/funding-backfill.js';

const USER = '0x00000000000000000000000000000000c0000011';

function fixture(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schema: 'hypaper_funding_backfill_v1',
    paper: true,
    user: USER,
    createdAt: 7_200_001,
    events: [
      {
        asset: 1, coin: 'xyz:NATGAS', fundingTime: 3_600_000, expectedSzi: '10',
        oraclePx: '2.5', fundingRate: '0.001',
        oracleSourceSha256: 'a'.repeat(64), fundingSourceSha256: 'b'.repeat(64),
      },
      {
        asset: 2, coin: 'xyz:BRENTOIL', fundingTime: 3_600_000, expectedSzi: '-2',
        oraclePx: '80', fundingRate: '-0.002',
        oracleSourceSha256: 'c'.repeat(64), fundingSourceSha256: 'd'.repeat(64),
      },
    ],
    ...overrides,
  }));
}

describe('funding backfill manifest', () => {
  it('binds exact bytes, account, chronology, and exact Decimal totals', () => {
    const bytes = fixture();
    const sha = createHash('sha256').update(bytes).digest('hex');
    const parsed = parseFundingBackfill(bytes, sha, USER.toUpperCase().replace('0X', '0x'));
    expect(summarizeFundingBackfill(parsed)).toEqual({
      eventCount: 2, fundingCharge: '0.345', fundingCashflow: '-0.345',
    });
  });

  it('refuses byte drift, account drift, duplicate order, and non-hour times', () => {
    const bytes = fixture();
    const sha = createHash('sha256').update(bytes).digest('hex');
    expect(() => parseFundingBackfill(bytes, '0'.repeat(64), USER)).toThrow(/SHA-256 conflicts/);
    expect(() => parseFundingBackfill(bytes, sha, USER.replace('11', '12'))).toThrow(/user conflicts/);

    const unordered = fixture({
      events: [
        {
          asset: 2, coin: 'B', fundingTime: 3_600_000, expectedSzi: '1', oraclePx: '1',
          fundingRate: '0.1', oracleSourceSha256: 'a'.repeat(64), fundingSourceSha256: 'b'.repeat(64),
        },
        {
          asset: 1, coin: 'A', fundingTime: 3_600_000, expectedSzi: '1', oraclePx: '1',
          fundingRate: '0.1', oracleSourceSha256: 'a'.repeat(64), fundingSourceSha256: 'b'.repeat(64),
        },
      ],
    });
    expect(() => parseFundingBackfill(
      unordered, createHash('sha256').update(unordered).digest('hex'), USER,
    )).toThrow(/chronological order/);

    const offHour = fixture({
      events: [{
        asset: 1, coin: 'A', fundingTime: 1, expectedSzi: '1', oraclePx: '1', fundingRate: '0.1',
        oracleSourceSha256: 'a'.repeat(64), fundingSourceSha256: 'b'.repeat(64),
      }],
    });
    expect(() => parseFundingBackfill(
      offHour, createHash('sha256').update(offHour).digest('hex'), USER,
    )).toThrow(/exact UTC hour/);
  });
});
