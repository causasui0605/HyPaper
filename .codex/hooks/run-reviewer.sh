#!/bin/bash
# bash (3.2+) required, not POSIX sh: dash's `kill` builtin rejects the
# negative-pgid form (`kill -TERM -- -<pgid>`) and would make every group
# kill a silent no-op, leaking the whole reviewer tree. bash ships on the
# supported baseline (Linux; stock macOS has 3.2).
#
# run-reviewer.sh — bounded external-review attempt runner.
# Usage: run-reviewer.sh <prompt-file> <attempt-log>
#        run-reviewer.sh --self-test
#
# Contract: this helper is a SYNCHRONOUS, bounded lifecycle manager for ONE
# review attempt — it returns only when the attempt is over and the process
# group is verified gone. The ORCHESTRATOR runs it as a background task and
# treats the helper's completion as the attempt's completion; any tool-level
# ceiling on that background task must exceed REVIEW_TIMEOUT_SECS plus the
# grace/cleanup margin (say +60s), or be absent.
#
# Lifecycle owned here:
#   * launches ${REVIEWER_CMD} with the prompt file's CONTENT as the single
#     trailing argument and stdin closed (`< /dev/null` — load-bearing: an
#     open stdin can block a non-interactive engine forever);
#   * isolates the engine in its OWN process group (exec-ing the launcher
#     from the backgrounded subshell keeps $! == engine pid == pgid; a
#     leaderless subshell exec-ing setsid(1) is not forked over; the perl
#     fallback setsid()s in-process before exec). Launcher portability
#     (clean-host baseline): setsid(1) where present (Linux); else
#     /usr/bin/perl POSIX::setsid (perl ships with stock macOS); else refuse
#     — fail closed rather than run an uncleanable group;
#   * interruption safety is two-stage: a defer-only trap (flag set) covers
#     the instants before launch state exists; the full handler installed
#     right after pid/pgid assignment processes any deferred signal, TERMs
#     the direct child pid AS WELL AS the group (covering the pre-setsid
#     instant), and is fail-closed (125) if cleanup verification fails;
#   * enforces REVIEW_TIMEOUT_SECS (gate.conf > 1800 default) via a detached
#     watchdog beside a blocking wait — never a GNU `timeout` wrapper (stock
#     macOS lacks it), and never group-liveness polling for completion (a
#     zombie occupies its pgid and would wedge such a loop). The watchdog
#     sleeps in 1s increments and exits within ~1s of being retired via its
#     retire-marker file — no long-lived orphan sleeps;
#   * on expiry: TERM the group, grace ${GRACE_SECS}s, KILL, then VERIFY the
#     group is empty. A verification failure is FAIL-CLOSED on every path
#     (exit/record 125, never a parseable attempt);
#   * proves log quiescence by requiring two consecutive unchanged sampling
#     intervals (bounded); an unstable log is fail-closed (125);
#   * records the final status to <attempt-log>.exit (and the group id to
#     <attempt-log>.pgid); the orchestrator must treat a missing record, or
#     124/125/130, as infrastructure failure (never a verdict).
#
# Exit codes: 0 = engine exited 0. 124 = watchdog expiry (clean cleanup).
# 125 = cleanup/quiescence failure (fail closed). 130 = interrupted.
# 2 = usage/config. Anything else = engine's own exit, passed through.

set -u

GRACE_SECS=10
QUIESCE_TRIES=10
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SELF="$SCRIPT_DIR/$(basename "$0")"

