#!/usr/bin/env bash
# SessionStart probe: is the external third-party review engine available?
# Writes .codex/tmp/reviewer.engine and prints one context line for the session.
# States written:
#   external:<full REVIEWER_CMD>   engine binary found (and smoke-tested on startup)
#   degraded:<full REVIEWER_CMD>   binary found but a smoke invocation failed
#   missing:<binary>               engine binary not found
# `$milestone` may write `fallback-approved` after explicit human consent.
# That authorizes the fallback chain for this session: same-vendor sterile CLI
# first, built-in reviewer only if the sterile CLI also fails. A transient
# degraded placeholder is held during the smoke window so a harness-killed
# probe fails closed instead of leaving the previous session's state.
# Never blocks startup: always exits 0. A fresh startup also smoke-tests one
# real invocation, so auth/config breakage surfaces here as `degraded`;
# resume/clear/compact skip the smoke and check binary presence only.
set -u

# External reviewers are deliberately terminal leaves. If a project hook is
# ever discovered despite the sterile launcher, consume its input and stop
# before probing or dispatching another reviewer.
if [ "${AGENT_KIT_REVIEW_MODE:-}" = "external" ]; then
  cat > /dev/null
  exit 0
fi

DIR="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$DIR" || exit 0
TMP="$DIR/.codex/tmp"
mkdir -p "$TMP"
STATE="$TMP/reviewer.engine"
CONF="$DIR/.codex/hooks/gate.conf"

# Hook input: extract the SessionStart source (startup|resume|clear|compact).
input=$(cat)
src=$(printf '%s' "$input" | grep -o '"source"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

# shellcheck disable=SC1090  # trusted per-repo config, versioned in git
[ -f "$CONF" ] && source "$CONF"
REVIEWER_CMD="${REVIEWER_CMD:-.codex/hooks/reviewer-claude.sh}"

# Consent is session-scoped. Preserve it across resume/clear/compact, but reset
# it on a fresh startup so cross-vendor review is tried again.
if [ -f "$STATE" ] && grep -qx "fallback-approved" "$STATE"; then
  case "$src" in
    resume|clear|compact)
      echo "reviewer-engine: fallback-approved (human consent recorded this session) — \$milestone uses the fallback chain: sterile same-vendor CLI, then built-in reviewer if needed."
      exit 0
      ;;
  esac
fi

# Engine binary = first command-string token that is not a wrapper (`env`,
# `timeout`), not a VAR=val assignment, and not a bare number (a timeout arg).
engine_token() {
  local tok
  # Split with the SAME eval-set semantics the smoke invocation and
  # run-reviewer.sh use, so a quoted/whitespace-bearing engine path is one
  # token here too (naive word-splitting misclassified such engines as
  # missing and diverted the independent-review flow).
  eval "set -- $1"
  for tok in "$@"; do
    case "$tok" in
      env|timeout) continue ;;
      *=*) continue ;;
      ''|*[!0-9]*) printf '%s\n' "$tok"; return 0 ;;
      *) continue ;;
    esac
  done
  printf '%s\n' ""
}
bin="$(engine_token "$REVIEWER_CMD")"

if ! command -v "$bin" > /dev/null 2>&1; then
  printf 'missing:%s\n' "$bin" > "$STATE"
  echo "reviewer-engine: '$bin' NOT found from the installed project root or on PATH — cross-vendor review unavailable. Fix REVIEWER_CMD, or \$milestone must obtain explicit human consent for the fallback chain."
  exit 0
fi

