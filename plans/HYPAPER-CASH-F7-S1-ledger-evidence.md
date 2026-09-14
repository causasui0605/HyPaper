# HYPAPER-CASH-F7-S1: settled-USDC and ORACLE-funding evidence

- status: ready
- numeric: true
- owner: HyPaper
- date: 2026-09-14
- adoption base: `ecc83201c280cdf3035f250495a131b432211598`
- adoption tree: `88c24e00e9fd11c51cbeae2d2c59801f61f7a567`

This is a fresh, offline provider-contract preflight. It does not authorize
implementation, a HyPaper or Hyperliquid request, account access, Redis or
PostgreSQL access, a service, an environment change, a notification, an order,
a position change, promotion, merge, or push.

## Purpose and ownership

Provide a default-off, strictly read-only HyPaper receipt containing the
settled-USDC and actual recorded ORACLE-funding evidence required by the
tholos `LI_REVT-HL-CASH-F7-source-verifier` and delayed-cash finalizer.
HyPaper owns source inventory, stable-read validation, and the provider
receipt. Tholos owns retrieval-time freshness, first-write durable archival,
cash-final policy, the 24-hour grace period, and the 96-hour hard deadline.

The provider never persists a receipt. “Content-addressed” means that the
provider returns canonical bytes with a domain-separated digest; first-write
storage is exclusively the downstream consumer's responsibility. This avoids
contradicting the non-mutating endpoint boundary.

## Frozen request

The default-off route is `POST /hypaper` with `type` equal to
`getCashLedgerEvidence`. Its request is strict and has exactly these keys:

- `type`: `getCashLedgerEvidence`
- `user`: non-empty wallet/account string used only for the local lookup
- `dex`: non-empty ASCII identifier
- `coins`: non-empty, unique, ASCII-sorted array of non-empty ASCII coin names
- `coverageStartMs`: nonnegative safe integer on an exact funding boundary
- `coverageEndMs`: nonnegative safe integer on an exact funding boundary and
  not earlier than `coverageStartMs`
- `finalFlatRequired`: literal `true`

Unknown keys, duplicate coins, non-ASCII values, floats, unsafe integers,
malformed chronology, or a range not aligned to the configured funding
interval refuse before any store read. The route must appear before the common
`ensureAccount` branch and may not call it directly or indirectly.

## Canonical wire contract

The response media type is `application/json`. Successful bytes are UTF-8 with
no BOM, whitespace, or trailing newline. Object keys are recursively sorted by
ASCII code point; arrays preserve their validated source order. Encoding is
equivalent to `JSON.stringify` over the recursively sorted strict mapping.
Duplicate, missing, or unknown keys, noncanonical bytes, binary floats,
`NaN`/infinity, exponent notation, leading plus/zeros, decimal trailing zeros,
or negative zero are forbidden. Decimal values use `0` or optional `-` plus a
non-zero integer head and optional fractional digits ending non-zero.

The top-level exact keys are:

`schema_version`, `provider_identity`, `subject`, `coverage`,
`funding_events`, `funding_corrections`, `event_manifest`,
`correction_manifest`, `settled_usdc`, `flatness`, `receipt_digest`.

`schema_version` is `HYPAPER_CASH_LEDGER_EVIDENCE_V1`.
`receipt_digest` is lowercase hex
`SHA256(ASCII("HYPAPER_CASH_LEDGER_EVIDENCE_V1\n") || canonical_json(receipt
with receipt_digest omitted))`.

### Provider identity

`provider_identity` has exactly:

- `source_revision`: exact 40-character lowercase Git object id
- `image_digest`: exact `sha256:` plus 64 lowercase hex
- `compose_config_digest`: 64 lowercase hex of the reviewed rendered compose
  configuration, not either compose source-file hash
- `api_schema_version`: `HYPAPER_CASH_LEDGER_EVIDENCE_V1`
- `funding_interval_ms`: positive safe native integer
- `correction_finality_ms`: positive safe native integer
- `max_evidence_rows`: positive safe native integer

All three deployment identity values are required configuration with no
production default once the route is enabled. The later runtime preflight,
not this receipt alone, proves that the running image/config matches them.

### Subject and coverage

`subject` has exactly `wallet_fingerprint`, `dex`, and `coins`.
`wallet_fingerprint` is
`SHA256(ASCII("HYPAPER_WALLET_FINGERPRINT_V1\n") || ASCII(lowercase user))`;
the raw account/wallet is excluded from the receipt.

`coverage` has exactly:

- `start_ms`, `end_ms`, `observed_at_ms`, `funding_interval_ms`
- `latest_fully_covered_funding_time_ms`
- `correction_finality_watermark_ms`
- `finality_status`: `final` or `provisional`
- `terminal`: literal `true`
- `page_count`: native integer `1`

