# HYPAPER-AGENT-KIT-P1: repository-local Codex agent-kit prerequisite

- status: in-progress
- owner: HyPaper infrastructure
- date: 2026-09-14
- adoption base: `08651873dbf6cc5767ff33dc1116cadaeffcb79d`
- adoption tree: `685f3dab5f56c30553dd353534e0f84f9328442b`
- kit source revision: `49220af463c9ba2e4f8c931105f71af66bef689e`
- kit source tree: `d33fa167dda45a3f3ec2867cf9ae3c7db17b2121`
- installer SHA-256: `60ff8d4347a41846160b35dd29074bf4ce16567108db54d3226a75855b371f9d`

This is a separately authorized, repository-local workflow prerequisite. It
does not implement `HYPAPER-CASH-F7-S1`, call HyPaper or Hyperliquid, read an
account or data store, start a service, send a notification, submit an order,
change a position, promote, merge main, or push.

## Deliverable

Install the clean, committed `agent_policies-codex` distribution through its
canonical first-install transaction. The distribution is the smallest
supported installer unit; no ad-hoc subset or copied hook is permitted. It
provides the registered implementer, cross-vendor sterile reviewer route,
numeric verifier, archive workflow, review-bundle isolation, and takeover and
wrapup skills required before the CASH-F7 provider milestone may become ready.

## Exact install manifest

The canonical installer may create only these managed paths:

- `.agents/skills/extdoc/SKILL.md`
- `.agents/skills/milestone/SKILL.md`
- `.agents/skills/review/SKILL.md`
- `.agents/skills/takeover/SKILL.md`
- `.agents/skills/takeover/agents/openai.yaml`
- `.agents/skills/takeover/scripts/snapshot.sh`
- `.agents/skills/wrapup/SKILL.md`
- `.codex/agents/implementer.toml`
- `.codex/agents/numeric-verifier.toml`
- `.codex/agents/research-auditor.toml`
- `.codex/agents/reviewer-fallback.toml`
- `.codex/hooks/audit-manifest.sh`
- `.codex/hooks/check-reviewer.sh`
- `.codex/hooks/gate-implementer.sh`
- `.codex/hooks/gate.conf.example`
- `.codex/hooks/prepare-review-bundle.sh`
- `.codex/hooks/reviewer-claude.sh`
- `.codex/hooks/reviewer-codex.sh`
- `.codex/hooks/run-reviewer.sh`
- `.codex/reviewer.md`
- `plans/TEMPLATE.md`
- `tools/generic_capture/README.md`
- `tools/generic_capture/__init__.py`
- `tools/generic_capture/__main__.py`
- `tools/generic_capture/archive.py`
- `tools/generic_capture/canonical.py`
- `tools/generic_capture/cli.py`
- `tools/generic_capture/paths.py`
- `tools/generic_capture/policy.py`
- `tools/generic_capture/runner.py`
- `tools/generic_capture/schemas/package-manifest.schema.json`
- `tools/generic_capture/schemas/policy.schema.json`
- `tools/generic_capture/schemas/record.schema.json`
- `tools/generic_capture/schemas/request.schema.json`
- `tools/generic_capture/tests/__init__.py`
- `tools/generic_capture/tests/fixtures/command_fixture.py`
- `tools/generic_capture/tests/fixtures/environment-policy.json`
- `tools/generic_capture/tests/qualification.py`
- `tools/generic_capture/tests/support.py`
- `tools/generic_capture/tests/test_archive.py`
- `tools/generic_capture/tests/test_canonical.py`
- `tools/generic_capture/tests/test_integration.py`
- `tools/generic_capture/tests/test_policy.py`
- `tools/generic_capture/tests/test_runner.py`
- `tools/generic_capture/tests/test_verifier.py`
- `tools/generic_capture/verifier.py`

