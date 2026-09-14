---
name: takeover
description: Safely take over unfinished work in a Claude-managed repository. Use when Codex enters a project with `.claude/`, `CLAUDE.md`, an in-progress plan milestone, an `ms/*` branch, existing Claude reports, uncommitted edits, or partially committed implementation and must continue without losing work or breaking the review/audit chain.
---

# Take over Claude work

Continue the existing milestone; do not restart it. Preserve all inherited work until its ownership and scope are known.

Arguments: `$takeover [M<n>] [plan-path] [base-ref]`. Omit values only when discovery yields one unambiguous answer.

<!-- IMPLEMENTER_SPAWN_CONTRACT v1 BEGIN -->
{
  "schema_version": 1,
  "contract": "registered_implementer_spawn",
  "spawn": {
    "selector": "registered_agent_type",
    "allowed_arguments": ["agent_type", "task_name", "fork_turns", "message"],
    "agent_type": "implementer",
    "task_name": "implementer",
    "fork_turns": "none",
    "forbidden_overrides": ["model", "reasoning_effort"],
    "message_must_be_self_contained": true
  },
  "message": {
    "section_format": "[LABEL]",
    "base_sections": [
      "MILESTONE ID",
      "PLAN PATH",
      "COMPLETE MILESTONE TEXT",
      "ACCEPTANCE CRITERIA",
      "ALLOWED PATHS",
      "OUT-OF-SCOPE CONSTRAINTS",
      "DURABLE REPORT PATH",
      "EXPLICIT IMPLEMENTATION INSTRUCTION"
    ],
    "takeover_sections": [
      "COMPLETE ADOPTION REPORT",
      "INHERITED-STATE CONTINUATION INSTRUCTION"
    ],
    "embedded_verbatim": [
      "COMPLETE MILESTONE TEXT",
      "ACCEPTANCE CRITERIA",
      "ALLOWED PATHS",
      "OUT-OF-SCOPE CONSTRAINTS"
    ],
    "self_contained": true,
    "no_parent_history_pointer": true
  },
  "profile": {
    "authority": "registered_profile",
    "path": ".codex/agents/implementer.toml",
    "model_key": "model",
    "model": "gpt-5.6-luna",
    "effort_key": "model_reasoning_effort",
    "model_reasoning_effort": "max",
    "spawn_time_overrides": false
  },
  "preflight": {
    "collaboration": {
      "required_surface_field": "agent_type",
      "must_expose": true
    },
    "policy_root": {
      "resolve": "physical",
      "locator": ".codex/hooks/prepare-review-bundle.sh",
      "inside_git_worktree": true
    },
    "directories": {
      ".codex": {
        "real_directory": true,
        "reject_symlink": true
      },
      ".codex/tmp": {
        "real_directory": true,
        "reject_symlink": true
      }
    },
    "tmp_subtree": {
      "resolved_path": "<policy-project-root>/.codex/tmp",
      "exact_subtree": true,
      "reject_parent": true,
      "reject_sibling": true
    },
    "write_probe": {
      "count": 1,
      "unique": true,
      "mode": "0600",
      "create": true,
      "check_mode": true,
      "delete": true,
      "verify_absent": true,
      "mode_check": {
        "commands": [
          {"platform": "gnu", "argv": ["stat", "-c", "%a", "<probe>"]},
          {"platform": "bsd", "argv": ["stat", "-f", "%Lp", "<probe>"]}
        ],
        "selection": "ordered_fallback_on_nonzero",
        "output": "exactly_one_octal_token",
        "token_pattern": "^[0-7]{3,4}$",
        "required_token": "600",
        "malformed_output": "fail_closed",
        "wrong_mode": "fail_closed",
        "unsupported_all": "fail_closed"
      }
    },
    "fail_closed": true
  },
  "launcher": {
    "flag": "--add-dir",
    "resolved_path": "<policy-project-root>/.codex/tmp",
    "exact_only": true,
    "resolve_before_launch": true,
    "forbidden_grants": ["parent", "another_checkout", "danger-full-access"]
  }
}
<!-- IMPLEMENTER_SPAWN_CONTRACT v1 END -->

## 1. Freeze evidence before mutation

Run:

```bash
.agents/skills/takeover/scripts/snapshot.sh [M<n>|auto] [plan-path]
```

