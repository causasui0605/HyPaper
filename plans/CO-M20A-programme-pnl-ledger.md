# CO-M20A: Immutable funding ledger and programme PnL snapshot

- status: ready
- numeric: true
- base: `e135c4b796b8a645c1abe6b1a599029e63d3124b`
- base tree: `ec12ac9df57977a83b8789cf3aaf25581f298712`

## Frozen contract

- Add a default-off `getPnlSnapshot` HyPaper seam for paper programme
  accounting. The status read is strict and read-only: it never calls account
  creation and never writes Redis, PostgreSQL, orders, fills, positions,
  balances, replays, or funding state.
- A present pristine account with no replay, Redis/PG executions, funding,
  positions, or orders reports exact zero. A missing account refuses rather
  than being silently created. Any activity without an immutable historical
  replay starting-balance baseline refuses.
- The existing validated historical replay record supplies starting balance,
  replay closed PnL, and replay fees. Immediate ordinary Redis fills supply
  later closed PnL and fees. A new separately typed immutable ledger supplies
  later funding charges. Current clearinghouse state plus its exact current
  marks supply open-position unrealized PnL.
- For each requested coin, cumulative PnL is `replay closedPnl + ordinary
  closedPnl - replay fees - ordinary fees - fundingCharge + current
  unrealizedPnl`. A flat post-trading asset retains all realized net PnL.
- Total PnL is the exact sum of requested assets and must equal current account
  value minus immutable programme starting balance. Replay final cash, current
  cash, current unrealized PnL, ordinary fill effects, and funding effects also
  reconcile independently. No source is inferred, clamped, or backfilled.
- The funding worker derives Decimal.js precision-30 charge and post-state,
  then one Redis Lua boundary rechecks exact account/position identity and
  values before updating balance/cumulative funding and appending the event.
  Event identity is deterministic per normalized account, asset, and funding
  bucket. Same-bucket retry validates/adopts the stored event without a second
  charge; later buckets append. Reset does not delete this evidence.
- Stored funding schema, deterministic ID, list/key parity, chronology, model
  inputs, account transition, and all cumulative transitions are revalidated on
  every snapshot. Funding and ordinary fills predating replay refuse.
- The query accepts an explicit non-empty unique coin list, rejects held or
  evidenced coins outside it and inconsistent replay asset identities, never
  includes the account identity in its response, and double-reads all relevant
  mutable sources to refuse a torn snapshot.

## Out of scope

- Slack delivery, two-hour scheduling/deduplication, supervisor installation,
  monitor threshold compatibility, CO-M21 flat/subset selection, real venue
  behavior, funding backfill/migration, direct Redis/PostgreSQL repair, account
  reset semantics, deployment, environment mutation, cron, runtime API calls,
  paper orders, push, and webhook/account values.

## Acceptance

- Build and the full HyPaper test suite pass, including long/short funding,
  negative fractional charges, atomic refusal, same-bucket recovery, later
  buckets, immutable retention, disabled/read-only routing, pristine zero,
  open and flat programme PnL, four-asset attribution, exact reconciliation,
  malformed/orphan/duplicate evidence, pre-replay evidence, unknown positions,
  mark mismatch, and torn-read refusal.
- A fresh dedicated Fable Path A review approves the exact frozen product
  patch with no blocking findings.
- A fresh independent numeric verifier reproduces Decimal.js precision-30
  funding transitions and four-asset open/flat PnL reconciliations without
  importing production code or test expected values.

## Numeric checks

- `funding_transition`: independently derive long/short charges, exact account
  and cumulative field transitions, deterministic bucket IDs, retry no-op, and
  next-bucket append.
- `open_four_asset_pnl`: independently aggregate replay/fills/fees/funding/open
  unrealized PnL per coin and reconcile total to account value minus baseline.
- `flat_cumulative_pnl`: independently close the programme book, retain all
  realized net PnL, and reconcile exact flat cash/account value.
- `refusal_vectors`: independently perturb charge input, balance transition,
  asset identity, ledger membership, current mark, cash, and account value and
  confirm that no inconsistent snapshot is accepted.

## Review references

- `REVIEW_POLICY.md`
- `src/engine/historical-replay.ts`
- `src/engine/position.ts`
- `src/worker/order-matcher.ts`
- `src/utils/math.ts`
- `src/store/pg-queries.ts`

## Allowed product paths

- `docker-compose.yml`
- `src/types/pnl.ts`
- `src/engine/pnl.ts`
- `src/worker/funding-worker.ts`
- `src/api/routes/hypaper.ts`
- `src/config.ts`
- `src/store/keys.ts`
- `src/__tests__/pnl.test.ts`
- `src/__tests__/funding.test.ts`
- `src/__tests__/route-validation.test.ts`
- `src/__tests__/helpers/redis-mock.ts`
