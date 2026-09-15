# HYPAPER-CASH-F7-S2: reconstructible public cash source

- status: draft
- numeric: true
- owner: HyPaper
- date: 2026-09-15
- adoption base: `51d0aeacce8d60e10b4dad3e6d54d66ba705fd84`
- adoption tree: `d777a4866e3afa0dc1cdab32441d28437c5a55e8`

This is an offline provider-owned preflight. It authorizes only this plan and
append-only decision bookkeeping. It does not authorize readiness,
implementation, review, network/account/store access, a service, notification,
trading, promotion, merge, or push.

## Pinned consumer request and provider evidence

The inspected consumer proposal is
`plans/li_revt_hypaper_cash_provider_v2.md` at SHA-256
`01fa837b10af91f4bb04bf51d7d52b5b1142388c3e799cfce6e26238adb4f0b1`.
Its V1 binding reference is
`plans/li_revt_hypaper_cash_source_v1.md` at SHA-256
`aff8bf4cef5c71524a2c09fb224fa8a01afae93570114c0336d16031946d6d42`.
The locally promoted S1 provider is the adoption base above; its reviewed
close-out is `1cc3c044fde1cdb3d8d33c7e38cfa57d8c43ce31`.

Pinned provider dependencies:

| Path | SHA-256 |
|---|---|
| `src/types/historical-replay.ts` | `625ceceba47b2f389f7021caedc133604698797a11c12b1c193807ef7412a3ab` |
| `src/types/pnl.ts` | `6022080803eb5970bf140a3994d0c38c8f3c85cff4881a330573a184798c71b0` |
| `src/types/order.ts` | `524833b28c8aa151c8dc1851e4b47afdb9a7dedb69f8a79a7169cfaf2475da15` |
| `src/engine/historical-replay.ts` | `23f225752833f231aa7fa6b822a3c84e213d100cd498b61d81be6db99f6ba349` |
| `src/engine/position.ts` | `eca4b7e9a394c059c14396ddb8cc4532d222991a86c18c0dc23412786ea4343a` |
| `src/worker/order-matcher.ts` | `d131520d7ac370a62ea122c047caaabe2e9bd33613e45736fa16be9503cabc46` |
| `src/store/keys.ts` | `022d8438382d44587a573a4afcb8f90f6b14fbb6b8712c251ea0c7ebaa67000c` |

## Provider-owned compatibility verdict

The request is implementable without a new writer or store key, using the
existing read methods plus read-only `smembers`, `zrange`, `keys`, `hgetall`
and `lrange`. The minimum honest success scope is the entire account under one
current immutable replay epoch. Ordinary fills are account-wide and do not
carry a complete strategy allocation, while reset/manual/deposit/withdrawal
history has no reconstructible ledger. S2 therefore cannot publish a
strategy-subset cash result or use an unexplained balancing plug.

The consumer proposal is **REVISED** at its position-row clause. The writer at
`src/worker/order-matcher.ts:265-281` deletes the position hash and removes the
asset from the user position set when `newSzi` is zero. Consequently:

- successful final-flat `positions.rows` is exactly empty;
- both the user-position set and matching position-key inventory are empty;
- an indexed missing hash, unindexed hash, or stored/indexed zero-size row is a
  malformed parity state and refuses;
- S2 never manufactures zero rows to prove a historical flat interval.

This replaces, rather than silently reinterprets, the upstream phrase
“including zero rows.” It is consistent with the existing replay admission
check at `src/engine/historical-replay.ts:637-648`.

The ordinary fill list is written by `LPUSH` at
`src/worker/order-matcher.ts:315-316`, so public source order is newest-first
and quantity replay is reverse source order, never timestamp sort. Funding,
correction, and replay indexes retain their native oldest-first order.
Terminal order hashes remain in the account order index. Complete flatness
therefore requires account-index/hash parity, owner validation, and membership
checks against both global open and trigger sets. A missing/malformed global
active member whose owner cannot be safely attributed refuses.