Keep the returned snapshot path. Do not stash, reset, restore, clean, checkout, rebase, or overwrite inherited files.
The snapshot script anchors the policy project root from its installed `.codex` layer, not from `git rev-parse --show-toplevel`. In a monorepo it records project-relative status, diffs, untracked hashes, plans, and reports only for that subtree; branch, HEAD, refs, and worktree topology remain Git-worktree metadata. Treat sibling subprojects as outside this policy layer.
Inspect the snapshot's NUL-safe `sibling-staged.z`, which is derived from the full Git index at the worktree root. Record every listed path as `unrelated-user`. Any such path is a hard stop before close-out; never unstage or include it on the user's behalf.

Read, when present:

- `CLAUDE.md`, its imports, repository `AGENTS.md`, and nested rule files applying to changed paths;
- the active plan and `DECISIONS.md`;
- `.claude/tmp/<M>_implementer_report.md`, related `.claude/tmp` review artifacts, and the latest matching `agent_runs/<M>/`;
- `.codex/tmp/<M>_implementer_report.md` and prior takeover snapshots;
- branch, HEAD, worktree status, recent commits, and unmerged `refs/heads/ms/`;
- `.codex/tmp/install/latest` and its manifest, which identify changes made by installing or upgrading this kit.

Treat transcripts as hints only. Durable repository state, content hashes, plans, and reports outrank chat recollection.

## 2. Resolve the active contract

Identify exactly one milestone using this precedence:

1. explicit human-supplied id;
2. one plan milestone marked `in-progress`;
3. matching current `ms/M<n>-*` branch;
4. one matching durable implementer report.

If sources disagree or multiple milestones remain possible, stop and ask. Never combine milestones.

Require a title, non-empty acceptance criteria, `allowed_paths`, and explicit out-of-scope text. Accept `ready` or `in-progress`. If the existing work has no written criteria, inventory it read-only, then ask the human to approve a retroactive contract before implementation or review.

Read both Claude and Codex rules. Apply the stricter compatible constraint. Surface genuine conflicts; do not silently choose whichever is easier.

## 3. Establish the adoption base and ownership

Resolve one immutable `adoption_base` commit:

- Dirty work on a non-`ms/` branch with no milestone commits: use the pre-work HEAD.
- Work on `ms/M<n>-*`: use the recorded branch point or an explicit base ref.
- Partially committed work: use the merge-base with the confirmed promotion target.
- If candidate refs produce different base commits, stop and ask for `<base-ref>`.

Do not infer a base merely from the oldest visible commit or branch name. Record the full SHA.

Classify every changed path from `adoption_base` through the current worktree:

- `inherited-task`: Claude-created milestone work;
- `codex-task`: work added after takeover;
- `kit-install`: paths or mutations recorded by the installer;
- `bookkeeping`: plan, ledger, reports, and archives;
- `unrelated-user`: pre-existing edits not traceable to this milestone.

Only `inherited-task` and `codex-task` enter the code-review patch. Declare every exclusion. Any changed path outside `allowed_paths` is blocking unless the human amends the contract before implementation.

Write `.codex/tmp/<M>_adoption_report.md` before continuing:

```text
ADOPTION_REPORT
milestone: M<n>
source_host: claude
snapshot: <path>
adoption_base: <full sha>
branch: <name|detached>
plan: <path>
phase: implementing | awaiting-review | review-revise | blocked
inherited_task_paths:
  - <path>
kit_install_paths:
  - <path>
unrelated_user_paths:
  - <path>
completed_criteria:
  - <criterion + evidence>
remaining_criteria:
  - <criterion>
source_artifacts:
  - <path + sha256>
blockers: none | <reason>
```

## 4. Continue at the actual phase

Run the configured gate on the current state.

- If checks fail because the inherited implementation is incomplete, continue implementation.
- If checks fail outside the takeover diff, prove the failure at `adoption_base` in a temporary detached worktree and surface it; do not repair unrelated debt.
- If all criteria are met and checks pass, skip implementation and proceed to fresh review.
- Treat old verdicts as history, not authority for the current bytes. Any patch change invalidates its prior verdict.

