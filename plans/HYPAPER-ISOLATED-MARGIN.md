# Plan: HyPaper updateIsolatedMargin — add or remove margin on an isolated paper position

> Source of truth for milestone state.

## Next

Implement, cross-vendor review, merge into the hypaper branch the operator deploys from; the operator (revt session)
deploys to the Mac and Tokyo HyPaper in an agreed window (never during a held Energy Roll pair, never 15:30–15:52 ET or
:15–:30, template refresh per README-hypaper-deploy.md).

## Milestones

### HYPAPER-ISOLATED-MARGIN: the `updateIsolatedMargin` exchange action
- status: ready (2026-10-14)
- numeric: true (margin arithmetic decides refusals; hand-checkable expectations)
- requested by: tholos StatArb_EQ (registration §8a daily margin maintenance moves isolated margin toward
  |notional|/2) and, later, Energy Roll's isolated NATGAS leg. The paper path must equal testnet/mainnet (§11.5), so
  HyPaper must accept the same action. Keep it generic (any user, any asset, main or builder dex).
- context: HyPaper already models isolated margin (`user:<id>:lev:<asset>` {leverage, isCross, isolatedMargin} and the
  isolated position; `src/engine/margin.ts`, including `topUpIsolatedOnlyMargin`). There is no exchange action that moves
  USDC between the free balance and an existing isolated position.
- decision: implement Hyperliquid's `updateIsolatedMargin` L1 action on `/exchange`:
  `{"type":"updateIsolatedMargin","asset":<int>,"isBuy":<bool>,"ntli":<int>}`; `ntli` = USD amount × 1e6 as a signed
  integer (positive adds margin from the free balance, negative removes margin back to it). Same envelope, user
  resolution and auth handling as the other paper exchange actions; the response on success is
  `{"status":"ok","response":{"type":"default"}}`, on refusal `{"status":"err","response":"<message>"}` (HL's shape).
  - Refusals (nothing changes in Redis): unknown asset; no open position on the asset; the position is CROSS (isolated
    margin cannot be moved on a cross position); `ntli` = 0; `ntli` not a safe integer; `isBuy` not a boolean (NOT checked against
    the position side — amended 2026-10-14: Hyperliquid's Python SDK always sends `isBuy: true`, so a side check would
    refuse calls Hyperliquid accepts); an add larger than the free (withdrawable) balance; a removal that would leave the
    position's isolated margin below the transfer requirement max(initial margin at the stored leverage =
    |szi| × mark / leverage, 10% × |szi| × mark) — Hyperliquid's documented transfer margin requirement; the
    implementer confirms the rule against the Hyperliquid docs and records the source in the plan result; no finite
    positive mark price.
  - Effects on success, atomically (one Redis transaction or a Lua script, as the other margin writes): the position's
    isolated margin changes by ntli/1e6 exactly (decimal string arithmetic, no float), the free balance by the opposite;
    `clearinghouseState` (marginUsed, liquidationPx, leverage.rawUsd) and `activeAssetData` (leverage.rawUsd) reflect the
    new value on the next read; the liquidation engine uses the new margin; a ledger/event entry is recorded the same way
    other balance-moving paper actions record theirs (if a cash ledger applies, the move is internal: account value
    unchanged).
- acceptance:
  1. Add 5 USD (ntli 5000000) to an isolated 2x position: isolated margin +5, free balance −5, account value unchanged,
     clearinghouseState marginUsed and liquidationPx move as hand-computed in the test.
  2. Remove within the requirement succeeds with the mirror effects; a removal that would cross the requirement refuses
     with no change (boundary tested at exactly the requirement and one micro-USD beyond).
  3. Each refusal case above refuses with HL's error shape and no Redis change.
  4. Concurrency: two simultaneous adds whose sum exceeds the free balance — exactly one succeeds (atomicity).
  5. Existing tests pass; `npm run build` and `npm run test:run` pass.
- allowed_paths:
  - `src/engine/margin.ts`
  - `src/engine/**` (only where the exchange action is dispatched)
  - `src/api/**` (only the exchange action routing/validation)
  - `src/types/hl.ts`
  - `src/__tests__/isolated-margin*.test.ts`
  - `plans/HYPAPER-ISOLATED-MARGIN.md` (orchestrator)