V1 is deliberately unpaged and returns the complete requested interval.
There is no limit, cursor, or caller-selected truncation flag. A response that
cannot fit within the configured evidence-row cap refuses; a later paged
version requires a new schema. `final` is permitted only when the configured
provider correction-finality policy covers `end_ms`; otherwise the explicit
`provisional` result cannot be consumed as final cash evidence. Empty is not
final unless every expected funding boundary in the requested held interval
has an explicit source-backed zero-position status; V1 has no such status row,
so a held-interval gap refuses.

The route captures `observed_at_ms` only after the second stable read.
`correction_finality_watermark_ms = observed_at_ms -
correction_finality_ms`; underflow refuses. `latest_fully_covered_funding_time_ms`
is the greatest aligned boundary no later than both `end_ms` and that
watermark for which the complete requested coin inventory exists. `final`
requires `end_ms <= correction_finality_watermark_ms` and complete coverage
through `end_ms`; otherwise status is `provisional` and the receipt cannot
finalize cash.

### Original funding rows

`funding_events` preserves the immutable event-index order. Every item has
exactly:

`ordinal`, `schema`, `event_id`, `asset`, `coin`, `funding_time_ms`,
`applied_at_ms`, `szi`, `oracle_px`, `funding_rate`, `funding_charge`,
`source`, `account_balance_before`, `account_balance_after`,
`cum_funding_before`, `cum_funding_after`,
`cum_funding_since_open_before`, `cum_funding_since_open_after`,
`cum_funding_since_change_before`, `cum_funding_since_change_after`,
`source_record_sha256`, `member_sha256`.

`source` is the exact strict union already carried by the immutable event:
`live_market_context`; `live_boundary_snapshot` with
`funding_history_time_ms` and `context_observed_at_ms`; or
`verified_backfill` with its two source SHA-256 values. V1 does not synthesize
an unavailable upstream payload hash. `source_record_sha256` hashes the exact
stored Redis string bytes. `member_sha256` is domain-separated over the
canonical normalized item with only `member_sha256` omitted.

The provider independently validates the existing event schema and
deterministic event identity, requires unique event ids, requested coin/dex
scope, exact chronology, `applied_at_ms >= funding_time_ms`, and recomputes
`funding_charge == szi * oracle_px * funding_rate` with Decimal.js precision
30. MARK, BBO, trade, candle, or current price may not substitute for the
recorded `oracle_px`. It also recomputes every account and cumulative funding
before/after transition.

### Correction rows

`funding_corrections` preserves the immutable correction-index order. Every
item has exactly:

`ordinal`, `schema`, `correction_id`, `original_event_id`, `asset`, `coin`,
`funding_time_ms`, `applied_at_ms`, `szi`, `original_funding_charge`,
`corrected_oracle_px`, `corrected_funding_rate`,
`corrected_funding_charge`, `funding_charge_delta`, `source`,
`account_balance_before`, `account_balance_after`,
`cum_funding_before`, `cum_funding_after`,
`cum_funding_since_open_before`, `cum_funding_since_open_after`,
`cum_funding_since_change_before`, `cum_funding_since_change_after`,
`source_record_sha256`, `member_sha256`.

`source` has exactly `kind=verified_correction`,
`original_event_sha256`, `oracle_source_sha256`, and
`funding_source_sha256`. Every correction must bind one existing original,
match its immutable raw SHA-256 and identity fields, and independently
recompute corrected charge, delta, account balance, and cumulative funding.
V1 permits at most one correction per original; orphaned, duplicate, chained,
or zero-effect corrections refuse.

### Manifests

`event_manifest` and `correction_manifest` each have exactly `count`,
`member_sha256s`, and `manifest_digest`. Counts are nonnegative native JSON
integers (booleans rejected). Member digest order equals the corresponding
array order. Each manifest digest is domain-separated over its exact canonical
mapping with `manifest_digest` omitted. Index/key parity, missing/extra keys,
duplicate identities, reordering, member drift, or aggregate drift refuses.

The effective funding inventory is the original ordered event inventory with
the unique matching correction substituted only for arithmetic. Original
rows remain visible. The exact signed effective funding charge is the Decimal
sum of original charges plus correction deltas.

### Settled USDC and flatness

`settled_usdc` has exactly:

`currency`, `starting_balance`, `replay_final_balance`, `current_balance`,
`replay_realized_pnl`, `ordinary_realized_pnl`, `replay_fees`,
`ordinary_fees`, `effective_funding_charge`, `unrelated_cash_movement`,
`expected_current_balance`, `residual`, `evidence_sha256`.

