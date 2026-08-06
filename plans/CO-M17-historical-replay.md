# CO-M17: Paper-only historical replay import

- status: ready
- numeric: true
- base: `93882077ad50fdcea944bf99f87f55886d48b8e9`

## Frozen contract

- Add an opt-in, default-off `importHistoricalReplay` / `getHistoricalReplay`
  seam to this paper service. It accepts one programme-level canonical batch,
  never a real venue request.
- The first import requires the declared account identity and starting balance,
  empty Redis positions/leverage/orders/cloids/fills/funding/replay/active-user
  state, no orphan order hashes, and no ordinary PostgreSQL orders or fills.
  Redis rechecks all mutable premises atomically immediately before mutation.
- Events replay in global `(effectiveAt, phase, sequence)` chronology: scheduled
  entry before due scheduled reductions. The server derives fills with the
  existing L2-VWAP/aggressive-limit/mid-fallback model, then derives fees,
  realized PnL, balance, positions, replay-time risk, and margin posture.
- Price captures must be causally within 0..60 seconds of `effectiveAt`.
  Replay-time risk marks must be captured within 60 seconds of replay. Missing,
  early, late, reused, mismatched, malformed, or unbound evidence refuses the
  whole batch.
- Every source/evidence/model/risk/event/batch identity is canonical and
  digest-bound. Synthetic event/fill IDs are deterministic and carry explicit
  paper/synthetic/historical-replay tags, historical `effectiveAt`, and actual
  server `replayedAt`/`recordedAt`. No ordinary venue ID is fabricated.
- The import atomically writes final paper balance, positions, max-leverage
  selection, isolated margin where requested, immutable replay result/events,
  and the batch index. It never writes ordinary order/fill/funding evidence or
  advances ordinary sequence IDs.
- Identical retries and status reads strictly revalidate stored schema, IDs,
  digests, derived events, positions, risk, margin, and timestamps. A different
  batch, malformed response envelope, corrupt record, or changed derivation
  fails closed.
- CL/BRENT-style cross assets select venue maximum leverage. NG/COPPER-style
  isolated assets select venue maximum leverage and carry explicit isolated
  margin for effective leverage 3. Asset metadata and separately labelled
  replay-time risk marks are rechecked before mutation; negative cash,
  non-positive account value, or margin above account value refuses.

## Out of scope

- Real-venue submission, signing, deployment, environment mutation, direct
  Redis/PostgreSQL repair, reset behavior, funding backfill, current-price
  substitution, fabricated venue IDs, and changes to ordinary order/fill
  schemas or matching behavior.

## Acceptance

- Build and the full test suite pass, including schema/digest/chronology,
  L2-fill, fee/PnL/balance, margin, first-run, race, AOF-boundary, idempotency,
  stored-tamper, disabled-route, and ordinary-path regression tests.
- An independent external review approves the frozen product patch.
- A fresh independent numeric verifier reproduces canonical IDs, fill math,
  fees, PnL, balances, positions, and margin results.

## Numeric checks

- `chronological_replay`: independently replay entry then reductions across
  multiple assets and compare exact event order, fill strings, fees, PnL,
  balance, and final positions.
- `fill_model`: independently walk buy/sell L2 levels, remainder behavior,
  aggressive-limit clamp, and explicit-empty-side mid fallback.
- `risk_and_margin`: independently mark final positions, derive unrealized PnL,
  account value, cross/isolated margin, and feasibility boundaries.

## Review references

- `src/utils/slippage.ts`
- `src/engine/order.ts`
- `src/engine/margin.ts`
- `src/engine/position.ts`
- `src/api/middleware/auth.ts`
- `src/store/schema.ts`

## Allowed paths

- `src/types/historical-replay.ts`
- `src/engine/historical-replay.ts`
- `src/api/routes/hypaper.ts`
- `src/config.ts`
- `src/store/keys.ts`
- `src/store/pg-queries.ts`
- `src/__tests__/historical-replay.test.ts`
- `src/__tests__/route-validation.test.ts`