# Binary exists. On a fresh startup, also smoke-test one real invocation:
# binary presence alone has masked invocation-level breakage twice in production
# (a REVIEWER_CMD wrapped in GNU `timeout`, absent on stock macOS; an engine
# blocking forever on an open stdin). Skipped on resume/clear/compact to keep
# those cheap.
#
# Cap design: the engine runs in the BACKGROUND with output to a FILE — a
# command substitution would block on any orphaned grandchild holding the
# stdout pipe even after the direct child dies (this defeated an earlier
# perl-alarm cap). Poll up to SMOKE_CAP seconds, then kill the direct child.
# The timeout path also writes `degraded`, so a hanging engine can never
# leave a stale `external` behind (a killed probe that wrote nothing would
# recreate exactly the mid-milestone hang this probe exists to prevent).
# A grandchild may briefly outlive the kill; it no longer blocks us.
# stdin is closed explicitly for the same reason $milestone closes it.
#
# Cap value: must clear the engine's healthy runtime, not sit inside it. A cap
# that straddles the distribution turns the probe into a coin flip and reports
# `degraded` for a working engine — $milestone then stops for
# no reason. Observed on a codex 0.144.4 host (2026-07-16): 9 timed runs took
# 12/13/14/17/18/18/18/27/29s and 8/8 exited cleanly when not killed — no
# non-exit bug, but a cap of 25 sat mid-distribution and produced ~20-30% false
# `degraded`. Default 60 = ~2x that observed max; raise GATE_SMOKE_CAP in
# gate.conf for a slower engine.
case "$src" in
  resume|clear|compact)
    if [ -f "$STATE" ] && grep -q "^degraded:" "$STATE"; then
      echo "reviewer-engine: previous smoke marked the cross-vendor engine degraded — preserved on $src. Fix it or explicitly authorize the fallback chain; a fresh startup re-probes."
    else
      printf 'external:%s\n' "$REVIEWER_CMD" > "$STATE"
      echo "reviewer-engine: '$bin' available (smoke test skipped on $src) — \$milestone reviews via the external engine (REVIEWER_CMD: $REVIEWER_CMD)."
    fi
    ;;
  *)
    SMOKE_CAP="${GATE_SMOKE_CAP:-60}"
    SMOKE_OUT="$TMP/smoke.out"
    : > "$SMOKE_OUT"
    # Fail-closed placeholder: if the harness kills this hook mid-smoke (its
    # timeout is outside our control), the state must not remain the previous
    # session's `external`. The completion paths below overwrite this.
    printf 'degraded:%s (probe interrupted before completion)\n' "$REVIEWER_CMD" > "$STATE"
    warnPrefix=""
    if [ -n "${GATE_SMOKE_CMD:-}" ] && [ "$(engine_token "$GATE_SMOKE_CMD")" != "$bin" ]; then
      warnPrefix="warning: GATE_SMOKE_CMD engine differs from REVIEWER_CMD — ignored; "
      unset GATE_SMOKE_CMD
    fi
    # Parse with the SAME eval-set semantics run-reviewer.sh uses, so quoted/
    # whitespace-bearing configuration is split identically on both sides.
    # NOTE the scope of what this proves: when GATE_SMOKE_CMD is set (same
    # engine, alternate argv — see gate.conf.example), the probe validates the
    # ENGINE, not the exact production argv; only when it is unset does the
    # probe exercise REVIEWER_CMD's own argv.
    eval "set -- ${GATE_SMOKE_CMD:-$REVIEWER_CMD}"
    "$@" "You were dispatched as a subagent to execute a specific task. Task: reply with exactly: OK" < /dev/null > "$SMOKE_OUT" 2>&1 &
    smoke_pid=$!
    waited=0
    while kill -0 "$smoke_pid" 2>/dev/null && [ "$waited" -lt "$SMOKE_CAP" ]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$smoke_pid" 2>/dev/null; then
      kill -9 "$smoke_pid" 2>/dev/null
      wait "$smoke_pid" 2>/dev/null
      printf 'degraded:%s\n' "$REVIEWER_CMD" > "$STATE"
      echo "${warnPrefix}reviewer-engine: '$bin' found but the smoke invocation HUNG (killed at ${SMOKE_CAP}s) — \$milestone must fix it or obtain explicit human consent for the fallback chain."
    else
      wait "$smoke_pid"
      rc=$?
      out=$(cat "$SMOKE_OUT")
      if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
        printf 'external:%s\n' "$REVIEWER_CMD" > "$STATE"
        echo "${warnPrefix}reviewer-engine: '$bin' available and smoke-tested — \$milestone reviews via the external engine (REVIEWER_CMD: $REVIEWER_CMD)."
      else
        printf 'degraded:%s\n' "$REVIEWER_CMD" > "$STATE"
        echo "${warnPrefix}reviewer-engine: '$bin' found but a smoke invocation FAILED (exit $rc; auth, quota, or config) — \$milestone must fix it or obtain explicit human consent for the fallback chain. Output tail: $(printf '%s' "$out" | tail -c 200)"
      fi
    fi
    ;;
esac
exit 0