`currency` is `USDC`. V1 supports no unrelated cash ledger, so
`unrelated_cash_movement` must be canonical `0`; it never invents a balancing
plug. The exact equation is:

`expected_current_balance = starting_balance + replay_realized_pnl +
ordinary_realized_pnl - replay_fees - ordinary_fees -
effective_funding_charge + unrelated_cash_movement`.

`expected_current_balance == current_balance` and `residual == 0` are
mandatory. A set/reset/manual balance history that leaves an unexplained
residual refuses instead of being represented as a strategy cash flow.
`evidence_sha256` domain-separates and binds the complete replay, ordinary-fill,
funding-event, correction, and account-balance source inventory used in the
equation; it is not a hash of only the displayed aggregates.

`flatness` has exactly `all_positions_zero`, `relevant_open_order_count`,
`current_unrealized_pnl`, `clearinghouse_state_sha256`,
`open_order_inventory_sha256`. Success requires literal `true`, native integer
zero, canonical Decimal `0`, and source digests over the exact current reads.
Any held position, open order, unrealized value, unknown coin, or identity
drift refuses.

## Stable-read and no-mutation boundary

The engine receives explicit read-only dependencies. It reads exact funding
event/correction index and key inventories, replay evidence, ordinary fills,
account balance, current positions, and current open orders. It repeats every
mutable read after derivation and requires byte-identical state before emitting
the receipt. The API layer performs no Redis/PostgreSQL command except the
engine's declared read methods. Tests use a recording adapter and fail if any
write-like method, `ensureAccount`, upstream fetch, credential read, timer,
background worker, or proxy is invoked.

The endpoint is host-disabled by default. Disabled and refused paths return a
strict typed error envelope, never partial evidence. The successful receipt
contains no raw wallet, credential, connection string, Redis key, database
identifier, environment dump, stack trace, or mutable internal object.

The strict error envelope has exactly `schema_version`, `status`, and
`error_code`. `schema_version` is `HYPAPER_CASH_LEDGER_EVIDENCE_ERROR_V1`;
`status` is `disabled`, `refused`, or `error`; `error_code` is one closed
ASCII enum owned by the implementation for invalid request, disabled route,
missing source, provisional/incomplete coverage, row cap, identity, arithmetic,
flatness, stable-read, and internal failure classes. It carries no partial
receipt, caller value, store key, or exception text.

## Exact configuration boundary

The future implementation adds these names to the strict environment schema:

- `CASH_LEDGER_EVIDENCE_ENABLED`: exact `true`/`false`, default `false`
- `HYPAPER_SOURCE_REVISION`: no default when enabled
- `HYPAPER_IMAGE_DIGEST`: no default when enabled
- `HYPAPER_COMPOSE_CONFIG_DIGEST`: no default when enabled
- `CASH_LEDGER_EVIDENCE_CORRECTION_FINALITY_MS`: positive safe integer, no
  default when enabled
- `CASH_LEDGER_EVIDENCE_MAX_ROWS`: positive safe integer, no default when
  enabled

When disabled, missing identity/finality/cap values are accepted but the route
is unavailable. When enabled, any missing, defaulted, malformed, or conflicting
value fails process configuration before the route can serve evidence. The
existing funding cadence supplies `funding_interval_ms`; this milestone does
not change that cadence or worker.

## Dependencies and review references

Frozen dependency postimages at the adoption base:

| Path | SHA-256 |
|---|---|
| `src/types/pnl.ts` | `6022080803eb5970bf140a3994d0c38c8f3c85cff4881a330573a184798c71b0` |
| `src/engine/pnl.ts` | `8efce35b2feb563427fa3093a44d98fe576dd18c6f832080d550b922de8ef066` |
| `src/engine/funding-history.ts` | `76980aa782e093299e0be40f67bf651dad242ebd6726ebe6e101467291afd8d4` |
| `src/worker/funding-worker.ts` | `02ce7b048f0cb0a4729581d667225247f9ad860b188fc40179557c8b69e16d9f` |
| `src/engine/historical-replay.ts` | `23f225752833f231aa7fa6b822a3c84e213d100cd498b61d81be6db99f6ba349` |
| `src/engine/position.ts` | `eca4b7e9a394c059c14396ddb8cc4532d222991a86c18c0dc23412786ea4343a` |
| `src/store/keys.ts` | `022d8438382d44587a573a4afcb8f90f6b14fbb6b8712c251ea0c7ebaa67000c` |
| `REVIEW_POLICY.md` | `f96af1b4173bb7cd59a07ef538a3463204558d79ea71c842ac8ad1e5a63e47e5` |

