import { describe, expect, it } from 'vitest';
import { normalizeBuilderDexOnlyIsolated } from '../api/routes/info.js';

describe('builder-dex info proxy normalization', () => {
  it('makes omitted cross-margin flags explicit without changing isolated flags', () => {
    const result = normalizeBuilderDexOnlyIsolated(
      { type: 'metaAndAssetCtxs', dex: 'xyz' },
      [
        {
          universe: [
            { name: 'xyz:CL', szDecimals: 3, maxLeverage: 20 },
            { name: 'xyz:NATGAS', szDecimals: 1, maxLeverage: 10, onlyIsolated: true },
          ],
        },
        [{ markPx: '70' }, { markPx: '3' }],
      ],
    );

    expect(result).toEqual([
      {
        universe: [
          { name: 'xyz:CL', szDecimals: 3, maxLeverage: 20, onlyIsolated: false },
          { name: 'xyz:NATGAS', szDecimals: 1, maxLeverage: 10, onlyIsolated: true },
        ],
      },
      [{ markPx: '70' }, { markPx: '3' }],
    ]);
  });

  it('normalizes builder-dex meta responses too', () => {
    expect(normalizeBuilderDexOnlyIsolated(
      { type: 'meta', dex: 'xyz' },
      { universe: [{ name: 'xyz:BRENTOIL', szDecimals: 2, maxLeverage: 20 }] },
    )).toEqual({
      universe: [
        { name: 'xyz:BRENTOIL', szDecimals: 2, maxLeverage: 20, onlyIsolated: false },
      ],
    });
  });

  it('does not normalize main-dex or malformed present values', () => {
    const mainDex = { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }] };
    expect(normalizeBuilderDexOnlyIsolated({ type: 'meta' }, mainDex)).toBe(mainDex);

    const malformed = {
      universe: [{
        name: 'xyz:CL',
        szDecimals: 3,
        maxLeverage: 20,
        onlyIsolated: 'false',
      }],
    };
    expect(normalizeBuilderDexOnlyIsolated(
      { type: 'meta', dex: 'xyz' },
      malformed,
    )).toEqual(malformed);
  });
});