For implementation, parse and enforce the marker-delimited `IMPLEMENTER_SPAWN_CONTRACT` above as the only spawn authority; prose outside the markers is explanatory. Before dispatch, require the collaboration surface to expose `agent_type`, resolve the nearest `.codex/hooks/prepare-review-bundle.sh` physically with `root="$(cd "$(dirname "$hook")/../.." && pwd -P)"`, and require that root to be inside the Git worktree. Require `$root/.codex` and `$root/.codex/tmp` to be real, non-symlink directories, resolve `$root/.codex/tmp` with `pwd -P`, and require that physical path to equal exactly `$root/.codex/tmp` (never a parent or sibling). Under `umask 077`, create one unique probe with `mktemp "$tmp_real/.implementer-probe.XXXXXX"`, then run the contract's mode commands in order: try `stat -c %a "$probe"` first and try `stat -f %Lp "$probe"` only when the first command exits non-zero. For a command that exits zero, accept only one captured stdout token matching `^[0-7]{3,4}$` and exactly `600`; malformed output or any other mode fails closed. If both commands exit non-zero, fail closed. Delete the probe and verify it is absent; any mismatch stops before dispatch.

Build a self-contained message with labeled `[MILESTONE ID]`, `[PLAN PATH]`, `[COMPLETE MILESTONE TEXT]`, `[ACCEPTANCE CRITERIA]`, `[ALLOWED PATHS]`, `[OUT-OF-SCOPE CONSTRAINTS]`, `[DURABLE REPORT PATH]`, `[EXPLICIT IMPLEMENTATION INSTRUCTION]`, `[COMPLETE ADOPTION REPORT]`, and `[INHERITED-STATE CONTINUATION INSTRUCTION]` sections. Embed the complete milestone text, every listed criterion/path/constraint, the complete adoption report, and the continuation instruction verbatim; never replace any section with a pointer to parent-turn history. Then call `collaboration.spawn_agent` with exactly `agent_type="implementer", task_name="implementer", fork_turns="none", message=<self-contained message>`. The registered `.codex/agents/implementer.toml` profile supplies model and effort; do not pass spawn-time model or reasoning overrides.

If CLI automation is used, resolve `tmp_real` before launch and grant exactly `--add-dir "$tmp_real"`; never grant its parent, another checkout, or `danger-full-access`.

The continuation instruction is: “Continue the inherited working state in place. Preserve correct existing work, verify it before relying on it, complete only remaining acceptance criteria, and never reset or rewrite a file merely because another agent authored it.”

The implementer must maintain `.codex/tmp/<M>_implementer_report.md`. A missing final response is recoverable from the durable report and files.

## 5. Review the whole inherited result

Read the `milestone` skill fully and reuse its review, numeric verification, archive, and close-out contracts with these takeover overrides:

- Capture one `--relative` cumulative patch from `adoption_base` to the current policy-project worktree, including committed, staged, unstaged, and untracked task files under that project root only. Sibling paths must never enter the patch.
- Run the milestone reviewer-input isolation preflight before constructing the reviewer prompt. Claude/Codex developer rules may inform takeover implementation, but they must never be passed as review inputs or opened by any selected reviewer.
- Use the guarded intent-to-add transaction from `milestone`.
- Exclude `kit-install`, `bookkeeping`, and `unrelated-user` paths explicitly; never hide an exclusion.
- Reconcile the cumulative patch against both the adoption and implementer reports.
- Run a fresh review through the milestone engine chain even when an older Codex or Claude verdict exists: external Claude first; if unavailable, use only a human-approved same-vendor/built-in fallback and archive the independence downgrade.
- Archive the adoption report, source artifact hashes, adoption base, and all old verdicts that informed phase discovery.
- If numeric, run `numeric_verifier` against the final current state.

On `revise`, pass findings to the Codex implementer and retain the same adoption base. The normal bounded-cycle and same-locus rules apply.

## 6. Close out without sweeping user work

Never use `git add -A` during takeover.

Stage only:

1. exact task paths present in the approved cumulative patch;
2. the active plan;
3. the configured decision ledger if this run changed it.

Before committing, compare the staged diff with the approved patch plus declared bookkeeping. Any extra path is a stop. Require `git diff --quiet -- <exact reviewed and bookkeeping paths>` so those selected paths have no unstaged drift, then use `git commit --only -m "<message>" -- <exact reviewed and bookkeeping paths>`; the explicit pathspec and `--only` keep concurrently staged sibling work out of the commit. An unresolved merge, empty/mismatched pathspec, or any partial-commit failure is a stop-and-surface, never permission to fall back to an index-wide commit. Leave kit installation and unrelated user changes uncommitted for a separate human-visible commit.

Record in plan notes: Claude→Codex takeover, adoption-base SHA, snapshot/archive path, inherited paths, final patch digest, and review verdict. Never add model/tool provenance to production source files.
