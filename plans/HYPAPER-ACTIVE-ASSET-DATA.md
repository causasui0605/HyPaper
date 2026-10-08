# Plan: HyPaper activeAssetData — answer the paper leverage setting

> Source of truth for milestone state.

## Next

Close out, ff-merge into hypaper main, hand the merged commit to the operator who builds and deploys the image
(deploy window 2026-10-08 ~21:30Z → 2026-10-09 18:30Z; never while a paper pair is held).

## Milestones

### HYPAPER-ACTIVE-ASSET-DATA: `activeAssetData` reports the paper leverage setting
- status: implemented
- result: 2026-10-08 — `activeAssetData.leverage` is answered from the stored paper setting; other fields and the no-setting path unchanged; malformed/undecodable upstream or an invalid stored value → 502. Cross-vendor Codex review approve 8/8 in cycle 2 (cycle 1: undecodable upstream and empty stored value). Gate: build PASS, 21 files / 320 tests.
- numeric: false
- context: `/info` proxies unknown request types to Hyperliquid, so `activeAssetData` returns the PAPER wallet's MAINNET
  default leverage (e.g. `{"type":"isolated","value":10,"rawUsd":"0.0"}`), never the setting a paper client stored with
  `updateLeverage` (Redis `user:<id>:lev:<asset>` = {leverage, isCross, isolatedMargin}, written by
  `src/engine/order.ts updateLeverage`). `clearinghouseState` shows leverage only for open positions, so a paper client
  cannot read back its leverage before its first order. A client whose rule is "set isolated leverage, read it back, refuse
  if unconfirmed" (the tholos StatArb_EQ book) can therefore never trade on HyPaper, and a client could falsely confirm when
  the mainnet default happens to equal its target.
- decision: answer the `leverage` field locally when HyPaper holds a stored setting; keep every other field and every other
  case exactly as today.
  - `/info` `{"type":"activeAssetData","user":U,"coin":C}`: resolve C to its wire asset index (main dex: position in the
    stored main `meta` universe; builder dex `dex:NAME`: the entry of `market:assetmap` whose `coin` equals C — exactly one,
    else unresolved). If the coin resolves AND `user:<lower(U)>:lev:<asset>` has a `leverage` field, fetch the upstream
    response as today (same proxy cache), require its shape (an object with string `user`, string `coin` equal to C, object
    `leverage`, two-element arrays `maxTradeSzs` and `availableToTrade`, string `markPx`; anything else → HTTP 502 with an
    error, never a fabricated body), and return it with `leverage` replaced by the stored setting: cross →
    `{"type":"cross","value":N}`; isolated → `{"type":"isolated","value":N,"rawUsd":R}` with N the stored integer leverage
    and R the stored `isolatedMargin` decimal string (`"0"` when absent). Fields other than `leverage` stay the upstream
    values (they describe the mainnet account; documented as such).
  - No stored setting, an unresolved coin, or a missing `user`/`coin` → today's behaviour unchanged (proxy upstream; a
    missing field is passed through as today).
  - No write path changes; `updateLeverage` and `topUpIsolatedOnlyMargin` are untouched.
- acceptance:
  - [x] A stored isolated setting (leverage 2, isolatedMargin "0") on a builder-dex coin is returned as
    `{"type":"isolated","value":2,"rawUsd":"0"}` with every other field equal to the upstream fixture (a captured real
    Hyperliquid `activeAssetData` response, committed as a test fixture).
  - [x] A stored cross setting on a main-dex coin returns `{"type":"cross","value":N}` (no `rawUsd`).
  - [x] A stored isolated setting with a non-zero `isolatedMargin` returns it verbatim as `rawUsd`.
  - [x] No stored setting, an unknown coin, and a coin present twice in `market:assetmap` each return the upstream body
    unchanged (today's behaviour).
  - [x] A stored setting with an upstream body of the wrong shape returns 502 and no body is fabricated.
  - [x] The user address is matched case-insensitively (stored key lower-case, request mixed case).
  - [x] README documents that `activeAssetData.leverage` reflects the paper setting when one is stored.
  - [x] `npm run build` and `npm run test:run` pass.
- allowed_paths:
  - src/api/routes/info.ts
  - src/engine/asset.ts
  - src/__tests__/info-active-asset-data.test.ts
  - src/__tests__/fixtures/active-asset-data-*.json
  - README.md
- review_references:
  - REVIEW_POLICY.md
- review_mode: standard