self_test() {
  tmp_parent="${TMPDIR:-/tmp}/"
  tmp=$(mktemp -d "${tmp_parent}/run_reviewer_selftest.XXXXXX") || exit 2
  tmp="$(cd "$tmp" && pwd -P)" || exit 2
  fails=0
  printf 'prompt-content' > "$tmp/prompt.txt"
  printf '#!/bin/sh\necho ok-fast\nexit 0\n' > "$tmp/fast.sh"; chmod +x "$tmp/fast.sh"
  printf '#!/bin/sh\nsleep 300 &\nsleep 300\n' > "$tmp/slow.sh"; chmod +x "$tmp/slow.sh"

  for launcher in auto perl; do
    if [ "$launcher" = perl ] && [ ! -x /usr/bin/perl ]; then continue; fi
    # fast path: exit + output pass-through; watchdog marker must be retired
    RUN_REVIEWER_FORCE_LAUNCHER="$launcher" RUN_REVIEWER_CMD_FOR_TEST="$tmp/fast.sh" RUN_REVIEWER_TIMEOUT_FOR_TEST=60 \
      "$0" "$tmp/prompt.txt" "$tmp/fast_$launcher.log"
    [ "$(cat "$tmp/fast_$launcher.log.exit" 2>/dev/null)" = "0" ] || { echo "FAIL[$launcher]: fast exit"; fails=1; }
    grep -q ok-fast "$tmp/fast_$launcher.log" || { echo "FAIL[$launcher]: fast output"; fails=1; }
    [ ! -e "$tmp/fast_$launcher.log.wdogmark" ] || { echo "FAIL[$launcher]: wdog marker not retired"; fails=1; }
    # watchdog path: grandchild proves group-wide kill; group must be GONE after
    RUN_REVIEWER_FORCE_LAUNCHER="$launcher" RUN_REVIEWER_CMD_FOR_TEST="$tmp/slow.sh" RUN_REVIEWER_TIMEOUT_FOR_TEST=3 \
      "$0" "$tmp/prompt.txt" "$tmp/slow_$launcher.log"
    st=$?
    [ "$st" = "124" ] || { echo "FAIL[$launcher]: watchdog exit ($st)"; fails=1; }
    [ "$(cat "$tmp/slow_$launcher.log.exit" 2>/dev/null)" = "124" ] || { echo "FAIL[$launcher]: exit file"; fails=1; }
    [ ! -e "$tmp/slow_$launcher.log.wdogmark" ] || { echo "FAIL[$launcher]: wdog marker not retired"; fails=1; }
    pgid=$(cat "$tmp/slow_$launcher.log.pgid" 2>/dev/null)
    if [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null; then echo "FAIL[$launcher]: group survived"; fails=1; fi
  done

  # production tier-selection override: fallback routing must be able to select
  # a pre-resolved command without editing gate.conf.
  REVIEWER_CMD_OVERRIDE="$tmp/fast.sh" RUN_REVIEWER_TIMEOUT_FOR_TEST=60 \
    "$0" "$tmp/prompt.txt" "$tmp/override.log"
  [ "$(cat "$tmp/override.log.exit" 2>/dev/null)" = "0" ] || { echo "FAIL: command override exit"; fails=1; }
  grep -q ok-fast "$tmp/override.log" || { echo "FAIL: command override ignored"; fails=1; }

  # Installed-project regression: a configured repo-relative engine must run
  # from the copied policy root even when the helper is called from below it.
  nested_project="$tmp/copied-project"
  nested_cwd="$nested_project/nested/cwd"
  mkdir -p "$nested_project/.codex/hooks" "$nested_project/tools" "$nested_cwd"
  cp -p "$SELF" "$nested_project/.codex/hooks/run-reviewer.sh"
  printf 'REVIEWER_CMD="tools/fake-reviewer.sh"\nREVIEW_TIMEOUT_SECS=60\n' \
    > "$nested_project/.codex/hooks/gate.conf"
  printf '#!/bin/sh\npwd -P\nprintf "prompt=%%s\\n" "$1"\n' \
    > "$nested_project/tools/fake-reviewer.sh"
  chmod +x "$nested_project/tools/fake-reviewer.sh"
  (
    cd "$nested_cwd" || exit 1
    printf 'nested-prompt' > prompt.txt
    ../../.codex/hooks/run-reviewer.sh prompt.txt attempt.log
  )
  [ "$(cat "$nested_cwd/attempt.log.exit" 2>/dev/null)" = "0" ] ||
    { echo "FAIL: nested project-relative command exit"; fails=1; }
  grep -Fxq "$nested_project" "$nested_cwd/attempt.log" ||
    { echo "FAIL: nested project-relative command cwd"; fails=1; }
  grep -Fq 'prompt=nested-prompt' "$nested_cwd/attempt.log" ||
    { echo "FAIL: nested caller-relative prompt"; fails=1; }

  # interruption path: TERM the helper mid-flight; the helper itself must exit
  # 130, record 130, kill the whole group, and retire the watchdog marker
  RUN_REVIEWER_CMD_FOR_TEST="$tmp/slow.sh" RUN_REVIEWER_TIMEOUT_FOR_TEST=120 "$0" "$tmp/prompt.txt" "$tmp/int.log" &
  hpid=$!
  sleep 2
  kill -TERM "$hpid" 2>/dev/null
  wait "$hpid"; hst=$?
  [ "$hst" = "130" ] || { echo "FAIL: interrupt helper exit ($hst)"; fails=1; }
  [ "$(cat "$tmp/int.log.exit" 2>/dev/null)" = "130" ] || { echo "FAIL: interrupt exit file"; fails=1; }
  [ ! -e "$tmp/int.log.wdogmark" ] || { echo "FAIL: interrupt wdog marker not retired"; fails=1; }
  pgid=$(cat "$tmp/int.log.pgid" 2>/dev/null)
  if [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null; then echo "FAIL: interrupt group survived"; fails=1; fi

  # pre-setsid stopped-launcher leg: freeze the launch subshell BEFORE setsid,
  # interrupt the helper, and require the vacuous-group + direct-child branch
  # to CONT+KILL the frozen launcher (bash>=4 only: needs BASHPID)
  if [ -n "${BASHPID:-}" ]; then
    RUN_REVIEWER_PRELAUNCH_STOP_FOR_TEST=1 RUN_REVIEWER_CMD_FOR_TEST="$tmp/slow.sh" RUN_REVIEWER_TIMEOUT_FOR_TEST=120 \
      "$0" "$tmp/prompt.txt" "$tmp/stopped.log" &
    hpid=$!
    sleep 2
    kill -TERM "$hpid" 2>/dev/null
    wait "$hpid"; hst=$?
    [ "$hst" = "130" ] || { echo "FAIL: stopped-launcher helper exit ($hst)"; fails=1; }
    cpid=$(cat "$tmp/stopped.log.pgid" 2>/dev/null)
    if [ -n "$cpid" ] && kill -0 "$cpid" 2>/dev/null; then echo "FAIL: stopped launcher survived"; fails=1; fi
    [ ! -e "$tmp/stopped.log.wdogmark" ] || { echo "FAIL: stopped-launcher wdog marker not retired"; fails=1; }
  fi

  # residue sweep: nothing may still reference the test dir (engines,
  # watchdogs, stray writers — a leak on any leg fails the suite), and no
  # leg may leave its watchdog marker file behind
  sleep 1
  if pgrep -f "$tmp" >/dev/null 2>&1; then echo "FAIL: leaked processes reference $tmp"; fails=1; fi
  marks=$(find "$tmp" -name '*.wdogmark' 2>/dev/null)
  [ -z "$marks" ] || { echo "FAIL: wdog marker files left behind: $marks"; fails=1; }

  # log-quiescence leg: a writer OUTSIDE the reviewer group appends to the log
  # after the engine exits; the helper must keep resampling until the log has
  # stopped growing. Proof of coverage: the size observed AT THE MOMENT the
  # helper returns must equal the final size after the writer finishes — a
  # helper that returns before stability (resample loop removed/broken) sees
  # a smaller size here and fails the leg.
  ( i=0; while [ "$i" -lt 3 ]; do echo tail-write >> "$tmp/quiet.log"; sleep 1; i=$((i+1)); done ) &
  writer=$!
  RUN_REVIEWER_CMD_FOR_TEST="$tmp/fast.sh" RUN_REVIEWER_TIMEOUT_FOR_TEST=60 "$0" "$tmp/prompt.txt" "$tmp/quiet.log"
  [ "$(cat "$tmp/quiet.log.exit" 2>/dev/null)" = "0" ] || { echo "FAIL: quiescence exit"; fails=1; }
  size_at_exit=$(wc -c < "$tmp/quiet.log")
  wait "$writer" 2>/dev/null
  size_final=$(wc -c < "$tmp/quiet.log")
  [ "$size_at_exit" = "$size_final" ] || { echo "FAIL: helper returned before log stabilized ($size_at_exit != $size_final)"; fails=1; }
  # this leg runs after the marker residue sweep above, so it asserts its own
  [ ! -e "$tmp/quiet.log.wdogmark" ] || { echo "FAIL: quiescence wdog marker not retired"; fails=1; }

  # NOT self-testable here (documented residual): the cleanup-failure path
  # (125) needs an unkillable process; the macOS launcher decision itself is
  # covered above by forcing the perl path on any host that has /usr/bin/perl.
  rm -rf "$tmp"
  [ "$fails" = 0 ] && { echo "SELF-TEST PASS"; exit 0; }
  echo "SELF-TEST FAIL"; exit 1
}

[ "${1:-}" = "--self-test" ] && self_test
[ $# -eq 2 ] || { echo "usage: $0 <prompt-file> <attempt-log>" >&2; exit 2; }
PROMPT_FILE=$1; LOG=$2
[ -r "$PROMPT_FILE" ] || { echo "prompt file unreadable: $PROMPT_FILE" >&2; exit 2; }
mkdir -p "$(dirname "$LOG")" || exit 2
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
REPO_ROOT="${AGENT_KIT_REPO_ROOT:-$PROJECT_ROOT}"
export AGENT_KIT_REPO_ROOT="$REPO_ROOT"

# gate.conf is read by sourcing it in an ISOLATED bash subshell (faithful to
# check-reviewer.sh's own sourcing semantics — a sed parse was tried first
# and truncated quoted/expanded values, silently diverging from the probe);
# isolation keeps the conf from mutating this process's environment.
CONF="$PROJECT_ROOT/.codex/hooks/gate.conf"
conf_get() {
  [ -r "$CONF" ] || return 0
  bash -c '. "$1" 2>/dev/null; eval "printf %s \"\${$2-}\""' _ "$CONF" "$1" 2>/dev/null
}
# Precedence: self-test override, then the orchestrator's already-resolved
# REVIEWER_CMD_OVERRIDE tier, then gate.conf. Path A normally resolves to the
# same command approved by check-reviewer; Path B deliberately selects the
# configured fallback without mutating the versioned config.
# RUN_REVIEWER_*_FOR_TEST remain self-test-only.
REVIEWER_CMD="${RUN_REVIEWER_CMD_FOR_TEST:-${REVIEWER_CMD_OVERRIDE:-$(conf_get REVIEWER_CMD)}}"
REVIEWER_CMD="${REVIEWER_CMD:-.codex/hooks/reviewer-claude.sh}"
TIMEOUT="${RUN_REVIEWER_TIMEOUT_FOR_TEST:-$(conf_get REVIEW_TIMEOUT_SECS)}"
TIMEOUT="${TIMEOUT:-1800}"

case "${RUN_REVIEWER_FORCE_LAUNCHER:-auto}" in
  perl)   LAUNCHER=perl ;;
  setsid) LAUNCHER=setsid ;;
  *) if command -v setsid >/dev/null 2>&1; then LAUNCHER=setsid
     elif [ -x /usr/bin/perl ]; then LAUNCHER=perl
     else echo "no process-group launcher (setsid or /usr/bin/perl); refusing" >&2; exit 2; fi ;;
