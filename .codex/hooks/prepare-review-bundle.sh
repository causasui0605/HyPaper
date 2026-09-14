#!/usr/bin/env bash
# Build a reviewer-visible snapshot without agent instruction files.
# Production calls use the explicit option contract printed by usage().
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SELF="$SCRIPT_DIR/$(basename "$0")"
HOST_DIR="$(basename "$(dirname "$SCRIPT_DIR")")"

secret_equivalent_path() {
  case "$1" in
    .env|.env.*|.env/*|*/.env|*/.env.*|*/.env/*) return 0 ;;
    *) return 1 ;;
  esac
}

forbidden_path() {
  secret_equivalent_path "$1" && return 0
  case "$1" in
    AGENTS.md|*/AGENTS.md|CLAUDE.md|*/CLAUDE.md|\
    .claude|.claude/*|*/.claude|*/.claude/*|\
    .codex|.codex/*|*/.codex|*/.codex/*|\
    .agents|.agents/*|*/.agents|*/.agents/*) return 0 ;;
    *) return 1 ;;
  esac
}

sha256_path() {
  python3 - "$1" <<'PY'
import hashlib
from pathlib import Path
import sys

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

patch_has_rejected_header() {
  LC_ALL=C awk '
    function secret_equivalent_header(line) {
      return line ~ /(^|[[:space:]\/"])(\.\/)?\.env($|[.\/[:space:]"])/
    }
    /^diff --git / {
      in_headers = 1
      if (secret_equivalent_header($0)) {
        rejected = 1
        exit
      }
      next
    }
    in_headers && /^@@/ {
      in_headers = 0
      next
    }
    in_headers && ($0 == "GIT binary patch" || $0 ~ /^Binary files .* differ$/) {
      in_headers = 0
      next
    }
    in_headers && (/^(---|\+\+\+) / || /^(rename|copy) (from|to) /) {
      if (secret_equivalent_header($0)) {
        rejected = 1
        exit
      }
    }
    END {
      exit(rejected ? 0 : 1)
    }
  ' "$1"
}

self_test() {
  local tmp_parent tmp repo project sibling bundle bundle_input patch runner
  local dir_repo dir_project dir_bundle dir_runner rel reject_i rejected_patch
  local rejected_bundle rejected_output quoted_patch quoted_bundle quoted_output
  local safe_quoted_patch safe_quoted_bundle safe_quoted_output
  local header_case safe_prefixless_patch safe_prefixless_bundle safe_prefixless_output
  local body_patch body_bundle body_output bundle_digest
  local binary_patch binary_bundle binary_output summary_patch summary_bundle summary_output
  local maintenance_repo maintenance_project maintenance_runner maintenance_patch
  local maintenance_bundle maintenance_output maintenance_upstream maintenance_upgrade
  local maintenance_base maintenance_head upstream_digest upgrade_digest
  local maintenance_nonce maintenance_digest maintenance_unknown_upstream
  local maintenance_partial_upstream maintenance_partial_upstream_digest
  local projection_bundle projection_output projection_sidecar projection_digest
  local projection_head projection_patch projection_invalid_head projection_invalid_patch
  local leak_base leak_head leak_patch leak_upgrade leak_upgrade_digest
  local leak_bundle leak_sidecar
  local projection_stale_upgrade projection_stale_digest
  local composite_repo composite_project composite_runner composite_patch
  local composite_bundle composite_output composite_base composite_head
  local composite_upstream_claude composite_upgrade_claude
  local composite_upstream_codex composite_upgrade_codex
  local composite_upstream_claude_digest composite_upgrade_claude_digest
  local composite_upstream_codex_digest composite_upgrade_codex_digest
  local composite_nonce composite_digest composite_case
  local composite_projection_bundle composite_projection_output
  local composite_projection_sidecar composite_projection_sidecar_digest
  local composite_projection_head composite_projection_patch
  local composite_pxim_bundle composite_pxim_output
  local composite_pxim_upgrade_claude composite_pxim_upgrade_codex
  local composite_pxim_upgrade_claude_digest composite_pxim_upgrade_codex_digest
  local composite_mixed_upstream composite_mixed_upgrade
  local composite_mixed_upstream_digest composite_mixed_upgrade_digest
  local composite_incompatible_upstream composite_incompatible_upgrade
  local composite_incompatible_upstream_digest composite_incompatible_upgrade_digest
  local composite_unknown_upstream composite_unknown_upstream_digest
  local composite_unclassified_upstream composite_unclassified_upgrade
  local composite_unclassified_upstream_digest composite_unclassified_upgrade_digest
  local composite_tampered_upstream
  local maintenance_unknown_upgrade maintenance_duplicate_upstream
  local unknown_upstream_digest unknown_upgrade_digest duplicate_upstream_digest
  local attestation_canary tmp_instruction_canary
  local tmp_control_patch tmp_control_bundle tmp_control_output tmp_control_rel
  local non_tmp_name non_tmp_rel non_tmp_patch non_tmp_bundle non_tmp_output
  local canary_prefix domain_canary cycle_canary unicode_canary ignored_canary
  local leading_canary extensionless_canary ignored_root_canary space_canary
  local declared_canary ambient_canary unrelated_canary newline_canary canary
  local fixture_kit m22_matrix_program m22_matrix_one m22_matrix_two
  local m23_matrix_program m23_matrix_one m23_matrix_two
  if [ "$HOST_DIR" = .claude ]; then
    fixture_kit=agent_policies-claude
  else
    fixture_kit=agent_policies-codex
  fi
  run_bundle() {
    local selected_runner="$1" selected_patch="$2" selected_bundle="$3" selected_root="$4"
    shift 4
    "$selected_runner" \
      --patch "$selected_patch" \
      --bundle "$selected_bundle" \
      --plan "$selected_root/plans/M7.md" \
      --review-policy "$selected_root/REVIEW_POLICY.md" \
      "$@"
  }
  # Deliberately retain a trailing slash and add another one: stock macOS
  # commonly exports TMPDIR this way, and mktemp may echo the doubled spelling.
  tmp_parent="${TMPDIR:-/tmp}/"
  tmp="$(mktemp -d "${tmp_parent}/review-bundle-selftest.XXXXXX")"
  tmp="$(cd "$tmp" && pwd -P)"
  trap 'rm -rf "$tmp"' RETURN
  canary_prefix="m7-instruction-${RANDOM}-${RANDOM}"
  domain_canary="${canary_prefix}-domain"
  cycle_canary="${canary_prefix}-cycle"
  unicode_canary="${canary_prefix}-unicode"
  ignored_canary="${canary_prefix}-ignored"
  leading_canary="${canary_prefix}-leading"
  extensionless_canary="${canary_prefix}-extensionless"
  ignored_root_canary="${canary_prefix}-ignored-root"
  space_canary="${canary_prefix}-space"
  declared_canary="${canary_prefix}-declared"
  ambient_canary="${canary_prefix}-ambient"
  unrelated_canary="${canary_prefix}-unrelated"
  newline_canary="${canary_prefix}-newline"
  tmp_instruction_canary="${canary_prefix}-tmp-instruction"
  repo="$tmp/repo"
  project="$repo/services/app"
  sibling="$repo/services/sibling"
  bundle="$tmp/bundle"
  bundle_input="$tmp//bundle"
  patch="$tmp/review.patch"
  git -C "$tmp" init -q repo
  mkdir -p "$project/src" "$project/nested/deeper" "$project/.claude" \
    "$project/.codex" "$project/.agents" "$project/$HOST_DIR/hooks" "$sibling"
  mkdir -p "$project/plans"
  runner="$project/$HOST_DIR/hooks/$(basename "$SELF")"
  cp -p "$SELF" "$runner"
  printf 'policy\n' > "$project/REVIEW_POLICY.md"
  printf '# M7\n' > "$project/plans/M7.md"
  printf 'source\n' > "$project/src/main.py"
  printf '%s\n' '-- .env' 'ordinary' > "$project/safe.txt"
  printf 'TRACKED_ROOT_ENV_SENTINEL\n' > "$project/.env"
  printf 'TRACKED_NESTED_ENV_SENTINEL\n' > "$project/nested/.env.local"
  printf 'agent\n' > "$project/AGENTS.md"
  printf 'claude\n' > "$project/nested/CLAUDE.md"
  printf 'hidden\n' > "$project/.claude/hidden"
  printf 'hidden\n' > "$project/.codex/hidden"
  printf 'hidden\n' > "$project/.agents/hidden"
  printf 'sibling\n' > "$sibling/not-in-bundle.txt"
  ln -s main.py "$project/src/link.txt"
  git -C "$repo" add .
  printf 'UNTRACKED_ENV_SENTINEL\n' > "$project/src/.env"
  printf 'UNTRACKED_NESTED_ENV_SENTINEL\n' > "$project/nested/deeper/.env.production"
  printf 'source changed\n' > "$project/src/main.py"
  git -C "$repo" diff --no-renames --binary --relative=services/app -- \
    services/app/src/main.py > "$patch"
  (cd "$project/src" && run_bundle "$runner" "$patch" "$bundle_input" "$project") > "$tmp/result.env"
  [ -f "$bundle/REVIEW_POLICY.md" ]
  [ -f "$bundle/src/main.py" ]
  [ ! -e "$bundle/services" ]
  [ ! -e "$bundle/not-in-bundle.txt" ]
  [ ! -e "$bundle/AGENTS.md" ]
  [ ! -e "$bundle/nested/CLAUDE.md" ]
  [ ! -e "$bundle/.claude" ]
  [ ! -e "$bundle/.codex" ]
  [ ! -e "$bundle/.agents" ]
  [ ! -e "$bundle/.env" ]
  [ ! -e "$bundle/nested/.env.local" ]
  [ ! -e "$bundle/src/.env" ]
  [ ! -e "$bundle/nested/deeper/.env.production" ]
  [ ! -e "$bundle/src/link.txt" ]
  if grep -R -Fq '_ENV_SENTINEL' "$bundle"; then
    echo "secret-equivalent sentinel leaked into review bundle" >&2
    return 1
  fi
  grep -qx 'src/link.txt' "$bundle/.review-input/omitted-symlinks.txt"
  cmp "$patch" "$bundle/.review-input/patch.diff"
  grep -qx "review_repo_root=$bundle" "$tmp/result.env"
  grep -qx "review_patch=$bundle/.review-input/patch.diff" "$tmp/result.env"
  bundle_digest="$(sha256_path "$bundle/.review-input/bundle-inventory.json")"
  grep -qx "review_bundle_digest=$bundle_digest" "$tmp/result.env"

  body_patch="$tmp/body.patch"
  body_bundle="$tmp/body-bundle"
  body_output="$tmp/body.out"
  printf '%s\n' '++ .env' 'ordinary' > "$project/safe.txt"
  git -C "$repo" diff -- services/app/safe.txt > "$body_patch"
  grep -Fqx -- '--- .env' "$body_patch"
  grep -Fqx '+++ .env' "$body_patch"
  (cd "$project" && run_bundle "$runner" "$body_patch" "$body_bundle" "$project") > "$body_output"
  cmp "$body_patch" "$body_bundle/.review-input/patch.diff"
  grep -qx "review_repo_root=$body_bundle" "$body_output"
  grep -qx "review_patch=$body_bundle/.review-input/patch.diff" "$body_output"

  printf '\000old-binary\377\n' > "$project/src/blob.bin"
  git -C "$repo" add "$project/src/blob.bin"
  printf '\000new-binary\376\n' > "$project/src/blob.bin"
  binary_patch="$tmp/binary.patch"
  binary_bundle="$tmp/binary-bundle"
  binary_output="$tmp/binary.out"
  git -C "$repo" diff --no-renames --binary --relative=services/app -- \
    services/app/src/blob.bin > "$binary_patch"
  grep -Fqx 'GIT binary patch' "$binary_patch"
  (cd "$project" && run_bundle \
    "$runner" "$binary_patch" "$binary_bundle" "$project") > "$binary_output"
  cmp "$binary_patch" "$binary_bundle/.review-input/patch.diff"
  grep -qx "review_repo_root=$binary_bundle" "$binary_output"

  dir_repo="$tmp/directory-repo"
  dir_project="$dir_repo/project"
  dir_bundle="$tmp/directory-bundle"
  git -C "$tmp" init -q "$(basename "$dir_repo")"
  mkdir -p "$dir_project/src" "$dir_project/.env" \
    "$dir_project/nested/.env" "$dir_project/$HOST_DIR/hooks"
  mkdir -p "$dir_project/plans"
  dir_runner="$dir_project/$HOST_DIR/hooks/$(basename "$SELF")"
  cp -p "$SELF" "$dir_runner"
  printf 'policy\n' > "$dir_project/REVIEW_POLICY.md"
  printf '# M7\n' > "$dir_project/plans/M7.md"
  printf 'ordinary\n' > "$dir_project/src/main.py"
  printf 'ROOT_ENV_DIRECTORY_SENTINEL\n' > "$dir_project/.env/secret.txt"
  printf 'NESTED_ENV_DIRECTORY_SENTINEL\n' > "$dir_project/nested/.env/secret.txt"
  git -C "$dir_repo" add .
  (cd "$dir_project" && run_bundle "$dir_runner" "$patch" "$dir_bundle" "$dir_project") > "$tmp/directory-result.env"
  [ -f "$dir_bundle/src/main.py" ]
  [ ! -e "$dir_bundle/.env" ]
  [ ! -e "$dir_bundle/nested/.env" ]
  if grep -R -Fq '_ENV_DIRECTORY_SENTINEL' "$dir_bundle"; then
    echo "literal .env directory sentinel leaked into review bundle" >&2
    return 1
  fi

  reject_i=0
  for rel in ".env" "nested/.env.local" ".env/token.txt" "nested/.env/token.txt"; do
    reject_i=$((reject_i + 1))
    rejected_patch="$tmp/rejected-$reject_i.patch"
    rejected_bundle="$tmp/rejected-bundle-$reject_i"
    rejected_output="$tmp/rejected-$reject_i.out"
    printf 'diff --git a/%s b/%s\n' "$rel" "$rel" > "$rejected_patch"
    if (cd "$project" && run_bundle "$runner" "$rejected_patch" "$rejected_bundle" "$project") > "$rejected_output" 2>&1; then
      echo "secret-equivalent review patch was accepted" >&2
      return 1
    fi
    [ ! -e "$rejected_bundle" ]
    grep -qx 'review patch rejected due to a secret-equivalent path header' "$rejected_output"
  done

  quoted_patch="$tmp/quoted.patch"
  quoted_bundle="$tmp/quoted-bundle"
  quoted_output="$tmp/quoted.out"
  printf 'diff --git "a/safe dir/.env" "b/safe dir/.env"\n' > "$quoted_patch"
  if (cd "$project" && run_bundle "$runner" "$quoted_patch" "$quoted_bundle" "$project") > "$quoted_output" 2>&1; then
    echo "ambiguous quoted review patch header was accepted" >&2
    return 1
  fi
  [ ! -e "$quoted_bundle" ]
  grep -qx 'review patch rejected due to a secret-equivalent path header' "$quoted_output"

  for header_case in rename-unquoted rename-quoted copy-unquoted copy-quoted \
    diff-prefixless old-prefixless new-prefixless binary-marker-after-secret \
    binary-summary-after-secret binary-next-diff-secret; do
    reject_i=$((reject_i + 1))
    rejected_patch="$tmp/rejected-$reject_i.patch"
    rejected_bundle="$tmp/rejected-bundle-$reject_i"
    rejected_output="$tmp/rejected-$reject_i.out"
    case "$header_case" in
      rename-unquoted)
        printf '%s\n' 'diff --git safe.txt safe.txt' 'rename from .env' 'rename to safe.txt' > "$rejected_patch"
        ;;
      rename-quoted)
        printf '%s\n' 'diff --git safe.txt safe.txt' 'rename from ".env"' 'rename to "safe name.txt"' > "$rejected_patch"
        ;;
      copy-unquoted)
        printf '%s\n' 'diff --git safe.txt safe.txt' 'copy from .env.local' 'copy to safe.txt' > "$rejected_patch"
        ;;
      copy-quoted)
        printf '%s\n' 'diff --git safe.txt safe.txt' 'copy from ".env.production"' 'copy to "safe name.txt"' > "$rejected_patch"
        ;;
      diff-prefixless)
        printf '%s\n' 'diff --git .env .env' > "$rejected_patch"
        ;;
      old-prefixless)
        printf '%s\n' 'diff --git safe.txt safe.txt' '--- .env' '+++ safe.txt' > "$rejected_patch"
        ;;
      new-prefixless)
        printf '%s\n' 'diff --git safe.txt safe.txt' '--- safe.txt' '+++ ".env.local"' > "$rejected_patch"
        ;;
      binary-marker-after-secret)
        printf '%s\n' 'diff --git safe.bin safe.bin' 'rename from .env' \
          'GIT binary patch' > "$rejected_patch"
        ;;
      binary-summary-after-secret)
        printf '%s\n' 'diff --git safe.bin safe.bin' '--- .env' \
          'Binary files safe.bin and safe.bin differ' > "$rejected_patch"
        ;;
      binary-next-diff-secret)
        printf '%s\n' 'diff --git safe.bin safe.bin' 'GIT binary patch' \
          'rename from .env' 'diff --git .env .env' > "$rejected_patch"
        ;;
    esac
    if (cd "$project" && run_bundle "$runner" "$rejected_patch" "$rejected_bundle" "$project") > "$rejected_output" 2>&1; then
      echo "root secret-equivalent patch header was accepted" >&2
      return 1
    fi
    [ ! -e "$rejected_bundle" ]
    grep -qx 'review patch rejected due to a secret-equivalent path header' "$rejected_output"
  done

  mkdir -p "$project/rules" "$project/docs"
  printf '@AGENTS.md\n' > "$project/CLAUDE.md"
  printf '@rules/domain.md\n' > "$project/AGENTS.md"
  printf '%s\n' '@cycle.md' '@"space policy.md"' '@"unicode-策略.md"' \
    '@ignored.md' '@-leading-policy.md' '@nested.noext' \
    "$domain_canary" > "$project/rules/domain.md"
  printf '%s\n' '@domain.md' "$cycle_canary" > "$project/rules/cycle.md"
  printf '%s\n' "$unicode_canary" > "$project/rules/unicode-策略.md"
  printf '%s\n' "$ignored_canary" > "$project/rules/ignored.md"
  printf '%s\n' "$leading_canary" > "$project/rules/-leading-policy.md"
  printf '@deep.md\n' > "$project/rules/nested.noext"
  printf '%s\n' "$extensionless_canary" > "$project/rules/deep.md"
  mkdir -p "$project/ignored-root"
  printf '@rules/ignored-root-target.md\n' > "$project/ignored-root/CLAUDE.md"
  printf '%s\n' "$ignored_root_canary" > "$project/rules/ignored-root-target.md"
  printf 'SAFE_REVIEW_REFERENCE\n' > "$project/docs/spec.md"
  printf '%s\n' "$ambient_canary" > "$project/docs/ambient.md"
  printf 'PATCHED_AMBIENT_DOC_SENTINEL\n' > "$project/docs/patched-ambient.md"
  printf '%s\n' "$declared_canary" > "$project/docs/declared.md"
  printf 'docs/declared.md\n' > "$project/$HOST_DIR/review-forbidden-paths"
  printf '%s\n' 'rules/ignored.md' 'ignored-root/CLAUDE.md' >> "$project/.gitignore"
  printf 'new source\n' > "$project/src/new.py"
  git -C "$repo" add "$project/CLAUDE.md" "$project/AGENTS.md" \
    "$project/rules/domain.md" "$project/rules/cycle.md" \
    "$project/rules/unicode-策略.md" "$project/rules/-leading-policy.md" \
    "$project/rules/nested.noext" "$project/rules/deep.md" \
    "$project/rules/ignored-root-target.md" "$project/docs/spec.md" \
    "$project/docs/ambient.md" "$project/docs/patched-ambient.md" \
    "$project/docs/declared.md" "$project/.gitignore" \
    "$project/$HOST_DIR/review-forbidden-paths"
  printf 'PATCHED_AMBIENT_DOC_CHANGED\n' > "$project/docs/patched-ambient.md"
  git -C "$repo" add -N "$project/src/new.py"
  printf '%s\n' "$space_canary" > "$project/rules/space policy.md"
  printf '%s\n' "$unrelated_canary" > "$project/src/unrelated.py"

  dynamic_patch="$tmp/dynamic.patch"
  dynamic_bundle="$tmp/dynamic-bundle"
  dynamic_output="$tmp/dynamic.out"
  git -C "$repo" diff --no-renames --binary --relative=services/app -- \
    services/app/src/main.py services/app/src/new.py \
    services/app/docs/patched-ambient.md > "$dynamic_patch"
  run_bundle "$runner" "$dynamic_patch" "$dynamic_bundle" "$project" \
    --review-reference "$project/docs/spec.md" > "$dynamic_output"
  [ -f "$dynamic_bundle/src/main.py" ]
  [ -f "$dynamic_bundle/src/new.py" ]
  [ ! -e "$dynamic_bundle/src/unrelated.py" ]
  [ -f "$dynamic_bundle/docs/spec.md" ]
  [ ! -e "$dynamic_bundle/docs/ambient.md" ]
  [ ! -e "$dynamic_bundle/docs/patched-ambient.md" ]
  [ ! -e "$dynamic_bundle/docs/declared.md" ]
  [ ! -e "$dynamic_bundle/CLAUDE.md" ]
  [ ! -e "$dynamic_bundle/AGENTS.md" ]
  [ ! -e "$dynamic_bundle/rules" ]
  [ -f "$dynamic_bundle/.review-input/instruction-closure.json" ]
  [ -f "$dynamic_bundle/.review-input/patch-paths.json" ]
  [ -f "$dynamic_bundle/.review-input/bundle-inventory.json" ]
  [ -f "$dynamic_bundle/.review-input/omitted-symlinks.json" ]
  for canary in "$domain_canary" "$cycle_canary" "$unicode_canary" \
      "$ignored_canary" "$leading_canary" "$extensionless_canary" \
      "$ignored_root_canary" "$space_canary" "$declared_canary" \
      "$ambient_canary" "$unrelated_canary"; do
    if grep -R -Fq "$canary" "$dynamic_bundle"; then
      echo "instruction or ambient-document sentinel leaked into review bundle" >&2
      return 1
    fi
  done
  python3 - "$dynamic_bundle" <<'PY'
import hashlib
import json
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
closure = json.loads((root / ".review-input/instruction-closure.json").read_text())
paths = {item["path"]: item for item in closure["paths"]}
required = {
    "AGENTS.md",
    "CLAUDE.md",
    "rules/domain.md",
    "rules/cycle.md",
    "rules/space policy.md",
    "rules/unicode-策略.md",
    "rules/ignored.md",
    "rules/-leading-policy.md",
    "rules/nested.noext",
    "rules/deep.md",
    "rules/ignored-root-target.md",
    "ignored-root/CLAUDE.md",
    "docs/declared.md",
}
assert required <= set(paths)
assert "imported" in paths["rules/domain.md"]["kinds"]
assert "declared" in paths["docs/declared.md"]["kinds"]
assert paths["rules/ignored.md"]["git_visibility"] == "ignored"
assert paths["ignored-root/CLAUDE.md"]["git_visibility"] == "ignored"
patch_paths = json.loads((root / ".review-input/patch-paths.json").read_text())
assert patch_paths["paths"] == ["docs/patched-ambient.md", "src/main.py", "src/new.py"]
inventory_file = root / ".review-input/bundle-inventory.json"
inventory = json.loads(inventory_file.read_text())
expected = {item["path"]: item for item in inventory["files"]}
actual = {}
for path in root.rglob("*"):
    if path.is_dir() or path == inventory_file:
        continue
    assert path.is_file() and not path.is_symlink()
    rel = path.relative_to(root).as_posix()
    actual[rel] = {
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "mode": stat.S_IMODE(path.stat().st_mode),
    }
assert set(actual) == set(expected)
for rel, values in actual.items():
    assert values["sha256"] == expected[rel]["sha256"]
    assert values["mode"] == expected[rel]["mode"]
PY
  grep -qx "review_instruction_manifest=$dynamic_bundle/.review-input/instruction-closure.json" "$dynamic_output"
  grep -qx "review_bundle_manifest=$dynamic_bundle/.review-input/bundle-inventory.json" "$dynamic_output"

  imported_patch="$tmp/imported.patch"
  imported_bundle="$tmp/imported-bundle"
  printf '%s\n' '@cycle.md' '@"space policy.md"' '@"unicode-策略.md"' \
    '@ignored.md' '@-leading-policy.md' '@nested.noext' \
    'domain changed' > "$project/rules/domain.md"
  git -C "$repo" diff --no-renames --binary --relative=services/app -- \
    services/app/rules/domain.md > "$imported_patch"
  if run_bundle "$runner" "$imported_patch" "$imported_bundle" "$project" \
      > "$tmp/imported.out" 2>&1; then
    echo "patch containing an imported instruction was accepted" >&2
    return 1
  fi
  [ ! -e "$imported_bundle" ]
  grep -q 'review patch contains an instruction-closure path: rules/domain.md' "$tmp/imported.out"
  printf '%s\n' '@cycle.md' '@"space policy.md"' '@"unicode-策略.md"' \
    '@ignored.md' '@-leading-policy.md' '@nested.noext' \
    "$domain_canary" > "$project/rules/domain.md"

  printf '%s\n' '@rules/domain.md' '# changed fixed instruction root' > "$project/AGENTS.md"
  git -C "$repo" diff --no-renames --binary --relative=services/app -- \
    services/app/AGENTS.md > "$tmp/fixed-root.patch"
  if run_bundle "$runner" "$tmp/fixed-root.patch" "$tmp/fixed-root-bundle" "$project" \
      > "$tmp/fixed-root.out" 2>&1; then
    echo "patch containing a fixed instruction root was accepted" >&2
    return 1
  fi
  grep -q 'review patch contains an instruction-closure path: AGENTS.md' "$tmp/fixed-root.out"
  printf '@rules/domain.md\n' > "$project/AGENTS.md"

  printf '%s\n' 'docs/declared.md' '# classification change' \
    > "$project/$HOST_DIR/review-forbidden-paths"
  git -C "$repo" diff --no-renames --binary --relative=services/app -- \
    "services/app/$HOST_DIR/review-forbidden-paths" > "$tmp/classification.patch"
  if run_bundle "$runner" "$tmp/classification.patch" "$tmp/classification-bundle" "$project" \
      > "$tmp/classification.out" 2>&1; then
    echo "patch changing the closure classification manifest was accepted" >&2
    return 1
  fi
  grep -q "review patch contains an instruction-closure path: $HOST_DIR/review-forbidden-paths" \
    "$tmp/classification.out"
  printf 'docs/declared.md\n' > "$project/$HOST_DIR/review-forbidden-paths"

  conflict_bundle="$tmp/reference-conflict-bundle"
  if run_bundle "$runner" "$dynamic_patch" "$conflict_bundle" "$project" \
      --review-reference "$project/rules/domain.md" > "$tmp/reference-conflict.out" 2>&1; then
    echo "imported instruction was accepted as a review reference" >&2
    return 1
  fi
  [ ! -e "$conflict_bundle" ]
  grep -q 'explicit review input is an agent instruction or forbidden path' "$tmp/reference-conflict.out"

  printf '@rules/link.md\n' > "$project/AGENTS.md"
  ln -s domain.md "$project/rules/link.md"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/symlink-import-bundle" "$project" \
      > "$tmp/symlink-import.out" 2>&1; then
    echo "symlink instruction import was accepted" >&2
    return 1
  fi
  grep -q 'instruction import resolves to a symlink' "$tmp/symlink-import.out"
  rm "$project/rules/link.md"

  printf '@../outside.md\n' > "$project/AGENTS.md"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/traversal-import-bundle" "$project" \
      > "$tmp/traversal-import.out" 2>&1; then
    echo "traversal instruction import was accepted" >&2
    return 1
  fi
  grep -q 'unsafe traversal' "$tmp/traversal-import.out"

  printf '@/tmp/outside.md\n' > "$project/AGENTS.md"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/absolute-import-bundle" "$project" \
      > "$tmp/absolute-import.out" 2>&1; then
    echo "absolute instruction import was accepted" >&2
    return 1
  fi
  grep -q 'must be project-relative' "$tmp/absolute-import.out"

  printf '@"unterminated\n' > "$project/AGENTS.md"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/malformed-import-bundle" "$project" \
      > "$tmp/malformed-import.out" 2>&1; then
    echo "malformed instruction import was accepted" >&2
    return 1
  fi
  grep -q 'malformed quoted instruction import' "$tmp/malformed-import.out"

  printf '@{rules/domain.md}\n' > "$project/AGENTS.md"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/unknown-import-bundle" "$project" \
      > "$tmp/unknown-import.out" 2>&1; then
    echo "unknown instruction import syntax was accepted" >&2
    return 1
  fi
  grep -q 'dangling instruction import' "$tmp/unknown-import.out"

  printf '@rules/domain.md\n' > "$project/AGENTS.md"
  printf '@rules/deep.md\n' > "$project/nested.noext"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/ambiguous-import-bundle" "$project" \
      > "$tmp/ambiguous-import.out" 2>&1; then
    echo "ambiguous instruction import was accepted" >&2
    return 1
  fi
  grep -q 'ambiguous instruction import from rules/domain.md: nested.noext' \
    "$tmp/ambiguous-import.out"
  rm "$project/nested.noext"

  printf '@rules/invalid.md\n' > "$project/AGENTS.md"
  printf '\377\n' > "$project/rules/invalid.md"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/invalid-utf8-import-bundle" "$project" \
      > "$tmp/invalid-utf8-import.out" 2>&1; then
    echo "invalid UTF-8 instruction import was accepted" >&2
    return 1
  fi
  grep -q 'instruction file must be valid UTF-8: rules/invalid.md' \
    "$tmp/invalid-utf8-import.out"
  rm "$project/rules/invalid.md"

  printf '%s\n' "$newline_canary" > "$project/rules/line
break.md"
  printf '@rules/line\nbreak.md\n' > "$project/AGENTS.md"
  if run_bundle "$runner" "$dynamic_patch" "$tmp/newline-import-bundle" "$project" \
      > "$tmp/newline-import.out" 2>&1; then
    echo "newline-spanning instruction import was accepted" >&2
    return 1
  fi
  grep -q 'contains a line break' "$tmp/newline-import.out"
  rm "$project/rules/line
break.md"
  printf '@rules/domain.md\n' > "$project/AGENTS.md"

  maintenance_repo="$tmp/maintenance-repo"
  maintenance_project="$maintenance_repo/services/app"
  maintenance_runner="$maintenance_project/$HOST_DIR/hooks/$(basename "$SELF")"
  maintenance_patch="$tmp/maintenance.patch"
  maintenance_bundle="$tmp/maintenance-bundle"
  maintenance_output="$tmp/maintenance.out"
  maintenance_upstream="$tmp/upstream-attestation.json"
  maintenance_upgrade="$tmp/upgrade-attestation.json"
  maintenance_nonce="maintenance-bundle-selftest-${RANDOM}-${RANDOM}"
  git init -q "$maintenance_repo"
  git -C "$maintenance_repo" config user.name maintenance-self-test
  git -C "$maintenance_repo" config user.email maintenance@example.invalid
  mkdir -p "$maintenance_project/$HOST_DIR/hooks" \
    "$maintenance_project/$HOST_DIR/policies" \
    "$maintenance_project/$HOST_DIR/tmp/tracked" \
    "$maintenance_project/nested/$HOST_DIR/tmp/tracked" \
    "$maintenance_project/plans" "$maintenance_project/src/deep" \
    "$maintenance_repo/services/sibling"
  cp -p "$SELF" "$maintenance_runner"
  printf 'policy\n' > "$maintenance_project/REVIEW_POLICY.md"
  printf '# M7-A\n' > "$maintenance_project/plans/M7.md"
  printf 'reference root: %s\n' "$maintenance_project" \
    > "$maintenance_project/plans/path-leak-reference.md"
  printf 'old release\n' > "$maintenance_project/README.md"
  printf 'unchanged managed\n' > "$maintenance_project/CURRENT.md"
  printf 'project instruction before candidate\n' > "$maintenance_project/AGENTS.md"
  printf 'old project source\n' > "$maintenance_project/src/project.py"
  printf 'GATE_CHECKS=("true")\n' \
    > "$maintenance_project/$HOST_DIR/hooks/gate.conf"
  printf 'plans/TEMPLATE.md\n' > "$maintenance_project/$HOST_DIR/kit-overrides"
  printf '#!/usr/bin/env bash\nprintf "project hook base\\n"\n' \
    > "$maintenance_project/$HOST_DIR/hooks/project-hook.sh"
  chmod +x "$maintenance_project/$HOST_DIR/hooks/project-hook.sh"
  printf 'non-tmp fixed AGENTS root\n' \
    > "$maintenance_project/$HOST_DIR/policies/AGENTS.md"
  printf 'non-tmp fixed CLAUDE root\n' \
    > "$maintenance_project/$HOST_DIR/policies/CLAUDE.md"
  printf '/%s/tmp/\n/nested/%s/tmp/\n' "$HOST_DIR" "$HOST_DIR" \
    > "$maintenance_project/.gitignore"
  for tmp_control_rel in \
    "$HOST_DIR/tmp/tracked/AGENTS.md" \
    "$HOST_DIR/tmp/tracked/CLAUDE.md" \
    "nested/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "nested/$HOST_DIR/tmp/tracked/CLAUDE.md"; do
    printf '@AGENTS.md\n%s:%s\n' "$tmp_instruction_canary" "$tmp_control_rel" \
      > "$maintenance_project/$tmp_control_rel"
  done
  printf 'sibling sentinel\n' > "$maintenance_repo/services/sibling/sentinel.txt"
  git -C "$maintenance_repo" add .
  git -C "$maintenance_repo" add -f \
    "services/app/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "services/app/$HOST_DIR/tmp/tracked/CLAUDE.md" \
    "services/app/nested/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "services/app/nested/$HOST_DIR/tmp/tracked/CLAUDE.md"
  git -C "$maintenance_repo" commit -qm maintenance-base
  maintenance_base="$(git -C "$maintenance_repo" rev-parse HEAD)"
  mkdir -p "$maintenance_project/$HOST_DIR/tmp/ignored" \
    "$maintenance_project/nested/$HOST_DIR/tmp/ignored"
  for tmp_control_rel in \
    "$HOST_DIR/tmp/ignored/AGENTS.md" \
    "$HOST_DIR/tmp/ignored/CLAUDE.md" \
    "nested/$HOST_DIR/tmp/ignored/AGENTS.md" \
    "nested/$HOST_DIR/tmp/ignored/CLAUDE.md"; do
    printf '@AGENTS.md\n%s:%s\n' "$tmp_instruction_canary" "$tmp_control_rel" \
      > "$maintenance_project/$tmp_control_rel"
    git -C "$maintenance_repo" check-ignore -q -- "services/app/$tmp_control_rel"
  done
  for tmp_control_rel in \
    "$HOST_DIR/tmp/tracked/AGENTS.md" \
    "$HOST_DIR/tmp/tracked/CLAUDE.md" \
    "nested/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "nested/$HOST_DIR/tmp/tracked/CLAUDE.md"; do
    git -C "$maintenance_repo" ls-files --error-unmatch \
      "services/app/$tmp_control_rel" >/dev/null
  done
  printf 'upstream release\n' > "$maintenance_project/README.md"
  git -C "$maintenance_repo" add services/app/README.md
  git -C "$maintenance_repo" commit -qm maintenance-upgrade
  printf 'project instruction candidate\n' > "$maintenance_project/AGENTS.md"
  printf 'project source candidate\n' > "$maintenance_project/src/project.py"
  printf 'GATE_CHECKS=("true")\nREVIEW_TIMEOUT_SECS=900\n' \
    > "$maintenance_project/$HOST_DIR/hooks/gate.conf"
  printf 'plans/TEMPLATE.md\n# candidate override registry\n' \
    > "$maintenance_project/$HOST_DIR/kit-overrides"
  printf '#!/usr/bin/env bash\nprintf "project hook candidate\\n"\n' \
    > "$maintenance_project/$HOST_DIR/hooks/project-hook.sh"
  chmod +x "$maintenance_project/$HOST_DIR/hooks/project-hook.sh"
  git -C "$maintenance_repo" add services/app/AGENTS.md \
    services/app/src/project.py \
    "services/app/$HOST_DIR/hooks/gate.conf" \
    "services/app/$HOST_DIR/kit-overrides" \
    "services/app/$HOST_DIR/hooks/project-hook.sh"
  git -C "$maintenance_repo" commit -qm maintenance-candidate
  maintenance_head="$(git -C "$maintenance_repo" rev-parse HEAD)"
  git -C "$maintenance_project" diff --no-renames --binary --relative \
    "$maintenance_base...$maintenance_head" -- . > "$maintenance_patch"

  tmp_control_patch="$tmp/tmp-control-plane.patch"
  tmp_control_bundle="$tmp/tmp-control-plane-bundle"
  tmp_control_output="$tmp/tmp-control-plane.out"
  for tmp_control_rel in \
    "$HOST_DIR/tmp/tracked/AGENTS.md" \
    "$HOST_DIR/tmp/tracked/CLAUDE.md" \
    "nested/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "nested/$HOST_DIR/tmp/tracked/CLAUDE.md"; do
    printf '@AGENTS.md\n%s:changed:%s\n' \
      "$tmp_instruction_canary" "$tmp_control_rel" \
      > "$maintenance_project/$tmp_control_rel"
  done
  git -C "$maintenance_project" diff --no-renames --binary --relative -- \
    "$HOST_DIR/tmp/tracked/AGENTS.md" \
    "$HOST_DIR/tmp/tracked/CLAUDE.md" \
    "nested/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "nested/$HOST_DIR/tmp/tracked/CLAUDE.md" > "$tmp_control_patch"
  [ -s "$tmp_control_patch" ]
  run_bundle "$maintenance_runner" "$tmp_control_patch" \
    "$tmp_control_bundle" "$maintenance_project" > "$tmp_control_output"
  cmp "$tmp_control_patch" "$tmp_control_bundle/.review-input/patch.diff"
  [ ! -e "$tmp_control_bundle/$HOST_DIR" ]
  [ ! -e "$tmp_control_bundle/nested/$HOST_DIR" ]
  python3 - "$tmp_control_bundle" "$HOST_DIR" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
host_dir = sys.argv[2]
closure = json.loads(
    (root / ".review-input/instruction-closure.json").read_text(encoding="utf-8")
)
paths = {item["path"] for item in closure["paths"]}
assert f"{host_dir}/policies/AGENTS.md" in paths
assert f"{host_dir}/policies/CLAUDE.md" in paths
assert not any(f"{host_dir}/tmp/" in path for path in paths)
PY
  for tmp_control_rel in \
    "$HOST_DIR/tmp/tracked/AGENTS.md" \
    "$HOST_DIR/tmp/tracked/CLAUDE.md" \
    "nested/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "nested/$HOST_DIR/tmp/tracked/CLAUDE.md"; do
    printf '@AGENTS.md\n%s:%s\n' "$tmp_instruction_canary" "$tmp_control_rel" \
      > "$maintenance_project/$tmp_control_rel"
  done
  git -C "$maintenance_project" diff --quiet -- \
    "$HOST_DIR/tmp/tracked/AGENTS.md" \
    "$HOST_DIR/tmp/tracked/CLAUDE.md" \
    "nested/$HOST_DIR/tmp/tracked/AGENTS.md" \
    "nested/$HOST_DIR/tmp/tracked/CLAUDE.md"

  for non_tmp_name in AGENTS.md CLAUDE.md; do
    non_tmp_rel="$HOST_DIR/policies/$non_tmp_name"
    non_tmp_patch="$tmp/non-tmp-$non_tmp_name.patch"
    non_tmp_bundle="$tmp/non-tmp-$non_tmp_name-bundle"
    non_tmp_output="$tmp/non-tmp-$non_tmp_name.out"
    printf 'changed non-tmp fixed %s\n' "$non_tmp_name" \
      > "$maintenance_project/$non_tmp_rel"
    git -C "$maintenance_project" diff --no-renames --binary --relative -- \
      "$non_tmp_rel" > "$non_tmp_patch"
    [ -s "$non_tmp_patch" ]
    if run_bundle "$maintenance_runner" "$non_tmp_patch" "$non_tmp_bundle" \
        "$maintenance_project" > "$non_tmp_output" 2>&1; then
      echo "standard review accepted non-tmp fixed instruction root: $non_tmp_rel" >&2
      return 1
    fi
    grep -Fq "review patch contains an instruction-closure path: $non_tmp_rel" \
      "$non_tmp_output"
    printf 'non-tmp fixed %s root\n' "${non_tmp_name%.md}" \
      > "$maintenance_project/$non_tmp_rel"
    git -C "$maintenance_project" diff --quiet -- "$non_tmp_rel"
  done

  python3 - "$maintenance_project" "$maintenance_base" "$HOST_DIR" \
    "$maintenance_upstream" "$maintenance_upgrade" <<'PY'
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys

project = Path(sys.argv[1])
base = sys.argv[2]
host_dir = sys.argv[3]
upstream_path = Path(sys.argv[4])
upgrade_path = Path(sys.argv[5])
kit = "agent_policies-claude" if host_dir == ".claude" else "agent_policies-codex"


def state_bytes(value):
    return {"sha256": hashlib.sha256(value).hexdigest(), "mode": 0o644}


readme_source = state_bytes(b"upstream release\n")
current_source = state_bytes(b"unchanged managed\n")
agents_source = state_bytes(b"upstream instruction\n")
agents_post = state_bytes(b"project instruction before candidate\n")
readme_pre = state_bytes(b"old release\n")
entries = [
    {
        "path": "AGENTS.md",
        "action": "override",
        "ownership": "project-override",
        "source": agents_source,
        "pre": agents_post,
        "post": agents_post,
    },
    {
        "path": "CURRENT.md",
        "action": "current",
        "ownership": "upstream-identical",
        "source": current_source,
        "pre": current_source,
        "post": current_source,
    },
    {
        "path": "README.md",
        "action": "upgrade",
        "ownership": "upstream-identical",
        "source": readme_source,
        "pre": readme_pre,
        "post": readme_source,
    },
]
projection = [
    {
        "path": item["path"],
        "ownership": item["ownership"],
        "source": item["source"],
        "post": item["post"],
    }
    for item in entries
]
projection_digest = hashlib.sha256(
    json.dumps(
        {"schema": 1, "paths": projection},
        separators=(",", ":"),
        sort_keys=True,
    ).encode()
).hexdigest()
source_revision = "5" * 40
source_tree = "6" * 40
upstream = {
    "schema": 1,
    "kit": kit,
    "repository": f"https://example.invalid/{kit}.git",
    "source_revision": source_revision,
    "source_tree": source_tree,
    "review": {
        "milestone": "M14",
        "patch_sha256": "7" * 64,
        "archive_manifest_sha256": "8" * 64,
        "verdict": "approve",
        "criteria_met": "14/14",
        "blocking": "none",
    },
    "managed_files": [
        {"path": "AGENTS.md", **agents_source},
        {"path": "CURRENT.md", **current_source},
        {"path": "README.md", **readme_source},
    ],
    "managed_file_count": 3,
}
base_tree = subprocess.check_output(
    ["git", "-C", str(project), "rev-parse", f"{base}^{{tree}}"],
    text=True,
).strip()
empty_digest = hashlib.sha256(b"").hexdigest()
upgrade = {
    "schema": 1,
    "record_version": 3,
    "operation": "upgrade",
    "kit": kit,
    "destination": str(project),
    "scope": "subproject",
    "source": {
        "revision": source_revision,
        "tree": source_tree,
        "dirty": False,
    },
    "pre": {
        "head": base,
        "tree": base_tree,
        "branch": "master",
        "status_sha256": empty_digest,
    },
    "post": {
        "status_sha256": empty_digest,
        "managed_projection_sha256": projection_digest,
    },
    "managed_path_count": 3,
    "managed_paths": entries,
}
upstream_path.write_text(
    json.dumps(upstream, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
upgrade_path.write_text(
    json.dumps(upgrade, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
  upstream_digest="$(sha256_path "$maintenance_upstream")"
  upgrade_digest="$(sha256_path "$maintenance_upgrade")"
  maintenance_partial_upstream="$tmp/partial-upstream-attestation.json"
  python3 - "$maintenance_upstream" "$maintenance_partial_upstream" <<'PY'
import json
from pathlib import Path
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
value = json.loads(source.read_text(encoding="utf-8"))
value["review"]["criteria_met"] = "7/10"
destination.write_text(
    json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
  maintenance_partial_upstream_digest="$(sha256_path "$maintenance_partial_upstream")"
  attestation_canary="m7a-attestation-${RANDOM}-${RANDOM}"
  standard_control_index=0
  for control_rel in \
    "$HOST_DIR/hooks/gate.conf" \
    "$HOST_DIR/kit-overrides" \
    "$HOST_DIR/hooks/project-hook.sh"; do
    standard_control_index=$((standard_control_index + 1))
    standard_control_patch="$tmp/control-plane-$standard_control_index.patch"
    git -C "$maintenance_project" diff --no-renames --binary --relative \
      "$maintenance_base...$maintenance_head" -- "$control_rel" \
      > "$standard_control_patch"
    [ -s "$standard_control_patch" ]
    if "$maintenance_runner" \
        --patch "$standard_control_patch" \
        --bundle "$tmp/control-plane-standard-$standard_control_index-bundle" \
        --plan "$maintenance_project/plans/M7.md" \
        --review-policy "$maintenance_project/REVIEW_POLICY.md" \
        > "$tmp/control-plane-standard-$standard_control_index.out" 2>&1; then
      echo "standard review accepted agent control-plane path: $control_rel" >&2
      return 1
    fi
    grep -Fq "review patch contains an instruction-closure path: $control_rel" \
      "$tmp/control-plane-standard-$standard_control_index.out"
  done
  if "$maintenance_runner" \
      --mode standard \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$tmp/duplicate-mode-maintenance-bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      > "$tmp/duplicate-mode-maintenance.out" 2>&1; then
    echo "duplicate maintenance mode option was accepted" >&2
    return 1
  fi
  grep -q '^usage:' "$tmp/duplicate-mode-maintenance.out"

  if "$maintenance_runner" \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$tmp/partial-review-maintenance-bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_partial_upstream" \
      --upstream-attestation-sha256 "$maintenance_partial_upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      > "$tmp/partial-review-maintenance.out" 2>&1; then
    echo "legacy singleton accepted partial review criteria" >&2
    return 1
  fi
  [ "$(tail -n 1 "$tmp/partial-review-maintenance.out")" = \
    'BundleError: upstream release attestation does not carry a valid approve verdict' ]
  [ ! -e "$tmp/partial-review-maintenance-bundle" ]

  maintenance_unknown_upstream="$tmp/unknown-upstream-attestation.json"
  maintenance_unknown_upgrade="$tmp/unknown-upgrade-attestation.json"
  maintenance_duplicate_upstream="$tmp/duplicate-upstream-attestation.json"
  cp "$maintenance_upstream" "$maintenance_unknown_upstream"
  cp "$maintenance_upgrade" "$maintenance_unknown_upgrade"
  cp "$maintenance_upstream" "$maintenance_duplicate_upstream"
  python3 - "$maintenance_unknown_upstream" "$maintenance_unknown_upgrade" \
    "$maintenance_duplicate_upstream" "$attestation_canary" <<'PY'
import json
from pathlib import Path
import sys

unknown_upstream = Path(sys.argv[1])
unknown_upgrade = Path(sys.argv[2])
duplicate_upstream = Path(sys.argv[3])
canary = sys.argv[4]

upstream = json.loads(unknown_upstream.read_text(encoding="utf-8"))
upstream["unrecognized"] = canary
unknown_upstream.write_text(
    json.dumps(upstream, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)

upgrade = json.loads(unknown_upgrade.read_text(encoding="utf-8"))
upgrade["managed_paths"][0]["unrecognized"] = canary
unknown_upgrade.write_text(
    json.dumps(upgrade, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)

text = duplicate_upstream.read_text(encoding="utf-8")
duplicate_upstream.write_text(
    text.replace(
        '"schema": 1,',
        f'"schema": "{canary}",\n  "schema": 1,',
        1,
    ),
    encoding="utf-8",
)
PY
  unknown_upstream_digest="$(sha256_path "$maintenance_unknown_upstream")"
  unknown_upgrade_digest="$(sha256_path "$maintenance_unknown_upgrade")"
  duplicate_upstream_digest="$(sha256_path "$maintenance_duplicate_upstream")"

  if "$maintenance_runner" \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$tmp/unknown-upstream-maintenance-bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_unknown_upstream" \
      --upstream-attestation-sha256 "$unknown_upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      > "$tmp/unknown-upstream-maintenance.out" 2>&1; then
    echo "unknown upstream attestation field was accepted" >&2
    return 1
  fi
  grep -q 'upstream release attestation has unknown or missing fields' \
    "$tmp/unknown-upstream-maintenance.out"

  if "$maintenance_runner" \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$tmp/unknown-upgrade-maintenance-bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$maintenance_unknown_upgrade" \
      --upgrade-attestation-sha256 "$unknown_upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      > "$tmp/unknown-upgrade-maintenance.out" 2>&1; then
    echo "unknown upgrade managed-entry field was accepted" >&2
    return 1
  fi
  grep -q 'upgrade attestation managed entry has unknown or missing fields' \
    "$tmp/unknown-upgrade-maintenance.out"

  if "$maintenance_runner" \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$tmp/duplicate-upstream-maintenance-bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_duplicate_upstream" \
      --upstream-attestation-sha256 "$duplicate_upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      > "$tmp/duplicate-upstream-maintenance.out" 2>&1; then
    echo "duplicate upstream attestation key was accepted" >&2
    return 1
  fi
  grep -q 'maintenance attestation duplicates JSON key: schema' \
    "$tmp/duplicate-upstream-maintenance.out"

  (
    cd "$maintenance_project/src/deep"
    "$maintenance_runner" \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$maintenance_bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      --instruction-delta "$HOST_DIR/hooks/gate.conf" \
      --instruction-delta "$HOST_DIR/kit-overrides" \
      --instruction-delta "$HOST_DIR/hooks/project-hook.sh"
  ) > "$maintenance_output"
  [ -f "$maintenance_bundle/src/project.py" ]
  [ ! -e "$maintenance_bundle/AGENTS.md" ]
  [ ! -e "$maintenance_bundle/README.md" ]
  [ ! -e "$maintenance_bundle/$HOST_DIR/hooks/gate.conf" ]
  [ ! -e "$maintenance_bundle/$HOST_DIR/kit-overrides" ]
  [ ! -e "$maintenance_bundle/$HOST_DIR/hooks/project-hook.sh" ]
  [ ! -e "$maintenance_bundle/services/sibling" ]
  cmp "$maintenance_patch" "$maintenance_bundle/.review-input/patch.diff"
  maintenance_digest="$(
    sha256_path "$maintenance_bundle/.review-input/maintenance-manifest.json"
  )"
  grep -qx 'review_mode=maintenance' "$maintenance_output"
  grep -qx "review_maintenance_digest=$maintenance_digest" "$maintenance_output"
  if grep -R -Fq "$maintenance_nonce" "$maintenance_bundle"; then
    echo "raw maintenance authorization leaked into review bundle" >&2
    return 1
  fi
  if grep -R -Fq "$attestation_canary" "$maintenance_bundle"; then
    echo "unvalidated attestation content leaked into review bundle" >&2
    return 1
  fi
  if grep -R -Fq "$tmp_instruction_canary" "$maintenance_bundle"; then
    echo "tmp instruction artifact leaked into maintenance review bundle" >&2
    return 1
  fi
  python3 - "$maintenance_bundle" "$HOST_DIR" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
host_dir = sys.argv[2]
manifest = json.loads(
    (root / ".review-input/maintenance-manifest.json").read_text(encoding="utf-8")
)
assert set(manifest) == {
    "schema",
    "mode",
    "base_commit",
    "head_commit",
    "head_tree",
    "patch_sha256",
    "authorization_sha256",
    "upstream_attestation_sha256",
    "upgrade_attestation_sha256",
    "instruction_closure_sha256",
    "patch_paths_sha256",
    "upstream",
    "upgrade",
    "ownership",
}
assert manifest["schema"] == 1
assert (root / ".review-input/upstream-release-attestation.json").is_file()
assert (root / ".review-input/upgrade-attestation.json").is_file()
assert not (root / ".review-input/attestations").exists()
closure = json.loads(
    (root / ".review-input/instruction-closure.json").read_text(encoding="utf-8")
)
closure_paths = {item["path"] for item in closure["paths"]}
assert f"{host_dir}/policies/AGENTS.md" in closure_paths
assert f"{host_dir}/policies/CLAUDE.md" in closure_paths
assert not any(f"{host_dir}/tmp/" in path for path in closure_paths)
ownership = {
    item["path"]: item["classification"] for item in manifest["ownership"]
}
assert ownership == {
    "AGENTS.md": "instruction-delta",
    "README.md": "upstream-identical",
    f"{host_dir}/hooks/gate.conf": "instruction-delta",
    f"{host_dir}/hooks/project-hook.sh": "instruction-delta",
    f"{host_dir}/kit-overrides": "instruction-delta",
    "src/project.py": "project-owned",
}
assert manifest["mode"] == "maintenance"
assert len(manifest["authorization_sha256"]) == 64
base_keys = {
    "path",
    "classification",
    "candidate",
    "instruction_kinds",
    "instruction_sources",
}
for path, item in {entry["path"]: entry for entry in manifest["ownership"]}.items():
    if path in {"AGENTS.md", "README.md"}:
        assert set(item) == base_keys | {
            "upgrade_ownership",
            "upstream",
            "upgrade_post",
        }
    else:
        assert set(item) == base_keys
PY
  projection_bundle="$tmp/path-neutral-maintenance-bundle"
  projection_output="$tmp/path-neutral-maintenance.out"
  projection_sidecar="$tmp/path-neutral-prelaunch.json"
  printf '%s\n' \
    '# M7-D.2 projection fixture' \
    '- maintenance_review_projection: path-neutral-v1' \
    '- maintenance_attestation_bindings:' \
    "  - kit: \`$fixture_kit\`" \
    '    upstream_release_attestation_id: `release/M7D1/upstream.json`' \
    "    upstream_release_attestation_sha256: \`$upstream_digest\`" \
    '    upgrade_attestation_id: `install/latest/maintenance-attestation.json`' \
    "    upgrade_attestation_sha256: \`$upgrade_digest\`" \
    > "$maintenance_project/plans/M7-projection.md"
  git -C "$maintenance_project" add plans/M7-projection.md
  git -C "$maintenance_project" commit -qm path-neutral-plan-binding
  projection_head="$(git -C "$maintenance_project" rev-parse HEAD)"
  projection_patch="$tmp/path-neutral-maintenance.patch"
  git -C "$maintenance_project" diff --no-renames --binary --relative \
    "$maintenance_base...$projection_head" -- . > "$projection_patch"
  "$maintenance_runner" \
    --mode maintenance \
    --maintenance-review-projection path-neutral-v1 \
    --maintenance-prelaunch-sidecar "$projection_sidecar" \
    --patch "$projection_patch" \
    --bundle "$projection_bundle" \
    --plan "$maintenance_project/plans/M7-projection.md" \
    --review-policy "$maintenance_project/REVIEW_POLICY.md" \
    --base-ref "$maintenance_base" \
    --head-ref "$projection_head" \
    --upstream-attestation "$maintenance_upstream" \
    --upstream-attestation-sha256 "$upstream_digest" \
    --upgrade-attestation "$maintenance_upgrade" \
    --upgrade-attestation-sha256 "$upgrade_digest" \
    --maintenance-authorization "$maintenance_nonce" \
    --instruction-delta AGENTS.md \
    --instruction-delta "$HOST_DIR/hooks/gate.conf" \
    --instruction-delta "$HOST_DIR/kit-overrides" \
    --instruction-delta "$HOST_DIR/hooks/project-hook.sh" \
    > "$projection_output"
  [ -f "$projection_sidecar" ] && [ ! -L "$projection_sidecar" ]
  [ ! -e "$projection_bundle/.review-input/upstream-release-attestation.json" ]
  [ ! -e "$projection_bundle/.review-input/upgrade-attestation.json" ]
  [ ! -e "$projection_bundle/.review-input/attestations" ]
  [ ! -e "$projection_bundle/CURRENT.md" ]
  projection_digest="$(sha256_path "$projection_sidecar")"
  grep -qx 'review_maintenance_projection=path-neutral-v1' "$projection_output"
  grep -qx "review_maintenance_sidecar=$projection_sidecar" "$projection_output"
  grep -qx "review_maintenance_sidecar_digest=$projection_digest" "$projection_output"
  if grep -R -Fq "$maintenance_project" "$projection_bundle"; then
    echo "physical project root leaked into path-neutral bundle" >&2
    return 1
  fi
  python3 - "$projection_bundle" "$projection_sidecar" "$projection_digest" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
sidecar = Path(sys.argv[2])
manifest = json.loads((root / ".review-input/maintenance-manifest.json").read_text())
assert manifest["schema"] == 3
assert manifest["projection_mode"] == "path-neutral-v1"
assert len(manifest["attestation_projections"]) == 1
assert manifest["prelaunch_sidecar_sha256"] == sys.argv[3]
assert "destination" not in json.dumps(manifest)
side = json.loads(sidecar.read_text())
assert side["physical_project_root"]
assert side["attestation_sets"][0]["upgrade_artifact"]["path"]
assert hashlib.sha256(sidecar.read_bytes()).hexdigest() == sys.argv[3]
PY
  if "$maintenance_runner" \
      --mode maintenance \
      --maintenance-review-projection path-neutral-v1 \
      --maintenance-prelaunch-sidecar "$tmp/path-neutral-reference-leak-sidecar.json" \
      --patch "$projection_patch" \
      --bundle "$tmp/path-neutral-reference-leak-bundle" \
      --plan "$maintenance_project/plans/M7-projection.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --review-reference "$maintenance_project/plans/path-leak-reference.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$projection_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      --instruction-delta "$HOST_DIR/hooks/gate.conf" \
      --instruction-delta "$HOST_DIR/kit-overrides" \
      --instruction-delta "$HOST_DIR/hooks/project-hook.sh" \
      > "$tmp/path-neutral-reference-leak.out" 2>&1; then
    echo "path-neutral helper accepted a physical path in a review reference" >&2
    return 1
  fi
  grep -q 'path-neutral reviewable bytes contain a physical checkout/home/artifact path: plans/path-leak-reference.md' \
    "$tmp/path-neutral-reference-leak.out"
  [ ! -e "$tmp/path-neutral-reference-leak-bundle" ] &&
    [ ! -e "$tmp/path-neutral-reference-leak-sidecar.json" ]

  assert_projection_plan_rejected() {
    local negative_plan="$1"
    local negative_label="$2"
    local expected_error="$3"
    local negative_head negative_patch negative_bundle negative_sidecar negative_out
    git -C "$maintenance_project" add "plans/$negative_plan"
    git -C "$maintenance_project" commit -qm "path-neutral-$negative_label"
    negative_head="$(git -C "$maintenance_project" rev-parse HEAD)"
    negative_patch="$tmp/path-neutral-$negative_label.patch"
    negative_bundle="$tmp/path-neutral-$negative_label-bundle"
    negative_sidecar="$tmp/path-neutral-$negative_label-sidecar.json"
    negative_out="$tmp/path-neutral-$negative_label.out"
    git -C "$maintenance_project" diff --no-renames --binary --relative \
      "$maintenance_base...$negative_head" -- . > "$negative_patch"
    if "$maintenance_runner" \
        --mode maintenance \
        --maintenance-review-projection path-neutral-v1 \
        --maintenance-prelaunch-sidecar "$negative_sidecar" \
        --patch "$negative_patch" \
        --bundle "$negative_bundle" \
        --plan "$maintenance_project/plans/$negative_plan" \
        --review-policy "$maintenance_project/REVIEW_POLICY.md" \
        --base-ref "$maintenance_base" \
        --head-ref "$negative_head" \
        --upstream-attestation "$maintenance_upstream" \
        --upstream-attestation-sha256 "$upstream_digest" \
        --upgrade-attestation "$maintenance_upgrade" \
        --upgrade-attestation-sha256 "$upgrade_digest" \
        --maintenance-authorization "$maintenance_nonce" \
        --instruction-delta AGENTS.md \
        --instruction-delta "$HOST_DIR/hooks/gate.conf" \
        --instruction-delta "$HOST_DIR/kit-overrides" \
        --instruction-delta "$HOST_DIR/hooks/project-hook.sh" \
        > "$negative_out" 2>&1; then
      echo "path-neutral helper accepted invalid plan fixture: $negative_label" >&2
      return 1
    fi
    grep -Fq "$expected_error" "$negative_out"
    [ ! -e "$negative_bundle" ] && [ ! -e "$negative_sidecar" ]
    git -C "$maintenance_project" checkout -q --detach "$projection_head"
  }

  printf '%s\n' \
    '# M7-D.2 mixed projection declaration fixture' \
    'maintenance_review_projection: path-neutral-v1' \
    '- maintenance_review_projection: path-neutral-v1' \
    '- maintenance_attestation_bindings:' \
    "  - kit: $fixture_kit" \
    '    upstream_release_attestation_id: release/M7D1/upstream.json' \
    "    upstream_release_attestation_sha256: $upstream_digest" \
    '    upgrade_attestation_id: install/latest/maintenance-attestation.json' \
    "    upgrade_attestation_sha256: $upgrade_digest" \
    > "$maintenance_project/plans/M7-projection-duplicate.md"
  assert_projection_plan_rejected \
    M7-projection-duplicate.md projection-duplicate \
    'path-neutral helper opt-in requires exactly one matching plan declaration'

  printf '%s\n' \
    '# M7-D.2 mixed binding declaration fixture' \
    '- maintenance_review_projection: path-neutral-v1' \
    'maintenance_attestation_bindings:' \
    '- maintenance_attestation_bindings:' \
    "  - kit: $fixture_kit" \
    '    upstream_release_attestation_id: release/M7D1/upstream.json' \
    "    upstream_release_attestation_sha256: $upstream_digest" \
    '    upgrade_attestation_id: install/latest/maintenance-attestation.json' \
    "    upgrade_attestation_sha256: $upgrade_digest" \
    > "$maintenance_project/plans/M7-binding-duplicate.md"
  assert_projection_plan_rejected \
    M7-binding-duplicate.md binding-duplicate \
    'path-neutral plan duplicates maintenance_attestation_bindings'

  printf '%s\n' \
    '# M7-D.2 malformed backtick fixture' \
    '- maintenance_review_projection: path-neutral-v1' \
    '- maintenance_attestation_bindings:' \
    "  - kit: \`$fixture_kit" \
    '    upstream_release_attestation_id: `release/M7D1/upstream.json`' \
    "    upstream_release_attestation_sha256: \`$upstream_digest\`" \
    '    upgrade_attestation_id: `install/latest/maintenance-attestation.json`' \
    "    upgrade_attestation_sha256: \`$upgrade_digest\`" \
    > "$maintenance_project/plans/M7-backtick-malformed.md"
  assert_projection_plan_rejected \
    M7-backtick-malformed.md backtick-malformed \
    'path-neutral plan binding has a malformed backtick scalar'

  printf '%s\n' \
    '# M7-D.2 list-prefixed legacy artifact fixture' \
    '- maintenance_review_projection: path-neutral-v1' \
    "- upstream_release_attestation: \`$maintenance_upstream\`" \
    '- maintenance_attestation_bindings:' \
    "  - kit: $fixture_kit" \
    '    upstream_release_attestation_id: release/M7D1/upstream.json' \
    "    upstream_release_attestation_sha256: $upstream_digest" \
    '    upgrade_attestation_id: install/latest/maintenance-attestation.json' \
    "    upgrade_attestation_sha256: $upgrade_digest" \
    > "$maintenance_project/plans/M7-path-bearing-key.md"
  assert_projection_plan_rejected \
    M7-path-bearing-key.md path-bearing-key \
    'path-neutral tracked plan must use logical attestation IDs, not artifact paths'

  printf '%s\n' \
    '# M7-D.2 invalid physical-path fixture' \
    'maintenance_review_projection: path-neutral-v1' \
    'maintenance_attestation_bindings:' \
    "  - kit: $fixture_kit" \
    '    upstream_release_attestation_id: release/M7D1/upstream.json' \
    "    upstream_release_attestation_sha256: $upstream_digest" \
    '    upgrade_attestation_id: install/latest/maintenance-attestation.json' \
    "    upgrade_attestation_sha256: $upgrade_digest" \
    "notes: $maintenance_project" \
    > "$maintenance_project/plans/M7-projection-path-leak.md"
  git -C "$maintenance_project" add plans/M7-projection-path-leak.md
  git -C "$maintenance_project" commit -qm path-neutral-plan-leak
  projection_invalid_head="$(git -C "$maintenance_project" rev-parse HEAD)"
  projection_invalid_patch="$tmp/path-neutral-plan-leak.patch"
  git -C "$maintenance_project" diff --no-renames --binary --relative \
    "$maintenance_base...$projection_invalid_head" -- . \
    > "$projection_invalid_patch"
  if "$maintenance_runner" \
      --mode maintenance \
      --maintenance-review-projection path-neutral-v1 \
      --maintenance-prelaunch-sidecar "$tmp/path-neutral-plan-leak-sidecar.json" \
      --patch "$projection_invalid_patch" \
      --bundle "$tmp/path-neutral-plan-leak-bundle" \
      --plan "$maintenance_project/plans/M7-projection-path-leak.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$projection_invalid_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      --instruction-delta "$HOST_DIR/hooks/gate.conf" \
      --instruction-delta "$HOST_DIR/kit-overrides" \
      --instruction-delta "$HOST_DIR/hooks/project-hook.sh" \
      > "$tmp/path-neutral-plan-leak.out" 2>&1; then
    echo "path-neutral helper accepted a physical path in the tracked plan" >&2
    return 1
  fi
  grep -q 'path-neutral reviewable bytes contain a physical checkout/home/artifact path: plans/M7-projection-path-leak.md' \
    "$tmp/path-neutral-plan-leak.out"
  [ ! -e "$tmp/path-neutral-plan-leak-bundle" ] &&
    [ ! -e "$tmp/path-neutral-plan-leak-sidecar.json" ]
  git -C "$maintenance_project" checkout -q --detach "$projection_head"
  projection_stale_upgrade="$tmp/path-neutral-stale-upgrade.json"
  cp "$maintenance_upgrade" "$projection_stale_upgrade"
  python3 - "$projection_stale_upgrade" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
value = json.loads(path.read_text())
value["destination"] = "/stale/physical/destination"
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
  projection_stale_digest="$(sha256_path "$projection_stale_upgrade")"
  if "$maintenance_runner" \
      --mode maintenance \
      --maintenance-review-projection path-neutral-v1 \
      --maintenance-prelaunch-sidecar "$tmp/path-neutral-stale-sidecar.json" \
      --patch "$projection_patch" \
      --bundle "$tmp/path-neutral-stale-bundle" \
      --plan "$maintenance_project/plans/M7-projection.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$projection_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$projection_stale_upgrade" \
      --upgrade-attestation-sha256 "$projection_stale_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      --instruction-delta "$HOST_DIR/hooks/gate.conf" \
      --instruction-delta "$HOST_DIR/kit-overrides" \
      --instruction-delta "$HOST_DIR/hooks/project-hook.sh" \
      > "$tmp/path-neutral-stale.out" 2>&1; then
    echo "path-neutral helper accepted a stale physical destination" >&2
    return 1
  fi
  grep -q 'upgrade attestation target binding mismatch' "$tmp/path-neutral-stale.out"
  [ ! -e "$tmp/path-neutral-stale-bundle" ] &&
    [ ! -e "$tmp/path-neutral-stale-sidecar.json" ]
  if "$maintenance_runner" \
      --mode maintenance \
      --maintenance-review-projection path-neutral-v1 \
      --patch "$projection_patch" \
      --bundle "$tmp/path-neutral-partial-bundle" \
      --plan "$maintenance_project/plans/M7-projection.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$projection_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      > "$tmp/path-neutral-partial.out" 2>&1; then
    echo "partial path-neutral helper opt-in was accepted" >&2
    return 1
  fi
  [ ! -e "$tmp/path-neutral-partial-bundle" ]
  git -C "$maintenance_project" checkout -q --detach "$maintenance_head"
  undeclared_index=0
  expect_undeclared_delta() {
    local expected="$1"
    shift
    undeclared_index=$((undeclared_index + 1))
    if "$maintenance_runner" \
        --mode maintenance \
        --patch "$maintenance_patch" \
        --bundle "$tmp/undeclared-maintenance-$undeclared_index-bundle" \
        --plan "$maintenance_project/plans/M7.md" \
        --review-policy "$maintenance_project/REVIEW_POLICY.md" \
        --base-ref "$maintenance_base" \
        --head-ref "$maintenance_head" \
        --upstream-attestation "$maintenance_upstream" \
        --upstream-attestation-sha256 "$upstream_digest" \
        --upgrade-attestation "$maintenance_upgrade" \
        --upgrade-attestation-sha256 "$upgrade_digest" \
        --maintenance-authorization "$maintenance_nonce" \
        "$@" > "$tmp/undeclared-maintenance-$undeclared_index.out" 2>&1; then
      echo "undeclared maintenance instruction delta was accepted: $expected" >&2
      return 1
    fi
    grep -Fq "maintenance instruction delta was not declared: $expected" \
      "$tmp/undeclared-maintenance-$undeclared_index.out"
  }
  expect_undeclared_delta "$HOST_DIR/hooks/gate.conf"
  expect_undeclared_delta "$HOST_DIR/hooks/project-hook.sh" \
    --instruction-delta "$HOST_DIR/hooks/gate.conf"
  expect_undeclared_delta "$HOST_DIR/kit-overrides" \
    --instruction-delta "$HOST_DIR/hooks/gate.conf" \
    --instruction-delta "$HOST_DIR/hooks/project-hook.sh"
  expect_undeclared_delta AGENTS.md \
    --instruction-delta "$HOST_DIR/hooks/gate.conf" \
    --instruction-delta "$HOST_DIR/hooks/project-hook.sh" \
    --instruction-delta "$HOST_DIR/kit-overrides"
  if "$maintenance_runner" \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$tmp/false-delta-maintenance-bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      --instruction-delta "$HOST_DIR/hooks/gate.conf" \
      --instruction-delta "$HOST_DIR/kit-overrides" \
      --instruction-delta "$HOST_DIR/hooks/project-hook.sh" \
      --instruction-delta src/project.py \
      > "$tmp/false-delta-maintenance.out" 2>&1; then
    echo "non-closure maintenance instruction delta was accepted" >&2
    return 1
  fi
  grep -q 'declared instruction delta is outside the closure: src/project.py' \
    "$tmp/false-delta-maintenance.out"
  if "$maintenance_runner" \
      --mode maintenance \
      --patch "$maintenance_patch" \
      --bundle "$tmp/wrong-attestation-maintenance-bundle" \
      --plan "$maintenance_project/plans/M7.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$maintenance_base" \
      --head-ref "$maintenance_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 \
        0000000000000000000000000000000000000000000000000000000000000000 \
      --upgrade-attestation "$maintenance_upgrade" \
      --upgrade-attestation-sha256 "$upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      --instruction-delta AGENTS.md \
      > "$tmp/wrong-attestation-maintenance.out" 2>&1; then
    echo "wrong maintenance attestation digest was accepted" >&2
    return 1
  fi
  grep -q 'upstream release attestation digest mismatch' \
    "$tmp/wrong-attestation-maintenance.out"

  composite_repo="$tmp/composite-repo"
  composite_project="$composite_repo/project"
  composite_runner="$composite_project/$HOST_DIR/hooks/$(basename "$SELF")"
  composite_patch="$tmp/composite.patch"
  composite_bundle="$tmp/composite-bundle"
  composite_output="$tmp/composite.out"
  composite_upstream_claude="$tmp/composite-upstream-claude.json"
  composite_upgrade_claude="$tmp/composite-upgrade-claude.json"
  composite_upstream_codex="$tmp/composite-upstream-codex.json"
  composite_upgrade_codex="$tmp/composite-upgrade-codex.json"
  composite_nonce="composite-maintenance-${RANDOM}-${RANDOM}"
  git init -q "$composite_repo"
  git -C "$composite_repo" config user.name composite-self-test
  git -C "$composite_repo" config user.email composite@example.invalid
  mkdir -p "$composite_project/$HOST_DIR/hooks" \
    "$composite_project/.claude/hooks" "$composite_project/.codex/hooks" \
    "$composite_project/plans" "$composite_project/src/deep"
  cp -p "$SELF" "$composite_runner"
  printf 'policy\n' > "$composite_project/REVIEW_POLICY.md"
  printf '# M7-D\n' > "$composite_project/plans/M7.md"
  printf 'dual instruction base\n' > "$composite_project/AGENTS.md"
  printf 'shared release\n' > "$composite_project/SHARED.txt"
  printf 'old Claude release\n' > "$composite_project/CLAUDE_RELEASE.txt"
  printf 'old Codex release\n' > "$composite_project/CODEX_RELEASE.txt"
  printf 'Claude gate base\n' > "$composite_project/.claude/hooks/gate.conf"
  printf 'Codex gate base\n' > "$composite_project/.codex/hooks/gate.conf"
  printf 'old project source\n' > "$composite_project/src/project.py"
  git -C "$composite_repo" add .
  git -C "$composite_repo" commit -qm composite-base
  composite_base="$(git -C "$composite_repo" rev-parse HEAD)"
  printf 'dual instruction candidate\n' > "$composite_project/AGENTS.md"
  printf 'Claude release\n' > "$composite_project/CLAUDE_RELEASE.txt"
  printf 'Codex release\n' > "$composite_project/CODEX_RELEASE.txt"
  printf 'Claude gate candidate\n' > "$composite_project/.claude/hooks/gate.conf"
  printf 'Codex gate candidate\n' > "$composite_project/.codex/hooks/gate.conf"
  printf 'project source candidate\n' > "$composite_project/src/project.py"
  git -C "$composite_repo" add .
  git -C "$composite_repo" commit -qm composite-candidate
  composite_head="$(git -C "$composite_repo" rev-parse HEAD)"
  git -C "$composite_project" diff --no-renames --binary --relative \
    "$composite_base...$composite_head" -- . > "$composite_patch"

  composite_mixed_upstream="$tmp/composite-mixed-upstream.json"
  composite_mixed_upgrade="$tmp/composite-mixed-upgrade.json"
  composite_incompatible_upstream="$tmp/composite-incompatible-upstream.json"
  composite_incompatible_upgrade="$tmp/composite-incompatible-upgrade.json"
  composite_unknown_upstream="$tmp/composite-unknown-upstream.json"
  composite_unclassified_upstream="$tmp/composite-unclassified-upstream.json"
  composite_unclassified_upgrade="$tmp/composite-unclassified-upgrade.json"
  composite_tampered_upstream="$tmp/composite-tampered-upstream.json"
  python3 - "$composite_project" "$composite_base" "$composite_head" \
    "$composite_upstream_claude" "$composite_upgrade_claude" \
    "$composite_upstream_codex" "$composite_upgrade_codex" \
    "$composite_mixed_upstream" "$composite_mixed_upgrade" \
    "$composite_incompatible_upstream" "$composite_incompatible_upgrade" \
    "$composite_unknown_upstream" \
    "$composite_unclassified_upstream" "$composite_unclassified_upgrade" <<'PY'
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys

project = Path(sys.argv[1])
base = sys.argv[2]
head = sys.argv[3]
paths = [Path(value) for value in sys.argv[4:]]
(
    upstream_claude_path,
    upgrade_claude_path,
    upstream_codex_path,
    upgrade_codex_path,
    mixed_upstream_path,
    mixed_upgrade_path,
    incompatible_upstream_path,
    incompatible_upgrade_path,
    unknown_upstream_path,
    unclassified_upstream_path,
    unclassified_upgrade_path,
) = paths


def state(value):
    return {"sha256": hashlib.sha256(value).hexdigest(), "mode": 0o644}


def projection_digest(entries):
    projection = [
        {
            "path": item["path"],
            "ownership": item["ownership"],
            "source": item["source"],
            "post": item["post"],
        }
        for item in entries
    ]
    return hashlib.sha256(
        json.dumps(
            {"schema": 1, "paths": sorted(projection, key=lambda item: item["path"])},
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
    ).hexdigest()


def refresh(upstream, upgrade):
    upstream["managed_files"] = sorted(
        upstream["managed_files"], key=lambda item: item["path"]
    )
    upstream["managed_file_count"] = len(upstream["managed_files"])
    upgrade["managed_paths"] = sorted(
        upgrade["managed_paths"], key=lambda item: item["path"]
    )
    upgrade["managed_path_count"] = len(upgrade["managed_paths"])
    upgrade["post"]["managed_projection_sha256"] = projection_digest(
        upgrade["managed_paths"]
    )


def write(path, value, *, compact=False):
    if compact:
        raw = json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n"
    else:
        raw = json.dumps(value, indent=2, sort_keys=True) + "\n"
    path.write_text(raw, encoding="utf-8")


base_tree = subprocess.check_output(
    ["git", "-C", str(project), "rev-parse", f"{base}^{{tree}}"], text=True
).strip()
head_tree = subprocess.check_output(
    ["git", "-C", str(project), "rev-parse", f"{head}^{{tree}}"], text=True
).strip()
head_branch = subprocess.check_output(
    ["git", "-C", str(project), "symbolic-ref", "--quiet", "--short", "HEAD"],
    text=True,
).strip()
empty_digest = hashlib.sha256(b"").hexdigest()
shared_source = state(b"shared release\n")
base_agents = state(b"dual instruction base\n")
candidate_agents = state(b"dual instruction candidate\n")
old_project = state(b"old project source\n")


def pair(kit):
    is_claude = kit == "agent_policies-claude"
    host = ".claude" if is_claude else ".codex"
    release_path = "CLAUDE_RELEASE.txt" if is_claude else "CODEX_RELEASE.txt"
    release_source = state(b"Claude release\n" if is_claude else b"Codex release\n")
    release_pre = state(
        b"old Claude release\n" if is_claude else b"old Codex release\n"
    )
    agents_source = state(
        b"Claude upstream instruction\n"
        if is_claude
        else b"Codex upstream instruction\n"
    )
    agents_post = state(
        b"Claude project instruction history\n"
        if is_claude
        else b"Codex project instruction history\n"
    )
    gate_source = state(
        b"Claude upstream gate\n" if is_claude else b"Codex upstream gate\n"
    )
    gate_pre = state(b"Claude gate base\n" if is_claude else b"Codex gate base\n")
    gate_post = state(
        b"Claude project gate history\n"
        if is_claude
        else b"Codex project gate history\n"
    )
    entries = [
        {
            "path": "AGENTS.md",
            "action": "override",
            "ownership": "project-override",
            "source": agents_source,
            "pre": base_agents,
            "post": agents_post,
        },
        {
            "path": f"{host}/hooks/gate.conf",
            "action": "override",
            "ownership": "project-override",
            "source": gate_source,
            "pre": gate_pre,
            "post": gate_post,
        },
        {
            "path": release_path,
            "action": "upgrade",
            "ownership": "upstream-identical",
            "source": release_source,
            "pre": release_pre,
            "post": release_source,
        },
        {
            "path": "SHARED.txt",
            "action": "current",
            "ownership": "upstream-identical",
            "source": shared_source,
            "pre": shared_source,
            "post": shared_source,
        },
    ]
    source_revision = ("a" if is_claude else "b") * 40
    source_tree = ("c" if is_claude else "d") * 40
    claim = (
        {
            "qualification": {
                "handoff_id": "DUAL-KIT-REPOSITORY-FREE-HANDOFF",
                "handoff_verify": "PASS",
                "release_tag": "dual-agent-kit-fixture",
            }
        }
        if is_claude
        else {
            "review": {
                "milestone": "M20",
                "patch_sha256": "1" * 64,
                "archive_manifest_sha256": "2" * 64,
                "verdict": "approve",
                "criteria_met": "7/10",
                "blocking": "none",
            }
        }
    )
    upstream = {
        "schema": 1,
        "kit": kit,
        "repository": f"https://example.invalid/{kit}.git",
        "source_revision": source_revision,
        "source_tree": source_tree,
        **claim,
        "managed_files": [
            {"path": item["path"], **item["source"]} for item in entries
        ],
        "managed_file_count": len(entries),
    }
    if not is_claude:
        actual_post = {
            "AGENTS.md": candidate_agents,
            ".codex/hooks/gate.conf": state(b"Codex gate candidate\n"),
            "CODEX_RELEASE.txt": release_source,
            "SHARED.txt": shared_source,
        }
        for item in entries:
            item["post"] = actual_post[item["path"]]
            item["pre"] = actual_post[item["path"]]
            if item["ownership"] == "upstream-identical":
                item["action"] = "current"
    upgrade = {
        "schema": 1,
        "record_version": 3,
        "operation": "upgrade" if is_claude else "current-state-attestation",
        "kit": kit,
        "destination": str(project) if is_claude else "@TARGET_PROJECT_ROOT@",
        "scope": "git-root",
        "source": {
            **({} if is_claude else {"repository": upstream["repository"]}),
            "revision": source_revision,
            "tree": source_tree,
            "dirty": False,
        },
        "pre": {
            "head": base if is_claude else head,
            "tree": base_tree if is_claude else head_tree,
            "branch": "master" if is_claude else head_branch,
            "status_sha256": empty_digest,
        },
        "post": {
            "status_sha256": empty_digest,
            "managed_projection_sha256": projection_digest(entries),
        },
        "managed_path_count": len(entries),
        "managed_paths": entries,
    }
    refresh(upstream, upgrade)
    return upstream, upgrade


upstream_claude, upgrade_claude = pair("agent_policies-claude")
upstream_codex, upgrade_codex = pair("agent_policies-codex")
write(upstream_claude_path, upstream_claude)
write(upgrade_claude_path, upgrade_claude)
write(upstream_codex_path, upstream_codex, compact=True)
write(upgrade_codex_path, upgrade_codex)

mixed_upstream = copy.deepcopy(upstream_codex)
mixed_upgrade = copy.deepcopy(upgrade_codex)
for item in mixed_upstream["managed_files"]:
    if item["path"] == "AGENTS.md":
        item.update(candidate_agents)
for item in mixed_upgrade["managed_paths"]:
    if item["path"] == "AGENTS.md":
        item["action"] = "current"
        item["ownership"] = "upstream-identical"
        item["source"] = candidate_agents
        item["pre"] = candidate_agents
        item["post"] = candidate_agents
refresh(mixed_upstream, mixed_upgrade)
write(mixed_upstream_path, mixed_upstream)
write(mixed_upgrade_path, mixed_upgrade)

incompatible_upstream = copy.deepcopy(upstream_claude)
incompatible_upgrade = copy.deepcopy(upgrade_claude)
different_shared = state(b"incompatible shared release\n")
for item in incompatible_upstream["managed_files"]:
    if item["path"] == "SHARED.txt":
        item.update(different_shared)
for item in incompatible_upgrade["managed_paths"]:
    if item["path"] == "SHARED.txt":
        item["source"] = different_shared
        item["pre"] = different_shared
        item["post"] = different_shared
refresh(incompatible_upstream, incompatible_upgrade)
write(incompatible_upstream_path, incompatible_upstream)
write(incompatible_upgrade_path, incompatible_upgrade)

unknown_upstream = copy.deepcopy(upstream_codex)
unknown_upstream["unknown_composite_field"] = "must-fail"
write(unknown_upstream_path, unknown_upstream)

unclassified_upstream = copy.deepcopy(upstream_claude)
unclassified_upgrade = copy.deepcopy(upgrade_claude)
project_source = state(b"upstream project source\n")
unclassified_upstream["managed_files"].append(
    {"path": "src/project.py", **project_source}
)
unclassified_upgrade["managed_paths"].append(
    {
        "path": "src/project.py",
        "action": "upgrade",
        "ownership": "upstream-identical",
        "source": project_source,
        "pre": old_project,
        "post": project_source,
    }
)
refresh(unclassified_upstream, unclassified_upgrade)
write(unclassified_upstream_path, unclassified_upstream)
write(unclassified_upgrade_path, unclassified_upgrade)
PY
  composite_upstream_claude_digest="$(sha256_path "$composite_upstream_claude")"
  composite_upgrade_claude_digest="$(sha256_path "$composite_upgrade_claude")"
  composite_upstream_codex_digest="$(sha256_path "$composite_upstream_codex")"
  composite_upgrade_codex_digest="$(sha256_path "$composite_upgrade_codex")"
  composite_mixed_upstream_digest="$(sha256_path "$composite_mixed_upstream")"
  composite_mixed_upgrade_digest="$(sha256_path "$composite_mixed_upgrade")"
  composite_incompatible_upstream_digest="$(sha256_path "$composite_incompatible_upstream")"
  composite_incompatible_upgrade_digest="$(sha256_path "$composite_incompatible_upgrade")"
  composite_unknown_upstream_digest="$(sha256_path "$composite_unknown_upstream")"
  composite_unclassified_upstream_digest="$(sha256_path "$composite_unclassified_upstream")"
  composite_unclassified_upgrade_digest="$(sha256_path "$composite_unclassified_upgrade")"
  cp "$composite_upstream_claude" "$composite_tampered_upstream"
  printf ' ' >> "$composite_tampered_upstream"

  (
    cd "$composite_project/src/deep"
    "$composite_runner" \
      --mode maintenance \
      --patch "$composite_patch" \
      --bundle "$composite_bundle" \
      --plan "$composite_project/plans/M7.md" \
      --review-policy "$composite_project/REVIEW_POLICY.md" \
      --base-ref "$composite_base" \
      --head-ref "$composite_head" \
      --upstream-attestation "$composite_upstream_claude" \
      --upstream-attestation-sha256 "$composite_upstream_claude_digest" \
      --upgrade-attestation "$composite_upgrade_claude" \
      --upgrade-attestation-sha256 "$composite_upgrade_claude_digest" \
      --upstream-attestation "$composite_upstream_codex" \
      --upstream-attestation-sha256 "$composite_upstream_codex_digest" \
      --upgrade-attestation "$composite_upgrade_codex" \
      --upgrade-attestation-sha256 "$composite_upgrade_codex_digest" \
      --maintenance-authorization "$composite_nonce" \
      --instruction-delta AGENTS.md \
      --instruction-delta .claude/hooks/gate.conf \
      --instruction-delta .codex/hooks/gate.conf
  ) > "$composite_output"
  cmp "$composite_patch" "$composite_bundle/.review-input/patch.diff"
  [ -f "$composite_bundle/src/project.py" ]
  [ ! -e "$composite_bundle/AGENTS.md" ]
  [ ! -e "$composite_bundle/CLAUDE_RELEASE.txt" ]
  [ ! -e "$composite_bundle/CODEX_RELEASE.txt" ]
  [ ! -e "$composite_bundle/.claude/hooks/gate.conf" ]
  [ ! -e "$composite_bundle/.codex/hooks/gate.conf" ]
  composite_digest="$(
    sha256_path "$composite_bundle/.review-input/maintenance-manifest.json"
  )"
  grep -qx "review_maintenance_digest=$composite_digest" "$composite_output"
  if grep -R -Fq "$composite_nonce" "$composite_bundle"; then
    echo "raw composite maintenance authorization leaked into bundle" >&2
    return 1
  fi
  python3 - "$composite_bundle" <<'PY'
import hashlib
import json
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
review_input = root / ".review-input"
manifest = json.loads((review_input / "maintenance-manifest.json").read_text())
assert set(manifest) == {
    "schema",
    "mode",
    "base_commit",
    "head_commit",
    "head_tree",
    "patch_sha256",
    "authorization_sha256",
    "instruction_closure_sha256",
    "patch_paths_sha256",
    "attestation_sets",
    "managed_union",
    "ownership",
}
assert manifest["schema"] == 2
assert [item["kit"] for item in manifest["attestation_sets"]] == [
    "agent_policies-claude",
    "agent_policies-codex",
]
for item in manifest["attestation_sets"]:
    assert set(item) == {
        "kit",
        "upstream_attestation_sha256",
        "upgrade_attestation_sha256",
        "upstream",
        "upgrade",
    }
    artifact_root = review_input / "attestations" / item["kit"]
    upstream = artifact_root / "upstream-release-attestation.json"
    upgrade = artifact_root / "upgrade-attestation.json"
    assert hashlib.sha256(upstream.read_bytes()).hexdigest() == item[
        "upstream_attestation_sha256"
    ]
    assert hashlib.sha256(upgrade.read_bytes()).hexdigest() == item[
        "upgrade_attestation_sha256"
    ]
union = {item["path"]: item for item in manifest["managed_union"]}
assert list(union) == sorted(union)
assert len(union) == 6
for item in union.values():
    assert set(item) == {"path", "bindings"}
    assert [binding["kit"] for binding in item["bindings"]] == sorted(
        binding["kit"] for binding in item["bindings"]
    )
    assert all(
        set(binding) == {"kit", "ownership", "source", "post"}
        for binding in item["bindings"]
    )
agents = union["AGENTS.md"]["bindings"]
assert len(agents) == 2
assert {item["ownership"] for item in agents} == {"project-override"}
assert agents[0]["source"] != agents[1]["source"]
assert agents[0]["post"] != agents[1]["post"]
shared = union["SHARED.txt"]["bindings"]
assert len(shared) == 2
assert shared[0]["source"] == shared[1]["source"]
assert shared[0]["post"] == shared[1]["post"]
ownership = {item["path"]: item for item in manifest["ownership"]}
assert list(ownership) == sorted(ownership)
assert {path: item["classification"] for path, item in ownership.items()} == {
    ".claude/hooks/gate.conf": "instruction-delta",
    ".codex/hooks/gate.conf": "instruction-delta",
    "AGENTS.md": "instruction-delta",
    "CLAUDE_RELEASE.txt": "upstream-identical",
    "CODEX_RELEASE.txt": "upstream-identical",
    "src/project.py": "project-owned",
}
base_keys = {
    "path",
    "classification",
    "candidate",
    "instruction_kinds",
    "instruction_sources",
}
for path, item in ownership.items():
    if path == "src/project.py":
        assert set(item) == base_keys
    else:
        assert set(item) == base_keys | {"managed_bindings"}
        assert all(
            set(binding)
            == {"kit", "upgrade_ownership", "upstream", "upgrade_post"}
            for binding in item["managed_bindings"]
        )
inventory_path = review_input / "bundle-inventory.json"
inventory = json.loads(inventory_path.read_text())
expected = {item["path"]: item for item in inventory["files"]}
for path in review_input.glob("attestations/*/*.json"):
    rel = path.relative_to(root).as_posix()
    assert rel in expected
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected[rel]["sha256"]
    assert stat.S_IMODE(path.stat().st_mode) == expected[rel]["mode"]
PY

  # The same strict qualification + legacy-upgrade / review + current-state
  # pairing must remain valid for a subproject-scoped pxim-shaped target.
  composite_pxim_bundle="$tmp/composite-pxim-bundle"
  composite_pxim_output="$tmp/composite-pxim.out"
  composite_pxim_upgrade_claude="$tmp/composite-pxim-upgrade-claude.json"
  composite_pxim_upgrade_codex="$tmp/composite-pxim-upgrade-codex.json"
  python3 - "$composite_upgrade_claude" "$composite_pxim_upgrade_claude" \
    "$composite_upgrade_codex" "$composite_pxim_upgrade_codex" <<'PY'
import json
from pathlib import Path
import sys

for source_name, destination_name in zip(sys.argv[1::2], sys.argv[2::2]):
    value = json.loads(Path(source_name).read_text(encoding="utf-8"))
    value["scope"] = "subproject"
    Path(destination_name).write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
PY
  composite_pxim_upgrade_claude_digest="$(sha256_path "$composite_pxim_upgrade_claude")"
  composite_pxim_upgrade_codex_digest="$(sha256_path "$composite_pxim_upgrade_codex")"
  "$composite_runner" \
    --mode maintenance \
    --patch "$composite_patch" \
    --bundle "$composite_pxim_bundle" \
    --plan "$composite_project/plans/M7.md" \
    --review-policy "$composite_project/REVIEW_POLICY.md" \
    --base-ref "$composite_base" \
    --head-ref "$composite_head" \
    --upstream-attestation "$composite_upstream_claude" \
    --upstream-attestation-sha256 "$composite_upstream_claude_digest" \
    --upgrade-attestation "$composite_pxim_upgrade_claude" \
    --upgrade-attestation-sha256 "$composite_pxim_upgrade_claude_digest" \
    --upstream-attestation "$composite_upstream_codex" \
    --upstream-attestation-sha256 "$composite_upstream_codex_digest" \
    --upgrade-attestation "$composite_pxim_upgrade_codex" \
    --upgrade-attestation-sha256 "$composite_pxim_upgrade_codex_digest" \
    --maintenance-authorization "$composite_nonce" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf \
    > "$composite_pxim_output"
  grep -qx 'review_mode=maintenance' "$composite_pxim_output"
  [ -f "$composite_pxim_bundle/.review-input/maintenance-manifest.json" ]

  composite_projection_bundle="$tmp/composite-path-neutral-bundle"
  composite_projection_output="$tmp/composite-path-neutral.out"
  composite_projection_sidecar="$tmp/composite-path-neutral-sidecar.json"
  printf '%s\n' \
    '# M7-D.2 composite projection fixture' \
    '- maintenance_review_projection: path-neutral-v1' \
    '- maintenance_attestation_bindings:' \
    '  - kit: `agent_policies-claude`' \
    '    upstream_release_attestation_id: `release/claude/upstream.json`' \
    "    upstream_release_attestation_sha256: \`$composite_upstream_claude_digest\`" \
    '    upgrade_attestation_id: `install/claude/maintenance-attestation.json`' \
    "    upgrade_attestation_sha256: \`$composite_upgrade_claude_digest\`" \
    '  - kit: `agent_policies-codex`' \
    '    upstream_release_attestation_id: `release/codex/upstream.json`' \
    "    upstream_release_attestation_sha256: \`$composite_upstream_codex_digest\`" \
    '    upgrade_attestation_id: `install/codex/maintenance-attestation.json`' \
    "    upgrade_attestation_sha256: \`$composite_upgrade_codex_digest\`" \
    > "$composite_project/plans/M7-projection.md"
  git -C "$composite_project" add plans/M7-projection.md
  git -C "$composite_project" commit -qm composite-path-neutral-plan-binding
  composite_projection_head="$(git -C "$composite_project" rev-parse HEAD)"
  composite_projection_patch="$tmp/composite-path-neutral.patch"
  git -C "$composite_project" diff --no-renames --binary --relative \
    "$composite_base...$composite_projection_head" -- . \
    > "$composite_projection_patch"
  "$composite_runner" \
    --mode maintenance \
    --maintenance-review-projection path-neutral-v1 \
    --maintenance-prelaunch-sidecar "$composite_projection_sidecar" \
    --patch "$composite_projection_patch" \
    --bundle "$composite_projection_bundle" \
    --plan "$composite_project/plans/M7-projection.md" \
    --review-policy "$composite_project/REVIEW_POLICY.md" \
    --base-ref "$composite_base" \
    --head-ref "$composite_projection_head" \
    --upstream-attestation "$composite_upstream_claude" \
    --upstream-attestation-sha256 "$composite_upstream_claude_digest" \
    --upgrade-attestation "$composite_upgrade_claude" \
    --upgrade-attestation-sha256 "$composite_upgrade_claude_digest" \
    --upstream-attestation "$composite_upstream_codex" \
    --upstream-attestation-sha256 "$composite_upstream_codex_digest" \
    --upgrade-attestation "$composite_upgrade_codex" \
    --upgrade-attestation-sha256 "$composite_upgrade_codex_digest" \
    --maintenance-authorization "$composite_nonce" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf \
    > "$composite_projection_output"
  composite_projection_sidecar_digest="$(sha256_path "$composite_projection_sidecar")"
  grep -qx 'review_maintenance_projection=path-neutral-v1' \
    "$composite_projection_output"
  grep -qx "review_maintenance_sidecar_digest=$composite_projection_sidecar_digest" \
    "$composite_projection_output"
  [ ! -e "$composite_projection_bundle/.review-input/attestations" ]
  if grep -R -Fq "$composite_project" "$composite_projection_bundle"; then
    echo "composite physical project root leaked into path-neutral bundle" >&2
    return 1
  fi
  python3 - "$composite_projection_bundle" "$composite_projection_sidecar" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
manifest = json.loads((root / ".review-input/maintenance-manifest.json").read_text())
sidecar = json.loads(Path(sys.argv[2]).read_text())
assert manifest["schema"] == 3
assert manifest["projection_mode"] == "path-neutral-v1"
assert [item["kit"] for item in manifest["attestation_projections"]] == [
    "agent_policies-claude", "agent_policies-codex"
]
assert [item["kit"] for item in sidecar["attestation_sets"]] == [
    "agent_policies-claude", "agent_policies-codex"
]
assert "destination" not in json.dumps(manifest)
assert not any("path" in descriptor for item in manifest["attestation_projections"] for descriptor in [item])
PY
  if "$composite_runner" \
      --mode maintenance \
      --maintenance-review-projection path-neutral-v1 \
      --maintenance-prelaunch-sidecar "$tmp/composite-projection-tamper-sidecar.json" \
      --patch "$composite_projection_patch" \
      --bundle "$tmp/composite-projection-tamper-bundle" \
      --plan "$composite_project/plans/M7-projection.md" \
      --review-policy "$composite_project/REVIEW_POLICY.md" \
      --base-ref "$composite_base" \
      --head-ref "$composite_projection_head" \
      --upstream-attestation "$composite_tampered_upstream" \
      --upstream-attestation-sha256 "$composite_upstream_claude_digest" \
      --upgrade-attestation "$composite_upgrade_claude" \
      --upgrade-attestation-sha256 "$composite_upgrade_claude_digest" \
      --upstream-attestation "$composite_upstream_codex" \
      --upstream-attestation-sha256 "$composite_upstream_codex_digest" \
      --upgrade-attestation "$composite_upgrade_codex" \
      --upgrade-attestation-sha256 "$composite_upgrade_codex_digest" \
      --maintenance-authorization "$composite_nonce" \
      --instruction-delta AGENTS.md \
      --instruction-delta .claude/hooks/gate.conf \
      --instruction-delta .codex/hooks/gate.conf \
      > "$tmp/composite-projection-tamper.out" 2>&1; then
    echo "path-neutral composite accepted a tampered original artifact" >&2
    return 1
  fi
  [ ! -e "$tmp/composite-projection-tamper-bundle" ] &&
    [ ! -e "$tmp/composite-projection-tamper-sidecar.json" ]
  git -C "$composite_project" checkout -q --detach "$composite_head"

  expect_composite_failure() {
    local label="$1" expected="$2" upstream_one="$3" upstream_one_digest="$4"
    local upgrade_one="$5" upgrade_one_digest="$6" upstream_two="$7"
    local upstream_two_digest="$8" upgrade_two="$9" upgrade_two_digest="${10}"
    shift 10
    if "$composite_runner" \
        --mode maintenance \
        --patch "$composite_patch" \
        --bundle "$tmp/composite-fail-$label-bundle" \
        --plan "$composite_project/plans/M7.md" \
        --review-policy "$composite_project/REVIEW_POLICY.md" \
        --base-ref "$composite_base" \
        --head-ref "$composite_head" \
        --upstream-attestation "$upstream_one" \
        --upstream-attestation-sha256 "$upstream_one_digest" \
        --upgrade-attestation "$upgrade_one" \
        --upgrade-attestation-sha256 "$upgrade_one_digest" \
        --upstream-attestation "$upstream_two" \
        --upstream-attestation-sha256 "$upstream_two_digest" \
        --upgrade-attestation "$upgrade_two" \
        --upgrade-attestation-sha256 "$upgrade_two_digest" \
        --maintenance-authorization "$composite_nonce" \
        "$@" > "$tmp/composite-fail-$label.out" 2>&1; then
      echo "composite negative leg was accepted: $label" >&2
      return 1
    fi
    grep -Fq "$expected" "$tmp/composite-fail-$label.out"
    [ ! -e "$tmp/composite-fail-$label-bundle" ] || {
      echo "composite negative leg left accepted output: $label" >&2
      return 1
    }
  }

  write_m21_mutation() {
    local mutation="$1" source_path="$2" destination_path="$3"
    local context="${4:-}"
    python3 - "$mutation" "$source_path" "$destination_path" "$context" <<'PY'
import json
from pathlib import Path
import sys

mutation = sys.argv[1]
source = Path(sys.argv[2])
destination = Path(sys.argv[3])
context = sys.argv[4]
raw = source.read_bytes()

if mutation == "invalid-utf8":
    destination.write_bytes(b"\xff" + raw)
    raise SystemExit
value = json.loads(raw.decode("utf-8"))
if mutation == "nonfinite":
    destination.write_bytes(raw.replace(b'"schema": 1', b'"schema": NaN', 1))
    raise SystemExit
if mutation == "noncanonical":
    destination.write_text(json.dumps(value, sort_keys=True), encoding="utf-8")
    raise SystemExit

valid_review = {
    "archive_manifest_sha256": "2" * 64,
    "blocking": "none",
    "criteria_met": "10/10",
    "milestone": "M21",
    "patch_sha256": "1" * 64,
    "verdict": "approve",
}
if mutation == "claims-both":
    value["review"] = valid_review
elif mutation == "claims-neither":
    value.pop("qualification")
elif mutation == "qualification-missing":
    value["qualification"].pop("release_tag")
elif mutation == "qualification-extra":
    value["qualification"]["extra"] = "reject"
elif mutation == "qualification-type":
    value["qualification"]["handoff_id"] = 7
elif mutation == "qualification-value":
    value["qualification"]["handoff_verify"] = "FAIL"
elif mutation == "qualification-release-tag":
    value["qualification"]["release_tag"] = context
elif mutation == "review-zero":
    value["review"]["criteria_met"] = "0/10"
elif mutation == "review-over":
    value["review"]["criteria_met"] = "11/10"
elif mutation == "review-nonnumeric":
    value["review"]["criteria_met"] = "seven/10"
elif mutation == "review-unicode-digit":
    value["review"]["criteria_met"] = "\uff17/10"
elif mutation == "review-type":
    value["review"]["criteria_met"] = 7
elif mutation == "review-extra":
    value["review"]["unexpected"] = "reject"
elif mutation == "review-verdict":
    value["review"]["verdict"] = "revise"
elif mutation == "review-blocking":
    value["review"]["blocking"] = "present"
elif mutation == "review-patch-digest":
    value["review"]["patch_sha256"] = "not-a-digest"
elif mutation == "review-archive-digest":
    value["review"]["archive_manifest_sha256"] = "not-a-digest"
elif mutation == "review-wrong-milestone":
    value["review"]["milestone"] = "M21"
elif mutation == "source-repository-missing":
    value["source"].pop("repository")
elif mutation == "source-repository-extra":
    value["source"]["repository_alias"] = value["source"]["repository"]
elif mutation == "source-repository-wrong":
    value["source"]["repository"] = "https://example.invalid/wrong.git"
elif mutation == "source-revision-wrong":
    value["source"]["revision"] = "e" * 40
elif mutation == "source-tree-wrong":
    value["source"]["tree"] = "f" * 40
elif mutation == "operation-mixed":
    value["operation"] = "upgrade"
elif mutation == "operation-unknown":
    value["operation"] = "current"
elif mutation == "source-dirty":
    value["source"]["dirty"] = True
elif mutation == "destination-drift":
    value["destination"] = "@WRONG_TARGET_ROOT@"
elif mutation == "scope-drift":
    value["scope"] = "unknown"
elif mutation == "pre-status-drift":
    value["pre"]["status_sha256"] = "1" * 64
elif mutation == "post-status-drift":
    value["post"]["status_sha256"] = "1" * 64
elif mutation == "managed-count-drift":
    value["managed_path_count"] += 1
elif mutation == "managed-path-drift":
    value["managed_paths"][0]["path"] = "UNBOUND.txt"
elif mutation == "action-drift":
    next(
        item
        for item in value["managed_paths"]
        if item["ownership"] == "upstream-identical"
    )["action"] = "upgrade"
elif mutation == "source-digest-drift":
    value["managed_paths"][0]["source"]["sha256"] = "0" * 64
elif mutation == "pre-digest-drift":
    value["managed_paths"][0]["pre"]["sha256"] = "0" * 64
elif mutation == "post-digest-drift":
    next(
        item
        for item in value["managed_paths"]
        if item["ownership"] == "upstream-identical"
    )["post"]["sha256"] = "0" * 64
elif mutation == "mode-drift":
    value["managed_paths"][0]["post"]["mode"] = 0o600
elif mutation == "duplicate-managed-path":
    value["managed_paths"].append(value["managed_paths"][0])
    value["managed_path_count"] += 1
elif mutation == "managed-order-drift":
    value["managed_paths"] = list(reversed(value["managed_paths"]))
else:
    raise SystemExit(f"unknown M21 self-test mutation: {mutation}")

destination.write_text(
    json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
  }

  expect_m21_upstream_failure() {
    local label="$1" expected="$2" mutation="$3"
    local artifact="$tmp/m21-upstream-$label.json" digest
    write_m21_mutation "$mutation" "$composite_upstream_claude" "$artifact"
    digest="$(sha256_path "$artifact")"
    expect_composite_failure "m21-upstream-$label" "$expected" \
      "$artifact" "$digest" \
      "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
      "$composite_upstream_codex" "$composite_upstream_codex_digest" \
      "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
      --instruction-delta AGENTS.md \
      --instruction-delta .claude/hooks/gate.conf \
      --instruction-delta .codex/hooks/gate.conf
  }

  expect_m21_review_failure() {
    local label="$1" expected="$2" mutation="$3"
    local artifact="$tmp/m21-review-$label.json" digest
    write_m21_mutation "$mutation" "$composite_upstream_codex" "$artifact"
    digest="$(sha256_path "$artifact")"
    expect_composite_failure "m21-review-$label" "$expected" \
      "$composite_upstream_claude" "$composite_upstream_claude_digest" \
      "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
      "$artifact" "$digest" \
      "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
      --instruction-delta AGENTS.md \
      --instruction-delta .claude/hooks/gate.conf \
      --instruction-delta .codex/hooks/gate.conf
    [ "$(tail -n 1 "$tmp/composite-fail-m21-review-$label.out")" = \
      "BundleError: $expected" ]
  }

  expect_m21_projection_sanitized_failure() {
    local label="$1" expected="$2" raw_value="$3"
    local artifact="$tmp/m21-projection-$label.json" digest
    local bundle_path="$tmp/m21-projection-$label-bundle"
    local sidecar_path="$tmp/m21-projection-$label-sidecar.json"
    local output_path="$tmp/m21-projection-$label.out"
    write_m21_mutation qualification-release-tag \
      "$composite_upstream_claude" "$artifact" "$raw_value"
    digest="$(sha256_path "$artifact")"
    git -C "$composite_project" checkout -q --detach "$composite_projection_head"
    if "$composite_runner" \
        --mode maintenance \
        --maintenance-review-projection path-neutral-v1 \
        --maintenance-prelaunch-sidecar "$sidecar_path" \
        --patch "$composite_projection_patch" \
        --bundle "$bundle_path" \
        --plan "$composite_project/plans/M7-projection.md" \
        --review-policy "$composite_project/REVIEW_POLICY.md" \
        --base-ref "$composite_base" \
        --head-ref "$composite_projection_head" \
        --upstream-attestation "$artifact" \
        --upstream-attestation-sha256 "$digest" \
        --upgrade-attestation "$composite_upgrade_claude" \
        --upgrade-attestation-sha256 "$composite_upgrade_claude_digest" \
        --upstream-attestation "$composite_upstream_codex" \
        --upstream-attestation-sha256 "$composite_upstream_codex_digest" \
        --upgrade-attestation "$composite_upgrade_codex" \
        --upgrade-attestation-sha256 "$composite_upgrade_codex_digest" \
        --maintenance-authorization "$composite_nonce" \
        --instruction-delta AGENTS.md \
        --instruction-delta .claude/hooks/gate.conf \
        --instruction-delta .codex/hooks/gate.conf \
        > "$output_path" 2>&1; then
      echo "path-neutral projection negative was accepted: $label" >&2
      return 1
    fi
    [ "$(tail -n 1 "$output_path")" = "BundleError: $expected" ]
    if grep -Fq -- "$raw_value" "$output_path"; then
      echo "path-neutral projection negative reflected raw input: $label" >&2
      return 1
    fi
    [ ! -e "$bundle_path" ] && [ ! -e "$sidecar_path" ] || {
      echo "path-neutral projection negative left output: $label" >&2
      return 1
    }
    git -C "$composite_project" checkout -q --detach "$composite_head"
  }

  expect_m21_current_failure() {
    local label="$1" expected="$2" mutation="$3"
    local artifact="$tmp/m21-current-$label.json" digest
    write_m21_mutation "$mutation" "$composite_upgrade_codex" "$artifact"
    digest="$(sha256_path "$artifact")"
    expect_composite_failure "m21-current-$label" "$expected" \
      "$composite_upstream_claude" "$composite_upstream_claude_digest" \
      "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
      "$composite_upstream_codex" "$composite_upstream_codex_digest" \
      "$artifact" "$digest" \
      --instruction-delta AGENTS.md \
      --instruction-delta .claude/hooks/gate.conf \
      --instruction-delta .codex/hooks/gate.conf
  }

  if "$composite_runner" \
      --mode maintenance \
      --patch "$composite_patch" \
      --bundle "$tmp/composite-unequal-bundle" \
      --plan "$composite_project/plans/M7.md" \
      --review-policy "$composite_project/REVIEW_POLICY.md" \
      --base-ref "$composite_base" \
      --head-ref "$composite_head" \
      --upstream-attestation "$composite_upstream_claude" \
      --upstream-attestation-sha256 "$composite_upstream_claude_digest" \
      --upgrade-attestation "$composite_upgrade_claude" \
      --upgrade-attestation-sha256 "$composite_upgrade_claude_digest" \
      --upstream-attestation "$composite_upstream_codex" \
      --upstream-attestation-sha256 "$composite_upstream_codex_digest" \
      --maintenance-authorization "$composite_nonce" \
      --instruction-delta AGENTS.md \
      > "$tmp/composite-unequal.out" 2>&1; then
    echo "unequal composite attestation members were accepted" >&2
    return 1
  fi
  grep -q '^usage:' "$tmp/composite-unequal.out"
  if "$composite_runner" \
      --patch "$composite_patch" \
      --bundle "$tmp/composite-standard-attestation-bundle" \
      --plan "$composite_project/plans/M7.md" \
      --review-policy "$composite_project/REVIEW_POLICY.md" \
      --upstream-attestation "$composite_upstream_claude" \
      > "$tmp/composite-standard-attestation.out" 2>&1; then
    echo "standard mode accepted a maintenance attestation member" >&2
    return 1
  fi
  grep -q '^usage:' "$tmp/composite-standard-attestation.out"

  expect_m21_upstream_failure claims-both \
    'must contain exactly one review or qualification claim' claims-both
  expect_m21_upstream_failure claims-neither \
    'must contain exactly one review or qualification claim' claims-neither
  expect_m21_upstream_failure qualification-missing \
    'upstream release qualification binding has unknown or missing fields' \
    qualification-missing
  expect_m21_upstream_failure qualification-extra \
    'upstream release qualification binding has unknown or missing fields' \
    qualification-extra
  expect_m21_upstream_failure qualification-type \
    'upstream release qualification handoff identity is malformed' qualification-type
  expect_m21_upstream_failure qualification-value \
    'upstream release qualification is not verified' qualification-value
  expect_m21_upstream_failure qualification-noncanonical \
    'is not canonical sorted UTF-8 JSON' noncanonical
  expect_m21_upstream_failure qualification-invalid-utf8 \
    'cannot read upstream release attestation set 1' invalid-utf8
  expect_m21_upstream_failure qualification-nonfinite \
    'contains a non-finite JSON number' nonfinite

  expect_m21_review_failure zero \
    'upstream release attestation does not carry a valid approve verdict' \
    review-zero
  expect_m21_review_failure over \
    'upstream release attestation does not carry a valid approve verdict' \
    review-over
  expect_m21_review_failure nonnumeric \
    'upstream release attestation does not carry a valid approve verdict' \
    review-nonnumeric
  expect_m21_review_failure unicode-digit \
    'upstream release attestation does not carry a valid approve verdict' \
    review-unicode-digit
  expect_m21_review_failure type \
    'upstream release attestation does not carry a valid approve verdict' \
    review-type
  expect_m21_review_failure extra \
    'upstream release review binding has unknown or missing fields' \
    review-extra
  expect_m21_review_failure verdict \
    'upstream release attestation does not carry a valid approve verdict' \
    review-verdict
  expect_m21_review_failure blocking \
    'upstream release attestation does not carry a valid approve verdict' \
    review-blocking
  expect_m21_review_failure patch-digest \
    'upstream release attestation does not carry a valid approve verdict' \
    review-patch-digest
  expect_m21_review_failure archive-digest \
    'upstream release attestation does not carry a valid approve verdict' \
    review-archive-digest
  expect_m21_review_failure wrong-milestone \
    'upstream release attestation does not carry a valid approve verdict' \
    review-wrong-milestone
  expect_m21_review_failure noncanonical \
    'upstream release attestation set 2 is not canonical sorted UTF-8 JSON' \
    noncanonical

  local physical_marker private_key_marker credential_marker token_marker
  physical_marker="$composite_project"
  private_key_marker='-----BEGIN '"OPENSSH PRIVATE KEY-----"
  credential_marker='Authorization:'" Bearer self-test-credential"
  token_marker='github_'"pat_self_test_token"
  expect_m21_projection_sanitized_failure physical-path \
    'path-neutral reviewable bytes contain a physical checkout/home/artifact path: .review-input/maintenance-manifest.json' \
    "$physical_marker"
  expect_m21_projection_sanitized_failure private-key \
    'path-neutral reviewable bytes contain a secret marker: .review-input/maintenance-manifest.json' \
    "$private_key_marker"
  expect_m21_projection_sanitized_failure credential \
    'path-neutral reviewable bytes contain a secret marker: .review-input/maintenance-manifest.json' \
    "$credential_marker"
  expect_m21_projection_sanitized_failure token \
    'path-neutral reviewable bytes contain a secret marker: .review-input/maintenance-manifest.json' \
    "$token_marker"

  expect_m21_current_failure repository-missing \
    'upgrade attestation source binding has unknown or missing fields' \
    source-repository-missing
  expect_m21_current_failure repository-extra \
    'upgrade attestation source binding has unknown or missing fields' \
    source-repository-extra
  expect_m21_current_failure repository-wrong \
    'upgrade attestation source binding mismatch' source-repository-wrong
  expect_m21_current_failure revision-wrong \
    'upgrade attestation source binding mismatch' source-revision-wrong
  expect_m21_current_failure tree-wrong \
    'upgrade attestation source binding mismatch' source-tree-wrong
  expect_m21_current_failure operation-mixed \
    'upgrade attestation target binding mismatch' operation-mixed
  expect_m21_current_failure operation-unknown \
    'upgrade attestation operation is unsupported' operation-unknown
  expect_m21_current_failure dirty \
    'upgrade attestation source binding mismatch' source-dirty
  expect_m21_current_failure destination \
    'upgrade attestation target binding mismatch' destination-drift
  expect_m21_current_failure scope \
    'upgrade attestation target binding mismatch' scope-drift
  expect_m21_current_failure pre-status \
    'current-state attestation target state binding mismatch' pre-status-drift
  expect_m21_current_failure post-status \
    'current-state attestation target state binding mismatch' post-status-drift
  expect_m21_current_failure count \
    'upgrade/upstream managed path sets differ' managed-count-drift
  expect_m21_current_failure path \
    'upgrade/upstream managed source mismatch' managed-path-drift
  expect_m21_current_failure action \
    'current-state attestation has a non-current action' action-drift
  expect_m21_current_failure source-digest \
    'upgrade/upstream managed source mismatch' source-digest-drift
  expect_m21_current_failure pre-digest \
    'current-state attestation pre/post state differs' pre-digest-drift
  expect_m21_current_failure post-digest \
    'upgrade postimage is not upstream-identical' post-digest-drift
  expect_m21_current_failure mode \
    'has an invalid file state' mode-drift
  expect_m21_current_failure duplicate-path \
    'upgrade attestation duplicates managed path' duplicate-managed-path
  expect_m21_current_failure path-order \
    'upgrade/upstream managed path sets differ' managed-order-drift
  expect_m21_current_failure current-noncanonical \
    'is not canonical sorted UTF-8 JSON' noncanonical
  expect_composite_failure wrong-kit-order \
    'composite maintenance kit order must be Claude then Codex' \
    "$composite_upstream_codex" "$composite_upstream_codex_digest" \
    "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
    "$composite_upstream_claude" "$composite_upstream_claude_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf

  expect_composite_failure duplicate-kit \
    'composite maintenance duplicates kit identity: agent_policies-claude' \
    "$composite_upstream_claude" "$composite_upstream_claude_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    "$composite_upstream_claude" "$composite_upstream_claude_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf
  expect_composite_failure cross-swap \
    'maintenance attestation pair kit identity mismatch' \
    "$composite_upstream_claude" "$composite_upstream_claude_digest" \
    "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
    "$composite_upstream_codex" "$composite_upstream_codex_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf
  expect_composite_failure mixed-shared-ownership \
    'shared managed path has mixed ownership: AGENTS.md' \
    "$composite_upstream_claude" "$composite_upstream_claude_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    "$composite_mixed_upstream" "$composite_mixed_upstream_digest" \
    "$composite_mixed_upgrade" "$composite_mixed_upgrade_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf
  [ "$(tail -n 1 "$tmp/composite-fail-mixed-shared-ownership.out")" = \
    'BundleError: shared managed path has mixed ownership: AGENTS.md' ]
  expect_composite_failure incompatible-shared-state \
    'shared upstream-identical managed state is incompatible: SHARED.txt' \
    "$composite_incompatible_upstream" \
    "$composite_incompatible_upstream_digest" \
    "$composite_incompatible_upgrade" \
    "$composite_incompatible_upgrade_digest" \
    "$composite_upstream_codex" "$composite_upstream_codex_digest" \
    "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf
  [ "$(tail -n 1 "$tmp/composite-fail-incompatible-shared-state.out")" = \
    'BundleError: shared upstream-identical managed state is incompatible: SHARED.txt' ]
  expect_composite_failure omitted-delta \
    'maintenance instruction delta was not declared: .codex/hooks/gate.conf' \
    "$composite_upstream_claude" "$composite_upstream_claude_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    "$composite_upstream_codex" "$composite_upstream_codex_digest" \
    "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf
  expect_composite_failure upstream-identical-candidate-drift \
    'candidate managed path drifted from upstream release: src/project.py' \
    "$composite_unclassified_upstream" \
    "$composite_unclassified_upstream_digest" \
    "$composite_unclassified_upgrade" \
    "$composite_unclassified_upgrade_digest" \
    "$composite_upstream_codex" "$composite_upstream_codex_digest" \
    "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf
  [ "$(tail -n 1 "$tmp/composite-fail-upstream-identical-candidate-drift.out")" = \
    'BundleError: candidate managed path drifted from upstream release: src/project.py' ]
  expect_composite_failure unknown-attestation \
    'upstream release attestation set 2 has unknown or missing fields' \
    "$composite_upstream_claude" "$composite_upstream_claude_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    "$composite_unknown_upstream" "$composite_unknown_upstream_digest" \
    "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf
  [ "$(tail -n 1 "$tmp/composite-fail-unknown-attestation.out")" = \
    'BundleError: upstream release attestation set 2 has unknown or missing fields' ]
  if grep -Fq 'must-fail' "$tmp/composite-fail-unknown-attestation.out"; then
    echo "unknown attestation field reflected its raw value" >&2
    return 1
  fi
  expect_composite_failure tampered-attestation \
    'upstream release attestation set 1 digest mismatch' \
    "$composite_tampered_upstream" "$composite_upstream_claude_digest" \
    "$composite_upgrade_claude" "$composite_upgrade_claude_digest" \
    "$composite_upstream_codex" "$composite_upstream_codex_digest" \
    "$composite_upgrade_codex" "$composite_upgrade_codex_digest" \
    --instruction-delta AGENTS.md \
    --instruction-delta .claude/hooks/gate.conf \
    --instruction-delta .codex/hooks/gate.conf
  git -C "$maintenance_project" checkout -q --detach "$projection_head"
  printf 'deleted physical root: %s\n' "$maintenance_project" \
    > "$maintenance_project/path-leak.txt"
  git -C "$maintenance_project" add path-leak.txt
  git -C "$maintenance_project" commit -qm path-leak-base
  leak_base="$(git -C "$maintenance_project" rev-parse HEAD)"
  rm "$maintenance_project/path-leak.txt"
  git -C "$maintenance_project" add -u path-leak.txt
  git -C "$maintenance_project" commit -qm path-leak-candidate
  leak_head="$(git -C "$maintenance_project" rev-parse HEAD)"
  leak_patch="$tmp/path-leak.patch"
  leak_upgrade="$tmp/path-leak-upgrade.json"
  leak_bundle="$tmp/path-leak-bundle"
  leak_sidecar="$tmp/path-leak-sidecar.json"
  git -C "$maintenance_project" diff --no-renames --binary --relative \
    "$leak_base...$leak_head" -- . > "$leak_patch"
  cp "$maintenance_upgrade" "$leak_upgrade"
  python3 - "$leak_upgrade" "$maintenance_project" "$leak_base" <<'PY'
import json
from pathlib import Path
import subprocess
import sys

path = Path(sys.argv[1])
project = sys.argv[2]
base = sys.argv[3]
value = json.loads(path.read_text())
value["pre"]["head"] = base
value["pre"]["tree"] = subprocess.check_output(
    ["git", "-C", project, "rev-parse", f"{base}^{{tree}}"], text=True
).strip()
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
  leak_upgrade_digest="$(sha256_path "$leak_upgrade")"
  if "$maintenance_runner" \
      --mode maintenance \
      --maintenance-review-projection path-neutral-v1 \
      --maintenance-prelaunch-sidecar "$leak_sidecar" \
      --patch "$leak_patch" \
      --bundle "$leak_bundle" \
      --plan "$maintenance_project/plans/M7-projection.md" \
      --review-policy "$maintenance_project/REVIEW_POLICY.md" \
      --base-ref "$leak_base" \
      --head-ref "$leak_head" \
      --upstream-attestation "$maintenance_upstream" \
      --upstream-attestation-sha256 "$upstream_digest" \
      --upgrade-attestation "$leak_upgrade" \
      --upgrade-attestation-sha256 "$leak_upgrade_digest" \
      --maintenance-authorization "$maintenance_nonce" \
      > "$tmp/path-leak.out" 2>&1; then
    echo "path-neutral helper accepted a physical root in a deleted patch line" >&2
    return 1
  fi
  grep -q 'path-neutral reviewable bytes contain a physical checkout/home/artifact path: .review-input/patch.diff' \
    "$tmp/path-leak.out"
  [ ! -e "$leak_bundle" ] && [ ! -e "$leak_sidecar" ] || {
    echo "failed path-neutral bundle left a bundle or sidecar behind" >&2
    return 1
  }
  m22_matrix_program="$tmp/m22-secret-marker-matrix.py"
  m22_matrix_one="$tmp/m22-secret-marker-matrix-one.out"
  m22_matrix_two="$tmp/m22-secret-marker-matrix-two.out"
  cat > "$m22_matrix_program" <<'PY'
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def fail(reason):
    raise SystemExit(f"M22 marker matrix failure: {reason}")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def production_child(helper):
    raw = helper.read_bytes()
    anchor = b'9<<< "$MAINTENANCE_AUTHORIZATION" <<\'PY\'\n'
    start = raw.find(anchor)
    if start < 0:
        fail("production heredoc anchor missing")
    start += len(anchor)
    end = raw.find(b"\nPY\n", start)
    if end < 0:
        fail("production heredoc terminator missing")
    source = raw[start : end + 1].decode("utf-8", "strict")
    tree = ast.parse(source)
    wanted = {
        "path_neutral_contains_secret_marker",
        "enforce_path_neutral_secret_markers",
    }
    functions = {
        node.name: node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name in wanted
    }
    if set(functions) != wanted:
        fail("production scanner function set mismatch")
    segments = []
    for name in (
        "path_neutral_contains_secret_marker",
        "enforce_path_neutral_secret_markers",
    ):
        segment = ast.get_source_segment(source, functions[name])
        if segment is None:
            fail("production scanner source segment missing")
        segments.append(segment)
    return (
        "import re\nimport sys\n"
        "class MarkerFailure(Exception):\n    pass\n"
        "def fail(reason):\n    raise MarkerFailure(reason)\n\n"
        + "\n\n".join(segments)
        + "\n\ndata = sys.stdin.buffer.read()\n"
        "try:\n"
        "    enforce_path_neutral_secret_markers(\n"
        "        data, '.review-input/m22-secret-marker-fixture.bin'\n"
        "    )\n"
        "except MarkerFailure as error:\n"
        "    sys.stdout.write('BundleError: ' + str(error) + '\\n')\n"
        "    raise SystemExit(1)\n"
        "sys.stdout.write('M22_SECRET_MARKER_SCAN=PASS\\n')\n"
    )


def run_case(child, case_id, data, reject):
    completed = subprocess.run(
        [sys.executable, "-c", child],
        input=data,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        env={"LC_ALL": "C", "TZ": "UTC"},
        check=False,
    )
    pass_output = b"M22_SECRET_MARKER_SCAN=PASS\n"
    reject_output = (
        b"BundleError: path-neutral reviewable bytes contain a secret marker: "
        b".review-input/m22-secret-marker-fixture.bin\n"
    )
    expected_rc = 1 if reject else 0
    expected_stdout = reject_output if reject else pass_output
    if (
        completed.returncode != expected_rc
        or completed.stdout != expected_stdout
        or completed.stderr
    ):
        fail(f"case contract mismatch: {case_id}")
    if reject and data and data in completed.stdout:
        fail(f"raw fixture reflected: {case_id}")
    return {
        "case": case_id,
        "expected": "REJECT" if reject else "ACCEPT",
        "rc": completed.returncode,
        "stdout_sha256": sha256(completed.stdout),
    }


def main():
    if len(sys.argv) != 3:
        fail("argv")
    helper = Path(sys.argv[1])
    bound_patch_arg = sys.argv[2]
    child = production_child(helper)
    assignment = b"maintenance_" + b"authorization="
    writer = (
        b"    'printf \""
        + assignment
        + b"%s\\n\" \"${AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION:-}\" "
        b">> \"$REVIEW_WRAPPER_TEST_OUT\"' \\"
    )
    audited_once = [writer] + [
        b"  grep -qx '" + assignment + b"' \"$out." + suffix + b"\""
        for suffix in (
            b"maintenance",
            b"projection",
            b"composite",
            b"composite-projection",
        )
    ]
    expected_hashes_once = [
        "8c179e8c472a8d4be33a14a8ccf89877dba37753ddef05db2f1686c29a0f7803",
        "59d2677f395e091b14699055ff715faf84d9f570be9afbfd1277a20187b50d54",
        "70185bbf3bd56c97de259bd7bef7ba50a532adc90b388a848de91286867e101a",
        "a248c0f522fbbdbe71b1d4d17dfee44724fd8ad8117da67f95d532dac4ed077f",
        "da58e3fa54522afb61f60462eee40997d4de717f90d12a26a1b5f6158c8cbf0c",
    ]
    if [sha256(item) for item in audited_once] != expected_hashes_once:
        fail("audited inert line binding mismatch")
    audited = audited_once + audited_once
    positives = [
        (f"audited-inert-{index:02d}", value, False)
        for index, value in enumerate(audited, 1)
    ]
    positives.extend(
        [
            (
                "empty-assertion-whitespace",
                b"\tgrep\t-qx\t'" + assignment + b"'\t\"$out.whitespace\"\t",
                False,
            ),
            (
                "deterministic-template-whitespace",
                b"\t'printf\t\""
                + assignment
                + b"%s\\n\"\t\"${AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION:-}\""
                b"\t>>\t\"$REVIEW_WRAPPER_TEST_OUT\"'\t\\\t",
                False,
            ),
        ]
    )
    exact_bound_patch = 0
    if bound_patch_arg:
        patch_path = Path(bound_patch_arg)
        if not patch_path.is_file() or patch_path.is_symlink():
            fail("bound patch type mismatch")
        patch = patch_path.read_bytes()
        if (
            len(patch) != 375732
            or sha256(patch)
            != "28f330fd28c39c2081b94a91f07cbfeb09d607fa86845a204c56080479507796"
            or patch.count(assignment) != 10
        ):
            fail("bound patch bytes mismatch")
        positives.append(("exact-bound-aa-patch", patch, False))
        exact_bound_patch = 1

    private_openssh = b"-----BEGIN " + b"OPENSSH PRIVATE KEY-----"
    private_generic = b"-----BEGIN " + b"PRIVATE KEY-----"
    bearer = b"Authorization:" + b" Bearer "
    token = b"github_" + b"pat_"
    negatives = [
        ("nonempty-literal", assignment + b"literal-value", True),
        ("single-quoted-value", assignment + b"'literal-value'", True),
        ("double-quoted-value", assignment + b'"literal-value"', True),
        ("variable-expansion", assignment + b"${VALUE}", True),
        ("command-substitution", assignment + b"$(value-source)", True),
        ("concatenated-value", assignment + b"prefix${VALUE}suffix", True),
        ("indirect-value", assignment + b"${!VALUE_NAME}", True),
        ("malformed-input", assignment + b"\xff", True),
        ("binary-input", assignment + b"\x00fixture", True),
        ("raw-authorization-shape", assignment + b"A" * 64, True),
        ("raw-nonce-shape", assignment + b"nonce-fixture-value", True),
        ("authorization-bearer", bearer + b"fixture-value", True),
        ("private-key-openssh", private_openssh, True),
        ("private-key-generic", private_generic, True),
        ("token-shaped", token + b"fixture-value", True),
    ]
    cases = positives + negatives
    results = [run_case(child, *case) for case in cases]
    output = {
        "audited_inert": 10,
        "exact_bound_patch": exact_bound_patch,
        "negative": len(negatives),
        "other_marker_regressions": 4,
        "positive": len(positives),
        "results": results,
        "schema": "m22-secret-marker-matrix-v1",
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
    print(
        "M22 MARKER MATRIX PASS "
        f"positive={len(positives)} negative={len(negatives)} "
        f"audited_inert=10 exact_bound_patch={exact_bound_patch} "
        "other_marker_regressions=4"
    )


if __name__ == "__main__":
    main()
PY
  python3 "$m22_matrix_program" "$SELF" "${M22_AA_BOUND_PATCH:-}" \
    > "$m22_matrix_one"
  python3 "$m22_matrix_program" "$SELF" "${M22_AA_BOUND_PATCH:-}" \
    > "$m22_matrix_two"
  cmp -s "$m22_matrix_one" "$m22_matrix_two" || {
    echo "M22 secret-marker matrix was not deterministic" >&2
    return 1
  }
  cat "$m22_matrix_one"
  m23_matrix_program="$tmp/m23-physical-path-matrix.py"
  m23_matrix_one="$tmp/m23-physical-path-matrix-one.out"
  m23_matrix_two="$tmp/m23-physical-path-matrix-two.out"
  cat > "$m23_matrix_program" <<'PY'
import ast
import hashlib
import json
from pathlib import Path
import sys


def fail(reason):
    raise SystemExit(f"M23 physical-path matrix failure: {reason}")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def production_classifier(helper):
    raw = helper.read_bytes()
    anchor = b'9<<< "$MAINTENANCE_AUTHORIZATION" <<\'PY\'\n'
    start = raw.find(anchor)
    if start < 0:
        fail("production heredoc anchor missing")
    start += len(anchor)
    end = raw.find(b"\nPY\n", start)
    if end < 0:
        fail("production heredoc terminator missing")
    source = raw[start : end + 1].decode("utf-8", "strict")
    tree = ast.parse(source)
    matches = [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "path_neutral_contains_physical_path"
    ]
    if len(matches) != 1:
        fail("production classifier function mismatch")
    segment = ast.get_source_segment(source, matches[0])
    if segment is None:
        fail("production classifier source segment missing")
    namespace = {}
    exec(segment, namespace)
    return namespace["path_neutral_contains_physical_path"]


def main():
    if len(sys.argv) != 3:
        fail("argv")
    classifier = production_classifier(Path(sys.argv[1]))
    bound_patch_arg = sys.argv[2]
    runtime = {
        b"/runtime/project-root",
        b"/runtime/user-home",
        b"/runtime/sidecars/prelaunch.json",
        b"/runtime/sidecars",
        b"/runtime/upstream/release.json",
        b"/runtime/upstream",
        b"/runtime/current/attestation.json",
        b"/runtime/current",
    }
    forbidden = sorted(runtime, key=len, reverse=True)
    patch = ".review-input/patch.diff"
    nonpatch = "REVIEW_POLICY.md"
    positives = [
        ("patch-generic-home", patch, b"+literal /home/example/source\n"),
        ("patch-generic-tmp", patch, b"+literal /tmp/example/output\n"),
        ("patch-no-marker", patch, b"+ordinary source line\n"),
        ("nonpatch-no-marker", nonpatch, b"ordinary policy line\n"),
    ]
    exact_bound_patch = 0
    canaries = 0
    if bound_patch_arg:
        bound_path = Path(bound_patch_arg)
        if not bound_path.is_file() or bound_path.is_symlink():
            fail("bound patch type mismatch")
        bound_patch = bound_path.read_bytes()
        canaries = bound_patch.count(b"/home/") + bound_patch.count(b"/tmp/")
        if (
            len(bound_patch) != 389386
            or sha256(bound_patch)
            != "f29e1c5180feae6dc2502c0d0e8790fee2da6c0238f612ef1414be84cc1929ad"
            or canaries != 14
        ):
            fail("bound patch bytes mismatch")
        positives.append(("exact-bound-aa-patch", patch, bound_patch))
        exact_bound_patch = 1
    negatives = [
        ("patch-project-root", patch, b"+" + b"/runtime/project-root" + b"\n"),
        ("patch-home-root", patch, b"+" + b"/runtime/user-home" + b"\n"),
        (
            "patch-sidecar-path",
            patch,
            b"+" + b"/runtime/sidecars/prelaunch.json" + b"\n",
        ),
        ("patch-sidecar-parent", patch, b"+" + b"/runtime/sidecars" + b"\n"),
        (
            "patch-upstream-path",
            patch,
            b"+" + b"/runtime/upstream/release.json" + b"\n",
        ),
        ("patch-upstream-parent", patch, b"+" + b"/runtime/upstream" + b"\n"),
        (
            "patch-current-path",
            patch,
            b"+" + b"/runtime/current/attestation.json" + b"\n",
        ),
        ("patch-current-parent", patch, b"+" + b"/runtime/current" + b"\n"),
        ("nonpatch-users", nonpatch, b"literal /Users/example/source\n"),
        ("nonpatch-home", nonpatch, b"literal /home/example/source\n"),
        ("nonpatch-private", nonpatch, b"literal /private/example/source\n"),
        ("nonpatch-tmp", nonpatch, b"literal /tmp/example/source\n"),
        ("nonpatch-wsl", nonpatch, b"literal /mnt/c/Users/example/source\n"),
        (
            "nonpatch-windows",
            nonpatch,
            b"literal C:" + b"\\" + b"Users" + b"\\" + b"example\n",
        ),
        (
            "nonpatch-json-windows",
            nonpatch,
            b'"repository":"github.com/example/C:'
            + b"\\\\"
            + b"Users"
            + b"\\\\"
            + b'example"\n',
        ),
    ]
    results = []
    for case_id, rel, data in positives + negatives:
        expected = case_id.startswith("patch-") and case_id not in {
            "patch-generic-home",
            "patch-generic-tmp",
            "patch-no-marker",
        }
        if case_id == "exact-bound-aa-patch" or case_id == "nonpatch-no-marker":
            expected = False
        if case_id.startswith("nonpatch-") and case_id != "nonpatch-no-marker":
            expected = True
        observed = classifier(data, rel, forbidden)
        if observed is not expected:
            fail(f"case mismatch: {case_id}")
        results.append(
            {
                "case": case_id,
                "expected": "REJECT" if expected else "ACCEPT",
            }
        )
    output = {
        "canaries": canaries,
        "exact_bound_patch": exact_bound_patch,
        "negative": len(negatives),
        "positive": len(positives),
        "results": results,
        "schema": "m23-physical-path-matrix-v1",
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
    print(
        "M23 PHYSICAL PATH MATRIX PASS "
        f"positive={len(positives)} negative={len(negatives)} "
        f"exact_bound_patch={exact_bound_patch} canaries={canaries}"
    )


if __name__ == "__main__":
    main()
PY
  python3 "$m23_matrix_program" "$SELF" "${M23_AA_BOUND_PATCH:-}" \
    > "$m23_matrix_one"
  python3 "$m23_matrix_program" "$SELF" "${M23_AA_BOUND_PATCH:-}" \
    > "$m23_matrix_two"
  cmp -s "$m23_matrix_one" "$m23_matrix_two" || {
    echo "M23 physical-path matrix was not deterministic" >&2
    return 1
  }
  cat "$m23_matrix_one"
  echo 'M21 MATRIX PASS positive_generic=2 positive_projection=1 legacy_review_regressions=2 review_claim_negatives=12 qualification_negatives=9 current_state_negatives=22 criterion6_negatives=5 union_negatives=3 composite_binding_negatives=5'
  echo "SELF-TEST PASS"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi

usage() {
  cat >&2 <<EOF
usage: $0 --patch <absolute-patch> --bundle <new-absolute-bundle-dir> \
  --plan <absolute-plan> --review-policy <absolute-REVIEW_POLICY.md> \
  [--review-reference <absolute-reference>]...

maintenance mode additionally requires:
  --mode maintenance --base-ref <commit> --head-ref <commit> \
  [--upstream-attestation <absolute-json> \
   --upstream-attestation-sha256 <hex> \
   --upgrade-attestation <absolute-json> \
   --upgrade-attestation-sha256 <hex>]... \
  --maintenance-authorization <fresh-nonce> \
  [--instruction-delta <project-relative-path>]...

path-neutral maintenance projection additionally requires:
  --maintenance-review-projection path-neutral-v1 \
  --maintenance-prelaunch-sidecar <new-absolute-json-outside-bundle>
EOF
  exit 2
}

PATCH=""
BUNDLE=""
PLAN=""
POLICY=""
REVIEW_MODE=standard
MODE_SEEN=0
BASE_REF=""
HEAD_REF=""
UPSTREAM_ATTESTATIONS=()
UPSTREAM_ATTESTATION_SHA256S=()
UPGRADE_ATTESTATIONS=()
UPGRADE_ATTESTATION_SHA256S=()
UPSTREAM_COUNT=0
UPSTREAM_DIGEST_COUNT=0
UPGRADE_COUNT=0
UPGRADE_DIGEST_COUNT=0
MAINTENANCE_AUTHORIZATION=""
MAINTENANCE_REVIEW_PROJECTION=""
MAINTENANCE_PRELAUNCH_SIDECAR=""
REVIEW_REFERENCES=()
INSTRUCTION_DELTAS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --patch|--bundle|--plan|--review-policy|--review-reference|--mode|\
    --base-ref|--head-ref|--upstream-attestation|\
    --upstream-attestation-sha256|--upgrade-attestation|\
    --upgrade-attestation-sha256|--maintenance-authorization|\
    --instruction-delta|--maintenance-review-projection|\
    --maintenance-prelaunch-sidecar)
      [ "$#" -ge 2 ] || usage
      key="$1"
      value="$2"
      shift 2
      case "$key" in
        --patch) [ -z "$PATCH" ] || usage; PATCH="$value" ;;
        --bundle) [ -z "$BUNDLE" ] || usage; BUNDLE="$value" ;;
        --plan) [ -z "$PLAN" ] || usage; PLAN="$value" ;;
        --review-policy) [ -z "$POLICY" ] || usage; POLICY="$value" ;;
        --review-reference) REVIEW_REFERENCES+=("$value") ;;
        --mode)
          [ "$MODE_SEEN" -eq 0 ] || usage
          MODE_SEEN=1
          REVIEW_MODE="$value"
          ;;
        --base-ref) [ -z "$BASE_REF" ] || usage; BASE_REF="$value" ;;
        --head-ref) [ -z "$HEAD_REF" ] || usage; HEAD_REF="$value" ;;
        --upstream-attestation)
          UPSTREAM_ATTESTATIONS+=("$value")
          UPSTREAM_COUNT=$((UPSTREAM_COUNT + 1))
          ;;
        --upstream-attestation-sha256)
          UPSTREAM_ATTESTATION_SHA256S+=("$value")
          UPSTREAM_DIGEST_COUNT=$((UPSTREAM_DIGEST_COUNT + 1))
          ;;
        --upgrade-attestation)
          UPGRADE_ATTESTATIONS+=("$value")
          UPGRADE_COUNT=$((UPGRADE_COUNT + 1))
          ;;
        --upgrade-attestation-sha256)
          UPGRADE_ATTESTATION_SHA256S+=("$value")
          UPGRADE_DIGEST_COUNT=$((UPGRADE_DIGEST_COUNT + 1))
          ;;
        --maintenance-authorization)
          [ -z "$MAINTENANCE_AUTHORIZATION" ] || usage
          MAINTENANCE_AUTHORIZATION="$value"
          ;;
        --maintenance-review-projection)
          [ -z "$MAINTENANCE_REVIEW_PROJECTION" ] || usage
          MAINTENANCE_REVIEW_PROJECTION="$value"
          ;;
        --maintenance-prelaunch-sidecar)
          [ -z "$MAINTENANCE_PRELAUNCH_SIDECAR" ] || usage
          MAINTENANCE_PRELAUNCH_SIDECAR="$value"
          ;;
        --instruction-delta) INSTRUCTION_DELTAS+=("$value") ;;
      esac
      ;;
    *) usage ;;
  esac
