import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseFundingCorrectionManifest,
  summarizeFundingCorrectionManifest,
} from '../engine/funding-correction.js';

const USER = `0x${'1'.repeat(40)}`;

function manifest() {
  return {
    schema: 'hypaper_funding_correction_manifest_v1',
    paper: true,
    user: USER,
    createdAt: 7_200_000,
    corrections: [{
      asset: 1,
      coin: 'xyz:NATGAS',
      fundingTime: 3_600_000,
      expectedSzi: '10',
      correctedOraclePx: '2.5',
      correctedFundingRate: '0.0001',
      originalEventSha256: 'a'.repeat(64),
      oracleSourceSha256: 'b'.repeat(64),
      fundingSourceSha256: 'c'.repeat(64),
    }],
  };
}

describe('funding correction manifest', () => {
  it('binds exact bytes and summarizes corrected charges', () => {
    const bytes = Buffer.from(JSON.stringify(manifest()));
    const parsed = parseFundingCorrectionManifest(
      bytes, createHash('sha256').update(bytes).digest('hex'), USER,
    );
    expect(summarizeFundingCorrectionManifest(parsed)).toEqual({
      correctionCount: 1,
      correctedFundingCharge: '0.0025',
    });
  });

  it('refuses byte drift and non-hour boundaries', () => {
    const bytes = Buffer.from(JSON.stringify(manifest()));
    expect(() => parseFundingCorrectionManifest(bytes, '0'.repeat(64), USER))
      .toThrow(/SHA-256 conflicts/);
    const malformed = manifest();
    malformed.corrections[0].fundingTime = 1;
    const malformedBytes = Buffer.from(JSON.stringify(malformed));
    expect(() => parseFundingCorrectionManifest(
      malformedBytes,
      createHash('sha256').update(malformedBytes).digest('hex'),
      USER,
    )).toThrow(/exact UTC hour/);
  });
});