esac
if [ "$LAUNCHER" = perl ] && [ ! -x /usr/bin/perl ]; then echo "forced perl launcher unavailable" >&2; exit 2; fi

PROMPT_CONTENT=$(cat "$PROMPT_FILE")
# Watchdog retire-marker lives beside the attempt log (orchestrator-owned dir,
# no predictable /tmp name), and is observable by tests.
WDOG_MARK="$LOG.wdogmark"
: > "$WDOG_MARK" || exit 2

# Parse REVIEWER_CMD preserving the configured quoting (a bare unquoted
# expansion word-splits and glob-expands, mangling quoted or
# whitespace-bearing arguments). gate.conf is repo-committed, already-sourced
# configuration — eval here adds no authority it does not already have.
eval "set -- $REVIEWER_CMD"
ENGINE=("$@")
[ "${#ENGINE[@]}" -gt 0 ] || { echo "empty REVIEWER_CMD" >&2; exit 2; }

CHILD=""; WDOG=""; PGID=""
group_alive() { [ -n "$PGID" ] && kill -0 -- "-$PGID" 2>/dev/null; }
kill_group() {
  [ -n "$PGID" ] || return 0
  kill -TERM -- "-$PGID" 2>/dev/null
  waited=0
  while group_alive && [ "$waited" -lt "$GRACE_SECS" ]; do sleep 1; waited=$((waited+1)); done
  if group_alive; then kill -KILL -- "-$PGID" 2>/dev/null; sleep 1; fi
  if group_alive; then echo "cleanup failure: process group $PGID survived KILL" >&2; return 1; fi
  return 0
}
retire_wdog() { rm -f "$WDOG_MARK" 2>/dev/null; [ -n "$WDOG" ] && wait "$WDOG" 2>/dev/null; }
fail_closed() { # $1 = code; group already handled by caller
  retire_wdog
  echo "$1" > "$LOG.exit"
  exit "$1"
}

