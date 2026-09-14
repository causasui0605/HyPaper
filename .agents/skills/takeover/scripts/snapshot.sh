#!/usr/bin/env bash
set -euo pipefail

MILESTONE="${1:-auto}"
PLAN="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
GIT_TOP="$(git -C "$PROJECT_ROOT" rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: takeover requires a Git repository" >&2
  exit 2
}
GIT_ROOT="$(cd "$GIT_TOP" && pwd -P)"
case "$PROJECT_ROOT/" in
  "$GIT_ROOT/"*) ;;
  *) echo "error: installed project root escapes its Git worktree" >&2; exit 2 ;;
esac
PROJECT_PREFIX="$(git -C "$PROJECT_ROOT" rev-parse --show-prefix)"
cd "$PROJECT_ROOT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$PROJECT_ROOT/.codex/tmp/takeover/$MILESTONE/$STAMP"
mkdir -p "$OUT/artifacts"

git -C "$GIT_ROOT" rev-parse HEAD > "$OUT/head.txt"
if ! git -C "$GIT_ROOT" symbolic-ref --quiet --short HEAD > "$OUT/branch.txt"; then
  printf '%s\n' detached > "$OUT/branch.txt"
fi
# Porcelain v1 -z always spells paths from the Git root, even when -C points at
# a subdirectory. Normalize both ordinary and rename/copy continuation records
# to the installed policy project root without ever parsing on whitespace.
if [ -z "$PROJECT_PREFIX" ]; then
  git -C "$PROJECT_ROOT" status --porcelain=v1 -z -- . > "$OUT/status.z"
else
  git -C "$PROJECT_ROOT" status --porcelain=v1 -z -- . |
    PROJECT_PREFIX="$PROJECT_PREFIX" perl -0ne '
      BEGIN { $pending = 0 }
      my $prefix = $ENV{PROJECT_PREFIX};
      if ($pending) {
        s/^\Q$prefix\E//s
          or die "status continuation escaped policy project root\n";
        $pending = 0;
      } else {
        /^([ MTADRCU?!]{2}) /s
          or die "malformed porcelain status record\n";
        my $xy = $1;
        s/^([ MTADRCU?!]{2} )\Q$prefix\E/$1/s
          or die "status path escaped policy project root\n";
        s/^([ MTADRCU?!]{2} )\0$/$1.\0/s;
        $pending = 1 if $xy =~ /[RC]/;
      }
      print;
      END { die "missing status continuation record\n" if $pending }
    ' > "$OUT/status.z"
fi
git -C "$PROJECT_ROOT" diff --relative --binary HEAD -- . > "$OUT/working.patch"
git -C "$PROJECT_ROOT" diff --cached --relative --binary HEAD -- . > "$OUT/staged.patch"
git -C "$PROJECT_ROOT" ls-files --others --exclude-standard -z -- . > "$OUT/untracked.z"
if [ -z "$PROJECT_PREFIX" ]; then
  : > "$OUT/sibling-staged.z"
else
  git -C "$GIT_ROOT" diff --cached --name-only -z |
    PROJECT_PREFIX="$PROJECT_PREFIX" perl -0ne '
      my $prefix = $ENV{PROJECT_PREFIX};
      print unless /^\Q$prefix\E/s;
    ' > "$OUT/sibling-staged.z"
fi
git -C "$GIT_ROOT" for-each-ref --format='%(objectname) %(refname)' refs/heads/ms/ > "$OUT/ms-refs.txt"
git -C "$GIT_ROOT" worktree list --porcelain > "$OUT/worktrees.txt"
git -C "$GIT_ROOT" log --decorate --oneline -40 > "$OUT/recent-log.txt"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

: > "$OUT/untracked-hashes.nul"
while IFS= read -r -d '' path; do
  [ -f "$PROJECT_ROOT/$path" ] || continue
  digest="$(hash_file "$PROJECT_ROOT/$path")"
  size="$(wc -c < "$PROJECT_ROOT/$path" | tr -d ' ')"
  printf '%s\0%s\0%s\0' "$path" "$digest" "$size" >> "$OUT/untracked-hashes.nul"
done < "$OUT/untracked.z"

: > "$OUT/artifacts.sha256"
record_artifact() {
  local path="$1" label safe digest
  [ -f "$path" ] || return 0
  digest="$(hash_file "$path")"
  printf '%s  %s\n' "$digest" "$path" >> "$OUT/artifacts.sha256"
  label="${path#./}"
  safe="${label//\//__}"
  cp "$path" "$OUT/artifacts/$safe"
}

record_artifact "CLAUDE.md"
record_artifact "AGENTS.md"
record_artifact ".claude/hooks/gate.conf"
record_artifact ".codex/hooks/gate.conf"
[ -n "$PLAN" ] && record_artifact "$PLAN"

if [ "$MILESTONE" != auto ]; then
  record_artifact ".claude/tmp/${MILESTONE}_implementer_report.md"
  record_artifact ".codex/tmp/${MILESTONE}_implementer_report.md"
  record_artifact ".codex/tmp/${MILESTONE}_adoption_report.md"
fi

if [ -f ".codex/tmp/install/latest" ]; then
  install_dir="$(cat .codex/tmp/install/latest)"
  [ -f "$install_dir/manifest.txt" ] && record_artifact "$install_dir/manifest.txt"
  [ -f "$install_dir/pre_status.z" ] && cp "$install_dir/pre_status.z" "$OUT/install-pre-status.z"
  [ -f "$install_dir/post_status.z" ] && cp "$install_dir/post_status.z" "$OUT/install-post-status.z"
fi

{
  printf 'snapshot_version=2\n'
  printf 'milestone=%s\n' "$MILESTONE"
  printf 'plan=%s\n' "$PLAN"
  printf 'root=%s\n' "$PROJECT_ROOT"
  printf 'project_root=%s\n' "$PROJECT_ROOT"
  printf 'git_root=%s\n' "$GIT_ROOT"
  printf 'project_prefix=%s\n' "$PROJECT_PREFIX"
  printf 'head=%s\n' "$(cat "$OUT/head.txt")"
  printf 'branch=%s\n' "$(cat "$OUT/branch.txt")"
  printf 'created_utc=%s\n' "$STAMP"
} > "$OUT/manifest.env"

printf '%s\n' "$OUT"
