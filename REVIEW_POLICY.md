# Review policy

This file contains repository facts and invariants that a code reviewer may
use. Review orchestration, verdicts, run archives, and provisional findings do
not belong here.

## System boundary

- HyPaper is a paper-trading service. It does not sign or submit orders to a
  real venue. A feature that imports synthetic scenario state must remain
  default-off and must not create real-venue identities or execution evidence.
- Redis is the runtime book and account-state source. PostgreSQL contains the
  existing ordinary user, order, and fill mirror. Historical replay may inspect
  ordinary PostgreSQL execution presence, but it must not insert synthetic
  rows into the ordinary order or fill tables.
- Existing public API behavior remains unchanged unless an explicitly enabled,
  separately typed endpoint is selected.

## Accounting and price conventions

- Money, price, fee, and quantity inputs cross API and storage boundaries as
  canonical decimal strings. Binary floats, non-finite values, implicit unit
  conversions, and hidden defaults are not acceptable on those boundaries.
- Historical execution prices use the existing paper fill assumption: walk the
  supplied correct L2 side, apply the existing remaining-depth behavior and
  aggressive-limit clamp, and use the supplied mid only when that side is
  explicitly empty. Current prices, marks, or oracles never replace historical
  execution evidence.
- A replay-time risk mark is a separately labelled current valuation input. It
  is not a historical fill price and cannot be used as one.
- Fees, realized PnL, balance, positions, leverage posture, and margin state are
  derived by the server from the validated source inputs. Client-computed
  result fields are not accepted as authoritative.

## Evidence and identity invariants

- Ordinary orders and fills keep their existing `oid`, `tid`, `cloid`, and
  venue-hash meanings. Synthetic historical events are stored under a distinct
  schema with deterministic synthetic identifiers and never fabricate those
  ordinary identities.
- Historical `effectiveAt` and actual server `replayedAt`/`recordedAt` are
  distinct fields. Backdating the server timestamps to the schedule instant is
  a defect.
- Source, evidence, model-input, risk-mark, event, and batch identities are
  bound by canonical SHA-256 digests. Unknown fields, duplicate identities,
  changed bytes, malformed chronology, and inconsistent stored derivations
  fail closed.
- Historical price evidence is causal: request and response occur at or after
  the scheduled instant and within the frozen capture window. Replay-time risk
  marks satisfy their own freshness window. Missing evidence is never filled,
  interpolated, or replaced.

## First-import and recovery invariants

- A historical replay is a first-run bootstrap only. The account must have the
  exact declared starting balance and no ordinary positions, leverage state,
  orders, cloids, fills, funding, active-user state, or prior replay state;
  ordinary PostgreSQL order/fill presence also refuses the import.
- One Redis script rechecks every mutable premise before its first write and
  then writes the immutable replay ledger, account balance, positions, and
  margin posture atomically. All post-validation commands have fixed compatible
  key types.
- An identical batch retry is a validated read/no-op. A different batch is
  refused. Malformed or internally inconsistent stored replay state is never
  adopted or repaired silently.
- Replay-derived positions and leverage state are ordinary runtime paper state,
  so later online paper orders continue from them. Historical events remain
  distinguishable and never appear as ordinary fills.

## Applicable specification

- `plans/CO-M17-historical-replay.md` is the frozen dependency contract for the
  historical replay import milestone.
- `plans/CO-M20A-programme-pnl-ledger.md` is the frozen dependency contract for
  immutable programme-funding evidence and read-only programme PnL snapshots.

## Programme PnL invariants

- Programme PnL is a paper-only accounting view. It neither creates an account
  nor mutates an order, fill, position, balance, replay, funding, or PostgreSQL
  row. The endpoint is unavailable unless its separate host opt-in is enabled.
- The immutable historical replay supplies the programme starting balance and
  replay realized PnL/fees. Immediate ordinary Redis fills supply later realized
  PnL/fees. A separately typed append-only funding ledger supplies every later
  funding charge; current clearinghouse state and mark context supply current
  unrealized PnL. Missing or malformed attribution is never guessed.
- Each programme-funding event is deterministically bound to account, asset,
  and funding-time bucket. One Redis script validates the exact pre-state, then
  updates account/position funding fields and appends the immutable event as one
  application boundary. Same-bucket retries adopt the existing validated event
  without charging twice.
- A verified historical correction never overwrites an immutable funding event.
  It appends a separately typed correction bound to the original event bytes and
  source digests, atomically applies only the charge difference to the paper
  account and position funding fields, and exposes one effective funding row.
- Scheduled funding is bound to an explicit UTC boundary and a fresh
  post-boundary oracle context. Its rate comes from the venue's realized
  `fundingHistory` row for that same boundary; an early timer, stale context,
  missing realized row, or expired retry window cannot create an event.
- For each requested asset, cumulative PnL is replay closed PnL plus ordinary
  closed PnL, minus replay and ordinary fees, minus durable funding charges,
  plus current unrealized PnL. The four-asset total must exactly equal current
  account value minus immutable programme starting balance.
- A present, never-traded flat paper account reports exact zero. Once programme
  activity exists, a flat book retains cumulative realized net PnL. Activity
  without an immutable programme baseline, ledger mismatch, identity drift,
  malformed arithmetic, or state movement during derivation fails closed.
