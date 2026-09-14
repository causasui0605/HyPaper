#!/usr/bin/env bash
# SubagentStop gate for the `implementer` subagent (matched by name in hooks.json).
#
# Enforces before the implementer may finish:
#   1. every command in GATE_CHECKS passes (from .codex/hooks/gate.conf;
#      if absent, auto-detected from the repo manifest)
#   2. no secret-looking material in the working diff
#
# Protocol (Codex hooks): exit 0 with NO stdout = allow stop.
# Exit 0 with a single JSON object on stdout = structured decision:
#   {"continue":false,"stopReason":"..."}  -> subagent must continue and fix
#   {"systemMessage":"..."}              -> allow stop, alert the human
# Bounded retries: block up to MAX_RETRIES times, then allow stop with an alert.
set -uo pipefail

MAX_RETRIES=3
DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
TMP="$DIR/.codex/tmp"
mkdir -p "$TMP"
COUNTER_FILE="$TMP/gate.retries"
LOG="$TMP/gate.log"
CONF="$DIR/.codex/hooks/gate.conf"

# Consume stdin (hook input JSON). Agent identity is guaranteed by the
# hooks.json matcher, so nothing from the payload is needed here.
cat > /dev/null

cd "$DIR" || exit 0
echo "=== gate run $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"

GATE_CHECKS=()
GATE_SECRET_EXCLUDE=()
if [ -f "$CONF" ]; then
  # shellcheck disable=SC1090  # trusted per-repo config, versioned in git
  source "$CONF"
fi

# Manifest auto-detect fallback when no conf defines checks.
if [ "${#GATE_CHECKS[@]}" -eq 0 ]; then
  if [ -f Cargo.toml ]; then
    GATE_CHECKS=("cargo test --workspace" "cargo clippy --workspace --all-targets -- -D warnings")
  elif [ -f pyproject.toml ] || [ -f setup.py ]; then
    GATE_CHECKS=("python -m pytest -q")
  elif [ -f package.json ]; then
    GATE_CHECKS=("npm test --silent")
  fi
fi

if [ "${#GATE_CHECKS[@]}" -eq 0 ]; then
  printf '{"systemMessage":"gate: no GATE_CHECKS in .codex/hooks/gate.conf and no known manifest detected. Allowing stop UNGATED - configure gate.conf."}\n'
  exit 0
fi

fail_reasons=()

for check in "${GATE_CHECKS[@]}"; do
  echo "--- check: $check" >> "$LOG"
  if ! bash -c "$check" >> "$LOG" 2>&1; then
    fail_reasons+=("check failed: $check")
  fi
done

# Secrets scan on the working diff (tracked changes + untracked via intent-to-add).
# .codex/tmp is always excluded to avoid scanning the gate's own artifacts.
# Secret-equivalent env files are excluded at every depth because their values
# must not enter the gate log or external review artifacts.
git add -N . >> "$LOG" 2>&1 || true
EXCLUDES=(
  ":(exclude).codex/tmp"
  ":(exclude,glob).env"
  ":(exclude,glob).env.*"
  ":(exclude,glob)**/.env"
  ":(exclude,glob)**/.env.*"
  ":(exclude,glob).env/**"
  ":(exclude,glob)**/.env/**"
)
for p in "${GATE_SECRET_EXCLUDE[@]+"${GATE_SECRET_EXCLUDE[@]}"}"; do
  [ -n "$p" ] && EXCLUDES+=(":(exclude)$p")
done
SECRET_PATTERNS='(-----BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|api[_-]?key[[:space:]]*[:=]|secret[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{12,}|private[_-]?key[[:space:]]*[:=]|mnemonic|0x[0-9a-fA-F]{64})'
if git diff -- . "${EXCLUDES[@]}" 2>/dev/null | grep -iEq "$SECRET_PATTERNS"; then
  fail_reasons+=("possible secret/private-key material in diff (pattern match; content redacted)")
  echo "--- secret scan: possible secret pattern matched outside excluded paths (content redacted)" >> "$LOG"
fi

if [ "${#fail_reasons[@]}" -eq 0 ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

count=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$COUNTER_FILE"

reason_text=$(printf '%s; ' "${fail_reasons[@]}")
reason_text=${reason_text%; }

if [ "$count" -le "$MAX_RETRIES" ]; then
  # stdout must contain ONLY this JSON object.
  printf '{"continue":false,"stopReason":"Gate failed: %s. Attempt %s/%s. Fix and finish again. Full log: .codex/tmp/gate.log"}\n' \
    "$reason_text" "$count" "$MAX_RETRIES"
  exit 0
else
  rm -f "$COUNTER_FILE"
  printf '{"systemMessage":"gate: still failing after %s attempts (%s). Allowing stop - HUMAN REVIEW REQUIRED. Log: .codex/tmp/gate.log"}\n' \
    "$MAX_RETRIES" "$reason_text"
  exit 0
fi