done
[ -n "$PATCH" ] && [ -n "$BUNDLE" ] && [ -n "$PLAN" ] && [ -n "$POLICY" ] || usage
case "$REVIEW_MODE" in
  standard)
    [ -z "$BASE_REF$HEAD_REF$MAINTENANCE_AUTHORIZATION$MAINTENANCE_REVIEW_PROJECTION$MAINTENANCE_PRELAUNCH_SIDECAR" ] || usage
    [ "$UPSTREAM_COUNT" -eq 0 ] && [ "$UPSTREAM_DIGEST_COUNT" -eq 0 ] || usage
    [ "$UPGRADE_COUNT" -eq 0 ] && [ "$UPGRADE_DIGEST_COUNT" -eq 0 ] || usage
    [ "${#INSTRUCTION_DELTAS[@]}" -eq 0 ] || usage
    ;;
  maintenance)
    [ -n "$BASE_REF" ] && [ -n "$HEAD_REF" ] &&
      [ -n "$MAINTENANCE_AUTHORIZATION" ] &&
      [ "$UPSTREAM_COUNT" -ge 1 ] &&
      [ "$UPSTREAM_COUNT" -eq "$UPSTREAM_DIGEST_COUNT" ] &&
      [ "$UPSTREAM_COUNT" -eq "$UPGRADE_COUNT" ] &&
      [ "$UPSTREAM_COUNT" -eq "$UPGRADE_DIGEST_COUNT" ] || usage
    for DIGEST in \
      "${UPSTREAM_ATTESTATION_SHA256S[@]+"${UPSTREAM_ATTESTATION_SHA256S[@]}"}" \
      "${UPGRADE_ATTESTATION_SHA256S[@]+"${UPGRADE_ATTESTATION_SHA256S[@]}"}"; do
      printf '%s' "$DIGEST" | grep -Eq '^[0-9a-f]{64}$' || usage
    done
    printf '%s' "$MAINTENANCE_AUTHORIZATION" |
      grep -Eq '^[A-Za-z0-9._:-]{16,128}$' || usage
    case "$MAINTENANCE_REVIEW_PROJECTION" in
      "") [ -z "$MAINTENANCE_PRELAUNCH_SIDECAR" ] || usage ;;
      path-neutral-v1) [ -n "$MAINTENANCE_PRELAUNCH_SIDECAR" ] || usage ;;
      *) usage ;;
    esac
    ;;
  *) usage ;;
