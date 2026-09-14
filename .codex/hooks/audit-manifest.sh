#!/usr/bin/env bash
# audit-manifest.sh — build a canonical, complete research-audit manifest (P0-b).
#
# Usage: audit-manifest.sh <draft.json> <out-manifest.json>
#        audit-manifest.sh --self-test
#
# draft.json fields (all required):
#   subject      : short slug identifying the audited number
#   claim        : object — the number AND its reference convention (HOW to
#                  re-derive it independently; the auditor re-derives from this,
#                  never by importing the producing script)
#   script       : path to the producing script (content-hashed here)
#   inputs       : array of input paths (each content-hashed here). Ephemeral
#                  out-of-repo / /tmp inputs MUST first be frozen to an IMMUTABLE
#                  snapshot: this helper fails closed on a symlink or a writable
#                  file (not immutable = not reproducible = not auditable).
#   environment  : object — interpreter + versions the re-derivation depends on
#   output       : object — the claimed value(s)
#
# Emits key-sorted canonical JSON to <out-manifest.json> (parent dir created if
# absent) and prints `manifest_digest: <sha256>` — the SHA-256 of the EXACT
# on-disk manifest file bytes, so an auditor that hashes the pinned file gets the
# same digest. Pass this digest to the auditor; the AUDIT_VERDICT must echo it,
# and the scout-clearing join binds to it.
#
# PRECONDITION: python3 (the ONLY hard dependency — no GNU coreutils / sha256sum,
# unlike run-reviewer.sh's shell-only path). This is deliberate: the research-audit
# gate presupposes a Python research host (the auditor re-derives in Python; its
# contract says "Python heredoc is fine"). A host without python3 fails LOUD and
# fail-closed here (`command not found` + `set -e` → nonzero exit), never silently.
set -euo pipefail

if [ "${1:-}" = "--self-test" ]; then
  td=$(mktemp -d "${TMPDIR:-/tmp}/audit_manifest_selftest.XXXXXX") || exit 2
  trap 'rm -rf "$td"' EXIT
  self="${BASH_SOURCE[0]}"
  ok=1
  frozen="$td/frozen.csv"; printf 'a,b\n1,2\n' > "$frozen"; chmod 444 "$frozen"
  good_draft="$td/good.json"
  cat > "$good_draft" <<JSON
{"subject":"t","claim":{"number":"n","reference_convention":"c","tolerance":"1e-6"},
 "script":"$self","inputs":["$frozen"],"environment":{"i":"x"},"output":{"v":1}}