The provider proposes revising the account projection to exactly
`{wallet_fingerprint,currency,balance,created_at_ms,replay_batch_id}`. The
stored account has `userId`, `balance`, and `createdAt`; raw `userId` is not
published. The provider also proposes that order projections retain every
sanitized state field needed to
reconstruct their identity and lifecycle:
`oid,coin,asset,side,qty,filled_qty,average_fill_px,limit_px,order_type,
time_in_force,reduce_only,grouping,status,created_at_ms,updated_at_ms,
cl_ord_id,trigger_px,tp_sl,is_market,open_set_member,trigger_set_member`.
Optional values are explicit null, not omitted or synthesized.
All three protocol corrections received bilateral technical acceptance during
this preflight. The accepted order shape is a complete sanitized **current
order-state projection**, not an invented historical lifecycle: required
non-null `average_fill_px` comes from stored `avgPx` (zero is permitted only
when actually stored); `order_type` is `limit|trigger`; `time_in_force` is
`Gtc|Ioc|Alo`; `reduce_only`, memberships, and any present `is_market` are
strict booleans; `grouping` is `na|normalTpsl|positionTpsl`. Only
`cl_ord_id,trigger_px,tp_sl,is_market` may be null, and null means the stored
optional field is absent. Missing required fields, empty optional strings, or
silent `avgPx ?? 0` / `isMarket ?? false` repair refuses. Average fill price is
state evidence only, never a fill, ORACLE, execution-reference, or cash oracle.
`created_at_ms` is the stored nonnegative safe integer from `createdAt`; it is
identity/source evidence and may not be refreshed to an observation clock.

## Exact public source adaptation

S2 adds strict request `getCashLedgerEvidenceV2` and response
`HYPAPER_CASH_LEDGER_EVIDENCE_V2`; V1 remains byte-for-byte unchanged and no
fallback or negotiation is allowed. The request exact keys are
`type,user,dex,coins,coverageStartMs,coverageEndMs,finalFlatRequired,scope,
expectedReplayBatchId`. `scope` is `whole_account_replay_epoch` and the batch
id must equal the current `hprb` index. The default-off flag is
`CASH_LEDGER_EVIDENCE_V2_ENABLED=false`. When enabled, a positive safe-integer
`CASH_LEDGER_EVIDENCE_V2_MAX_BYTES` and all existing provider identity/finality
caps are required; callers cannot enlarge them.

Successful canonical bytes use strict compact ASCII-key-sorted JSON, preserve
array order, and have no BOM or trailing LF. Decimal values are canonical
strings. Unknown/missing/duplicate keys, JSON numbers for Decimal fields,
unsafe integers, booleans as integers, or noncanonical bytes refuse.

The V2 receipt is V1's exact top-level structure plus `source_inventory`;
`settled_usdc.evidence_sha256` equals `source_inventory.inventory_digest`.
`source_inventory` has exactly:
`schema_version,replay,ordinary_fills,funding_records,correction_records,
account,positions,orders,manifest,inventory_digest`. Each collection has
exactly `rows,manifest`; each row has exactly
`ordinal,identity,source,source_digest`; ordinals are contiguous from zero.

Exact sources and order:

1. `replay`: one full strict `HistoricalReplayResult`, structurally replacing
   raw `user` with `wallet_fingerprint`; identity is `batchId`.
2. `ordinary_fills`: full strict `PaperFill` fields, newest-first; identity is
   canonical `tid`. Missing venue identity refuses.
3. `funding_records`: `{raw_json}` parsing as the pinned funding schema,
   oldest-first; identity is `eventId`.
4. `correction_records`: `{raw_json}` parsing as the pinned correction schema,
   oldest-first; identity is `correctionId`.
5. `account`: the exact sanitized projection above; identity is the wallet
   fingerprint.
6. `positions`: exact current projections `{asset,coin,szi,entry_px}` in asset
   identity order. For successful final-flat evidence this array is empty;
   any zero/nonzero stored row refuses.
7. `orders`: the complete sanitized projection above in oid identity order,
   including terminal rows and active-set membership.

Funding/correction raw SHA-256 values remain SHA-256 of the exact stored UTF-8
string because their pinned schemas contain no wallet/store key. Other source
digests use `SHA256(ASCII("HYPAPER_CASH_SOURCE_<KIND>_V2\n") ||
canonical_json(source))`; no V1 private raw digest is relabelled. Collection,
top inventory, stable-state and receipt digests use distinct V2 domains and
are fully reconstructible from published bytes. Existing replay
`sourceDigest` and funding ORACLE source identifiers are preserved only as
declared identities: the store does not retain every original upstream
publication preimage, so S2 does not claim publication-time provenance.

All original reads and index/key inventories are captured twice and compared
before success. Resource caps apply before per-record fanout when counts
already prove overflow; exact raw and canonical byte counts are bounded too.
No account creation, upstream request, mutation, clock refresh, pagination,
truncation, filtering, or private data from another account is allowed.

