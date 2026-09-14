# Plan: <project name>

> Source of truth for milestone state. Sessions are ephemeral; this file is not.
> Status values: draft | ready | in-progress | implemented | promoted | dropped
> A fresh milestone may only enter `$milestone` when status is `ready` and acceptance criteria are written.
> A cross-host handoff may enter `$takeover` at `ready` or `in-progress`; record the adoption base and inherited paths in notes.

## Next

<one line: the single next action>

## Milestones

### M1: <title>
- status: ready
- numeric: false
- context: <optional one line: why this milestone exists / prior decision it follows>
- acceptance:
  - [ ] <criterion - testable and specific, e.g. "function returns documented fallback before warmup (unit test)">
  - [ ] <criterion>
- allowed_paths:            # hard edit boundary; reviewer blocks any change outside it
  - src/<area>/
  - tests/<area>/
- review_references:        # optional pure domain/spec evidence; never agent instruction files
  - REVIEW_POLICY.md
  - docs/<domain-spec>.md
- review_mode: standard     # set to maintenance only with explicit human authorization
# maintenance_base: <exact ancestor commit>
# Optional M7-D.2 portable review projection. Omit for legacy schema 1/2.
# maintenance_review_projection: path-neutral-v1
# The orchestrator creates a fresh bundle-external sidecar path per attempt;
# never store that physical path or raw authorization in this tracked plan.
# In path-neutral-v1, omit every path-bearing legacy attestation field below.
# Record only logical/archive-relative IDs plus their out-of-band digests:
# maintenance_attestation_bindings:
#   - kit: agent_policies-claude
#     upstream_release_attestation_id: <logical-or-archive-relative-id>
#     upstream_release_attestation_sha256: <64 lowercase hex>
#     upgrade_attestation_id: <logical-or-archive-relative-id>
#     upgrade_attestation_sha256: <64 lowercase hex>
#   - kit: agent_policies-codex       # omit this item for singleton
#     upstream_release_attestation_id: <logical-or-archive-relative-id>
#     upstream_release_attestation_sha256: <64 lowercase hex>
#     upgrade_attestation_id: <logical-or-archive-relative-id>
#     upgrade_attestation_sha256: <64 lowercase hex>
# Runtime-only resolution maps those IDs to absolute original artifact paths and
# passes them directly to the helper CLI; that mapping is never tracked/reviewable.
# Legacy M7-C singleton form (schema 1); keep all four fields or none:
# upstream_release_attestation: <absolute path outside the review bundle>
# upstream_release_attestation_sha256: <64 lowercase hex>
# upgrade_attestation: <absolute version-3 maintenance-attestation.json>
# upgrade_attestation_sha256: <64 lowercase hex>
# M7-D composite alternative (schema 2); exactly two ordered complete items,
# one for agent_policies-claude and one for agent_policies-codex.
# Do not mix maintenance_attestations with any legacy singleton field.
# maintenance_attestations:
#   - upstream_release_attestation: <absolute path outside the review bundle>
#     upstream_release_attestation_sha256: <64 lowercase hex>
#     upgrade_attestation: <absolute version-3 maintenance-attestation.json>
#     upgrade_attestation_sha256: <64 lowercase hex>
#   - upstream_release_attestation: <absolute path for the next kit>
#     upstream_release_attestation_sha256: <64 lowercase hex>
#     upgrade_attestation: <absolute version-3 maintenance-attestation.json for the next kit>
#     upgrade_attestation_sha256: <64 lowercase hex>
# instruction_deltas:       # exhaustive project-owned closure paths; inert patch only
#   - AGENTS.md
- out_of_scope: <explicitly excluded work>
- notes:
  - takeover: <optional `Claude -> Codex`; adoption-base SHA; snapshot/archive path>

### M2: <title with quantitative/math content>
- status: draft
- numeric: true
- acceptance:
  - [ ] <criterion>
- allowed_paths:
  - src/<area>/
  - tests/<area>/
- review_references:
  - REVIEW_POLICY.md
- numeric_checks:
  - name: <quantity, e.g. ewm_two_step_value>
    reference: <e.g. pandas ewm(span=20, adjust=True) on fixture data/golden/small.csv>
    tolerance: <e.g. 1e-10 relative>
- out_of_scope:
- notes:

## Parked / dropped

<milestones removed from scope, with one-line reasons>