The reviewed CO-M20A tip `28b4666894e4fd3f758d4cbec0c29a243a09c506`
is an ancestor. The adoption line contains the promoted CO-M17 implementation
`e135c4b796b8a645c1abe6b1a599029e63d3124b`; the separately parked CO-M17
milestone tip `4ff0cd469e600481e9f90a20469e8606f8f58299` is not an ancestor but has the
same product tree `ec12ac9df57977a83b8789cf3aaf25581f298712`, so it creates no product
conflict. The later tholos verifier remains a consumer, not a provider
dependency.

## Candidate allowed paths

These paths are proposed for a future `draft -> ready` implementation. This
draft does not activate them:

- `src/types/cash-ledger-evidence.ts`
- `src/engine/cash-ledger-evidence.ts`
- `src/api/routes/hypaper.ts`
- `src/config.ts`
- `src/__tests__/cash-ledger-evidence.test.ts`
- `src/__tests__/route-validation.test.ts`

No store key or production funding-writer change is allowed. If implementation
proves that the frozen receipt cannot be derived strictly read-only from the
reviewed immutable ledgers, stop and seek a new prerequisite rather than
widening this milestone.

## Acceptance criteria

1. Public request and receipt codecs implement the exact closed schema and
   canonical byte/digest rules above; independent decode/re-encode is exact.
2. Provider identity, wallet fingerprint, DEX/coin/range, source inventories,
   manifests, finality, cash equation, and flatness are all transitively bound
   to the receipt digest.
3. Every original and correction is visible and independently validated;
   effective funding uses recorded ORACLE only and is Decimal-exact.
4. Complete unpaged interval coverage is proven or the request refuses. Empty,
   provisional, oversized, truncated, missing, duplicate, orphaned, torn, or
   ambiguous evidence never becomes a final receipt.
5. Settled USDC exactly reconciles from immutable sources with zero residual;
   no unrelated movement is inferred and no cross-currency conversion exists.
6. Final-flat position/open-order/unrealized proofs are exact and stable across
   the double read.
7. The enabled route is demonstrably read-only and non-proxy; disabled is the
   default and `ensureAccount` is unreachable.
8. Hostile tests cover noncanonical bytes/decimals/times, float/bool coercion,
   wrong identity/config, event/correction source drift, pagination/row-cap,
   gaps/ties/duplicates, missing ORACLE, arithmetic/balance/manifests,
   set/reset residual, non-flat/open-order state, torn reads, attempted mutation,
   and redaction.
9. Build and full tests pass; an independent sterile review approves; an
   independent numeric verifier reproduces event/correction charges, the full
   signed funding aggregate, settled-USDC equation, and zero residual without
   importing production implementation or test expected values.

## Out of scope

Implementation under this preflight; network or provider calls; reading an
actual account; direct tholos access to Redis/PostgreSQL; deployment; image or
compose mutation; funding backfill/correction; changing existing event,
correction, order, fill, position, replay, cash, or reset semantics; persisting
provider receipts; paging; credentials; real venue data; alerts; Slack;
services; trading; position changes; promotion; merge; push.

## Preflight result

- Primary HyPaper checkout was clean and untouched.
- Fresh isolated worktree from exact source revision/tree: PASS.
- Initial status and diff snapshots were empty (SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
- Local `ms/*` ref manifest: 3 rows, terminal-LF SHA-256
  `2afc8873a057812f2f931e283eeae971a14cd67b70c672164a68e548d43fe4bc`.
  Exact rows are
  `ms/CO-M17-hypaper-historical-replay-import@4ff0cd469e600481e9f90a20469e8606f8f58299`,
  `ms/CO-M20A-hypaper-pnl-ledger@28b4666894e4fd3f758d4cbec0c29a243a09c506`,
  and `ms/HP-M1-isolated-margin-parity@026b0ddf355a31f1a6b35661651449dda0acabb3`.
- Exact dependency-source inspection: PASS.
- Runtime/deployed identity, actual rows, finality, and account cash: NOT
  EXERCISED by design.
- Offline dependency installation used the local npm cache only
  (`npm ci --offline --ignore-scripts`): PASS; no tracked dependency bytes
  changed.
- TypeScript build (`npm run build`): PASS.
- Full test suite (`npm run test:run`): PASS, 17 files / 262 tests.
- Milestone status remains `draft`.
- Unreviewed landings since the branch point: none before this draft-only
  bookkeeping commit; no product code landed.
- Unverified scout numbers used as product premises: none. Test counts and
  content hashes above are reproducibility evidence, not research findings.

## Next

Run the authorized bounded offline implementation over the exact six allowed
paths, full gates, Opus sterile review, independent numeric verification,
archive, and close-out. Any needed store-key or funding-writer change is a new
prerequisite and must stop this milestone rather than silently widen it.