## Cash and quantity reconstruction

The consumer independently reconstructs:

`expected_current_balance = starting_balance + replay_realized_pnl +
ordinary_realized_pnl - replay_fees - ordinary_fees -
effective_funding_charge + unrelated_cash_movement`.

`unrelated_cash_movement` is exactly `0`. Fees preserve their signed stored
value, so a negative maker fee is a rebate. Effective funding is the exact sum
of original signed charges plus correction deltas. Every fill has explicit
side and positive quantity; signed quantity is derived. Whole-account cash,
per-event before/after transitions, quantity replay, current empty positions,
terminal orders, and final residual must all agree exactly.

Redis `HINCRBYFLOAT` is used for existing cash writes at
`src/worker/order-matcher.ts:293-300`. A stored balance may therefore already
have lost precision. S2 attests the exact stored text but never treats it as a
computational oracle or recovers missing digits. Arithmetic uses input-sized
Decimal precision; if reconstruction differs from stored balance by any
amount, the result is **REFUSE**. Tolerance remains exactly zero.

## Frozen synthetic numeric evidence

These are synthetic arithmetic projections, not complete V2 public-source or
receipt fixtures and not observed market/account results.
Independent numeric verification must parse the frozen bytes below and may
not import production code or test expected values as its arithmetic oracle.

Success seed: 988 canonical bytes; raw SHA-256
`40619a5aa4eb17b352decbb8b04d3133f4568bb6f84ccaae8c86f9d6f806d4e2`;
domain digest
`3ef8bb132bc81370fd6beca74173c3e5bda17ccdf8995dd66619993642f95c34`.

```json
{"account":{"currency":"USDC","current_balance":"9999.25"},"corrections":[{"account_balance_after":"9999.25","account_balance_before":"10000.25","corrected_funding_charge":"3","corrected_funding_rate":"0.01","corrected_oracle_px":"150","funding_charge_delta":"1","original_funding_charge":"2","szi":"2"}],"funding_events":[{"account_balance_after":"9998.25","account_balance_before":"10000.25","coin":"xyz:CL","funding_charge":"2","funding_rate":"0.01","oracle_px":"100","szi":"2"},{"account_balance_after":"10000.25","account_balance_before":"9998.25","coin":"xyz:NATGAS","funding_charge":"-2","funding_rate":"0.01","oracle_px":"200","szi":"-1"}],"ordinary_fills":[{"closed_pnl":"-1","coin":"xyz:CL","fee":"-0.125","side":"B","start_position":"-1","sz":"1"},{"closed_pnl":"-1","coin":"xyz:NATGAS","fee":"-0.125","side":"A","start_position":"1","sz":"1"}],"replay":{"events":[{"closed_pnl":"3","fee":"1"}],"starting_balance":"10000"},"schema_version":"HYPAPER_CASH_F7_S2_NUMERIC_SEED_V1"}
```

Precision seed: 182 canonical bytes; raw SHA-256
`cde804f82d4cb5fcfe012195670c167655ae330535b2781239fdaa1b91e3cbdd`;
domain digest
`0b4baf43aef0d7404402d280f8b8ee7f77b8a459d6c26c8cb526340be2802215`.

```json
{"funding_rate":"-0.1","oracle_px":"0.00000000000000000000000000000000000001","schema_version":"HYPAPER_CASH_F7_S2_PRECISION_SEED_V1","szi":"123456789012345678901234567890123456789"}
```

The exact numeric manifest is 1,283 canonical bytes, SHA-256
`4711b7714d570005d3019c19ee6a11723b27f3e11130b3475bd38a9e3cf584b6`:

```json
{"checks":[{"expected":["2","-2"],"id":"original_charges","tolerance":"0"},{"expected":"3","id":"corrected_charge","tolerance":"0"},{"expected":"1","id":"correction_delta","tolerance":"0"},{"expected":"1","id":"effective_funding_charge","tolerance":"0"},{"expected":"3","id":"replay_realized_pnl","tolerance":"0"},{"expected":"1","id":"replay_fees","tolerance":"0"},{"expected":"10002","id":"replay_final_balance","tolerance":"0"},{"expected":"-2","id":"ordinary_realized_pnl","tolerance":"0"},{"expected":"-0.25","id":"ordinary_fees","tolerance":"0"},{"expected":"9999.25","id":"expected_current_balance","tolerance":"0"},{"expected":"0","id":"residual","tolerance":"0"},{"expected":["0","0"],"id":"fill_end_positions","tolerance":"0"},{"expected":"-0.123456789012345678901234567890123456789","id":"precision_funding_charge","tolerance":"0"}],"fixtures":{"precision":{"bytes":182,"domain_digest":"0b4baf43aef0d7404402d280f8b8ee7f77b8a459d6c26c8cb526340be2802215","sha256":"cde804f82d4cb5fcfe012195670c167655ae330535b2781239fdaa1b91e3cbdd"},"success":{"bytes":988,"domain_digest":"3ef8bb132bc81370fd6beca74173c3e5bda17ccdf8995dd66619993642f95c34","sha256":"40619a5aa4eb17b352decbb8b04d3133f4568bb6f84ccaae8c86f9d6f806d4e2"}},"schema_version":"HYPAPER_CASH_F7_S2_NUMERIC_MANIFEST_V1"}
```

All 13 arithmetic checks use tolerance `0`. The precision product must equal
`-0.123456789012345678901234567890123456789`. Any provider/global-context
rounding, stored cash drift, fee-sign drift, changed bytes, or digest mismatch
refuses.

The complete conditional V2 exemplar is now frozen in plan-owned fixture files:

| File | Canonical payload bytes / SHA-256 (without terminal LF) | Tracked-file SHA-256 (with terminal LF) |
|---|---|---|
| `plans/fixtures/hypaper_cash_f7_s2_success.json` | 21,993 / `ab648315f0d2c270b45a3483321f57d51bb695506c478049aa20e4eef689c1ec` | `edab1df36718f928aa470c367971e44c9b6038d22dd3af50a24ce10d6c401ad9` |
| `plans/fixtures/hypaper_cash_f7_s2_hostile.json` | 458 / `06352158d6aa7b2deee491764f44b3469ed9f857ccb3b7dfe86fd3439f441e33` | `5fc4a7c85f7fb297031cac32e9c35963472f178e9196fd48a0ca7e4ecc46a30b` |
| `plans/fixtures/hypaper_cash_f7_s2_expected.json` | 10,337 / `83797246fa1bae2c37bd186a5ce129fbd492bb171fdc4bcd5892c36b5150d712` | `40fec55bbee16b0f6e375695958bd700904636c15982fba0407b099f62457e40` |

The success payload contains one complete strict replay result with two
synthetic entry/reduction events, four ordinary fills in Redis newest-first
order, two same-boundary funding events, one correction, the exact sanitized
account, an empty final position inventory, four terminal orders, all source
rows, member/collection/top manifests, stable-state/inventory/receipt digests,
and final coverage. The expected manifest freezes 52 checks over identities,
complete source-time and separate observation-clock inventories, every
replay/ordinary/funding/correction cash and quantity
transition, every source/member/manifest digest, finality/watermark, stable
state, inventory and outer receipt. Decimal checks have tolerance zero.

The time checks name every public source timestamp by exact field family and
preserve its native row order. Coverage/observation timestamps are a separate
mapping, not mixed into or mislabelled as source-row evidence.

The earlier 988-byte arithmetic seed intentionally abstracts replay fees as
`1`, producing `9999.25`. The complete schema fixture derives its two replay
fees from price × size × rate (`0.5 + 0.515 = 1.015`) and therefore produces
`9999.235`. They are separate synthetic fixtures with separate manifests, not
two claims about one account or a tolerance-based discrepancy.

The hostile manifest deterministically mutates
`/source_inventory/ordinary_fills/rows/0/source/fee` from `-0.0625` to
`-0.0624` without updating its source/member/outer digests and requires a
redacted `source_preimage` refusal with no receipt. Further hostile cases may
be expressed as exact mutations of this base during implementation; no market
or account data is represented.

An independent standard-library verifier (ignored preflight evidence; no
production import) re-canonicalized the three payloads, recomputed all V2
digests and cash/quantity equations, and passed all 52 expected checks. A
separate schema-only probe confirmed that the nested replay payload and stored
result match the pinned production Zod schemas; production arithmetic was not
used as the expected-value oracle.

## Proposed implementation allowlist and acceptance

Exactly six product/test paths, unchanged from S1:

- `src/types/cash-ledger-evidence.ts`
- `src/engine/cash-ledger-evidence.ts`
- `src/api/routes/hypaper.ts`
- `src/config.ts`
- `src/__tests__/cash-ledger-evidence.test.ts`
- `src/__tests__/route-validation.test.ts`