# Interruption handling closes BOTH races around launch:
#   (a) signal before CHILD/PGID exist — the pre-launch trap only defers
#       (INTERRUPTED=1); once state is assigned the full handler runs and the
#       deferred signal is processed, so nothing is orphaned unseen;
#   (b) signal before the child has called setsid() — the child is then still
#       outside its final group, so the handler TERMs the direct child pid AS
#       WELL AS the group; the pid survives exec/setsid, so one of the two
#       always lands.
# Cleanup failure inside the handler is fail-closed 125, never a bare 130.
INTERRUPTED=""
on_signal() {
  INTERRUPTED=1
  # Disarmed state (CHILD and PGID cleared after the reviewer was reaped and
  # its group confirmed dead): both pids may already be reused by unrelated
  # processes, so a late INT/TERM/HUP must not signal anything — clean up and
  # report interrupted.
  if [ -z "$CHILD" ] && [ -z "$PGID" ]; then
    retire_wdog
    echo 130 > "$LOG.exit"
    exit 130
  fi
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null
  if ! kill_group; then retire_wdog; echo 125 > "$LOG.exit"; exit 125; fi
  # kill_group succeeding vacuously (pre-setsid: -$PGID does not exist yet)
  # must not orphan a stopped/delayed launcher holding a pending TERM: verify
  # the DIRECT CHILD pid is gone as well; a stopped process ignores TERM until
  # continued, but KILL always lands.
  if [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null; then
    kill -CONT "$CHILD" 2>/dev/null
    kill -KILL "$CHILD" 2>/dev/null
    sleep 1
    if kill -0 "$CHILD" 2>/dev/null; then retire_wdog; echo 125 > "$LOG.exit"; exit 125; fi
  fi
  retire_wdog
  echo 130 > "$LOG.exit"
  exit 130
}
trap 'INTERRUPTED=1' INT TERM HUP   # defer-only until launch state exists

# RUN_REVIEWER_PRELAUNCH_STOP_FOR_TEST (self-test only): SIGSTOPs the launch
# subshell BEFORE exec/setsid, freezing it pre-group so the vacuous-group +
# direct-child cleanup branch of on_signal can be exercised deterministically.
# Requires BASHPID (bash >= 4); silently inert where absent.
if [ "$LAUNCHER" = setsid ]; then
  ( [ -n "${RUN_REVIEWER_PRELAUNCH_STOP_FOR_TEST:-}" ] && [ -n "${BASHPID:-}" ] && kill -STOP "$BASHPID"; cd "$PROJECT_ROOT" || exit 2; exec setsid "${ENGINE[@]}" "$PROMPT_CONTENT" ) < /dev/null > "$LOG" 2>&1 &
else
  ( [ -n "${RUN_REVIEWER_PRELAUNCH_STOP_FOR_TEST:-}" ] && [ -n "${BASHPID:-}" ] && kill -STOP "$BASHPID"; cd "$PROJECT_ROOT" || exit 2; exec /usr/bin/perl -e 'use POSIX qw(setsid); setsid() != -1 or die "setsid: $!"; exec @ARGV or die "exec: $!"' -- "${ENGINE[@]}" "$PROMPT_CONTENT" ) < /dev/null > "$LOG" 2>&1 &
fi
CHILD=$!
PGID=$CHILD
echo "$PGID" > "$LOG.pgid"
trap on_signal INT TERM HUP
[ -n "$INTERRUPTED" ] && on_signal

# Watchdog beside a blocking wait (completion is detected by reaping the
# child). 1s-increment sleeps + the retire marker mean it exits within ~1s of
# retirement — no orphan outliving the attempt, nothing holding caller FDs.
(
  t=0
  while [ -e "$WDOG_MARK" ] && [ "$t" -lt "$TIMEOUT" ]; do sleep 1; t=$((t+1)); done
  [ -e "$WDOG_MARK" ] || exit 0
  : > "$LOG.timeout"
  # Signal the direct child pid AS WELL AS the group: before the launcher
  # completes setsid() the final group does not exist yet, and a delayed or
  # stopped launcher must not defeat the wall-clock bound (same pre-setsid
  # race the interruption handler covers).
  kill -TERM "$CHILD" 2>/dev/null
  kill -TERM -- "-$PGID" 2>/dev/null
  g=0
  while [ "$g" -lt "$GRACE_SECS" ] && [ -e "$WDOG_MARK" ]; do sleep 1; g=$((g+1)); done
  if [ -e "$WDOG_MARK" ]; then kill -KILL "$CHILD" 2>/dev/null; kill -KILL -- "-$PGID" 2>/dev/null; fi
) < /dev/null > /dev/null 2>&1 &
WDOG=$!

wait "$CHILD"; STATUS=$?

if [ -e "$LOG.timeout" ]; then
  kill_group || fail_closed 125
  retire_wdog
  echo 124 > "$LOG.exit"
  exit 124
fi

retire_wdog
if group_alive; then kill_group || fail_closed 125; fi

# Reviewer reaped, group confirmed dead: disarm the signal handler's kill
# targets so an interrupt arriving during log quiescence cannot signal a
# reused pid or process group.
CHILD=""; PGID=""

# Log quiescence: require two consecutive unchanged intervals (three equal
# samples). One unchanged interval can race a writer with the same cadence as
# the sampler and return immediately before that writer's next append.
prev=$(wc -c < "$LOG"); stable_count=0
i=0
while [ "$i" -lt "$QUIESCE_TRIES" ]; do
  sleep 1
  cur=$(wc -c < "$LOG")
  if [ "$cur" = "$prev" ]; then
    stable_count=$((stable_count+1))
    [ "$stable_count" -ge 2 ] && break
  else
    stable_count=0
  fi
  prev=$cur
  i=$((i+1))
done
[ "$stable_count" -ge 2 ] || { echo "log never quiesced" >&2; fail_closed 125; }

echo "$STATUS" > "$LOG.exit"
exit "$STATUS"
