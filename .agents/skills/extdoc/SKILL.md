---
name: extdoc
description: "Check external reports, PDFs, and data packs for publication readiness and removal of AI, tooling, and internal traces. Use when creating, revising, or handing over any client- or executive-facing document."
---

Any document that leaves the team is written in the operator's voice, as a plain
analyst report. Drafting assistance must leave no trace: the finished document is
indistinguishable from a hand-written report, and it does not ship until every
check below passes. This is a standing mandate, not a preference.

## Voice

- Plain analyst prose: facts, numbers, and the decision they support. Short
  declarative sentences. Lead with the result.
- The document stands alone. No audience, meeting, venue, or occasion references
  ("this meeting", "as discussed", "the July review"). A decision section is
  headed "Decision to make" — never "Decision this meeting owes".
- No self-awarded adjectives: honest, rigorous, candid, decision-grade,
  comprehensive, world-class. State the fact and let it stand. Neutral technical
  descriptors are fine (out-of-sample, audited, unlevered, cost-inclusive).
- Numbers are never softened or inflated to fit a narrative; courtesy lives in
  framing and word choice, not in the figures.

## Forbidden content (the scrub list)

1. **Agent/ops jargon** — rewrite in analyst terms: "needs a human go", "touches
   keys", keyless, "paper soak", "halts/gaps", "net delta held", "cash
   conservation", machinery / engine / stack / plumbing, code-complete,
   "promotes/sizes/trades nothing", "simulation only", Go/No-Go, mainnet,
   tiny-notional, "wire the gateway", "shape surprise", guardrail. ("Ran cleanly
   for three days in paper trading"; "commits real capital, so it needs
   sign-off"; "no capital is committed".)
2. **Internal identifiers** — milestone codes (M3, CO-M4, FC-M2b), repo/file
   paths, internal report filenames, chat/artifact URLs, run ids, branch names,
   AI product or model names.
3. **People and process** — no personal names, no "principal(s)", no
   "briefing/pack" framing. Masthead style: "Report · <date>".
4. Keep legitimate domain vocabulary: backtest, out-of-sample, Sharpe, drawdown,
   funding, basis, backwardation, notional, margin, capacity, market-neutral.

## Mechanics

- **HTML→PDF print-fit**: a PDF cannot scroll — scroll containers
  (`overflow-x:auto`) print a dead scrollbar and silently CLIP overflowing
  content. Inject print overrides before rendering: `overflow:visible!important`
  on every table wrapper, table font ~0.74rem with tight padding,
  `th{white-space:normal}` so headers wrap, and hide `::-webkit-scrollbar`.
  Every table must fully fit the page.
- **PDF metadata**: headless renderers stamp `/Creator: HeadlessChrome` and leak
  the source filename into `/Title`; the OS username can land in `/Author`.
  Rewrite metadata (e.g. via pypdf): neutral `/Title`, blank
  `/Author`/`/Creator`/`/Subject`/`/Keywords`.
- **Attachments**: raw data CSVs with neutral, descriptive headers may go out
  as-is under clean filenames. Internal write-ups (pipeline report .md files) do
  NOT go out — they carry milestone codes; produce a scrubbed methodology note
  instead. Always tell the operator the exact list of files to send.

## Verification — all three, before every handover

1. **Trace scan**: extract the PDF text layer AND metadata; grep both against
   the scrub list (sections above) plus personal names. Zero hits required.
2. **Clipping probe**: for every wide table, confirm the rightmost column's
   values appear in the extracted text (a clipped column vanishes silently).
3. **Visual check**: rasterize page 1 (`sips -s format png` on macOS) and
   inspect the image — full-width tables, no scrollbar artifacts, sane layout.

Fail any check → fix, re-render, re-verify. Only a clean pass ships.