The installer may additionally create the canonical project glue
`.codex/config.toml`, `.codex/hooks.json`, `AGENTS.md`, and the derived
`.codex/hooks/gate.conf`; append only `.codex/tmp/` and `agent_runs/` to
`.gitignore`; preserve the existing project-owned `REVIEW_POLICY.md` and
`DECISIONS.md`; and create ignored `.codex/tmp/install/...` attestation files.
The gate configuration may then be changed only to use `npm run build` and
`npm run test:run`, the repository-external archive root, and the canonical
Claude-primary/Codex-fallback reviewer routes. Any other path or source drift
is blocking.

## Acceptance criteria

1. Source and target are clean and exact before installation; installer output
   records the pre-install HEAD, branch, NUL-safe status, source revision, and
   every installed or mutated path.
2. Every managed postimage is byte-identical and mode-identical to the bound
   source, except the explicitly derived/project-owned gate configuration and
   `.gitignore` append.
3. `.codex`, `.codex/tmp`, hook, reviewer-bundle, registered implementer, and
   numeric-verifier paths are real, non-symlink, inside the worktree policy
   root, and pass their supported self-tests/probes.
4. The primary reviewer is the isolated external Claude route. The dedicated
   reviewer identity is authenticated and must be configured for Opus before
   a CASH-F7 review may start. Same-vendor fallback remains human-gated.
5. `npm run build` and `npm run test:run` pass; hooks and reviewer isolation
   are validated without reviewing product code or making a provider request.
6. The install result, exact path/digest inventory, gates, reviewer status,
   archive root, and remaining restart/model prerequisites are durably recorded.

## Out of scope

CASH-F7 product implementation or review; dual-kit composite bootstrap;
upstream kit edits; ad-hoc hook wrappers; changing the existing HyPaper domain
policy; network/provider/account/data/store/service/order/position operations;
promotion, main merge, or push.

## Next

Obtain explicit authority to change only the dedicated external reviewer
profile model from `fable[1m]` to `opus`, then rerun the no-product reviewer
identity check and mark this prerequisite implemented.

## Installation result

- Pre-install freeze commit/tree:
  `190738563c92faafb294398e339a818441a985dc` /
  `5db0d923db7b3061ef3fd77e80b196a8d46caa6f`; target status was empty.
- Canonical installer completed from the frozen clean source revision. Its
  version-2 install record is archived outside the worktree at
  `/Users/dylan/kit_archives/hypaper/HYPAPER-AGENT-KIT-P1/20260914T164245Z`;
  `install-manifest.txt` SHA-256 is
  `b6d1afb549a8345d4b7df7f9ef572502c99714916e8176dd3a785df6ee451e8b`
  and the captured pre-status SHA-256 is the empty digest
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- All 49 source-owned copied paths were byte/mode identical; the sole derived
  installed path was the project gate configuration. No unexpected path was
  created. `upgrade.sh --check` returned `RESULT=current` with only the
  expected dirty-worktree warning before the install commit.
- Real-directory/tmp subtree and mode-0600 write/delete probe: PASS. Primary
  and fallback reviewer-wrapper self-tests, review-bundle self-test,
  audit-manifest self-test, and generic-capture tests (59) all PASS.
- Project gates: `npm run build` PASS; `npm run test:run` PASS (17 files,
  262 tests). Archive root is the real non-symlink directory
  `/Users/dylan/kit_archives/hypaper`.
- Registered implementer and numeric verifier are installed at exact source
  postimages `5fff101e1548233f11b472384b4826ab6cf8c900a643c2f47dc9b4fdf09e4fe8`
  and `0a7cf816a201abfeaf29f92b29642a3167e52f3d52b7befc079eb114497bca4b`.
  The isolated Claude reviewer wrapper postimage is
  `3e675b2dd4b393d9a91199a28e9da370c7aa95f0e5ac4d708ca4f153f63e1ced`.
- The dedicated reviewer identity is authenticated, but its external
  project-independent settings currently select `fable[1m]`, not the required
  Opus model. That settings file is outside this exact repository-local install
  manifest, so it was not modified. No live reviewer request was made.
- The new `.codex` agents and hooks require a fresh Codex session before the
  installed custom-agent surface can be used. CASH-F7 remains draft and no
  product implementation or provider/runtime action occurred.
