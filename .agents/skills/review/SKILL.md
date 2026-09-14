---
name: review
description: "Review code produced outside the milestone pipeline using gates, sterile cross-vendor review with consented quota fallback, archive, and close-out; also audit research numbers before durable use."
---

Review work that was NOT produced by the implementer subagent — human-written code or interactive-session output — with the same checks, terminal review, archive, and close-out discipline as $milestone. The primary path is cross-vendor independent; fallback paths must disclose their reduced independence. The pipeline principle is not "all code comes from the implementer"; it is "no code lands without passing checks, a validated verdict, and an audit trail."

**Mode dispatch (first argument):** `research-audit` → the **Research-audit gate (P0)** at the bottom of this file (audits a research NUMBER, not code). Anything else (`M<n>`) → the code-review pipeline below.

Argument format: `$review M5`, `$review M5 plans/other.md`, or `$review M5 plans/other.md <base-ref>`.
Plan path resolution: same as $milestone.
Report parsing rule: same as $milestone — a missing or malformed `REVIEW_VERDICT` is an infrastructure failure: retry once with the output-contract reminder appended, then stop and surface. Never treated as approve.

## Pipeline

**0. Preconditions**

- The milestone section must exist with a non-empty acceptance criteria list (status `ready` or `in-progress`). If the criteria are placeholders, STOP and have the human write them first — retroactively is fine and takes minutes; review without written criteria is vibes, not audit.
- Apply $milestone's complete reviewer-input isolation preflight, including its inside-repository, Git-visible, regular non-symlink requirements and rejection of AGENTS.md/CLAUDE.md/imports or agent configuration as review evidence.
- Run the repo's checks (`GATE_CHECKS` from `.codex/hooks/gate.conf`, else the manifest defaults) on the current state. They must pass — this substitutes for the SubagentStop gate the implementer would have faced. Any failure → stop and hand the failures to the human. Do not fix the code yourself.

**1. Capture the diff**

- If the milestone declares `review_mode: maintenance`, use only the clean committed-range branch defined by $milestone's explicit maintenance protocol. Require its `maintenance_base`, exhaustive `instruction_deltas`, and exactly one all-or-nothing attestation form: either the unchanged M7-C singleton fields or an ordered M7-D `maintenance_attestations` list with exactly two items—one Claude-kit pair and one Codex-kit pair—whose items each contain one upstream path+digest and one version-3 upgrade path+digest. Never mix the forms, accept a partial list item, or add a third kit; ignore a positional base that disagrees. A dirty tree, partial metadata, or an attempt to send instruction changes through standard mode is fail closed.
- Policy-project tree dirty → the review scope is that project's uncommitted work: apply the SAME guarded capture transaction as $milestone step 2 from the resolved policy project root (raw `command git`; NUL-safe pre-snapshot of project-relative untracked paths; `git add -N . && git diff --no-renames --binary --relative > .codex/tmp/M<n>.patch`; guaranteed `git restore --staged` rollback verified byte-identical against the scoped pre-snapshot, on failure paths too; patch must begin with `diff --git`, and an empty patch is a stop — nothing to review is an anomaly to surface).
- Policy-project tree clean and `<base-ref>` given → `command git diff --no-renames --binary --relative <base-ref>...HEAD -- . > .codex/tmp/M<n>.patch` (raw git, bypassing any wrapper; sibling subprojects remain outside the patch), then the SAME patch validation as the dirty path: the patch must begin with `diff --git`, and an empty patch is a stop — an empty range means there is nothing to review, which is an anomaly to surface, not a pass.
- Working tree clean and no base-ref → stop and ask which range to review.

**2. Review**

- Engine determination, explicit fallback consent, digest-bound sanitized review-bundle construction, prompt construction (`.codex/reviewer.md` body + bundled milestone + `REVIEW_POLICY.md` + validated `review_references` + patch + closure/patch/omitted/inventory manifests), singleton/schema-1 or composite/schema-2 maintenance bindings, the explicit `path-neutral-v1` schema-3 projection contract, the unchanged three maintenance verdict echoes, Path A/B/C execution, cleanup, canary scan, and parsing: identical to $milestone step 2. In composite mode, repeat the four helper attestation options in plan-list order and validate the full managed union and ownership partition. In path-neutral mode, require tracked logical/archive-relative IDs and digests only, resolve absolute original paths at runtime outside reviewable inputs, keep originals and physical paths in the digest-bound bundle-external sidecar, fail closed on final-payload path leakage, and require each wrapper to revalidate originals, destination, projections, exact patch, closure/deltas and projected tree before stripping all prelaunch-only environment bindings. Prefer cross-vendor CLI, then sterile same-vendor CLI; built-in fallback is last-resort and must be archived as an independence downgrade.
- Verdict handling differs in exactly one way: on `revise`, hand the blocking list to the HUMAN and stop — the human is the implementer here; there is no auto-loop. After fixes, re-run $review.
- `reject` → stop; the milestone spec itself is suspect.

**3. Archive**

- Same as $milestone step 4, preserving every singleton or composite maintenance attestation, its out-of-band digest and emitted archive path (kit-scoped in schema 2), all manifest/union/ownership bindings, and the unchanged verdict-echo parser evidence when selected, plus a `mode.txt` containing `retrofit-review`.

**4. Close out (approve only)**