JSON
  # happy path: succeeds AND the printed digest equals sha256 of the written file
  if out=$(bash "$self" "$good_draft" "$td/m.json" 2>/dev/null); then
    d_printed=${out##*: }
    # hash via python3 (already the sole dependency) — no sha256sum, so the
    # self-test runs on a host that lacks GNU coreutils too.
    d_file=$(python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$td/m.json")
    [ "$d_printed" = "$d_file" ] || { echo "FAIL: printed digest != file sha256"; ok=0; }
  else
    echo "FAIL: happy path errored"; ok=0
  fi
  # fail-closed legs — each MUST exit nonzero
  fail_closed() { # <label> <draft>
    if bash "$self" "$2" "$td/x.json" >/dev/null 2>&1; then echo "FAIL: $1 not fail-closed"; ok=0; fi
  }
  miss="$td/missing.csv"  # never created
  writ="$td/writable.csv"; printf 'x\n' > "$writ"; chmod 644 "$writ"
  link="$td/link.csv"; ln -s "$frozen" "$link"
  mk() { sed "s#\"$frozen\"#\"$1\"#" "$good_draft"; }
  mk "$miss" > "$td/d_miss.json"; fail_closed "missing input" "$td/d_miss.json"
  mk "$writ" > "$td/d_writ.json"; fail_closed "writable input" "$td/d_writ.json"
  mk "$link" > "$td/d_link.json"; fail_closed "symlink input" "$td/d_link.json"
  python3 -c "import json,sys; d=json.load(open('$good_draft')); d.pop('output'); json.dump(d,open('$td/d_nofield.json','w'))"
  fail_closed "missing required field" "$td/d_nofield.json"
  python3 -c "import json,sys; d=json.load(open('$good_draft')); d['bogus']=1; json.dump(d,open('$td/d_extra.json','w'))"
  fail_closed "unknown field" "$td/d_extra.json"
  [ "$ok" = 1 ] && { echo "SELF-TEST PASS"; exit 0; } || { echo "SELF-TEST FAIL"; exit 1; }
fi

DRAFT="${1:?usage: audit-manifest.sh <draft.json> <out-manifest.json> | --self-test}"
OUT="${2:?usage: audit-manifest.sh <draft.json> <out-manifest.json> | --self-test}"

python3 - "$DRAFT" "$OUT" <<'PY'
import json, hashlib, os, sys

draft_path, out_path = sys.argv[1], sys.argv[2]
try:
    draft = json.load(open(draft_path))
except Exception as e:
    sys.exit(f"audit-manifest: cannot read draft JSON {draft_path}: {e}")

required = ("subject", "claim", "script", "inputs", "environment", "output")
missing = [k for k in required if k not in draft]
if missing:
    sys.exit(f"audit-manifest: draft missing required fields: {missing} (fail-closed)")
extra = [k for k in draft if k not in required]
if extra:
    sys.exit(f"audit-manifest: draft has unknown top-level field(s) {extra} — the "
             f"manifest schema is exactly {list(required)}; put any free-form detail "
             f"inside claim/environment so a typo can't ride into the pinned manifest "
             f"(fail-closed)")

def _base_checks(p, kind):
    if not isinstance(p, str):
        sys.exit(f"audit-manifest: {kind} path must be a string, got {p!r} (fail-closed)")
    if os.path.islink(p):
        sys.exit(f"audit-manifest: {kind} is a symlink — point at a real immutable "
                 f"file, not a link that can be re-aimed: {p} (fail-closed)")
    if not os.path.isfile(p):
        sys.exit(f"audit-manifest: {kind} is not a regular file: {p} (fail-closed)")

def hash_script(p):
    # The script is content-IDENTIFIED (sha256). Immutability during the audit
    # window is enforced by the auditor's integrity re-hash (a changed script
    # fails the preflight), and a git-tracked script is pinned by its commit — so
    # a writable dev/repo script is allowed here.
    _base_checks(p, "script")
    return {"path": p, "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()}

def hash_input(p):
    # Inputs (DATA) must be IMMUTABLE: ephemeral /tmp / out-of-repo data must be
    # frozen to a read-only snapshot BEFORE audit. A writable input is fail-closed
    # (it could change inside the audit window) — freeze it (chmod a-w) first.
    _base_checks(p, "input")
    if os.access(p, os.W_OK):
        sys.exit(f"audit-manifest: input is writable — freeze it read-only (chmod a-w) "
                 f"so the audited bytes are immutable: {p} (fail-closed)")
    return {"path": p, "sha256": hashlib.sha256(open(p, "rb").read()).hexdigest()}

m = dict(draft)
m["script"] = hash_script(m["script"])
if not isinstance(m["inputs"], list):
    sys.exit("audit-manifest: 'inputs' must be an array of paths (fail-closed)")
m["inputs"] = [hash_input(p) for p in m["inputs"]]

# canonical serialization: key-sorted, compact, stable across runs
canon = json.dumps(m, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
out_dir = os.path.dirname(out_path)
if out_dir:
    os.makedirs(out_dir, exist_ok=True)
with open(out_path, "w") as fh:
    fh.write(canon + "\n")
# digest = SHA-256 of the EXACT on-disk file bytes (so an auditor hashing the
# pinned file reproduces it without any trailing-byte special case).
with open(out_path, "rb") as fh:
    digest = hashlib.sha256(fh.read()).hexdigest()
print("manifest_digest:", digest)
PY
