# Plan: HyPaper cash evidence S3 — immediately filled orders are indexed

> Source of truth for milestone state.

## Next

Build and deploy an image from this commit, then continue the consumer (tholos) close-out.

## Milestones

### HYPAPER-CASH-F7-S3-ioc-order-index: every created order is in its user's order index
- status: implemented
- numeric: false
- context: an end-to-end run on an isolated HyPaper (same image, fresh
  Redis/Postgres, throwaway wallet, 2026-09-26) imported a replay, opened and
  closed `xyz:CL` with IOC orders across a funding boundary, and asked for
  `getCashLedgerEvidenceV2`. It refused `owned order is absent from user order
  index` (class `membership`). `saveOrder` writes `order:<oid>` for every new
  order, but only `restOrder` and the trigger path add the oid to
  `user:<id>:orders`; an order that fills immediately (IOC, or GTC that
  crosses) is never indexed, while V2 requires every owned order hash to be
  indexed. Any account that ever took an immediate fill can therefore never
  produce V2 evidence.
- decision: fix the writer, not the checker. `saveOrder` also adds the oid to
  `user:<id>:orders` (score = `createdAt`), so the index is the complete owned
  order inventory V2 already expects. Readers of the index filter on
  `status === 'open'` (open-order views) or count it (PnL pristine check, V2),
  so indexing terminal orders changes no open-order view and makes the
  pristine check stricter, which is correct. Resting and trigger orders keep
  their existing `zadd` (idempotent for the same member and score). Orders
  created before this change are not back-filled; accounts that need V2 must
  be fresh (the only consumer wallet has no orders).
- acceptance:
  - [ ] An IOC order that fills immediately is in `user:<id>:orders` after
        `placeOrders` (test through the real `placeOrders`).
  - [ ] A GTC order that crosses and fills immediately is indexed likewise;
        resting GTC/ALO and trigger orders stay indexed exactly once.
  - [ ] An IOC order that cannot fill creates no order hash and no index
        member (unchanged behaviour, asserted).
  - [ ] Open-order views (`getOpenOrders`, `getFrontendOpenOrders`) still list
        only open orders.
  - [ ] V2 accepts an account whose history contains immediately filled
        orders created through `placeOrders` (test on the V2 engine with the
        orders written by the real writer).
  - [ ] `npm run build` and `npm run test:run` pass.
- allowed_paths:
  - src/engine/order.ts
  - src/__tests__/ (new tests only)
  - src/__tests__/helpers/redis-mock.ts (accept the field/value object form of
    `hset` that ioredis accepts and `saveOrder` uses; without it the mock
    silently drops every order hash written by the real writer)
  - plans/HYPAPER-CASH-F7-S3-ioc-order-index.md
- review_references:
  - REVIEW_POLICY.md
- review_mode: standard
- out_of_scope: back-filling old accounts, the V2 checker, any deployment.
- evidence (2026-09-26, isolated instance on an image of this change, fresh
  Redis/Postgres, wallet `0x…beef2`): replay import; IOC BUY 0.1 `xyz:CL`
  indexed at once (`user:<id>:orders` = `[1]`); held across the 22:00
  settlement; IOC SELL; `getCashLedgerEvidenceV2` for `[22:00, 22:00]`
  returned HTTP 200 with a success receipt, which the consumer's independent
  verifier accepted. The same flow on the unfixed image refused
  `owned order is absent from user order index`.
- closeout (2026-09-26): implemented interactively (Claude); cross-vendor
  Codex review cycle 1 revise (test-coverage: no writer-to-V2 test), cycle 2
  approve 6/6. Archive ~/kit_archives/hypaper/HYPAPER-CASH-F7-S3-ioc-order-index/20260926T221342Z. Gate: build PASS,
  20 files / 306 tests. Not merged or pushed.