esac

PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
GIT_TOP="$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null)" ||
  { echo "installed project root is not in a Git repository: $PROJECT_ROOT" >&2; exit 2; }
GIT_ROOT="$(cd "$GIT_TOP" && pwd -P)"
case "$PROJECT_ROOT/" in
  "$GIT_ROOT/"*) ;;
  *) echo "installed project root escapes its Git worktree: $PROJECT_ROOT" >&2; exit 2 ;;
esac
case "$PATCH" in
  /*) ;;
  *) echo "patch path must be absolute: $PATCH" >&2; exit 2 ;;
esac
[ -f "$PATCH" ] && [ ! -L "$PATCH" ] ||
  { echo "patch must be a regular non-symlink file: $PATCH" >&2; exit 2; }
PATCH="$(cd "$(dirname "$PATCH")" && pwd -P)/$(basename "$PATCH")"
head -n 1 "$PATCH" | grep -q '^diff --git ' ||
  { echo "patch does not begin with diff --git: $PATCH" >&2; exit 2; }
if patch_has_rejected_header "$PATCH"; then
  echo "review patch rejected due to a secret-equivalent path header" >&2
  exit 2
fi
case "$BUNDLE" in
  /*) ;;
  *) echo "bundle directory must be absolute: $BUNDLE" >&2; exit 2 ;;
esac
[ -d "$(dirname "$BUNDLE")" ] ||
  { echo "bundle parent does not exist: $(dirname "$BUNDLE")" >&2; exit 2; }
BUNDLE="$(cd "$(dirname "$BUNDLE")" && pwd -P)/$(basename "$BUNDLE")"
case "$BUNDLE/" in
  "$GIT_ROOT/"*) echo "review bundle must be outside the source Git worktree: $BUNDLE" >&2; exit 2 ;;
esac
[ ! -e "$BUNDLE" ] || { echo "bundle path already exists: $BUNDLE" >&2; exit 2; }

if [ "$REVIEW_MODE" = maintenance ]; then
  NORMALIZED_UPSTREAM_ATTESTATIONS=()
  NORMALIZED_UPGRADE_ATTESTATIONS=()
  for ATTESTATION in \
    "${UPSTREAM_ATTESTATIONS[@]+"${UPSTREAM_ATTESTATIONS[@]}"}"; do
    case "$ATTESTATION" in
      /*) ;;
      *) echo "maintenance attestation path must be absolute: $ATTESTATION" >&2; exit 2 ;;
    esac
    [ -f "$ATTESTATION" ] && [ ! -L "$ATTESTATION" ] ||
      { echo "maintenance attestation must be a regular non-symlink file: $ATTESTATION" >&2; exit 2; }
    NORMALIZED_UPSTREAM_ATTESTATIONS+=("$(cd "$(dirname "$ATTESTATION")" && pwd -P)/$(basename "$ATTESTATION")")
  done
  for ATTESTATION in \
    "${UPGRADE_ATTESTATIONS[@]+"${UPGRADE_ATTESTATIONS[@]}"}"; do
    case "$ATTESTATION" in
      /*) ;;
      *) echo "maintenance attestation path must be absolute: $ATTESTATION" >&2; exit 2 ;;
    esac
    [ -f "$ATTESTATION" ] && [ ! -L "$ATTESTATION" ] ||
      { echo "maintenance attestation must be a regular non-symlink file: $ATTESTATION" >&2; exit 2; }
    NORMALIZED_UPGRADE_ATTESTATIONS+=("$(cd "$(dirname "$ATTESTATION")" && pwd -P)/$(basename "$ATTESTATION")")
  done
  UPSTREAM_ATTESTATIONS=("${NORMALIZED_UPSTREAM_ATTESTATIONS[@]}")
  UPGRADE_ATTESTATIONS=("${NORMALIZED_UPGRADE_ATTESTATIONS[@]}")
fi

SIDECAR_STAGING=""
if [ "$MAINTENANCE_REVIEW_PROJECTION" = path-neutral-v1 ]; then
  case "$MAINTENANCE_PRELAUNCH_SIDECAR" in
    /*) ;;
    *) echo "maintenance prelaunch sidecar path must be absolute" >&2; exit 2 ;;
  esac
  [ -d "$(dirname "$MAINTENANCE_PRELAUNCH_SIDECAR")" ] ||
    { echo "maintenance prelaunch sidecar parent does not exist" >&2; exit 2; }
  MAINTENANCE_PRELAUNCH_SIDECAR="$(cd "$(dirname "$MAINTENANCE_PRELAUNCH_SIDECAR")" && pwd -P)/$(basename "$MAINTENANCE_PRELAUNCH_SIDECAR")"
  case "$MAINTENANCE_PRELAUNCH_SIDECAR/" in
    "$GIT_ROOT/"*) echo "maintenance prelaunch sidecar must be outside the source Git worktree" >&2; exit 2 ;;
  esac
  case "$MAINTENANCE_PRELAUNCH_SIDECAR/" in
    "$BUNDLE/"*) echo "maintenance prelaunch sidecar must be outside the sealed bundle" >&2; exit 2 ;;
  esac
  [ ! -e "$MAINTENANCE_PRELAUNCH_SIDECAR" ] ||
    { echo "maintenance prelaunch sidecar path already exists" >&2; exit 2; }
  SIDECAR_STAGING="$(mktemp "$(dirname "$MAINTENANCE_PRELAUNCH_SIDECAR")/.review-prelaunch-sidecar.XXXXXX")"
  rm -f -- "$SIDECAR_STAGING"
fi

STAGING="$(mktemp -d "$(dirname "$BUNDLE")/.review-bundle-stage.XXXXXX")"
BUNDLE_ACTIVE=1
cleanup_bundle() {
  rc=$?
  trap - EXIT INT TERM HUP
  if [ "$BUNDLE_ACTIVE" = 1 ]; then
    rm -rf -- "$STAGING"
    if [ -n "$MAINTENANCE_PRELAUNCH_SIDECAR" ]; then
      rm -f -- "$MAINTENANCE_PRELAUNCH_SIDECAR"
    fi
  fi
  [ -z "$SIDECAR_STAGING" ] || rm -f -- "$SIDECAR_STAGING"
  exit "$rc"
}
trap cleanup_bundle EXIT INT TERM HUP

python3 - "$PROJECT_ROOT" "$PATCH" "$STAGING" "$PLAN" "$POLICY" "$HOST_DIR" \
  "$REVIEW_MODE" "$BASE_REF" "$HEAD_REF" \
  "$MAINTENANCE_REVIEW_PROJECTION" "$SIDECAR_STAGING" \
  "$MAINTENANCE_PRELAUNCH_SIDECAR" \
  "${#REVIEW_REFERENCES[@]}" \
  "${REVIEW_REFERENCES[@]+"${REVIEW_REFERENCES[@]}"}" \
  "${#INSTRUCTION_DELTAS[@]}" \
  "${INSTRUCTION_DELTAS[@]+"${INSTRUCTION_DELTAS[@]}"}" \
  "$UPSTREAM_COUNT" \
  "${UPSTREAM_ATTESTATIONS[@]+"${UPSTREAM_ATTESTATIONS[@]}"}" \
  "${UPSTREAM_ATTESTATION_SHA256S[@]+"${UPSTREAM_ATTESTATION_SHA256S[@]}"}" \
  "${UPGRADE_ATTESTATIONS[@]+"${UPGRADE_ATTESTATIONS[@]}"}" \
  "${UPGRADE_ATTESTATION_SHA256S[@]+"${UPGRADE_ATTESTATION_SHA256S[@]}"}" \
  9<<< "$MAINTENANCE_AUTHORIZATION" <<'PY'
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import stat
import subprocess
import sys

root = Path(sys.argv[1])
patch = Path(sys.argv[2])
bundle = Path(sys.argv[3])
plan_arg = sys.argv[4]
policy_arg = sys.argv[5]
host_dir = sys.argv[6]
review_mode = sys.argv[7]
base_ref = sys.argv[8]
head_ref = sys.argv[9]
authorization_bytes = os.read(9, 130)
if (
    not authorization_bytes.endswith(b"\n")
    or b"\n" in authorization_bytes[:-1]
    or len(authorization_bytes) > 129
):
    raise SystemExit("maintenance authorization descriptor is malformed")
try:
    maintenance_authorization = authorization_bytes[:-1].decode("utf-8", "strict")
except UnicodeDecodeError as error:
    raise SystemExit(f"maintenance authorization is not UTF-8: {error}")
if maintenance_authorization and maintenance_authorization in sys.argv:
    raise SystemExit("maintenance authorization leaked into Python argv")
projection_mode = sys.argv[10]
sidecar_output_arg = sys.argv[11]
sidecar_final_arg = sys.argv[12]
reference_count = int(sys.argv[13])
reference_start = 14
reference_end = reference_start + reference_count
reference_args = sys.argv[reference_start:reference_end]
delta_count = int(sys.argv[reference_end])
delta_start = reference_end + 1
delta_end = delta_start + delta_count
instruction_delta_args = sys.argv[delta_start:delta_end]
if len(instruction_delta_args) != delta_count:
    raise SystemExit("maintenance instruction-delta argument count mismatch")
pair_count = int(sys.argv[delta_end])
pair_start = delta_end + 1
pair_end = pair_start + pair_count
upstream_attestation_args = sys.argv[pair_start:pair_end]
upstream_attestation_digests = sys.argv[pair_end : pair_end + pair_count]
upgrade_start = pair_end + pair_count
upgrade_attestation_args = sys.argv[upgrade_start : upgrade_start + pair_count]
upgrade_attestation_digests = sys.argv[
    upgrade_start + pair_count : upgrade_start + 2 * pair_count
]
if len(sys.argv) != upgrade_start + 2 * pair_count:
    raise SystemExit("maintenance attestation-pair argument count mismatch")

FIXED_DIRS = {".claude", ".codex", ".agents"}
INSTRUCTION_NAMES = {"AGENTS.md", "CLAUDE.md"}
TEXT_SUFFIXES = {".md", ".mdx", ".txt", ".rst", ".adoc", ".toml", ".json", ".yaml", ".yml"}
DOCUMENT_SUFFIXES = {".md", ".mdx", ".txt", ".rst", ".adoc"}


class BundleError(RuntimeError):
    pass


def fail(message):
    raise BundleError(message)


def decode_git_path(value):
    try:
        return value.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("Git-visible review paths must be valid UTF-8")


def validate_rel(raw, label="path"):
    if not isinstance(raw, str) or raw in ("", "."):
        fail(f"{label} is empty")
    if "\x00" in raw:
        fail(f"{label} contains NUL")
    if "\n" in raw or "\r" in raw:
        fail(f"{label} contains a line break")
    if raw.startswith("/") or raw.startswith("\\\\") or (
        len(raw) >= 3 and raw[1] == ":" and raw[2] in ("/", "\\")
    ):
        fail(f"{label} must be project-relative: {raw}")
    rel = PurePosixPath(raw)
    if rel.is_absolute() or any(part in ("", ".", "..") for part in rel.parts):
        fail(f"{label} contains unsafe traversal: {raw}")
    return rel.as_posix()


def path_parts(rel):
    return PurePosixPath(rel).parts


def secret_equivalent(rel):
    return any(part == ".env" or part.startswith(".env.") for part in path_parts(rel))


def fixed_forbidden(rel):
    parts = path_parts(rel)
    return bool(parts) and (
        parts[-1] in INSTRUCTION_NAMES or any(part in FIXED_DIRS for part in parts)
    )


def first_fixed_dir_index(rel):
    parts = path_parts(rel)
    for index, part in enumerate(parts):
        if part in FIXED_DIRS:
            return index
    return None


def agent_tmp_path(rel):
    parts = path_parts(rel)
    index = first_fixed_dir_index(rel)
    return index is not None and index + 1 < len(parts) and parts[index + 1] == "tmp"


def agent_instruction_config_path(rel):
    return first_fixed_dir_index(rel) is not None and not agent_tmp_path(rel)


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def lexical_path(rel):
    return root.joinpath(*path_parts(rel))


def lstat_kind(rel):
    path = lexical_path(rel)
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return "missing"
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    return "other"


def assert_no_symlink_parents(rel, label):
    current = root
    parts = path_parts(rel)
    for part in parts[:-1]:
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            fail(f"{label} parent is missing: {rel}")
        if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
            fail(f"{label} has a symlink or non-directory parent: {rel}")


def git_paths(args):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    values = result.stdout.split(b"\0")
    if values and values[-1] == b"":
        values.pop()
    return [validate_rel(decode_git_path(item), "Git path") for item in values]


visible = set(git_paths(["ls-files", "-co", "--exclude-standard", "-z", "--", "."]))
tracked = set(git_paths(["ls-files", "-z", "--", "."]))
ignored = set(
    git_paths(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "."])
)
known_files = visible | ignored


def git_visibility(rel):
    if rel in tracked:
        return "tracked"
    if rel in ignored:
        return "ignored"
    if rel in visible:
        return "untracked"
    return "filesystem-only"


def explicit_rel(argument, label):
    candidate = Path(argument)
    if not candidate.is_absolute():
        fail(f"{label} must be absolute: {argument}")
    try:
        rel = candidate.relative_to(root).as_posix()
    except ValueError:
        fail(f"{label} escapes the project root: {argument}")
    rel = validate_rel(rel, label)
    assert_no_symlink_parents(rel, label)
    if lstat_kind(rel) != "file":
        fail(f"{label} must be a regular non-symlink file: {rel}")
    if rel not in tracked:
        fail(f"{label} must be Git-tracked: {rel}")
    return rel


plan_rel = explicit_rel(plan_arg, "plan")
policy_rel = explicit_rel(policy_arg, "review policy")
if policy_rel != "REVIEW_POLICY.md":
    fail("review policy must be the project-root REVIEW_POLICY.md")
reference_rels = [explicit_rel(value, "review reference") for value in reference_args]
if len(reference_rels) != len(set(reference_rels)):
    fail("review references contain a duplicate path")
explicit_paths = {plan_rel, policy_rel, *reference_rels}

try:
    plan_text = lexical_path(plan_rel).read_text(encoding="utf-8")
except UnicodeError:
    fail("plan must be valid UTF-8")


def top_level_plan_field(line):
    if line.startswith("- "):
        return line[2:]
    if line and not line[0].isspace():
        return line
    return None


def canonical_plan_scalar(value):
    if "`" not in value:
        return value
    if (
        len(value) >= 3
        and value.startswith("`")
        and value.endswith("`")
        and value.count("`") == 2
    ):
        inner = value[1:-1]
        if inner and inner.strip() == inner:
            return inner
    fail("path-neutral plan binding has a malformed backtick scalar")


projection_declarations = [
    line
    for line in plan_text.splitlines()
    if top_level_plan_field(line)
    == "maintenance_review_projection: path-neutral-v1"
]
plan_attestation_bindings = []
if projection_mode == "path-neutral-v1":
    if len(projection_declarations) != 1:
        fail("path-neutral helper opt-in requires exactly one matching plan declaration")
    for line in plan_text.splitlines():
        top_level = top_level_plan_field(line)
        if top_level is not None and top_level.startswith((
            "upstream_release_attestation:",
            "upgrade_attestation:",
        )):
            fail(
                "path-neutral tracked plan must use logical attestation IDs, "
                "not artifact paths"
            )
    block_start = None
    lines = plan_text.splitlines()
    for index, line in enumerate(lines):
        if top_level_plan_field(line) == "maintenance_attestation_bindings:":
            if block_start is not None:
                fail("path-neutral plan duplicates maintenance_attestation_bindings")
            block_start = index + 1
    if block_start is None:
        fail("path-neutral plan lacks maintenance_attestation_bindings")
    current = None
    allowed_binding_keys = {
        "kit",
        "upstream_release_attestation_id",
        "upstream_release_attestation_sha256",
        "upgrade_attestation_id",
        "upgrade_attestation_sha256",
    }
    for line in lines[block_start:]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[:1].isspace():
            break
        if line.startswith("  - "):
            if current is not None:
                plan_attestation_bindings.append(current)
            current = {}
            stripped = line[4:]
        elif line.startswith("    "):
            stripped = line[4:]
        else:
            fail("path-neutral plan has a malformed attestation binding")
        if not stripped or stripped[0].isspace():
            fail("path-neutral plan has a malformed attestation binding")
        if ":" not in stripped or current is None:
            fail("path-neutral plan has a malformed attestation binding")
        key, value = (part.strip() for part in stripped.split(":", 1))
        if key not in allowed_binding_keys or key in current or not value:
            fail("path-neutral plan has unknown, duplicate, or empty binding fields")
        current[key] = canonical_plan_scalar(value)
    if current is not None:
        plan_attestation_bindings.append(current)
    if len(plan_attestation_bindings) not in (1, 2):
        fail("path-neutral plan requires one singleton or two composite bindings")
    for binding in plan_attestation_bindings:
        if set(binding) != allowed_binding_keys:
            fail("path-neutral plan binding has unknown or missing fields")
        for key in (
            "upstream_release_attestation_sha256",
            "upgrade_attestation_sha256",
        ):
            if re.fullmatch(r"[0-9a-f]{64}", binding[key]) is None:
                fail("path-neutral plan binding has a malformed digest")
        for key in (
            "upstream_release_attestation_id",
            "upgrade_attestation_id",
        ):
            value = binding[key]
            logical = PurePosixPath(value)
            if (
                value.startswith(("/", "\\\\"))
                or logical.is_absolute()
                or any(part in ("", ".", "..") for part in logical.parts)
            ):
                fail("path-neutral plan attestation ID must be logical/archive-relative")
    kits = [binding["kit"] for binding in plan_attestation_bindings]
    if len(kits) == 2 and kits != ["agent_policies-claude", "agent_policies-codex"]:
        fail("path-neutral composite plan bindings must be canonical Claude then Codex")
else:
    if projection_declarations:
        fail("path-neutral plan declaration requires complete helper opt-in")


def patch_paths():
    raw = patch.read_bytes()
    in_headers = False
    for line in raw.splitlines():
        if line.startswith(b"diff --git "):
            in_headers = True
            continue
        if in_headers and line.startswith(b"@@"):
            in_headers = False
            continue
        if in_headers and line.startswith(
            (b"rename from ", b"rename to ", b"copy from ", b"copy to ")
        ):
            fail("review patch must be generated with --no-renames")
    result = subprocess.run(
        ["git", "apply", "--numstat", "-z", "--", str(patch)],
        cwd=str(bundle),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        fail(f"cannot parse review patch paths with git apply --numstat: {detail}")
    records = result.stdout.split(b"\0")
    if records and records[-1] == b"":
        records.pop()
    found = []
    for record in records:
        fields = record.split(b"\t", 2)
        if len(fields) != 3:
            fail("malformed NUL-safe git numstat record")
        found.append(validate_rel(decode_git_path(fields[2]), "patch path"))
    if not found:
        fail("review patch contains no changed paths")
    if len(found) != len(set(found)):
        fail("review patch path inventory contains duplicates")
    return sorted(found)


changed_paths = patch_paths()
for rel in changed_paths:
    if secret_equivalent(rel):
        fail(f"review patch rejected due to a secret-equivalent path: {rel}")

maintenance = None


def git_output(args, binary=False):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", "replace").strip()
        fail(f"maintenance Git binding failed: {' '.join(args)}: {detail}")
    if binary:
        return result.stdout
    return result.stdout.decode("utf-8", "strict").strip()


def valid_hex(value, length):
    return (
        isinstance(value, str)
        and len(value) == length
        and all(char in "0123456789abcdef" for char in value)
    )


def exact_object(value, expected_keys, label):
    if not isinstance(value, dict) or set(value) != set(expected_keys):
        fail(f"{label} has unknown or missing fields")
    return value


def bounded_atom(value, label, maximum):
    if (
        not isinstance(value, str)
        or not value
        or len(value) > maximum
        or any(ord(char) < 0x21 or ord(char) > 0x7E for char in value)
    ):
        fail(f"{label} is malformed")
    return value


def bounded_text(value, label, maximum):
    if not isinstance(value, str) or not value or len(value) > maximum:
        fail(f"{label} is malformed")
    return value


def reject_duplicate_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail(f"maintenance attestation duplicates JSON key: {key}")
        value[key] = item
    return value


def load_bound_json(argument, expected_digest, label):
    path = Path(argument)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        fail(f"{label} must be an absolute regular non-symlink file")
    if not valid_hex(expected_digest, 64):
        fail(f"{label} digest is malformed")
    if sha256_file(path) != expected_digest:
        fail(f"{label} digest mismatch")
    if path.stat().st_size > 2 * 1024 * 1024:
        fail(f"{label} exceeds the maximum supported size")
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=reject_duplicate_pairs,
            parse_constant=lambda token: fail(
                f"{label} contains a non-finite JSON number"
            ),
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict) or value.get("schema") != 1:
        fail(f"{label} has an unsupported schema")
    return value


def require_canonical_attestation(argument, value, label):
    indent_json = (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    compact_json = (
        json.dumps(
            value, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        )
        + "\n"
    ).encode("utf-8")
    try:
        actual = Path(argument).read_bytes()
    except OSError:
        fail(f"cannot read {label}")
    if actual not in (indent_json, compact_json):
        fail(f"{label} is not canonical sorted UTF-8 JSON")


def validate_state(value, label):
    exact_object(value, {"sha256", "mode"}, label)
    if (
        not valid_hex(value.get("sha256"), 64)
        or type(value.get("mode")) is not int
        or value["mode"] not in (0o644, 0o755)
    ):
        fail(f"{label} has an invalid file state")
    return {"sha256": value["sha256"], "mode": value["mode"]}


def current_state(rel):
    kind = lstat_kind(rel)
    if kind == "missing":
        return {"type": "missing"}
    assert_no_symlink_parents(rel, "maintenance path")
    if kind != "file":
        fail(f"maintenance path must be a regular file or absent: {rel}")
    path = lexical_path(rel)
    return {
        "type": "file",
        "sha256": sha256_file(path),
        "mode": stat.S_IMODE(path.stat().st_mode),
    }


KNOWN_KITS = {"agent_policies-claude", "agent_policies-codex"}
ORDERED_KITS = ["agent_policies-claude", "agent_policies-codex"]
CURRENT_STATE_OPERATION = "current-state-attestation"
TARGET_PROJECT_ROOT = "@TARGET_PROJECT_ROOT@"


if review_mode == "maintenance":
    if git_output(["status", "--porcelain=v1", "-z"], binary=True):
        fail("maintenance review requires a clean target worktree")
    if pair_count not in (1, 2):
        fail("maintenance requires one singleton pair or two composite pairs")
    base_commit = git_output(["rev-parse", "--verify", f"{base_ref}^{{commit}}"])
    head_commit = git_output(["rev-parse", "--verify", f"{head_ref}^{{commit}}"])
    if head_commit != git_output(["rev-parse", "HEAD"]):
        fail("maintenance head must be the target worktree HEAD")
    if subprocess.run(
        ["git", "-C", str(root), "merge-base", "--is-ancestor", base_commit, head_commit],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode != 0:
        fail("maintenance base is not an ancestor of head")
    if git_output(["rev-list", "--merges", f"{base_commit}..{head_commit}"]):
        fail("maintenance review range must not contain merge commits")
    generated_patch = git_output(
        [
            "diff",
            "--no-renames",
            "--binary",
            "--relative",
            f"{base_commit}...{head_commit}",
            "--",
            ".",
        ],
        binary=True,
    )
    if generated_patch != patch.read_bytes():
        fail("maintenance patch is not the exact committed base-to-head diff")
    head_tree = git_output(["rev-parse", f"{head_commit}^{{tree}}"])
    expected_singleton_kit = (
        "agent_policies-claude" if host_dir == ".claude" else "agent_policies-codex"
    )
    validated_sets = []
    seen_kits = set()
    contains_current_state = False
    for index in range(pair_count):
        upstream_label = (
            "upstream release attestation"
            if pair_count == 1
            else f"upstream release attestation set {index + 1}"
        )
        upgrade_label = (
            "upgrade attestation"
            if pair_count == 1
            else f"upgrade attestation set {index + 1}"
        )
        upstream = load_bound_json(
            upstream_attestation_args[index],
            upstream_attestation_digests[index],
            upstream_label,
        )
        upgrade = load_bound_json(
            upgrade_attestation_args[index],
            upgrade_attestation_digests[index],
            upgrade_label,
        )
        require_canonical_attestation(
            upstream_attestation_args[index], upstream, upstream_label
        )
        require_canonical_attestation(
            upgrade_attestation_args[index], upgrade, upgrade_label
        )
        claim_fields = [
            field for field in ("review", "qualification") if field in upstream
        ]
        if len(claim_fields) != 1:
            fail(
                "upstream release attestation must contain exactly one review or qualification claim"
            )
        claim_field = claim_fields[0]
        exact_object(
            upstream,
            {
                "schema",
                "kit",
                "repository",
                "source_revision",
                "source_tree",
                claim_field,
                "managed_files",
                "managed_file_count",
            },
            upstream_label,
        )
        kit = upstream.get("kit")
        if kit not in KNOWN_KITS:
            fail("upstream release attestation kit identity mismatch")
        if pair_count == 1 and kit != expected_singleton_kit:
            fail("upstream release attestation kit identity mismatch")
        if kit in seen_kits:
            fail(f"composite maintenance duplicates kit identity: {kit}")
        seen_kits.add(kit)
        bounded_atom(
            upstream.get("repository"),
            "upstream release attestation repository identity",
            512,
        )
        source_revision = upstream.get("source_revision")
        source_tree = upstream.get("source_tree")
        if not valid_hex(source_revision, 40) or not valid_hex(source_tree, 40):
            fail("upstream release attestation has malformed source binding")
        if claim_field == "review":
            review = upstream.get("review")
            exact_object(
                review,
                {
                    "milestone",
                    "patch_sha256",
                    "archive_manifest_sha256",
                    "verdict",
                    "criteria_met",
                    "blocking",
                },
                "upstream release review binding",
            )
            bounded_atom(review.get("milestone"), "upstream release milestone", 64)
            criteria = review.get("criteria_met", "")
            criteria_parts = criteria.split("/") if isinstance(criteria, str) else []
            generic_m20_review = (
                pair_count == 2
                and kit == "agent_policies-codex"
                and review.get("milestone") == "M20"
            )
            if generic_m20_review:
                criteria_match = (
                    re.fullmatch(r"([0-9]+)/([0-9]+)", criteria)
                    if isinstance(criteria, str)
                    else None
                )
                criteria_valid = bool(criteria_match)
                if criteria_match:
                    criteria_met = int(criteria_match.group(1))
                    criteria_total = int(criteria_match.group(2))
                    criteria_valid = 1 <= criteria_met <= criteria_total
            else:
                criteria_valid = (
                    len(criteria_parts) == 2
                    and all(part.isdigit() for part in criteria_parts)
                    and criteria_parts[0] == criteria_parts[1]
                    and int(criteria_parts[0]) > 0
                )
            if (
                review.get("verdict") != "approve"
                or review.get("blocking") != "none"
                or not criteria_valid
                or not valid_hex(review.get("patch_sha256"), 64)
                or not valid_hex(review.get("archive_manifest_sha256"), 64)
                or not isinstance(review.get("milestone"), str)
                or not review["milestone"]
            ):
                fail(
                    "upstream release attestation does not carry a valid approve verdict"
                )
        else:
            qualification = upstream.get("qualification")
            exact_object(
                qualification,
                {"handoff_id", "handoff_verify", "release_tag"},
                "upstream release qualification binding",
            )
            bounded_text(
                qualification.get("handoff_id"),
                "upstream release qualification handoff identity",
                256,
            )
            bounded_text(
                qualification.get("release_tag"),
                "upstream release qualification tag",
                256,
            )
            if qualification.get("handoff_verify") != "PASS":
                fail("upstream release qualification is not verified")
        upstream_files = {}
        upstream_order = []
        upstream_entries = upstream.get("managed_files")
        if not isinstance(upstream_entries, list):
            fail("upstream release attestation managed files are not a list")
        for item in upstream_entries:
            exact_object(
                item,
                {"path", "sha256", "mode"},
                "upstream release managed entry",
            )
            rel = validate_rel(item.get("path"), "upstream managed path")
            if rel in upstream_files:
                fail(f"upstream release attestation duplicates managed path: {rel}")
            upstream_order.append(rel)
            upstream_files[rel] = validate_state(
                {"sha256": item.get("sha256"), "mode": item.get("mode")},
                f"upstream managed path {rel}",
            )
        if not upstream_files:
            fail("upstream release attestation has no managed files")
        if upstream_order != sorted(upstream_order):
            fail("upstream release attestation managed paths are not ordered")
        if (
            type(upstream.get("managed_file_count")) is not int
            or upstream.get("managed_file_count") != len(upstream_files)
        ):
            fail("upstream release attestation managed cardinality mismatch")

        exact_object(
            upgrade,
            {
                "schema",
                "record_version",
                "operation",
                "kit",
                "destination",
                "scope",
                "source",
                "pre",
                "post",
                "managed_path_count",
                "managed_paths",
            },
            upgrade_label,
        )
        if upgrade.get("kit") != kit:
            fail("maintenance attestation pair kit identity mismatch")
        operation = upgrade.get("operation")
        if operation == "upgrade":
            expected_destination = str(root)
            source_keys = {"revision", "tree", "dirty"}
        elif operation == CURRENT_STATE_OPERATION:
            contains_current_state = True
            expected_destination = TARGET_PROJECT_ROOT
            source_keys = {"repository", "revision", "tree", "dirty"}
        else:
            fail("upgrade attestation operation is unsupported")
        if (
            upgrade.get("record_version") != 3
            or upgrade.get("destination") != expected_destination
            or upgrade.get("scope") not in ("git-root", "subproject")
        ):
            fail("upgrade attestation target binding mismatch")
        upgrade_source = upgrade.get("source")
        exact_object(
            upgrade_source,
            source_keys,
            "upgrade attestation source binding",
        )
        if (
            not isinstance(upgrade_source, dict)
            or upgrade_source.get("dirty") is not False
            or upgrade_source.get("revision") != source_revision
            or upgrade_source.get("tree") != source_tree
            or (
                operation == CURRENT_STATE_OPERATION
                and upgrade_source.get("repository") != upstream.get("repository")
            )
        ):
            fail("upgrade attestation source binding mismatch")
        upgrade_pre = upgrade.get("pre")
        exact_object(
            upgrade_pre,
            {"head", "tree", "branch", "status_sha256"},
            "upgrade attestation pre-state binding",
        )
        upgrade_pre_head = upgrade_pre.get("head")
        if not valid_hex(upgrade_pre_head, 40):
            fail("upgrade attestation has malformed pre-HEAD")
        bounded_atom(upgrade_pre.get("branch"), "upgrade attestation pre-branch", 255)
        expected_pre_tree = git_output(
            ["rev-parse", f"{upgrade_pre_head}^{{tree}}"]
        )
        if (
            upgrade_pre.get("tree") != expected_pre_tree
            or not valid_hex(upgrade_pre.get("status_sha256"), 64)
            or not isinstance(upgrade_pre.get("branch"), str)
            or not upgrade_pre["branch"]
        ):
            fail("upgrade attestation pre-state binding mismatch")
        upgrade_post = upgrade.get("post")
        exact_object(
            upgrade_post,
            {"status_sha256", "managed_projection_sha256"},
            "upgrade attestation post-state binding",
        )
        if (
            not isinstance(upgrade_post, dict)
            or not valid_hex(upgrade_post.get("status_sha256"), 64)
        ):
            fail("upgrade attestation has malformed post-state binding")
        if operation == CURRENT_STATE_OPERATION:
            empty_status = hashlib.sha256(b"").hexdigest()
            if (
                upgrade_pre.get("status_sha256") != empty_status
                or upgrade_post.get("status_sha256") != empty_status
            ):
                fail("current-state attestation target state binding mismatch")
        for older, newer, label in (
            (base_commit, upgrade_pre_head, "base to upgrade pre-HEAD"),
            (upgrade_pre_head, head_commit, "upgrade pre-HEAD to review head"),
        ):
            if subprocess.run(
                [
                    "git",
                    "-C",
                    str(root),
                    "merge-base",
                    "--is-ancestor",
                    older,
                    newer,
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            ).returncode != 0:
                fail(f"upgrade attestation ancestry mismatch: {label}")

        upgrade_files = {}
        upgrade_order = []
        projection = []
        upgrade_entries = upgrade.get("managed_paths")
        if not isinstance(upgrade_entries, list):
            fail("upgrade attestation managed paths are not a list")
        for item in upgrade_entries:
            exact_object(
                item,
                {"path", "action", "ownership", "source", "pre", "post"},
                "upgrade attestation managed entry",
            )
            rel = validate_rel(item.get("path"), "upgrade managed path")
            if rel in upgrade_files:
                fail(f"upgrade attestation duplicates managed path: {rel}")
            upgrade_order.append(rel)
            ownership = item.get("ownership")
            action = item.get("action")
            if ownership not in ("upstream-identical", "project-override"):
                fail(f"upgrade attestation has invalid ownership: {rel}")
            if action not in ("add", "upgrade", "current", "override"):
                fail(f"upgrade attestation has invalid action: {rel}")
            if (ownership == "project-override") != (action == "override"):
                fail(f"upgrade attestation action/ownership mismatch: {rel}")
            source_state = validate_state(item.get("source"), f"upgrade source {rel}")
            post_state = validate_state(item.get("post"), f"upgrade postimage {rel}")
            pre_state = item.get("pre")
            if pre_state is not None:
                pre_state = validate_state(pre_state, f"upgrade preimage {rel}")
            if (action == "add") != (pre_state is None):
                fail(f"upgrade attestation action/preimage mismatch: {rel}")
            if rel not in upstream_files or source_state != upstream_files[rel]:
                fail(f"upgrade/upstream managed source mismatch: {rel}")
            if ownership == "upstream-identical" and post_state != source_state:
                fail(f"upgrade postimage is not upstream-identical: {rel}")
            if operation == CURRENT_STATE_OPERATION:
                if action not in ("current", "override"):
                    fail("current-state attestation has a non-current action")
                if pre_state != post_state:
                    fail("current-state attestation pre/post state differs")
                if current_state(rel) != {"type": "file", **post_state}:
                    fail("current-state attestation target managed state drifted")
            upgrade_files[rel] = {
                "ownership": ownership,
                "source": source_state,
                "post": post_state,
            }
            projection.append(
                {
                    "path": rel,
                    "ownership": ownership,
                    "source": source_state,
                    "post": post_state,
                }
            )
        if (
            upgrade_order != sorted(upgrade_order)
            or type(upgrade.get("managed_path_count")) is not int
            or set(upgrade_files) != set(upstream_files)
            or upgrade.get("managed_path_count") != len(upgrade_files)
        ):
            fail("upgrade/upstream managed path sets differ")
        projection_digest = hashlib.sha256(
            json.dumps(
                {
                    "schema": 1,
                    "paths": sorted(projection, key=lambda item: item["path"]),
                },
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        if upgrade_post.get("managed_projection_sha256") != projection_digest:
            fail("upgrade managed projection digest mismatch")
        validated_sets.append(
            {
                "kit": kit,
                "upstream_attestation_path": upstream_attestation_args[index],
                "upstream_attestation_sha256": upstream_attestation_digests[index],
                "upgrade_attestation_path": upgrade_attestation_args[index],
                "upgrade_attestation_sha256": upgrade_attestation_digests[index],
                "upstream": upstream,
                "upgrade": upgrade,
                "upgrade_files": upgrade_files,
            }
        )

    if pair_count == 2:
        if seen_kits != KNOWN_KITS:
            fail("composite maintenance requires exactly the Claude and Codex kits")
        if [item["kit"] for item in validated_sets] != ORDERED_KITS:
            fail("composite maintenance kit order must be Claude then Codex")
    if contains_current_state:
        if (
            git_output(["rev-parse", "HEAD"]) != head_commit
            or git_output(["rev-parse", "HEAD^{tree}"]) != head_tree
            or git_output(["status", "--porcelain=v1", "-z"], binary=True)
        ):
            fail("current-state attestation target changed during validation")
    validated_sets.sort(key=lambda item: item["kit"])
    if projection_mode == "path-neutral-v1":
        plan_digest_mismatch = False
        if len(plan_attestation_bindings) != pair_count:
            fail("path-neutral plan/runtime attestation cardinality mismatch")
        plan_by_kit = {
            binding["kit"]: binding for binding in plan_attestation_bindings
        }
        if len(plan_by_kit) != len(plan_attestation_bindings):
            fail("path-neutral plan duplicates kit identity")
        if set(plan_by_kit) != {item["kit"] for item in validated_sets}:
            fail("path-neutral plan/runtime kit identities differ")
        for attestation_set in validated_sets:
            binding = plan_by_kit[attestation_set["kit"]]
            if (
                binding["upstream_release_attestation_sha256"]
                != attestation_set["upstream_attestation_sha256"]
                or binding["upgrade_attestation_sha256"]
                != attestation_set["upgrade_attestation_sha256"]
            ):
                plan_digest_mismatch = True
            attestation_set["logical_binding"] = {
                "upstream_attestation_id": binding[
                    "upstream_release_attestation_id"
                ],
                "upgrade_attestation_id": binding["upgrade_attestation_id"],
            }
    managed_bindings_by_path = {}
    for attestation_set in validated_sets:
        for rel, entry in attestation_set["upgrade_files"].items():
            managed_bindings_by_path.setdefault(rel, []).append(
                {
                    "kit": attestation_set["kit"],
                    "ownership": entry["ownership"],
                    "source": entry["source"],
                    "post": entry["post"],
                }
            )
    managed_union = []
    for rel in sorted(managed_bindings_by_path):
        bindings = sorted(
            managed_bindings_by_path[rel], key=lambda item: item["kit"]
        )
        ownership_values = {item["ownership"] for item in bindings}
        if len(ownership_values) != 1:
            fail(f"shared managed path has mixed ownership: {rel}")
        if len(bindings) > 1 and bindings[0]["ownership"] == "upstream-identical":
            common_source = bindings[0]["source"]
            common_post = bindings[0]["post"]
            if any(
                item["source"] != common_source or item["post"] != common_post
                for item in bindings[1:]
            ):
                fail(f"shared upstream-identical managed state is incompatible: {rel}")
        if bindings[0]["ownership"] == "upstream-identical":
            expected = {"type": "file", **bindings[0]["source"]}
            if current_state(rel) != expected:
                fail(f"candidate managed path drifted from upstream release: {rel}")
        managed_bindings_by_path[rel] = bindings
        managed_union.append({"path": rel, "bindings": bindings})

    declared_deltas = [
        validate_rel(value, "maintenance instruction delta")
        for value in instruction_delta_args
    ]
    if len(declared_deltas) != len(set(declared_deltas)):
        fail("maintenance instruction deltas contain duplicates")
    maintenance = {
        "schema": 1 if pair_count == 1 else 2,
        "base_commit": base_commit,
        "head_commit": head_commit,
        "head_tree": head_tree,
        "patch_sha256": sha256_file(patch),
        "authorization_sha256": hashlib.sha256(
            maintenance_authorization.encode("utf-8")
        ).hexdigest(),
        "attestation_sets": validated_sets,
        "managed_bindings_by_path": managed_bindings_by_path,
        "managed_union": managed_union,
        "declared_deltas": set(declared_deltas),
        "ownership": [],
        "plan_digest_mismatch": (
            plan_digest_mismatch if projection_mode == "path-neutral-v1" else False
        ),
    }
    if pair_count == 1:
        singleton = validated_sets[0]
        maintenance.update(
            {
                "upstream": singleton["upstream"],
                "upstream_attestation_sha256": singleton[
                    "upstream_attestation_sha256"
                ],
                "upgrade": singleton["upgrade"],
                "upgrade_attestation_sha256": singleton[
                    "upgrade_attestation_sha256"
                ],
                "upgrade_files": singleton["upgrade_files"],
            }
        )

closure = {}
queue = []


def add_closure(rel, kind, imported_from=None):
    rel = validate_rel(rel, "instruction path")
    record = closure.setdefault(
        rel,
        {
            "path": rel,
            "kinds": set(),
            "imported_from": set(),
            "sha256": None,
            "type": lstat_kind(rel),
            "git_visibility": git_visibility(rel),
        },
    )
    record["kinds"].add(kind)
    if imported_from is not None:
        record["imported_from"].add(imported_from)
    if record["type"] == "file":
        record["sha256"] = sha256_file(lexical_path(rel))
    if record["type"] == "file" and (
        kind in ("imported", "declared")
        or PurePosixPath(rel).suffix.lower() in TEXT_SUFFIXES
    ):
        queue.append(rel)
    return record


for rel in sorted(known_files):
    parts = path_parts(rel)
    if agent_tmp_path(rel):
        continue
    if parts[-1] in INSTRUCTION_NAMES:
        if lstat_kind(rel) != "file":
            fail(f"fixed instruction root must be a regular non-symlink file: {rel}")
        assert_no_symlink_parents(rel, "fixed instruction root")
        add_closure(rel, "fixed-root")
    elif agent_instruction_config_path(rel):
        if lstat_kind(rel) == "symlink":
            fail(f"fixed instruction/config path must not be a symlink: {rel}")
        assert_no_symlink_parents(rel, "fixed instruction/config path")
        add_closure(rel, "fixed-root")

manifest_rel = f"{host_dir}/review-forbidden-paths"
manifest_path = lexical_path(manifest_rel)
if os.path.lexists(manifest_path):
    assert_no_symlink_parents(manifest_rel, "forbidden-path manifest")
    if lstat_kind(manifest_rel) != "file":
        fail(f"{manifest_rel} must be a regular non-symlink file")
    add_closure(manifest_rel, "classification-manifest")
    try:
        manifest_lines = manifest_path.read_text(encoding="utf-8").splitlines()
    except UnicodeError:
        fail(f"{manifest_rel} must be valid UTF-8")
    for line in manifest_lines:
        value = line.strip()
        if not value or value.startswith("#"):
            continue
        rel = validate_rel(value, "declared forbidden path")
        kind = lstat_kind(rel)
        if kind in ("missing", "symlink", "other"):
            fail(f"declared forbidden path is missing, unsafe, or unsupported: {rel}")
        if kind == "file":
            add_closure(rel, "declared")
        else:
            prefix = rel + "/"
            members = sorted(
                candidate for candidate in known_files if candidate.startswith(prefix)
            )
            if not members:
                fail(f"declared forbidden directory has no Git-visible members: {rel}")
            add_closure(rel, "declared")
            for member in members:
                add_closure(member, "declared")


def import_token(line, importer):
    stripped = line.strip()
    if not stripped.startswith("@") or stripped.startswith("@@"):
        return None
    payload = stripped[1:].strip()
    if not payload:
        fail(f"empty instruction import in {importer}")
    if payload[0] in ("'", '"'):
        try:
            parsed = shlex.split(payload, posix=True)
        except ValueError as error:
            fail(f"malformed quoted instruction import in {importer}: {error}")
        if len(parsed) != 1:
            fail(f"quoted instruction import must contain one path in {importer}")
        payload = parsed[0]
    return payload


def resolve_import(importer, token):
    token = validate_rel(token, f"instruction import from {importer}")
    importer_parent = PurePosixPath(importer).parent
    candidates = []
    for base in (importer_parent, PurePosixPath(".")):
        candidate = validate_rel((base / token).as_posix(), "instruction import")
        if candidate not in candidates and lstat_kind(candidate) != "missing":
            candidates.append(candidate)
    if not candidates:
        fail(f"dangling instruction import from {importer}: {token}")
    if len(candidates) != 1:
        fail(f"ambiguous instruction import from {importer}: {token}")
    rel = candidates[0]
    assert_no_symlink_parents(rel, "instruction import")
    kind = lstat_kind(rel)
    if kind == "symlink":
        fail(f"instruction import resolves to a symlink: {rel}")
    if kind != "file":
        fail(f"instruction import must resolve to a regular file: {rel}")
    return rel


parsed = set()
while queue:
    importer = queue.pop(0)
    if importer in parsed:
        continue
    parsed.add(importer)
    try:
        lines = lexical_path(importer).read_text(encoding="utf-8").splitlines()
    except UnicodeError:
        fail(f"instruction file must be valid UTF-8: {importer}")
    for line in lines:
        token = import_token(line, importer)
        if token is None:
            continue
        imported = resolve_import(importer, token)
        add_closure(imported, "imported", importer)


def closure_match(rel, sensitive_only=False):
    for record in closure.values():
        if sensitive_only and not ({"imported", "declared"} & record["kinds"]):
            continue
        path = record["path"]
        if rel == path or (
            record["type"] == "directory" and rel.startswith(path + "/")
        ):
            return record
    return None


for rel in explicit_paths:
    if fixed_forbidden(rel) or secret_equivalent(rel) or closure_match(rel):
        fail(f"explicit review input is an agent instruction or forbidden path: {rel}")

maintenance_ownership_by_path = {}
if review_mode == "standard":
    for rel in changed_paths:
        record = closure_match(rel)
        if record is not None:
            fail(f"review patch contains an instruction-closure path: {rel}")
else:
    declared_deltas = maintenance["declared_deltas"]
    consumed_deltas = set()
    ownership = []
    for rel in changed_paths:
        state = current_state(rel)
        record = closure_match(rel)
        managed_bindings = maintenance["managed_bindings_by_path"].get(rel, [])
        all_upstream_identical = bool(managed_bindings) and all(
            item["ownership"] == "upstream-identical" for item in managed_bindings
        )
        all_project_override = all(
            item["ownership"] == "project-override" for item in managed_bindings
        )
        expected_upstream = (
            {"type": "file", **managed_bindings[0]["source"]}
            if all_upstream_identical
            else None
        )
        if all_upstream_identical and state == expected_upstream:
            classification = "upstream-identical"
            if rel in declared_deltas:
                fail(
                    "upstream-identical path must not be declared as an "
                    f"instruction delta: {rel}"
                )
        elif record is not None:
            if rel not in declared_deltas:
                fail(f"maintenance instruction delta was not declared: {rel}")
            if managed_bindings and not all_project_override:
                fail(
                    "managed instruction delta lacks project-override ownership "
                    f"in the upgrade attestation: {rel}"
                )
            classification = "instruction-delta"
            consumed_deltas.add(rel)
        else:
            if rel in declared_deltas:
                fail(f"declared instruction delta is outside the closure: {rel}")
            if managed_bindings and not all_project_override:
                fail(
                    "managed project-owned path lacks project-override ownership "
                    f"in the upgrade attestation: {rel}"
                )
            classification = "project-owned"
        entry = {
            "path": rel,
            "classification": classification,
            "candidate": state,
            "instruction_kinds": sorted(record["kinds"]) if record else [],
            "instruction_sources": (
                sorted(record["imported_from"]) if record else []
            ),
        }
        if managed_bindings:
            if maintenance["schema"] == 1:
                singleton_binding = managed_bindings[0]
                entry["upgrade_ownership"] = singleton_binding["ownership"]
                entry["upstream"] = singleton_binding["source"]
                entry["upgrade_post"] = singleton_binding["post"]
            else:
                entry["managed_bindings"] = [
                    {
                        "kit": item["kit"],
                        "upgrade_ownership": item["ownership"],
                        "upstream": item["source"],
                        "upgrade_post": item["post"],
                    }
                    for item in managed_bindings
                ]
        ownership.append(entry)
        maintenance_ownership_by_path[rel] = classification
    missing_deltas = sorted(declared_deltas - consumed_deltas)
    if missing_deltas:
        fail(
            "declared instruction delta is not a changed closure path: "
            + ", ".join(missing_deltas)
        )
    maintenance["ownership"] = sorted(ownership, key=lambda item: item["path"])

review_input = bundle / ".review-input"
review_input.mkdir(parents=True)
omitted = []


def has_symlink_component(rel):
    current = root
    for part in path_parts(rel):
        current = current / part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:
            return False
        if stat.S_ISLNK(mode):
            return True
    return False


for rel in sorted(visible):
    if secret_equivalent(rel) or fixed_forbidden(rel) or closure_match(rel):
        continue
    if maintenance_ownership_by_path.get(rel) == "upstream-identical":
        continue
    if has_symlink_component(rel):
        omitted.append({"path": rel, "reason": "symlink"})
        continue
    if rel not in tracked and rel not in changed_paths:
        continue
    if projection_mode == "path-neutral-v1" and (
        rel not in explicit_paths and rel not in changed_paths
    ):
        continue
    if PurePosixPath(rel).suffix.lower() in DOCUMENT_SUFFIXES and rel not in explicit_paths:
        continue
    source = lexical_path(rel)
    try:
        mode = source.lstat().st_mode
    except FileNotFoundError:
        continue
    if not stat.S_ISREG(mode):
        continue
    destination = bundle.joinpath(*path_parts(rel))
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)

for rel in explicit_paths:
    destination = bundle.joinpath(*path_parts(rel))
    if not destination.is_file() or destination.is_symlink():
        fail(f"explicit review input was not copied into the bundle: {rel}")
if not (bundle / "REVIEW_POLICY.md").is_file() or (bundle / "REVIEW_POLICY.md").stat().st_size == 0:
    fail("REVIEW_POLICY.md missing or empty in review bundle")

closure_json = []
for rel in sorted(closure):
    record = closure[rel]
    closure_json.append(
        {
            "path": rel,
            "type": record["type"],
            "kinds": sorted(record["kinds"]),
            "imported_from": sorted(record["imported_from"]),
            "sha256": record["sha256"],
            "git_visibility": record["git_visibility"],
        }
    )


def write_json(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


write_json(
    review_input / "instruction-closure.json",
    {"schema": 1, "paths": closure_json},
)
write_json(
    review_input / "omitted-symlinks.json",
    {"schema": 1, "paths": omitted},
)
write_json(
    review_input / "patch-paths.json",
    {"schema": 1, "paths": changed_paths},
)
if maintenance is not None:
    if projection_mode == "path-neutral-v1":
        projection_sets = []
        sidecar_sets = []
        for attestation_set in maintenance["attestation_sets"]:
            upstream = attestation_set["upstream"]
            upgrade = attestation_set["upgrade"]
            record_inventory_sha256 = hashlib.sha256(
                json.dumps(
                    {
                        "schema": 1,
                        "managed_paths": sorted(
                            upgrade["managed_paths"], key=lambda item: item["path"]
                        ),
                    },
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
            ).hexdigest()
            projection_sets.append(
                {
                    "kit": attestation_set["kit"],
                    "upstream_attestation_id": attestation_set[
                        "logical_binding"
                    ]["upstream_attestation_id"],
                    "upgrade_attestation_id": attestation_set[
                        "logical_binding"
                    ]["upgrade_attestation_id"],
                    "repository": upstream["repository"],
                    "source_revision": upstream["source_revision"],
                    "source_tree": upstream["source_tree"],
                    "upstream_review": upstream[
                        "review" if "review" in upstream else "qualification"
                    ],
                    "upstream_attestation_sha256": attestation_set[
                        "upstream_attestation_sha256"
                    ],
                    "upgrade_attestation_sha256": attestation_set[
                        "upgrade_attestation_sha256"
                    ],
                    "upgrade_scope": upgrade["scope"],
                    "upgrade_pre": upgrade["pre"],
                    "upgrade_post": upgrade["post"],
                    "record_inventory_sha256": record_inventory_sha256,
                    "managed_path_count": upgrade["managed_path_count"],
                    "managed_paths": sorted(
                        [
                            {
                                "path": item["path"],
                                "ownership": item["ownership"],
                                "source": item["source"],
                                "post": item["post"],
                            }
                            for item in upgrade["managed_paths"]
                        ],
                        key=lambda item: item["path"],
                    ),
                }
            )
            sidecar_sets.append(
                {
                    "kit": attestation_set["kit"],
                    "upstream_attestation_id": attestation_set[
                        "logical_binding"
                    ]["upstream_attestation_id"],
                    "upgrade_attestation_id": attestation_set[
                        "logical_binding"
                    ]["upgrade_attestation_id"],
                    "upstream_artifact": {
                        "path": attestation_set["upstream_attestation_path"],
                        "sha256": attestation_set["upstream_attestation_sha256"],
                    },
                    "upgrade_artifact": {
                        "path": attestation_set["upgrade_attestation_path"],
                        "sha256": attestation_set["upgrade_attestation_sha256"],
                    },
                }
            )
        projection_sets.sort(key=lambda item: item["kit"])
        sidecar_sets.sort(key=lambda item: item["kit"])
        projection_sha256 = hashlib.sha256(
            json.dumps(
                {"schema": 1, "attestation_projections": projection_sets},
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        sidecar = {
            "schema": 1,
            "mode": "path-neutral-maintenance-prelaunch",
            "physical_project_root": str(root),
            "base_commit": maintenance["base_commit"],
            "head_commit": maintenance["head_commit"],
            "head_tree": maintenance["head_tree"],
            "patch_sha256": maintenance["patch_sha256"],
            "authorization_sha256": maintenance["authorization_sha256"],
            "projection_sha256": projection_sha256,
            "attestation_sets": sidecar_sets,
        }
        sidecar_path = Path(sidecar_output_arg)
        write_json(sidecar_path, sidecar)
        sidecar_path.chmod(0o400)
        manifest = {
            "schema": 3,
            "mode": "maintenance",
            "projection_mode": "path-neutral-v1",
            "base_commit": maintenance["base_commit"],
            "head_commit": maintenance["head_commit"],
            "head_tree": maintenance["head_tree"],
            "patch_sha256": maintenance["patch_sha256"],
            "authorization_sha256": maintenance["authorization_sha256"],
            "prelaunch_sidecar_sha256": sha256_file(sidecar_path),
            "instruction_closure_sha256": sha256_file(
                review_input / "instruction-closure.json"
            ),
            "patch_paths_sha256": sha256_file(review_input / "patch-paths.json"),
            "projection_sha256": projection_sha256,
            "attestation_projections": projection_sets,
            "managed_union": maintenance["managed_union"],
            "ownership": maintenance["ownership"],
        }
        write_json(review_input / "maintenance-manifest.json", manifest)
    elif maintenance["schema"] == 1:
        manifest = {
            "schema": 1,
            "mode": "maintenance",
            "base_commit": maintenance["base_commit"],
            "head_commit": maintenance["head_commit"],
            "head_tree": maintenance["head_tree"],
            "patch_sha256": maintenance["patch_sha256"],
            "authorization_sha256": maintenance["authorization_sha256"],
            "upstream_attestation_sha256": (
                maintenance["upstream_attestation_sha256"]
            ),
            "upgrade_attestation_sha256": (
                maintenance["upgrade_attestation_sha256"]
            ),
            "instruction_closure_sha256": sha256_file(
                review_input / "instruction-closure.json"
            ),
            "patch_paths_sha256": sha256_file(
                review_input / "patch-paths.json"
            ),
            "upstream": maintenance["upstream"],
            "upgrade": maintenance["upgrade"],
            "ownership": maintenance["ownership"],
        }
        write_json(review_input / "maintenance-manifest.json", manifest)
        singleton = maintenance["attestation_sets"][0]
        shutil.copy2(
            Path(singleton["upstream_attestation_path"]),
            review_input / "upstream-release-attestation.json",
        )
        shutil.copy2(
            Path(singleton["upgrade_attestation_path"]),
            review_input / "upgrade-attestation.json",
        )
        if (
            sha256_file(review_input / "upstream-release-attestation.json")
            != maintenance["upstream_attestation_sha256"]
            or sha256_file(review_input / "upgrade-attestation.json")
            != maintenance["upgrade_attestation_sha256"]
        ):
            fail("copied maintenance attestation digest mismatch")
    else:
        manifest_sets = []
        for attestation_set in maintenance["attestation_sets"]:
            manifest_sets.append(
                {
                    "kit": attestation_set["kit"],
                    "upstream_attestation_sha256": attestation_set[
                        "upstream_attestation_sha256"
                    ],
                    "upgrade_attestation_sha256": attestation_set[
                        "upgrade_attestation_sha256"
                    ],
                    "upstream": attestation_set["upstream"],
                    "upgrade": attestation_set["upgrade"],
                }
            )
        manifest = {
            "schema": 2,
            "mode": "maintenance",
            "base_commit": maintenance["base_commit"],
            "head_commit": maintenance["head_commit"],
            "head_tree": maintenance["head_tree"],
            "patch_sha256": maintenance["patch_sha256"],
            "authorization_sha256": maintenance["authorization_sha256"],
            "instruction_closure_sha256": sha256_file(
                review_input / "instruction-closure.json"
            ),
            "patch_paths_sha256": sha256_file(review_input / "patch-paths.json"),
            "attestation_sets": manifest_sets,
            "managed_union": maintenance["managed_union"],
            "ownership": maintenance["ownership"],
        }
        write_json(review_input / "maintenance-manifest.json", manifest)
        attestations_root = review_input / "attestations"
        for attestation_set in maintenance["attestation_sets"]:
            destination = attestations_root / attestation_set["kit"]
            destination.mkdir(parents=True)
            upstream_copy = destination / "upstream-release-attestation.json"
            upgrade_copy = destination / "upgrade-attestation.json"
            shutil.copy2(
                Path(attestation_set["upstream_attestation_path"]), upstream_copy
            )
            shutil.copy2(
                Path(attestation_set["upgrade_attestation_path"]), upgrade_copy
            )
            if (
                sha256_file(upstream_copy)
                != attestation_set["upstream_attestation_sha256"]
                or sha256_file(upgrade_copy)
                != attestation_set["upgrade_attestation_sha256"]
            ):
                fail(
                    "copied maintenance attestation digest mismatch for "
                    + attestation_set["kit"]
                )
(review_input / "omitted-symlinks.txt").write_text(
    "".join(f"{item['path']}\n" for item in omitted if "\n" not in item["path"]),
    encoding="utf-8",
)
shutil.copy2(patch, review_input / "patch.diff")
if (review_input / "patch.diff").read_bytes() != patch.read_bytes():
    fail("copied review patch is not byte-identical")


def path_neutral_contains_secret_marker(data):
    static_secret_markers = (
        b"-----BEGIN " + b"OPENSSH PRIVATE KEY-----",
        b"-----BEGIN " + b"PRIVATE KEY-----",
        b"Authorization:" + b" Bearer ",
        b"github_" + b"pat_",
    )
    if any(value in data for value in static_secret_markers):
        return True
    assignment = b"maintenance_" + b"authorization="
    if assignment not in data:
        return False
    try:
        data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        return True
    if b"\x00" in data:
        return True
    empty_assertion = re.compile(
        rb"[-+]?[ \t]*grep[ \t]+-qx[ \t]+'"
        + re.escape(assignment)
        + rb"'[ \t]+\"\$out\.[A-Za-z0-9._-]+\"[ \t]*"
    )
    deterministic_template = re.compile(
        rb"[-+]?[ \t]*'printf[ \t]+\""
        + re.escape(assignment)
        + rb"%s\\n\"[ \t]+"
        rb"\"\$\{AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION:-\}\"[ \t]+"
        rb">>[ \t]+\"\$REVIEW_WRAPPER_TEST_OUT\"'[ \t]*\\?[ \t]*"
    )
    for line in data.splitlines():
        if assignment not in line:
            continue
        if line.count(assignment) != 1:
            return True
        if empty_assertion.fullmatch(line) or deterministic_template.fullmatch(line):
            continue
        return True
    return False


def enforce_path_neutral_secret_markers(data, rel):
    if path_neutral_contains_secret_marker(data):
        fail(f"path-neutral reviewable bytes contain a secret marker: {rel}")


def path_neutral_contains_physical_path(data, rel, forbidden_bytes):
    if any(value in data for value in forbidden_bytes):
        return True
    if rel == ".review-input/patch.diff":
        return False
    generic_markers = (
        b"/Users/",
        b"/home/",
        b"/private/",
        b"/tmp/",
        b"/mnt/c/Users/",
        b"C:" + b"\\" + b"Users" + b"\\",
        b"C:" + b"\\\\" + b"Users" + b"\\\\",
    )
    return any(marker in data for marker in generic_markers)


if projection_mode == "path-neutral-v1":
    forbidden_literals = {str(root)}
    home = os.environ.get("HOME", "")
    if home:
        forbidden_literals.add(str(Path(home)))
    sidecar_artifact = Path(sidecar_final_arg)
    forbidden_literals.add(str(sidecar_artifact))
    forbidden_literals.add(str(sidecar_artifact.parent))
    for attestation_set in maintenance["attestation_sets"]:
        for key in ("upstream_attestation_path", "upgrade_attestation_path"):
            artifact = Path(attestation_set[key])
            forbidden_literals.add(str(artifact))
            forbidden_literals.add(str(artifact.parent))
    forbidden_bytes = sorted(
        {value.encode("utf-8") for value in forbidden_literals if value},
        key=len,
        reverse=True,
    )
    for directory, _, filenames in os.walk(bundle):
        for name in filenames:
            candidate = Path(directory) / name
            data = candidate.read_bytes()
            rel = candidate.relative_to(bundle).as_posix()
            if path_neutral_contains_physical_path(data, rel, forbidden_bytes):
                fail(
                    "path-neutral reviewable bytes contain a physical "
                    f"checkout/home/artifact path: {rel}"
                )
            enforce_path_neutral_secret_markers(data, rel)
    if maintenance["plan_digest_mismatch"]:
        fail("path-neutral plan/runtime attestation digest binding mismatch")

for directory, dirnames, filenames in os.walk(bundle):
    for name in filenames:
        path = Path(directory) / name
        mode = path.stat().st_mode
        path.chmod(mode & ~0o222)

inventory = []
inventory_path = review_input / "bundle-inventory.json"
for directory, dirnames, filenames in os.walk(bundle):
    for dirname in list(dirnames):
        path = Path(directory) / dirname
        if path.is_symlink():
            fail(f"review bundle contains a symlink directory: {path}")
    for name in filenames:
        path = Path(directory) / name
        if path == inventory_path:
            continue
        if path.is_symlink() or not path.is_file():
            fail(f"review bundle contains an unsafe file: {path}")
        rel = path.relative_to(bundle).as_posix()
        inventory.append(
            {
                "path": rel,
                "sha256": sha256_file(path),
                "mode": stat.S_IMODE(path.stat().st_mode),
            }
        )
write_json(
    inventory_path,
    {"schema": 1, "files": sorted(inventory, key=lambda item: item["path"])},
)
inventory_path.chmod(inventory_path.stat().st_mode & ~0o222)
PY

if [ "$MAINTENANCE_REVIEW_PROJECTION" = path-neutral-v1 ]; then
  mv "$SIDECAR_STAGING" "$MAINTENANCE_PRELAUNCH_SIDECAR"
  SIDECAR_STAGING=""
fi
mv "$STAGING" "$BUNDLE"
BUNDLE_ACTIVE=0
trap - EXIT INT TERM HUP

printf 'review_repo_root=%s\n' "$BUNDLE"
printf 'review_patch=%s\n' "$BUNDLE/.review-input/patch.diff"
printf 'review_instruction_manifest=%s\n' "$BUNDLE/.review-input/instruction-closure.json"
printf 'review_bundle_manifest=%s\n' "$BUNDLE/.review-input/bundle-inventory.json"
printf 'review_bundle_digest=%s\n' "$(sha256_path "$BUNDLE/.review-input/bundle-inventory.json")"
if [ "$REVIEW_MODE" = maintenance ]; then
  printf 'review_mode=maintenance\n'
  printf 'review_maintenance_manifest=%s\n' "$BUNDLE/.review-input/maintenance-manifest.json"
  printf 'review_maintenance_digest=%s\n' \
    "$(sha256_path "$BUNDLE/.review-input/maintenance-manifest.json")"
  if [ "$MAINTENANCE_REVIEW_PROJECTION" = path-neutral-v1 ]; then
    printf 'review_maintenance_projection=path-neutral-v1\n'
    printf 'review_maintenance_sidecar=%s\n' "$MAINTENANCE_PRELAUNCH_SIDECAR"
    printf 'review_maintenance_sidecar_digest=%s\n' \
      "$(sha256_path "$MAINTENANCE_PRELAUNCH_SIDECAR")"
  fi
fi
