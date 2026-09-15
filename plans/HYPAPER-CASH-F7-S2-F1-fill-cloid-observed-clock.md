# HYPAPER-CASH-F7-S2-F1: preserve fill cloid omission and post-stability clock

- status: implemented
- numeric: true
- owner: HyPaper
- date: 2026-09-15
- adoption base: `9bfcec3cb2eea86101f91987d97196233c20d53a`
- adoption tree: `07494b927c6dab373981cfb8625318c8a03571ab`
- baseline: `npm run build` PASS; `npm run test:run` PASS (18 files, 296 tests)
- reviewer: dedicated Opus profile; settings SHA-256 `1e6c6ed7dc47b149986645f2f0893a50473fb61371efdc4da1a45d046bb8d6e7`
- ref manifest: 5 local `ms/*` refs; terminal-LF SHA-256 `459c8b5813b32bc58d2348e18efe267ab8fc5b5863a13462e19dc29f7e849c52`
- implemented: 2026-09-15
- reviewed implementation commit: `1314f0d5445e3c8e138b0d301c8fa010c4b1a47d`
- reviewed implementation tree: `8d9d282f01d39b3728ee90ceb5d28ead0cd9cae8`
- result: exact three-path patch `2eda73f28f19b685b83994000037c254a37ef313e5e46850720e38f447320155`; build and 299-test gate PASS; Opus sterile Cycle 1 approve (7/8, no blockers); independent numeric PASS (9/9 named checks including all original 52 comparisons)
- archive: `/Users/dylan/kit_archives/hypaper/HYPAPER-CASH-F7-S2-F1/20260915T151743Z`; manifest SHA-256 `ce1e09ee72e33a367f5faa35fd28927762236fd18b70a66320c12cbe16f18547`

This is a narrow successor to promoted `HYPAPER-CASH-F7-S2`. It corrects two
provider-contract drifts discovered during consumer adoption. The prior S2
review and numeric verdict remain historical evidence, but did not exercise
these two boundaries.

## Acceptance

- [x] In each V2 ordinary-fill public `source`, `cloid` is optional. An absent
  stored `cloid` remains absent in the source object and canonical bytes; it is
  never synthesized as `null`.
- [x] A present ordinary-fill `cloid` is accepted only as a non-empty printable
  ASCII string. Explicit `null`, the empty string, non-ASCII, control
  characters, or a non-string refuse through the existing strict typed error.
- [x] Member, collection, inventory, settled-evidence and receipt digests are
  computed from the exact canonical object with the absent key omitted. Tests
  prove absent and present cases produce their independently expected bytes and
  digests, and that adding/removing the key changes the digest.
- [x] `coverage.observed_at_ms` is sampled only after the second complete V2
  source capture and the stable-state equality comparison both succeed.
- [x] After the observation clock is sampled, the V2 success path performs no
  store or source read. The sampled value is used consistently in the final
  receipt and chronology validation; a dynamic clock test proves call order and
  the absence of post-observation reads.
- [x] Existing V1 schemas, V1 bytes, routes, feature flags, source ordering,
  account/order/position projections, arithmetic, zero tolerance, resource
  caps, privacy rules and refusal taxonomy remain unchanged.
- [x] Focused tests cover ordinary-fill `cloid` absent, present, explicit null,
  empty/malformed, exact digest omission, and the clock/stable-read ordering.
- [x] `npm run build` and `npm run test:run` pass; the exact patch receives a
  valid Opus sterile approval before numeric verification and close-out.

## Allowed paths

- `src/types/cash-ledger-evidence.ts`
- `src/engine/cash-ledger-evidence.ts`
- `src/__tests__/cash-ledger-evidence.test.ts`
- `plans/HYPAPER-CASH-F7-S2-F1-fill-cloid-observed-clock.md`
- `DECISIONS.md` (append-only bookkeeping only, if a new decision is made)

## Review references

- `REVIEW_POLICY.md`
- `plans/HYPAPER-CASH-F7-S2-reconstructible-source.md`
- `plans/fixtures/hypaper_cash_f7_s2_success.json`
- `plans/fixtures/hypaper_cash_f7_s2_hostile.json`
- `plans/fixtures/hypaper_cash_f7_s2_expected.json`

Pinned tracked-file SHA-256 values at readiness:

- S2 plan: `6413b755783ed269410702e1bd23c643d738c8d870ddfea99261a702cd2bbcc8`
- success fixture: `edab1df36718f928aa470c367971e44c9b6038d22dd3af50a24ce10d6c401ad9`
- hostile fixture: `5fc4a7c85f7fb297031cac32e9c35963472f178e9196fd48a0ca7e4ecc46a30b`
- expected fixture: `40fec55bbee16b0f6e375695958bd700904636c15982fba0407b099f62457e40`

## Numeric checks

The verifier must independently execute the reviewed public V2 engine against
an isolated in-memory/read-only fixture adapter and compare actual canonical
output. It may use production types only to invoke the public boundary, never
production/test expected values as the arithmetic or digest oracle.

- `s2_original_52`: all 52 frozen success-manifest checks against actual output;
  exact string/byte/digest equality, tolerance `0`.
- `s2_precision`: the frozen long-precision funding result
  `-0.123456789012345678901234567890123456789`; tolerance `0`.
- `fill_cloid_absent_shape`: ordinary-fill source has no own `cloid` key when
  storage omitted it; exact canonical bytes and all derived digests match an
  independent SHA-256 reconstruction; tolerance `0`.
- `fill_cloid_present_shape`: a valid present ASCII `cloid` is retained exactly
  and independently changes member/collection/inventory/receipt digests;
  tolerance `0`.
- `fill_cloid_explicit_null_refusal`: explicit null refuses rather than becoming
  absent; exact typed refusal class/code.
- `fill_cloid_empty_or_malformed_refusal`: empty, non-ASCII, control-character
  and non-string values refuse; exact typed refusal class/code.
- `observed_after_stable_compare`: actual observation-clock call index is after
  both capture completions and the stable comparison; exact call-order match.
- `no_source_read_after_observed`: actual adapter/store read count remains fixed
  after the observation-clock call through response return; exact count match.
- `v1_unchanged`: pinned V1 public behavior and focused golden bytes remain
  unchanged; exact equality.

## Out of scope

- No changes to stores, writers, Redis keys, request/response routes, V1, cash
  equations, tolerance, source inventories, fixtures under `plans/fixtures`, or
  any consumer repository.
- No network, account or market-data access, running service, production store
  read/write, session creation, notification, order, position change, promotion,
  merge to an integration/main branch, or push.
- No reinterpretation of the promoted S2 approval/numeric record; this successor
  supplies the missing boundary evidence prospectively.

## Next

Obtain separate human authorization before any local promotion. Consumer
adoption remains closed until that reviewed result is promoted and independently
revalidated.

Close-out state: the milestone worktree is clean at the reviewed implementation
tree; no runtime, network, service, production-store, trading, promotion, merge,
or push action was performed.
