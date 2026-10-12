# Plan: HYPAPER-FUNDING-RACE

> Source of truth for milestone state.

## Next

Implement M1, review it with cross-vendor Codex (hypaper kit, REVIEWER_CMD_OVERRIDE=.codex/hooks/reviewer-codex.sh), then deploy it only after every LI_REVT paper pair is flat (not before 2026-10-15 ~21:00Z).

## Milestones

### M1: the funding worker funds every active position at every boundary; the upstream HL proxy fails fast and clearly
- status: implemented (merged to yihao; deploy moved to 2026-10-12 ~14:35Z: dylan ended the LI_REVT hold early on 10-12, and every LI_REVT pair was flat by 13:45Z)
- review: codex cross-vendor, 2 cycles, approve 5/5 (patch f1ee7ecb6709aca92631d35af6a4ee1d6a4306929674857c256adade96b5decb); gate 352 passed; archive /Users/dylan/kit_archives/hypaper/HYPAPER-FUNDING-RACE/20261011T090022Z
- numeric: false
- context: the 2026-10-09 diagnosis by the tholos orchestrator. The funding worker refuses a position whose `market:ctx:<coin>` observedAt is NEWER than the attempt's single `appliedAt` (src/worker/funding-worker.ts ~:621-628). The websocket and the 15 s xyz poll keep moving observedAt forward during the sequential per-position loop, which makes one fundingHistory HTTP call per position. So multi-position wallets miss most boundaries (TI_Z wallet …0002 since 10-05), and single-position xyz wallets miss some (10-10 20:00Z: xyz:CL and xyz:NATGAS). Retries then fail on `sameFundingInputs` comparing volatile fields (oraclePx and source.contextObservedAt) against events that already applied ("conflicting immutable evidence"). A missed boundary is skipped forever, and a cash-ledger V2 window containing it refuses terminally with "gap". Separately, the /info proxy (src/api/routes/info.ts fetchProxied) and l2-cache (src/utils/l2-cache.ts) call HL with NO timeout and NO status check: one IOC took 18 s, and an HL 502 page or a local DNS failure surfaced as 400/500 or hung.
- acceptance:
  - [ ] Freshness: a position's market context is admissible for boundary T iff `T <= observedAt <= T + bound` (a fixed, documented bound >= the worker's whole retry window). Context newer than the attempt start no longer refuses. Context older than T still refuses. Tests: a context updated mid-loop is accepted; a stale context (< T) is refused; one past the bound is refused.
  - [ ] Snapshot: the worker reads every needed `market:ctx` ONCE per attempt (a pipelined snapshot) before the loop, so a position's admissibility does not depend on its loop position. Test: 60 positions with contexts rewritten during the loop are all funded in one attempt.
  - [ ] Retry idempotence: on retry, a (user, asset, fundingTime) whose event already exists is skipped BEFORE any input is computed or compared, so a retry never fails on the volatile fields of an already-applied event. The immutable-evidence comparison stays for genuinely conflicting writes. Test: attempt 1 funds half the positions and attempt 2 funds the rest with no "conflicting immutable evidence".
  - [ ] Upstream calls: every fetch to HL (fundingHistory in the worker; the /info proxy fetchProxied; l2-cache getL2Book; the extra-dex ctx refresh) has an AbortSignal timeout (documented constants) and checks `res.ok` and the content type before `res.json()`. A non-OK, non-JSON or timed-out upstream becomes a clear 502/504 JSON error from the proxy and a typed failure in the worker. Nothing is cached on failure. Tests with a mocked fetch: an HTML 502 page, a timeout, and a DNS error.
  - [ ] No other behaviour change: cash-ledger evidence V2 semantics are unchanged, and the order path is unchanged apart from the l2 timeout. Full gate green (npm run build, npm run test:run).
- allowed_paths:
  - src/worker/
  - src/api/routes/info.ts
  - src/utils/l2-cache.ts
  - src/__tests__/
  - plans/HYPAPER-FUNDING-RACE.md
- review_references:
  - REVIEW_POLICY.md
- review_mode: standard