- Update the plan (status `implemented` + date + result note + `## Next`); record real decisions per the gate.conf ledger contract (`DECISION_LEDGER` default `DECISIONS.md`, `DECISION_LEDGER_MODE` default `append`; `pm-promoted` → milestone `notes:` + a proposal in the report; the mode governs only the named file).
- If the reviewed scope was uncommitted, commit it now with a plain content-focused message (no AI/tooling provenance). If it was an already-committed range, commit only the plan/DECISIONS updates.
- No push, no merge. Promotion is the human's job.
- Final message: archive path + the REVIEW_VERDICT verbatim.

## Never

- Never loosen or reinterpret acceptance criteria to make a verdict pass.
- Never silently substitute the review engine.
- Never review without written acceptance criteria.

## Research-audit gate (P0) — audit a research NUMBER, not code

Invoke as `$review research-audit <manifest-draft.json>`. This promotes a research number from `unverified-scout` to `audited` so it may be quoted as a result, used as a premise, or allowed to set scope/thresholds/criteria/decisions. It runs the `research_auditor` subagent (which independently re-derives the number from the claim's reference convention) — NOT the code reviewer. The number is a distinct object from the code that produced it: this gate audits the RESULT; code correctness is a separate `$review M<n>` on the code.

**Enablement (atomic):** this gate is active only because P1-2 (verdict anti-forgery), P1-4 (wrapup unreviewed-landings), and P1-1 (bounded review execution) are all in the kit baseline. If any is reverted, disable this gate rather than run it half-wired.

**0. Scout-by-default (P0-a).** A number that CROSSES into a durable/reported output — a commit, PR, `plans/*` note, or published artifact — is `unverified-scout` BY DEFAULT, regardless of whether anyone declared it as such. It stays scout until a content-bound `audited` record (step 4) clears it. Undeclared = still scout (fail closed), never "unclassified and therefore free." While scout, the milestone EDA prohibitions apply VERBATIM: never quoted as a result, used as a premise, or allowed to set scope, thresholds, criteria, or decisions — interactive discussion ONLY. (Backstop: `$wrapup` enumerates durable landings whose numbers lack an `audited` record; the main gate is this default-scout state, not the wrapup sweep.)

**1. Pin the manifest (P0-b).** Freeze first: any out-of-repo script or ephemeral (`/tmp`) input MUST be copied to an immutable snapshot before this step — an unfrozen input is fail-closed (not reproducible = not auditable). Write a draft JSON with `subject`, `claim` (the number AND its reference convention = how to re-derive it independently), `script` (path), `inputs` (array of frozen paths), `environment`, `output` (the claimed value), then:
`.codex/hooks/audit-manifest.sh <draft.json> .codex/tmp/audit/<subject>/manifest.json` — it content-hashes the script + inputs (fail-closed on any missing file), emits key-sorted canonical JSON, and prints `manifest_digest: <sha256>` covering the full serialization (hashes + environment + output). Record that digest.

**2. Run the auditor (P0-c producer).** Generate a fresh `run_nonce` (12 hex from `/dev/urandom`) FOR THIS ATTEMPT — a distinct nonce per attempt, never reused. Invoke the `research_auditor` subagent, passing: `subject`, the manifest path, this attempt's `run_nonce`, and the pinned `manifest_digest`. It consumes the manifest and re-derives the number from the `claim` convention WITHOUT importing the producing script — a mere re-run of the author's script is NOT an audit.

**3. Parse the AUDIT_VERDICT (P0-c parser).** A verdict is valid ONLY when ALL hold — any miss is malformed → re-run once with the contract reminder AND a NEW `run_nonce` generated for that retry attempt (never carry the prior attempt's nonce forward — a fresh nonce per attempt is what closes the echo/stale-token surface), then stop and surface (never treated as audited):
- the subagent returned normally and only the CURRENT run's output is read;
- the LAST `AUDIT_VERDICT` block is the one parsed (earlier fragments/echoes ignored);
- `subject` equals this subject; `run_nonce` equals the generated nonce; `manifest_digest` equals the pinned digest;
- findings match exactly one production: `verdict: audited` ⇒ findings is exactly the untagged `1. none`; `verdict: scout` ⇒ ≥1 numbered `N. [<class>] ...`, each with exactly one `[class]` (class check applies to scout findings only).

**4. Content-bound join + archive (P0-c).** The number is cleared to `audited` ONLY if `verdict: audited` AND `manifest_digest` equals the digest pinned for THIS number's source in step 1. A stale or unrelated `audited` marker whose `manifest_digest` differs does NOT clear it — the join fails and the number stays scout. Archive `manifest.json` + `audit_verdict.txt` + the engine/subagent fingerprint under the run archive; there is no third state — no valid audited join means scout.

**Same-artifact dual close-out (P0-d).** A research artifact that is both code and result needs BOTH a code review (`approve` REVIEW_VERDICT on the script) and a number audit (`audited` AUDIT_VERDICT on its output), bound to the SAME artifact version. The bind is the shared script CONTENT hash, evaluated at join time so no new archive field is needed: the manifest's `script` sha256 must equal the sha256 of the SAME script's content at the code review's approved commit — `git show <approved-commit>:<script-path> | sha256sum` (for an out-of-repo script the code review is a `$review <base-ref>` over that path and the same content hash is computed from the reviewed bytes). This binds on script CONTENT — it does NOT equate `patch_digest` (hash of a diff) with `manifest_digest` (hash of a manifest); those hash different objects. An unrelated approved patch plus an unrelated audited number does not satisfy the dual close-out: the two script content hashes must be equal.
