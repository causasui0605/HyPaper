# Codex agent kit

## Task routing

- Specified coding task with written acceptance criteria → use the `milestone` skill.
- Existing Claude-managed work, dirty tree, `in-progress` milestone, `ms/*` branch, or `.claude/tmp` recovery artifact → use the `takeover` skill; preserve and continue the inherited state.
- Exploratory research, EDA, or reverse engineering → keep it interactive; do not blindly delegate it.
- Code produced outside the milestone pipeline → use the `review` skill before it lands.
- End a working session with the `wrapup` skill so plan state, decisions, and unreviewed landings are durable.

## Pipeline invariants

- The primary Codex agent is the orchestrator. Delegate implementation to the `implementer` custom agent only after the selected milestone is `ready`, scoped, and has acceptance criteria.
- In a Claude-managed repository, read `CLAUDE.md`, its imports, the active plan, durable Claude reports, and current Git state before acting. Claude and Codex are two hosts of one repository workflow, not separate projects.
- A handoff continues from the existing branch/worktree and reviews the cumulative diff from the adoption base. Never erase inherited changes merely to obtain a clean tree.
- Prefer the external Claude CLI configured by `REVIEWER_CMD`. Never silently replace it: missing, degraded, or quota-exhausted primary review requires explicit session-scoped human consent for the fallback chain.
- The fallback chain is sterile same-vendor Codex CLI (`FALLBACK_REVIEWER_CMD`) first, then the built-in `reviewer_fallback` agent only if that CLI also fails. Archive the built-in path as an independence downgrade because it inherited developer context.
- No selected reviewer may receive or open `AGENTS.md`, `CLAUDE.md`, their imports, or agent configuration directories as review inputs. Put reviewable project invariants in `REVIEW_POLICY.md`, the milestone, or explicit pure-spec `review_references`.
- External review must use the ephemeral sanitized bundle produced outside the source checkout; only bundle paths may enter its prompt or environment.
- Reviewer verdicts are advisory until the orchestrator validates the nonce, patch digest, milestone, grammar, and cardinality contract.
- The orchestrator owns git writes, plan updates, archive creation, and commits. Subagents may inspect git but may not mutate it.
- All loops are bounded: gate retries at most three times; implementation/review cycles at most two unless a human explicitly authorizes one additional cycle.
- Never push, merge, or promote automatically.
- Never use broad staging during takeover; stage only reviewed task paths plus declared plan/ledger bookkeeping.

## Repository-specific setup

- Configure checks, secret-scan exclusions, primary and fallback reviewer commands, timeouts, archive root, and decision-ledger behavior in `.codex/hooks/gate.conf`.
- Put developer routing here. Put every convention any reviewer must enforce in `REVIEW_POLICY.md`, the milestone, or a pure-spec `review_references` file. Review treats drift from those isolated inputs as blocking.
- Trust project hooks with `/hooks` after inspecting them. Codex ignores project `.codex` config and hooks in untrusted repositories.