Plan, the three `plans/fixtures/hypaper_cash_f7_s2_*.json` design fixtures,
and append-only decision bookkeeping are the only preflight paths.
Writers, store keys, replay/funding/order/position engines and existing V1
semantics are read-only dependencies.

Acceptance requires: strict closed codecs and V1 isolation; complete
account/epoch source publication; deterministic native ordering; full
index/key/owner/active-set parity; two-read stability; resource caps; exact
public digest reconstruction; exact cash/quantity/order/flatness reconstruction;
explicit refusal for absent provenance, reset/manual/unrelated cash, malformed
zero position rows, unknown-owner orphans, gaps, nonflat/open state, rounding,
and any nonzero residual; hostile canonical/digest/redaction tests; configured
offline build/test gates; independent sterile review; and independent numeric
verification against the byte-bound manifest above.

## Preflight evidence and blockers

Takeover snapshot:
`/Users/dylan/work/hypaper/.codex/tmp/takeover/HYPAPER-CASH-F7-S2/20260915T112607Z`.
The only unmerged `ms/*` ref at inspection was
`ms/CO-M17-hypaper-historical-replay-import@4ff0cd469e600481e9f90a20469e8606f8f58299`,
already independently parked; the one-row terminal-LF manifest SHA-256 was
`6534c1a3700b905a3dc4e9393ed9e979770ef7f24d49f45f4e8e3ef0d8578248`.

The two prior offline readiness gaps are closed at candidate level: bilateral
consumer acceptance covers the position/account/order corrections, and the
complete fixture/digest manifest above is frozen. Before readiness, the owner
must still perform a fresh same-tree digest/ref/isolation/baseline
revalidation; that is a workflow gate, not an unresolved schema decision.

There is also a capability boundary: upstream publication preimages and
pre-rounded Redis cash digits do not exist in current source state. S2 must
disclaim the former and refuse any mismatch caused by the latter.
Strategy-scoped cash allocation or reconstructible
reset/deposit/withdrawal history would require a separate writer/storage
prerequisite.

Fresh offline baseline gates at the adoption base passed after an offline,
ignored dependency install: `npm run build` PASS; `npm run test:run` PASS with
18 files and 281 tests. No product or test byte changed.

The same configured baseline gates were repeated after the three plan-owned
fixture files were generated: build PASS and 18 files / 281 tests PASS.

Draft freeze commit: `d6bc865da5775baffe9596adac37dbdc7abd1f21`,
tree `522e9d9e485463a09426d10b1069df99afa3b81c`. The plan SHA-256 at that
freeze was `1280746e68e31368c39bd3ce05d12ac15ee7af506669f3b6d302eb12bfa0133f`.

Complete conditional fixture freeze commit:
`b2173ebc94e1860c24bd6818b12ed4eab7c66b0a`, tree
`0d1db7004054d70b7c14b54d3bcebe049d9f118b`; plan SHA-256 at that freeze
was `78455b5b94544cdc0b24fc3f0a891eda9219d457e183d26da1c46385947a4fbd`.

The consumer's sole fixture correction was resolved at
`64a1a037757754792d2cc93aceaaa6bf40ccb168`, tree
`900c13a4acf3ac9e05123c59664d4f03c489ad86`. It independently extracted and
matched all 24 named source/coverage timestamp arrays, all 52 checks, the
10,337-byte expected payload, SHA-256
`83797246fa1bae2c37bd186a5ce129fbd492bb171fdc4bcd5892c36b5150d712`,
and LF-file SHA-256
`40fec55bbee16b0f6e375695958bd700904636c15982fba0407b099f62457e40`.
The success and hostile fixture bytes were unchanged. This is bilateral
design-byte acceptance only, not implementation or sterile review.

UNREVIEWED LANDINGS: none. New commits contain only this draft plan, three
plan-owned synthetic fixture files, and the append-only decision entry, with no
product/test landing. SCOUT NUMBERS: none; all numeric values are explicitly
synthetic, byte-bound test vectors.

Wrapup audit: no product code or empirical result landed. The numeric values
above are content-bound synthetic test vectors. There are no unreviewed product
landings and no unaudited scout numbers in this preflight.

## Next

Under separate authority, perform fresh same-tree
digest/ref/isolation/baseline revalidation before any `draft -> ready`
decision and implementation pipeline.
