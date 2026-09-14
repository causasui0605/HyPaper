#!/usr/bin/env bash
# Sterile external Claude reviewer launcher.
#
# A dedicated CLAUDE_CONFIG_DIR prevents the normal developer profile from
# being read or synchronized. Claude --safe-mode additionally disables
# CLAUDE.md, skills, plugins, hooks, MCP, and agents while retaining reviewer
# authentication. All inherited ANTHROPIC_* and CLAUDE_CODE_* variables are
# removed before launch so a developer API key, local gateway, or provider
# selection cannot override the dedicated reviewer identity. Standard transport
# variables such as HTTPS_PROXY and NODE_EXTRA_CA_CERTS remain inherited so the
# reviewer can use the host's required network path. A disposable neutral
# working directory prevents project discovery. The prompt carries only
# plan/patch/REVIEW_POLICY/spec paths;
# AGENTS.md, CLAUDE.md, and agent configuration are forbidden review inputs.
set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
TMP_ROOT="$(CDPATH= cd -- "${TMPDIR:-/tmp}" && pwd -P)"
case "/$SELF/" in
  */.claude/hooks/*) KIT_NAME=agent_policies-claude ;;
  */.codex/hooks/*) KIT_NAME=agent_policies-codex ;;
  *) echo "reviewer wrapper is outside a known kit host directory: $SELF" >&2; exit 2 ;;
esac

sha256_path() {
  python3 - "$1" <<'PY'
import hashlib
from pathlib import Path
import sys

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

verify_review_bundle() {
  local manifest_schema=""
  # Routing-only pre-parse. The selected schema verifier re-reads the manifest
  # with duplicate-key rejection, size limits, digest binding, and exact keys.
  if [ "$3" = maintenance ] && [ -f "$1/.review-input/maintenance-manifest.json" ]; then
    manifest_schema="$(python3 - "$1/.review-input/maintenance-manifest.json" <<'PY'
import json
from pathlib import Path
import sys

try:
    value = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except Exception:
    value = {}
print(value.get("schema", ""))
PY
)"
  fi
  if [ "$manifest_schema" = 3 ]; then
    verify_projection_review_bundle "$@"
    return
  fi
  if [ "$manifest_schema" = 2 ]; then
    verify_composite_review_bundle "$@"
    return
  fi
  python3 - "$1" "$2" "$3" "$4" "$6" "$7" 9<<< "$5" <<'PY'
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys

FIXED_DIRS = {".claude", ".codex", ".agents"}
INSTRUCTION_NAMES = {"AGENTS.md", "CLAUDE.md"}


def fail(message):
    raise ValueError(message)


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


def reject_duplicate_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail(f"review bundle duplicates JSON key: {key}")
        value[key] = item
    return value


def validate_rel(raw):
    if not isinstance(raw, str) or raw in ("", ".") or "\x00" in raw:
        fail("manifest contains an empty or invalid path")
    rel = PurePosixPath(raw)
    if rel.is_absolute() or any(part in ("", ".", "..") for part in rel.parts):
        fail(f"manifest contains an unsafe path: {raw}")
    return rel.as_posix()


def fixed_forbidden(rel):
    parts = PurePosixPath(rel).parts
    return bool(parts) and (
        parts[-1] in INSTRUCTION_NAMES or any(part in FIXED_DIRS for part in parts)
    )


def secret_equivalent(rel):
    return any(
        part == ".env" or part.startswith(".env.")
        for part in PurePosixPath(rel).parts
    )


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path, label, maximum_bytes=None):
    if not path.is_file() or path.is_symlink():
        fail(f"review bundle lacks a regular {label}")
    if maximum_bytes is not None and path.stat().st_size > maximum_bytes:
        fail(f"{label} exceeds the maximum supported size")
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=reject_duplicate_pairs,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")
    if value.get("schema") != 1:
        fail(f"{label} has an unsupported schema")
    return value


def validate_state(value, label):
    exact_object(value, {"sha256", "mode"}, label)
    if (
        not valid_hex(value.get("sha256"), 64)
        or not isinstance(value.get("mode"), int)
        or not 0 <= value["mode"] <= 0o777
    ):
        fail(f"{label} has an invalid file state")
    return {"sha256": value["sha256"], "mode": value["mode"]}


try:
    root = Path(sys.argv[1])
    expected_inventory_digest = sys.argv[2]
    review_mode = sys.argv[3]
    expected_maintenance_digest = sys.argv[4]
    maintenance_project_arg = sys.argv[5]
    expected_kit = sys.argv[6]
    authorization_bytes = os.read(9, 130)
    if (
        not authorization_bytes.endswith(b"\n")
        or b"\n" in authorization_bytes[:-1]
        or len(authorization_bytes) > 129
    ):
        fail("maintenance authorization descriptor is malformed")
    maintenance_authorization = authorization_bytes[:-1].decode("utf-8", "strict")
    if maintenance_authorization and maintenance_authorization in sys.argv:
        fail("maintenance authorization leaked into Python argv")
    if (
        len(expected_inventory_digest) != 64
        or any(char not in "0123456789abcdef" for char in expected_inventory_digest)
    ):
        fail("missing or malformed expected review bundle digest")
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        fail("invalid review bundle root")
    if root.resolve(strict=True) != root.absolute():
        fail("review bundle root is not a canonical physical path")
    if review_mode not in ("standard", "maintenance"):
        fail("unsupported review bundle mode")
    if review_mode == "standard" and (
        expected_maintenance_digest
        or maintenance_authorization
        or maintenance_project_arg
    ):
        fail("standard review must not carry maintenance bindings")
    if review_mode == "maintenance":
        if (
            len(expected_maintenance_digest) != 64
            or any(
                char not in "0123456789abcdef"
                for char in expected_maintenance_digest
            )
        ):
            fail("missing or malformed maintenance manifest digest")
        if not maintenance_authorization:
            fail("maintenance review lacks the raw authorization nonce")
        maintenance_project = Path(maintenance_project_arg)
        if (
            not maintenance_project.is_absolute()
            or not maintenance_project.is_dir()
            or maintenance_project.is_symlink()
            or maintenance_project.resolve(strict=True)
            != maintenance_project.absolute()
        ):
            fail("maintenance project root is not a canonical physical directory")

    review_input = root / ".review-input"
    required = {
        "REVIEW_POLICY.md": root / "REVIEW_POLICY.md",
        "generated patch": review_input / "patch.diff",
        "instruction closure manifest": review_input / "instruction-closure.json",
        "patch path manifest": review_input / "patch-paths.json",
        "omitted-symlink manifest": review_input / "omitted-symlinks.json",
        "bundle inventory": review_input / "bundle-inventory.json",
    }
    for label, path in required.items():
        if not path.is_file() or path.is_symlink():
            fail(f"review bundle lacks a regular {label}")
    if sha256_file(required["bundle inventory"]) != expected_inventory_digest:
        fail("review bundle inventory digest does not match the expected digest")
    if (root / "REVIEW_POLICY.md").stat().st_size == 0:
        fail("review bundle REVIEW_POLICY.md is empty")

    closure = load_json(required["instruction closure manifest"], "instruction closure manifest")
    patch_paths = load_json(required["patch path manifest"], "patch path manifest")
    omitted = load_json(required["omitted-symlink manifest"], "omitted-symlink manifest")
    inventory = load_json(required["bundle inventory"], "bundle inventory")
    maintenance = None
    maintenance_path = review_input / "maintenance-manifest.json"
    if review_mode == "standard":
        if maintenance_path.exists() or maintenance_path.is_symlink():
            fail("standard review bundle contains a maintenance manifest")
    else:
        maintenance = load_json(maintenance_path, "maintenance manifest")
        exact_object(
            maintenance,
            {
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
            },
            "maintenance manifest",
        )
        if sha256_file(maintenance_path) != expected_maintenance_digest:
            fail("maintenance manifest digest does not match the expected digest")
        if maintenance.get("mode") != "maintenance":
            fail("maintenance manifest has an invalid mode")
        for field, length in (
            ("base_commit", 40),
            ("head_commit", 40),
            ("head_tree", 40),
            ("patch_sha256", 64),
            ("authorization_sha256", 64),
            ("upstream_attestation_sha256", 64),
            ("upgrade_attestation_sha256", 64),
            ("instruction_closure_sha256", 64),
            ("patch_paths_sha256", 64),
        ):
            value = maintenance.get(field)
            if (
                not isinstance(value, str)
                or len(value) != length
                or any(char not in "0123456789abcdef" for char in value)
            ):
                fail(f"maintenance manifest has a malformed {field}")
        if maintenance["patch_sha256"] != sha256_file(required["generated patch"]):
            fail("maintenance patch digest mismatch")
        if (
            maintenance["instruction_closure_sha256"]
            != sha256_file(required["instruction closure manifest"])
            or maintenance["patch_paths_sha256"]
            != sha256_file(required["patch path manifest"])
        ):
            fail("maintenance closure or patch-path binding mismatch")
        upstream_attestation = load_json(
            review_input / "upstream-release-attestation.json",
            "upstream release attestation",
            2 * 1024 * 1024,
        )
        upgrade_attestation = load_json(
            review_input / "upgrade-attestation.json",
            "upgrade attestation",
            2 * 1024 * 1024,
        )
        if (
            sha256_file(review_input / "upstream-release-attestation.json")
            != maintenance["upstream_attestation_sha256"]
            or sha256_file(review_input / "upgrade-attestation.json")
            != maintenance["upgrade_attestation_sha256"]
            or upstream_attestation != maintenance.get("upstream")
            or upgrade_attestation != maintenance.get("upgrade")
        ):
            fail("maintenance attestation content or digest mismatch")
        if maintenance["authorization_sha256"] != hashlib.sha256(
            maintenance_authorization.encode("utf-8")
        ).hexdigest():
            fail("maintenance authorization binding mismatch")
        exact_object(
            upstream_attestation,
            {
                "schema",
                "kit",
                "repository",
                "source_revision",
                "source_tree",
                "review",
                "managed_files",
                "managed_file_count",
            },
            "upstream release attestation",
        )
        if upstream_attestation.get("kit") != expected_kit:
            fail("upstream release attestation kit identity mismatch")
        bounded_atom(
            upstream_attestation.get("repository"),
            "upstream release repository identity",
            512,
        )
        source_revision = upstream_attestation.get("source_revision")
        source_tree = upstream_attestation.get("source_tree")
        if not valid_hex(source_revision, 40) or not valid_hex(source_tree, 40):
            fail("upstream release attestation has malformed source binding")
        upstream_review = upstream_attestation.get("review")
        exact_object(
            upstream_review,
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
        bounded_atom(upstream_review.get("milestone"), "upstream release milestone", 64)
        criteria = upstream_review.get("criteria_met", "")
        criteria_parts = criteria.split("/") if isinstance(criteria, str) else []
        if (
            upstream_review.get("verdict") != "approve"
            or upstream_review.get("blocking") != "none"
            or len(criteria_parts) != 2
            or not all(part.isdigit() for part in criteria_parts)
            or criteria_parts[0] != criteria_parts[1]
            or int(criteria_parts[0]) <= 0
            or not valid_hex(upstream_review.get("patch_sha256"), 64)
            or not valid_hex(
                upstream_review.get("archive_manifest_sha256"), 64
            )
        ):
            fail("maintenance manifest lacks an approved upstream release")
        upstream_files = {}
        upstream_entries = upstream_attestation.get("managed_files")
        if not isinstance(upstream_entries, list):
            fail("upstream release managed files are not a list")
        for item in upstream_entries:
            exact_object(
                item,
                {"path", "sha256", "mode"},
                "upstream release managed entry",
            )
            rel = validate_rel(item.get("path"))
            if rel in upstream_files:
                fail(f"upstream release duplicates managed path: {rel}")
            upstream_files[rel] = validate_state(
                {"sha256": item.get("sha256"), "mode": item.get("mode")},
                f"upstream managed path {rel}",
            )
        if (
            not upstream_files
            or upstream_attestation.get("managed_file_count") != len(upstream_files)
        ):
            fail("upstream release managed cardinality mismatch")

        exact_object(
            upgrade_attestation,
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
            "upgrade attestation",
        )
        if (
            upgrade_attestation.get("record_version") != 3
            or upgrade_attestation.get("operation") != "upgrade"
            or upgrade_attestation.get("kit") != expected_kit
            or upgrade_attestation.get("scope") not in ("git-root", "subproject")
        ):
            fail("upgrade attestation target binding mismatch")
        upgrade_source = upgrade_attestation.get("source")
        exact_object(
            upgrade_source,
            {"revision", "tree", "dirty"},
            "upgrade attestation source binding",
        )
        if (
            upgrade_source.get("dirty") is not False
            or upgrade_source.get("revision") != source_revision
            or upgrade_source.get("tree") != source_tree
        ):
            fail("maintenance manifest upgrade source is not clean")
        upgrade_pre = upgrade_attestation.get("pre")
        exact_object(
            upgrade_pre,
            {"head", "tree", "branch", "status_sha256"},
            "upgrade attestation pre-state binding",
        )
        bounded_atom(upgrade_pre.get("branch"), "upgrade attestation pre-branch", 255)
        if (
            not valid_hex(upgrade_pre.get("head"), 40)
            or not valid_hex(upgrade_pre.get("tree"), 40)
            or not valid_hex(upgrade_pre.get("status_sha256"), 64)
        ):
            fail("upgrade attestation has malformed pre-state binding")
        upgrade_post = upgrade_attestation.get("post")
        exact_object(
            upgrade_post,
            {"status_sha256", "managed_projection_sha256"},
            "upgrade attestation post-state binding",
        )
        if (
            not valid_hex(upgrade_post.get("status_sha256"), 64)
            or not valid_hex(upgrade_post.get("managed_projection_sha256"), 64)
        ):
            fail("upgrade attestation has malformed post-state binding")
        if upgrade_attestation.get("destination") != str(maintenance_project):
            fail("maintenance project/upgrade destination binding mismatch")
        upgrade_files = {}
        projection = []
        upgrade_entries = upgrade_attestation.get("managed_paths")
        if not isinstance(upgrade_entries, list):
            fail("upgrade attestation managed paths are not a list")
        for item in upgrade_entries:
            exact_object(
                item,
                {"path", "action", "ownership", "source", "pre", "post"},
                "upgrade attestation managed entry",
            )
            rel = validate_rel(item.get("path"))
            if rel in upgrade_files:
                fail(f"upgrade attestation duplicates managed path: {rel}")
            action = item.get("action")
            upgrade_ownership = item.get("ownership")
            if action not in ("add", "upgrade", "current", "override"):
                fail(f"upgrade attestation has invalid action: {rel}")
            if upgrade_ownership not in ("upstream-identical", "project-override"):
                fail(f"upgrade attestation has invalid ownership: {rel}")
            if (upgrade_ownership == "project-override") != (action == "override"):
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
            if upgrade_ownership == "upstream-identical" and post_state != source_state:
                fail(f"upgrade postimage is not upstream-identical: {rel}")
            upgrade_files[rel] = {
                "ownership": upgrade_ownership,
                "source": source_state,
                "post": post_state,
            }
            projection.append(
                {
                    "path": rel,
                    "ownership": upgrade_ownership,
                    "source": source_state,
                    "post": post_state,
                }
            )
        if (
            set(upgrade_files) != set(upstream_files)
            or upgrade_attestation.get("managed_path_count") != len(upgrade_files)
        ):
            fail("upgrade/upstream managed path sets differ")
        projection_digest = hashlib.sha256(
            json.dumps(
                {"schema": 1, "paths": sorted(projection, key=lambda item: item["path"])},
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        if upgrade_post.get("managed_projection_sha256") != projection_digest:
            fail("upgrade managed projection digest mismatch")
        if subprocess.run(
            ["git", "-C", str(maintenance_project), "status", "--porcelain=v1", "-z"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        ).stdout:
            fail("maintenance project worktree is not clean")
        head = subprocess.check_output(
            ["git", "-C", str(maintenance_project), "rev-parse", "HEAD"],
            stderr=subprocess.STDOUT,
        ).decode().strip()
        tree = subprocess.check_output(
            ["git", "-C", str(maintenance_project), "rev-parse", "HEAD^{tree}"],
            stderr=subprocess.STDOUT,
        ).decode().strip()
        if head != maintenance["head_commit"] or tree != maintenance["head_tree"]:
            fail("maintenance projected head/tree binding mismatch")
        projected_patch = subprocess.check_output(
            [
                "git",
                "-C",
                str(maintenance_project),
                "diff",
                "--no-renames",
                "--binary",
                "--relative",
                f"{maintenance['base_commit']}...{maintenance['head_commit']}",
                "--",
                ".",
            ],
            stderr=subprocess.STDOUT,
        )
        if projected_patch != required["generated patch"].read_bytes():
            fail("maintenance projected patch binding mismatch")

    expected = {}
    for item in inventory.get("files", []):
        rel = validate_rel(item.get("path"))
        if rel in expected:
            fail(f"bundle inventory contains a duplicate path: {rel}")
        expected[rel] = {
            "sha256": item.get("sha256"),
            "mode": item.get("mode"),
        }

    inventory_rel = ".review-input/bundle-inventory.json"
    actual = {}
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        for name in list(dirnames):
            path = Path(directory) / name
            if path.is_symlink():
                fail(f"review bundle contains a symlink directory: {path.relative_to(root)}")
        for name in filenames:
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                fail(f"review bundle contains an unsafe file: {path.relative_to(root)}")
            rel = validate_rel(path.relative_to(root).as_posix())
            if rel == inventory_rel:
                continue
            if fixed_forbidden(rel) or secret_equivalent(rel):
                fail(f"review bundle contains a forbidden path: {rel}")
            mode = stat.S_IMODE(path.stat().st_mode)
            if mode & 0o222:
                fail(f"review bundle contains a writable file: {rel}")
            actual[rel] = {"sha256": sha256_file(path), "mode": mode}

    if set(actual) != set(expected):
        fail("bundle inventory file set does not match the actual bundle")
    for rel, values in actual.items():
        if values != expected[rel]:
            fail(f"bundle inventory digest or mode mismatch: {rel}")

    closure_paths = []
    seen_closure_paths = set()
    for item in closure.get("paths", []):
        rel = validate_rel(item.get("path"))
        if rel in seen_closure_paths:
            fail(f"instruction closure contains a duplicate path: {rel}")
        seen_closure_paths.add(rel)
        kinds = item.get("kinds")
        if not isinstance(kinds, list) or not all(isinstance(kind, str) for kind in kinds):
            fail(f"instruction closure has invalid kinds: {rel}")
        target = root.joinpath(*PurePosixPath(rel).parts)
        if target.exists() or target.is_symlink():
            fail(f"instruction closure path leaked into review bundle: {rel}")
        closure_paths.append((rel, item.get("type")))

    def bound_candidate_state(value, rel):
        if value == {"type": "missing"}:
            return value
        exact_object(
            value,
            {"type", "sha256", "mode"},
            f"maintenance ownership candidate state {rel}",
        )
        if (
            not isinstance(value, dict)
            or value.get("type") != "file"
            or not isinstance(value.get("sha256"), str)
            or len(value["sha256"]) != 64
            or any(char not in "0123456789abcdef" for char in value["sha256"])
            or not isinstance(value.get("mode"), int)
            or not 0 <= value["mode"] <= 0o777
        ):
            fail(f"maintenance ownership has invalid candidate state: {rel}")
        return value

    def project_state(rel):
        path = maintenance_project
        for part in PurePosixPath(rel).parts:
            path = path / part
            if path.is_symlink():
                fail(f"maintenance project path contains a symlink: {rel}")
        if not path.exists():
            return {"type": "missing"}
        if not path.is_file():
            fail(f"maintenance project path is not a regular file: {rel}")
        return {
            "type": "file",
            "sha256": sha256_file(path),
            "mode": stat.S_IMODE(path.stat().st_mode),
        }

    ownership = {}
    if maintenance is not None:
        for item in maintenance.get("ownership", []):
            if not isinstance(item, dict):
                fail("maintenance ownership contains an invalid entry")
            rel = validate_rel(item.get("path"))
            if rel in ownership:
                fail(f"maintenance ownership contains a duplicate path: {rel}")
            classification = item.get("classification")
            if classification not in (
                "upstream-identical",
                "project-owned",
                "instruction-delta",
            ):
                fail(f"maintenance ownership has an invalid class: {rel}")
            expected_ownership_keys = {
                "path",
                "classification",
                "candidate",
                "instruction_kinds",
                "instruction_sources",
            }
            upgrade_entry = upgrade_files.get(rel)
            if upgrade_entry is not None:
                expected_ownership_keys.update(
                    {"upgrade_ownership", "upstream", "upgrade_post"}
                )
            exact_object(
                item,
                expected_ownership_keys,
                f"maintenance ownership entry {rel}",
            )
            if (
                not isinstance(item.get("instruction_kinds"), list)
                or not all(
                    isinstance(kind, str) for kind in item["instruction_kinds"]
                )
                or not isinstance(item.get("instruction_sources"), list)
                or not all(
                    isinstance(source, str) for source in item["instruction_sources"]
                )
            ):
                fail(f"maintenance ownership has invalid instruction evidence: {rel}")
            candidate = bound_candidate_state(item.get("candidate"), rel)
            if project_state(rel) != candidate:
                fail(f"maintenance candidate state drifted after bundling: {rel}")
            if classification == "upstream-identical":
                if upgrade_entry is None:
                    fail(f"maintenance upstream ownership lacks attestation path: {rel}")
                upstream_state = upstream_files[rel]
                upgrade_post_state = upgrade_entry["post"]
                if (
                    candidate.get("type") != "file"
                    or {key: candidate[key] for key in ("sha256", "mode")}
                    != upstream_state
                    or upstream_state != upgrade_post_state
                    or item.get("upgrade_ownership")
                    != upgrade_entry["ownership"]
                    or item.get("upstream") != upstream_state
                    or item.get("upgrade_post") != upgrade_post_state
                ):
                    fail(f"maintenance upstream ownership binding mismatch: {rel}")
            elif upgrade_entry is not None:
                if (
                    upgrade_entry["ownership"] != "project-override"
                    or item.get("upgrade_ownership") != upgrade_entry["ownership"]
                    or item.get("upstream") != upgrade_entry["source"]
                    or item.get("upgrade_post") != upgrade_entry["post"]
                ):
                    fail(f"maintenance project ownership binding mismatch: {rel}")
            ownership[rel] = item

        for rel, entry in upgrade_files.items():
            if entry["ownership"] != "upstream-identical":
                continue
            expected = {"type": "file", **upstream_files[rel]}
            if project_state(rel) != expected:
                fail(f"maintenance managed path drifted from upstream release: {rel}")

    seen_patch_paths = set()
    for raw in patch_paths.get("paths", []):
        rel = validate_rel(raw)
        if rel in seen_patch_paths:
            fail(f"patch path manifest contains a duplicate: {rel}")
        seen_patch_paths.add(rel)
        closure_intersection = False
        for forbidden, kind in closure_paths:
            if rel == forbidden or (kind == "directory" and rel.startswith(forbidden + "/")):
                closure_intersection = True
                break
        if maintenance is None:
            if closure_intersection:
                fail(f"review patch contains an instruction-closure path: {rel}")
        else:
            ownership_entry = ownership.get(rel)
            if ownership_entry is None:
                fail(f"maintenance ownership omits patch path: {rel}")
            classification = ownership_entry["classification"]
            if classification == "instruction-delta" and not closure_intersection:
                fail(f"instruction delta is outside the instruction closure: {rel}")
            if classification == "project-owned" and closure_intersection:
                fail(f"project-owned path intersects the instruction closure: {rel}")
            if classification in ("upstream-identical", "instruction-delta"):
                target = root.joinpath(*PurePosixPath(rel).parts)
                if target.exists() or target.is_symlink():
                    fail(f"inert maintenance path leaked into review bundle: {rel}")

    if maintenance is not None and set(ownership) != seen_patch_paths:
        fail("maintenance ownership path set does not match the patch path set")

    for item in omitted.get("paths", []):
        validate_rel(item.get("path"))
except Exception as error:
    print(f"invalid review bundle: {error}", file=sys.stderr)
    raise SystemExit(2)
PY
}

verify_composite_review_bundle() {
  python3 - "$1" "$2" "$3" "$4" "$6" 9<<< "$5" <<'PY'
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys

FIXED_DIRS = {".claude", ".codex", ".agents"}
INSTRUCTION_NAMES = {"AGENTS.md", "CLAUDE.md"}
KNOWN_KITS = ("agent_policies-claude", "agent_policies-codex")
BASE_OWNERSHIP_KEYS = {
    "path",
    "classification",
    "candidate",
    "instruction_kinds",
    "instruction_sources",
}


def fail(message):
    raise ValueError(message)


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


def reject_duplicate_pairs(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            fail(f"review bundle duplicates JSON key: {key}")
        value[key] = item
    return value


def validate_rel(raw):
    if not isinstance(raw, str) or raw in ("", ".") or "\x00" in raw:
        fail("manifest contains an empty or invalid path")
    rel = PurePosixPath(raw)
    if rel.is_absolute() or any(part in ("", ".", "..") for part in rel.parts):
        fail(f"manifest contains an unsafe path: {raw}")
    return rel.as_posix()


def fixed_forbidden(rel):
    parts = PurePosixPath(rel).parts
    return bool(parts) and (
        parts[-1] in INSTRUCTION_NAMES or any(part in FIXED_DIRS for part in parts)
    )


def secret_equivalent(rel):
    return any(
        part == ".env" or part.startswith(".env.")
        for part in PurePosixPath(rel).parts
    )


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path, label, expected_schema, maximum_bytes=None):
    if not path.is_file() or path.is_symlink():
        fail(f"review bundle lacks a regular {label}")
    if maximum_bytes is not None and path.stat().st_size > maximum_bytes:
        fail(f"{label} exceeds the maximum supported size")
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            object_pairs_hook=reject_duplicate_pairs,
        )
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")
    if not isinstance(value, dict) or value.get("schema") != expected_schema:
        fail(f"{label} has an unsupported schema")
    return value


def validate_state(value, label):
    exact_object(value, {"sha256", "mode"}, label)
    if (
        not valid_hex(value.get("sha256"), 64)
        or not isinstance(value.get("mode"), int)
        or not 0 <= value["mode"] <= 0o777
    ):
        fail(f"{label} has an invalid file state")
    return {"sha256": value["sha256"], "mode": value["mode"]}


def project_state(project, rel):
    path = project
    for part in PurePosixPath(rel).parts:
        path = path / part
        if path.is_symlink():
            fail(f"maintenance project path contains a symlink: {rel}")
    if not path.exists():
        return {"type": "missing"}
    if not path.is_file():
        fail(f"maintenance project path is not a regular file: {rel}")
    return {
        "type": "file",
        "sha256": sha256_file(path),
        "mode": stat.S_IMODE(path.stat().st_mode),
    }


def bound_candidate_state(value, rel):
    if value == {"type": "missing"}:
        return value
    exact_object(
        value,
        {"type", "sha256", "mode"},
        f"maintenance ownership candidate state {rel}",
    )
    if (
        value.get("type") != "file"
        or not valid_hex(value.get("sha256"), 64)
        or not isinstance(value.get("mode"), int)
        or not 0 <= value["mode"] <= 0o777
    ):
        fail(f"maintenance ownership has invalid candidate state: {rel}")
    return value


def validate_upstream(value, kit):
    exact_object(
        value,
        {
            "schema",
            "kit",
            "repository",
            "source_revision",
            "source_tree",
            "review",
            "managed_files",
            "managed_file_count",
        },
        f"{kit} upstream release attestation",
    )
    if value.get("schema") != 1 or value.get("kit") != kit:
        fail(f"{kit} upstream release attestation kit identity mismatch")
    bounded_atom(value.get("repository"), f"{kit} upstream repository", 512)
    revision = value.get("source_revision")
    tree = value.get("source_tree")
    if not valid_hex(revision, 40) or not valid_hex(tree, 40):
        fail(f"{kit} upstream release attestation has malformed source binding")
    review = value.get("review")
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
        f"{kit} upstream release review binding",
    )
    bounded_atom(review.get("milestone"), f"{kit} upstream milestone", 64)
    criteria = review.get("criteria_met", "")
    parts = criteria.split("/") if isinstance(criteria, str) else []
    if (
        review.get("verdict") != "approve"
        or review.get("blocking") != "none"
        or len(parts) != 2
        or not all(part.isdigit() for part in parts)
        or parts[0] != parts[1]
        or int(parts[0]) <= 0
        or not valid_hex(review.get("patch_sha256"), 64)
        or not valid_hex(review.get("archive_manifest_sha256"), 64)
    ):
        fail(f"{kit} upstream release is not independently approved")
    entries = value.get("managed_files")
    if not isinstance(entries, list):
        fail(f"{kit} upstream managed files are not a list")
    files = {}
    for item in entries:
        exact_object(item, {"path", "sha256", "mode"}, f"{kit} upstream entry")
        rel = validate_rel(item.get("path"))
        if rel in files:
            fail(f"{kit} upstream release duplicates managed path: {rel}")
        files[rel] = validate_state(
            {"sha256": item.get("sha256"), "mode": item.get("mode")},
            f"{kit} upstream managed path {rel}",
        )
    if not files or value.get("managed_file_count") != len(files):
        fail(f"{kit} upstream managed cardinality mismatch")
    return revision, tree, files


def validate_upgrade(value, kit, revision, tree, upstream_files, project, base, head):
    exact_object(
        value,
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
        f"{kit} upgrade attestation",
    )
    if (
        value.get("schema") != 1
        or value.get("record_version") != 3
        or value.get("operation") != "upgrade"
        or value.get("kit") != kit
        or value.get("scope") not in ("git-root", "subproject")
        or value.get("destination") != str(project)
    ):
        fail(f"{kit} upgrade attestation target binding mismatch")
    source = value.get("source")
    exact_object(source, {"revision", "tree", "dirty"}, f"{kit} upgrade source")
    if (
        source.get("dirty") is not False
        or source.get("revision") != revision
        or source.get("tree") != tree
    ):
        fail(f"{kit} upgrade source is not the attested clean release")
    pre = value.get("pre")
    exact_object(pre, {"head", "tree", "branch", "status_sha256"}, f"{kit} upgrade pre-state")
    bounded_atom(pre.get("branch"), f"{kit} upgrade pre-branch", 255)
    if (
        not valid_hex(pre.get("head"), 40)
        or not valid_hex(pre.get("tree"), 40)
        or not valid_hex(pre.get("status_sha256"), 64)
    ):
        fail(f"{kit} upgrade has malformed pre-state binding")
    post = value.get("post")
    exact_object(post, {"status_sha256", "managed_projection_sha256"}, f"{kit} upgrade post-state")
    if (
        not valid_hex(post.get("status_sha256"), 64)
        or not valid_hex(post.get("managed_projection_sha256"), 64)
    ):
        fail(f"{kit} upgrade has malformed post-state binding")
    try:
        pre_tree = subprocess.check_output(
            ["git", "-C", str(project), "rev-parse", f"{pre['head']}^{{tree}}"],
            stderr=subprocess.STDOUT,
            text=True,
        ).strip()
    except subprocess.CalledProcessError as error:
        fail(f"{kit} upgrade pre-head is unavailable: {error.output.strip()}")
    if pre_tree != pre["tree"]:
        fail(f"{kit} upgrade pre-head/tree binding mismatch")
    for older, newer, label in (
        (base, pre["head"], "base to upgrade pre-head"),
        (pre["head"], head, "upgrade pre-head to candidate"),
    ):
        if subprocess.run(
            ["git", "-C", str(project), "merge-base", "--is-ancestor", older, newer],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode != 0:
            fail(f"{kit} upgrade ancestry mismatch: {label}")
    entries = value.get("managed_paths")
    if not isinstance(entries, list):
        fail(f"{kit} upgrade managed paths are not a list")
    files = {}
    projection = []
    for item in entries:
        exact_object(
            item,
            {"path", "action", "ownership", "source", "pre", "post"},
            f"{kit} upgrade managed entry",
        )
        rel = validate_rel(item.get("path"))
        if rel in files:
            fail(f"{kit} upgrade duplicates managed path: {rel}")
        action = item.get("action")
        ownership = item.get("ownership")
        if action not in ("add", "upgrade", "current", "override"):
            fail(f"{kit} upgrade has invalid action: {rel}")
        if ownership not in ("upstream-identical", "project-override"):
            fail(f"{kit} upgrade has invalid ownership: {rel}")
        if (ownership == "project-override") != (action == "override"):
            fail(f"{kit} upgrade action/ownership mismatch: {rel}")
        source_state = validate_state(item.get("source"), f"{kit} upgrade source {rel}")
        post_state = validate_state(item.get("post"), f"{kit} upgrade postimage {rel}")
        pre_state = item.get("pre")
        if pre_state is not None:
            pre_state = validate_state(pre_state, f"{kit} upgrade preimage {rel}")
        if (action == "add") != (pre_state is None):
            fail(f"{kit} upgrade action/preimage mismatch: {rel}")
        if rel not in upstream_files or source_state != upstream_files[rel]:
            fail(f"{kit} upgrade/upstream managed source mismatch: {rel}")
        if ownership == "upstream-identical" and post_state != source_state:
            fail(f"{kit} upgrade postimage is not upstream-identical: {rel}")
        files[rel] = {
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
    if set(files) != set(upstream_files) or value.get("managed_path_count") != len(files):
        fail(f"{kit} upgrade/upstream managed path sets differ")
    projection_digest = hashlib.sha256(
        json.dumps(
            {"schema": 1, "paths": sorted(projection, key=lambda item: item["path"])},
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    if post.get("managed_projection_sha256") != projection_digest:
        fail(f"{kit} upgrade managed projection digest mismatch")
    return files


try:
    root = Path(sys.argv[1])
    expected_inventory_digest = sys.argv[2]
    review_mode = sys.argv[3]
    expected_maintenance_digest = sys.argv[4]
    maintenance_project_arg = sys.argv[5]
    authorization_bytes = os.read(9, 130)
    if (
        not authorization_bytes.endswith(b"\n")
        or b"\n" in authorization_bytes[:-1]
        or len(authorization_bytes) > 129
    ):
        fail("maintenance authorization descriptor is malformed")
    authorization = authorization_bytes[:-1].decode("utf-8", "strict")
    if authorization and authorization in sys.argv:
        fail("maintenance authorization leaked into Python argv")
    if review_mode != "maintenance":
        fail("schema-2 review bundle is not in maintenance mode")
    if not valid_hex(expected_inventory_digest, 64):
        fail("missing or malformed expected review bundle digest")
    if not valid_hex(expected_maintenance_digest, 64):
        fail("missing or malformed maintenance manifest digest")
    if not authorization:
        fail("maintenance review lacks the raw authorization nonce")
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        fail("invalid review bundle root")
    if root.resolve(strict=True) != root.absolute():
        fail("review bundle root is not a canonical physical path")
    project = Path(maintenance_project_arg)
    if (
        not project.is_absolute()
        or not project.is_dir()
        or project.is_symlink()
        or project.resolve(strict=True) != project.absolute()
    ):
        fail("maintenance project root is not a canonical physical directory")

    review_input = root / ".review-input"
    required = {
        "REVIEW_POLICY.md": root / "REVIEW_POLICY.md",
        "generated patch": review_input / "patch.diff",
        "instruction closure manifest": review_input / "instruction-closure.json",
        "patch path manifest": review_input / "patch-paths.json",
        "omitted-symlink manifest": review_input / "omitted-symlinks.json",
        "bundle inventory": review_input / "bundle-inventory.json",
        "maintenance manifest": review_input / "maintenance-manifest.json",
    }
    for label, path in required.items():
        if not path.is_file() or path.is_symlink():
            fail(f"review bundle lacks a regular {label}")
    if required["REVIEW_POLICY.md"].stat().st_size == 0:
        fail("review bundle REVIEW_POLICY.md is empty")
    if sha256_file(required["bundle inventory"]) != expected_inventory_digest:
        fail("review bundle inventory digest does not match the expected digest")
    if sha256_file(required["maintenance manifest"]) != expected_maintenance_digest:
        fail("maintenance manifest digest does not match the expected digest")

    closure = load_json(required["instruction closure manifest"], "instruction closure manifest", 1)
    patch_paths = load_json(required["patch path manifest"], "patch path manifest", 1)
    omitted = load_json(required["omitted-symlink manifest"], "omitted-symlink manifest", 1)
    inventory = load_json(required["bundle inventory"], "bundle inventory", 1)
    maintenance = load_json(required["maintenance manifest"], "maintenance manifest", 2)
    exact_object(closure, {"schema", "paths"}, "instruction closure manifest")
    exact_object(patch_paths, {"schema", "paths"}, "patch path manifest")
    exact_object(omitted, {"schema", "paths"}, "omitted-symlink manifest")
    exact_object(inventory, {"schema", "files"}, "bundle inventory")
    exact_object(
        maintenance,
        {
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
        },
        "maintenance manifest",
    )
    if maintenance.get("mode") != "maintenance":
        fail("maintenance manifest has an invalid mode")
    for field, length in (
        ("base_commit", 40),
        ("head_commit", 40),
        ("head_tree", 40),
        ("patch_sha256", 64),
        ("authorization_sha256", 64),
        ("instruction_closure_sha256", 64),
        ("patch_paths_sha256", 64),
    ):
        if not valid_hex(maintenance.get(field), length):
            fail(f"maintenance manifest has a malformed {field}")
    if maintenance["patch_sha256"] != sha256_file(required["generated patch"]):
        fail("maintenance patch digest mismatch")
    if (
        maintenance["instruction_closure_sha256"]
        != sha256_file(required["instruction closure manifest"])
        or maintenance["patch_paths_sha256"]
        != sha256_file(required["patch path manifest"])
    ):
        fail("maintenance closure or patch-path binding mismatch")
    if maintenance["authorization_sha256"] != hashlib.sha256(authorization.encode()).hexdigest():
        fail("maintenance authorization binding mismatch")

    status = subprocess.check_output(
        ["git", "-C", str(project), "status", "--porcelain=v1", "-z"],
        stderr=subprocess.STDOUT,
    )
    if status:
        fail("maintenance project worktree is not clean")
    head = subprocess.check_output(
        ["git", "-C", str(project), "rev-parse", "HEAD"], text=True
    ).strip()
    tree = subprocess.check_output(
        ["git", "-C", str(project), "rev-parse", "HEAD^{tree}"], text=True
    ).strip()
    if head != maintenance["head_commit"] or tree != maintenance["head_tree"]:
        fail("maintenance projected head/tree binding mismatch")
    base = maintenance["base_commit"]
    if subprocess.run(
        ["git", "-C", str(project), "merge-base", "--is-ancestor", base, head],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode != 0:
        fail("maintenance base is not an ancestor of the candidate")
    merges = subprocess.check_output(
        ["git", "-C", str(project), "rev-list", "--merges", f"{base}..{head}"],
        text=True,
    ).strip()
    if merges:
        fail("maintenance candidate contains a merge commit")
    projected_patch = subprocess.check_output(
        [
            "git",
            "-C",
            str(project),
            "diff",
            "--no-renames",
            "--binary",
            "--relative",
            f"{base}...{head}",
            "--",
            ".",
        ],
        stderr=subprocess.STDOUT,
    )
    if projected_patch != required["generated patch"].read_bytes():
        fail("maintenance projected patch binding mismatch")

    sets = maintenance.get("attestation_sets")
    if not isinstance(sets, list) or len(sets) != len(KNOWN_KITS):
        fail("composite maintenance requires exactly two attestation sets")
    kits = [item.get("kit") if isinstance(item, dict) else None for item in sets]
    if kits != list(KNOWN_KITS) or len(set(kits)) != len(KNOWN_KITS):
        fail("composite attestation sets are missing, duplicate, unknown, or unsorted")
    set_files = {}
    all_upgrade_files = {}
    for item in sets:
        exact_object(
            item,
            {
                "kit",
                "upstream_attestation_sha256",
                "upgrade_attestation_sha256",
                "upstream",
                "upgrade",
            },
            "composite attestation set",
        )
        kit = item["kit"]
        if not valid_hex(item.get("upstream_attestation_sha256"), 64) or not valid_hex(
            item.get("upgrade_attestation_sha256"), 64
        ):
            fail(f"{kit} attestation set has a malformed digest")
        artifact_root = review_input / "attestations" / kit
        upstream_path = artifact_root / "upstream-release-attestation.json"
        upgrade_path = artifact_root / "upgrade-attestation.json"
        upstream = load_json(upstream_path, f"{kit} upstream release attestation", 1, 2 * 1024 * 1024)
        upgrade = load_json(upgrade_path, f"{kit} upgrade attestation", 1, 2 * 1024 * 1024)
        if (
            sha256_file(upstream_path) != item["upstream_attestation_sha256"]
            or sha256_file(upgrade_path) != item["upgrade_attestation_sha256"]
            or upstream != item.get("upstream")
            or upgrade != item.get("upgrade")
        ):
            fail(f"{kit} attestation artifact content or digest mismatch")
        revision, source_tree, upstream_files = validate_upstream(upstream, kit)
        upgrade_files = validate_upgrade(
            upgrade,
            kit,
            revision,
            source_tree,
            upstream_files,
            project,
            base,
            head,
        )
        set_files[kit] = upstream_files
        all_upgrade_files[kit] = upgrade_files

    reconstructed = {}
    for kit in KNOWN_KITS:
        for rel, entry in all_upgrade_files[kit].items():
            reconstructed.setdefault(rel, []).append(
                {
                    "kit": kit,
                    "ownership": entry["ownership"],
                    "source": entry["source"],
                    "post": entry["post"],
                }
            )
    for rel in reconstructed:
        reconstructed[rel].sort(key=lambda item: item["kit"])

    union_entries = maintenance.get("managed_union")
    if not isinstance(union_entries, list):
        fail("composite managed union is not a list")
    union = {}
    union_order = []
    for item in union_entries:
        exact_object(item, {"path", "bindings"}, "composite managed union entry")
        rel = validate_rel(item.get("path"))
        if rel in union:
            fail(f"composite managed union duplicates path: {rel}")
        bindings = item.get("bindings")
        if not isinstance(bindings, list) or not bindings:
            fail(f"composite managed union lacks bindings: {rel}")
        checked = []
        binding_kits = []
        for binding in bindings:
            exact_object(
                binding,
                {"kit", "ownership", "source", "post"},
                f"composite managed binding {rel}",
            )
            kit = binding.get("kit")
            if kit not in KNOWN_KITS:
                fail(f"composite managed binding has unknown kit: {rel}")
            ownership = binding.get("ownership")
            if ownership not in ("upstream-identical", "project-override"):
                fail(f"composite managed binding has invalid ownership: {rel}")
            checked.append(
                {
                    "kit": kit,
                    "ownership": ownership,
                    "source": validate_state(binding.get("source"), f"{kit} union source {rel}"),
                    "post": validate_state(binding.get("post"), f"{kit} union post {rel}"),
                }
            )
            binding_kits.append(kit)
        if binding_kits != sorted(binding_kits) or len(binding_kits) != len(set(binding_kits)):
            fail(f"composite managed bindings are duplicate or unsorted: {rel}")
        union[rel] = checked
        union_order.append(rel)
    if union_order != sorted(union_order) or union != reconstructed:
        fail("composite managed union omits, adds, reorders, or tampers with attested paths")
    for rel, bindings in union.items():
        ownerships = {item["ownership"] for item in bindings}
        if len(ownerships) != 1:
            fail(f"composite managed path mixes ownership classes: {rel}")
        if ownerships == {"upstream-identical"}:
            states = {(item["source"]["sha256"], item["source"]["mode"]) for item in bindings}
            post_states = {(item["post"]["sha256"], item["post"]["mode"]) for item in bindings}
            if len(states) != 1 or states != post_states:
                fail(f"shared upstream-identical state is incompatible: {rel}")
            expected = {"type": "file", **bindings[0]["source"]}
            if project_state(project, rel) != expected:
                fail(f"maintenance managed path drifted from upstream release: {rel}")

    closure_paths = []
    closure_seen = set()
    closure_items = closure.get("paths")
    if not isinstance(closure_items, list):
        fail("instruction closure paths are not a list")
    for item in closure_items:
        if not isinstance(item, dict):
            fail("instruction closure contains an invalid entry")
        rel = validate_rel(item.get("path"))
        if rel in closure_seen:
            fail(f"instruction closure contains a duplicate path: {rel}")
        closure_seen.add(rel)
        kinds = item.get("kinds")
        if not isinstance(kinds, list) or not all(isinstance(kind, str) for kind in kinds):
            fail(f"instruction closure has invalid kinds: {rel}")
        target = root.joinpath(*PurePosixPath(rel).parts)
        if target.exists() or target.is_symlink():
            fail(f"instruction closure path leaked into review bundle: {rel}")
        closure_paths.append((rel, item.get("type")))

    patch_list = patch_paths.get("paths")
    if not isinstance(patch_list, list):
        fail("patch path manifest paths are not a list")
    seen_patch_paths = set()
    patch_order = []
    for raw in patch_list:
        rel = validate_rel(raw)
        if rel in seen_patch_paths:
            fail(f"patch path manifest contains a duplicate: {rel}")
        seen_patch_paths.add(rel)
        patch_order.append(rel)
    if patch_order != sorted(patch_order):
        fail("patch path manifest is not sorted")

    ownership_entries = maintenance.get("ownership")
    if not isinstance(ownership_entries, list):
        fail("maintenance ownership is not a list")
    ownership = {}
    ownership_order = []
    for item in ownership_entries:
        if not isinstance(item, dict):
            fail("maintenance ownership contains an invalid entry")
        rel = validate_rel(item.get("path"))
        if rel in ownership:
            fail(f"maintenance ownership contains a duplicate path: {rel}")
        expected_keys = set(BASE_OWNERSHIP_KEYS)
        bindings = union.get(rel)
        if bindings is not None:
            expected_keys.add("managed_bindings")
        exact_object(item, expected_keys, f"maintenance ownership entry {rel}")
        classification = item.get("classification")
        if classification not in ("upstream-identical", "project-owned", "instruction-delta"):
            fail(f"maintenance ownership has an invalid class: {rel}")
        kinds = item.get("instruction_kinds")
        sources = item.get("instruction_sources")
        if (
            not isinstance(kinds, list)
            or not all(isinstance(value, str) for value in kinds)
            or not isinstance(sources, list)
            or not all(isinstance(value, str) for value in sources)
        ):
            fail(f"maintenance ownership has invalid instruction evidence: {rel}")
        candidate = bound_candidate_state(item.get("candidate"), rel)
        if project_state(project, rel) != candidate:
            fail(f"maintenance candidate state drifted after bundling: {rel}")
        if bindings is not None:
            managed_bindings = item.get("managed_bindings")
            if not isinstance(managed_bindings, list):
                fail(f"maintenance ownership lacks managed bindings: {rel}")
            checked = []
            binding_kits = []
            for binding in managed_bindings:
                exact_object(
                    binding,
                    {"kit", "upgrade_ownership", "upstream", "upgrade_post"},
                    f"maintenance ownership managed binding {rel}",
                )
                kit = binding.get("kit")
                checked.append(
                    {
                        "kit": kit,
                        "upgrade_ownership": binding.get("upgrade_ownership"),
                        "upstream": validate_state(binding.get("upstream"), f"{kit} ownership upstream {rel}"),
                        "upgrade_post": validate_state(binding.get("upgrade_post"), f"{kit} ownership post {rel}"),
                    }
                )
                binding_kits.append(kit)
            expected_bindings = [
                {
                    "kit": binding["kit"],
                    "upgrade_ownership": binding["ownership"],
                    "upstream": binding["source"],
                    "upgrade_post": binding["post"],
                }
                for binding in bindings
            ]
            if (
                binding_kits != sorted(binding_kits)
                or len(binding_kits) != len(set(binding_kits))
                or checked != expected_bindings
            ):
                fail(f"maintenance ownership managed bindings mismatch: {rel}")
            union_ownership = {binding["ownership"] for binding in bindings}
            if union_ownership == {"upstream-identical"}:
                if classification != "upstream-identical":
                    fail(f"maintenance upstream ownership class mismatch: {rel}")
                expected = {"type": "file", **bindings[0]["source"]}
                if candidate != expected:
                    fail(f"maintenance upstream ownership binding mismatch: {rel}")
            elif union_ownership == {"project-override"}:
                if classification not in ("project-owned", "instruction-delta"):
                    fail(f"maintenance project override class mismatch: {rel}")
            else:
                fail(f"maintenance managed path mixes ownership classes: {rel}")
        elif classification == "upstream-identical":
            fail(f"maintenance upstream ownership lacks attestation path: {rel}")
        ownership[rel] = item
        ownership_order.append(rel)
    if ownership_order != sorted(ownership_order) or set(ownership) != seen_patch_paths:
        fail("maintenance ownership path set does not exactly match the patch path set")

    for rel in patch_order:
        closure_intersection = any(
            rel == forbidden or (kind == "directory" and rel.startswith(forbidden + "/"))
            for forbidden, kind in closure_paths
        )
        classification = ownership[rel]["classification"]
        if classification == "instruction-delta" and not closure_intersection:
            fail(f"instruction delta is outside the instruction closure: {rel}")
        if classification == "project-owned" and closure_intersection:
            fail(f"project-owned path intersects the instruction closure: {rel}")
        if classification in ("upstream-identical", "instruction-delta"):
            target = root.joinpath(*PurePosixPath(rel).parts)
            if target.exists() or target.is_symlink():
                fail(f"inert maintenance path leaked into review bundle: {rel}")

    omitted_items = omitted.get("paths")
    if not isinstance(omitted_items, list):
        fail("omitted-symlink paths are not a list")
    for item in omitted_items:
        if not isinstance(item, dict):
            fail("omitted-symlink manifest contains an invalid entry")
        validate_rel(item.get("path"))

    expected = {}
    inventory_items = inventory.get("files")
    if not isinstance(inventory_items, list):
        fail("bundle inventory files are not a list")
    inventory_order = []
    for item in inventory_items:
        exact_object(item, {"path", "sha256", "mode"}, "bundle inventory entry")
        rel = validate_rel(item.get("path"))
        if rel in expected:
            fail(f"bundle inventory contains a duplicate path: {rel}")
        state = validate_state(
            {"sha256": item.get("sha256"), "mode": item.get("mode")},
            f"bundle inventory path {rel}",
        )
        expected[rel] = state
        inventory_order.append(rel)
    if inventory_order != sorted(inventory_order):
        fail("bundle inventory is not sorted")

    inventory_rel = ".review-input/bundle-inventory.json"
    actual = {}
    for directory, dirnames, filenames in os.walk(root, followlinks=False):
        for name in list(dirnames):
            path = Path(directory) / name
            if path.is_symlink():
                fail(f"review bundle contains a symlink directory: {path.relative_to(root)}")
        for name in filenames:
            path = Path(directory) / name
            if path.is_symlink() or not path.is_file():
                fail(f"review bundle contains an unsafe file: {path.relative_to(root)}")
            rel = validate_rel(path.relative_to(root).as_posix())
            if rel == inventory_rel:
                continue
            if fixed_forbidden(rel) or secret_equivalent(rel):
                fail(f"review bundle contains a forbidden path: {rel}")
            mode = stat.S_IMODE(path.stat().st_mode)
            if mode & 0o222:
                fail(f"review bundle contains a writable file: {rel}")
            actual[rel] = {"sha256": sha256_file(path), "mode": mode}
    if set(actual) != set(expected):
        fail("bundle inventory file set does not match the actual bundle")
    for rel, values in actual.items():
        if values != expected[rel]:
            fail(f"bundle inventory digest or mode mismatch: {rel}")
except Exception as error:
    print(f"invalid review bundle: {error}", file=sys.stderr)
    raise SystemExit(2)
PY
}

verify_projection_review_bundle() {
  local compat compat_output compat_digest compat_manifest_digest
  [ "${AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION:-}" = path-neutral-v1 ] || {
    echo "path-neutral maintenance manifest lacks explicit wrapper opt-in" >&2
    return 2
  }
  compat="$(mktemp -d "$TMP_ROOT/agent-kit-maintenance-prelaunch.XXXXXX")"
  compat="$(cd "$compat" && pwd -P)"
  compat_output="$(python3 - "$1" "$2" "$4" "$6" \
    "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR:-}" \
    "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST:-}" "$compat" \
    9<<< "$5" <<'PY'
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys


def fail(message):
    raise ValueError(message)


def reject_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail(f"prelaunch input duplicates JSON key: {key}")
        result[key] = value
    return result


def load_json(path, label, max_size=2 * 1024 * 1024):
    if path.is_symlink() or not path.is_file():
        fail(f"{label} is not a regular non-symlink file")
    if path.stat().st_size > max_size:
        fail(f"{label} exceeds the maximum supported size")
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_pairs)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"cannot read {label}: {error}")


def exact(value, keys, label):
    if not isinstance(value, dict) or set(value) != set(keys):
        fail(f"{label} has unknown or missing fields")
    return value


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def valid_hex(value, length):
    return isinstance(value, str) and len(value) == length and all(c in "0123456789abcdef" for c in value)


def relpath(value):
    if not isinstance(value, str) or not value or "\x00" in value:
        fail("prelaunch input contains an invalid relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail(f"prelaunch input contains an unsafe path: {value}")
    return path.as_posix()


root = Path(sys.argv[1])
expected_inventory_digest = sys.argv[2]
expected_manifest_digest = sys.argv[3]
project_arg = sys.argv[4]
sidecar_arg = sys.argv[5]
expected_sidecar_digest = sys.argv[6]
compat = Path(sys.argv[7])
authorization_bytes = os.read(9, 130)
if not authorization_bytes.endswith(b"\n") or b"\n" in authorization_bytes[:-1]:
    fail("maintenance authorization descriptor is malformed")
authorization = authorization_bytes[:-1].decode("utf-8", "strict")
if not authorization:
    fail("maintenance authorization is missing")
if not root.is_absolute() or root.is_symlink() or not root.is_dir() or root.resolve() != root.absolute():
    fail("review bundle root is not a canonical physical directory")
review_input = root / ".review-input"
inventory_path = review_input / "bundle-inventory.json"
manifest_path = review_input / "maintenance-manifest.json"
if not valid_hex(expected_inventory_digest, 64) or sha(inventory_path) != expected_inventory_digest:
    fail("review bundle inventory digest mismatch")
if not valid_hex(expected_manifest_digest, 64) or sha(manifest_path) != expected_manifest_digest:
    fail("maintenance manifest digest mismatch")
inventory = load_json(inventory_path, "bundle inventory")
exact(inventory, {"schema", "files"}, "bundle inventory")
if inventory.get("schema") != 1 or not isinstance(inventory.get("files"), list):
    fail("bundle inventory schema is invalid")
expected_files = {}
for item in inventory["files"]:
    exact(item, {"path", "sha256", "mode"}, "bundle inventory entry")
    rel = relpath(item.get("path"))
    if rel in expected_files or not valid_hex(item.get("sha256"), 64) or not isinstance(item.get("mode"), int):
        fail("bundle inventory entry is invalid or duplicated")
    expected_files[rel] = {"sha256": item["sha256"], "mode": item["mode"]}
actual_files = {}
for directory, dirs, files in os.walk(root, followlinks=False):
    for name in dirs:
        if (Path(directory) / name).is_symlink():
            fail("review bundle contains a symlink directory")
    for name in files:
        path = Path(directory) / name
        rel = relpath(path.relative_to(root).as_posix())
        if rel == ".review-input/bundle-inventory.json":
            continue
        if path.is_symlink() or not path.is_file():
            fail(f"review bundle contains an unsafe file: {rel}")
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o222:
            fail(f"review bundle contains a writable file: {rel}")
        actual_files[rel] = {"sha256": sha(path), "mode": mode}
if actual_files != expected_files:
    fail("bundle inventory file set, digest, or mode mismatch")

manifest = load_json(manifest_path, "path-neutral maintenance manifest")
manifest_keys = {
    "schema", "mode", "projection_mode", "base_commit", "head_commit", "head_tree",
    "patch_sha256", "authorization_sha256", "prelaunch_sidecar_sha256",
    "instruction_closure_sha256", "patch_paths_sha256", "projection_sha256",
    "attestation_projections", "managed_union", "ownership",
}
exact(manifest, manifest_keys, "path-neutral maintenance manifest")
if manifest.get("schema") != 3 or manifest.get("mode") != "maintenance" or manifest.get("projection_mode") != "path-neutral-v1":
    fail("path-neutral maintenance manifest routing fields are invalid")
if manifest.get("authorization_sha256") != hashlib.sha256(authorization.encode()).hexdigest():
    fail("maintenance authorization binding mismatch")
sidecar = Path(sidecar_arg)
if not sidecar.is_absolute() or sidecar.is_symlink() or not sidecar.is_file():
    fail("prelaunch sidecar is not an absolute regular non-symlink file")
if sidecar.resolve() != sidecar.absolute() or root == sidecar or root in sidecar.parents:
    fail("prelaunch sidecar is not a canonical bundle-external file")
if not valid_hex(expected_sidecar_digest, 64) or sha(sidecar) != expected_sidecar_digest or manifest.get("prelaunch_sidecar_sha256") != expected_sidecar_digest:
    fail("prelaunch sidecar digest binding mismatch")
side = load_json(sidecar, "prelaunch sidecar")
side_keys = {
    "schema", "mode", "physical_project_root", "base_commit", "head_commit", "head_tree",
    "patch_sha256", "authorization_sha256", "projection_sha256", "attestation_sets",
}
exact(side, side_keys, "prelaunch sidecar")
if side.get("schema") != 1 or side.get("mode") != "path-neutral-maintenance-prelaunch":
    fail("prelaunch sidecar routing fields are invalid")
project = Path(project_arg)
if not project.is_absolute() or project.is_symlink() or not project.is_dir() or project.resolve() != project.absolute():
    fail("maintenance project root is not a canonical physical directory")
if side.get("physical_project_root") != str(project):
    fail("prelaunch sidecar physical destination mismatch")
for field in ("base_commit", "head_commit", "head_tree", "patch_sha256", "authorization_sha256", "projection_sha256"):
    if side.get(field) != manifest.get(field):
        fail(f"prelaunch sidecar/manifest {field} mismatch")
if not isinstance(side.get("attestation_sets"), list) or len(side["attestation_sets"]) not in (1, 2):
    fail("prelaunch sidecar has unsupported attestation cardinality")
if len(side["attestation_sets"]) == 2 and [item.get("kit") for item in side["attestation_sets"]] != ["agent_policies-claude", "agent_policies-codex"]:
    fail("prelaunch sidecar composite kits are missing, duplicate, or unsorted")

originals = []
derived = []
forbidden_literals = {str(project)}
home = os.environ.get("HOME", "")
if home:
    forbidden_literals.add(str(Path(home)))
for item in side["attestation_sets"]:
    exact(item, {"kit", "upstream_attestation_id", "upgrade_attestation_id", "upstream_artifact", "upgrade_artifact"}, "prelaunch attestation set")
    kit = item.get("kit")
    if kit not in ("agent_policies-claude", "agent_policies-codex"):
        fail("prelaunch attestation set has unknown kit")
    loaded = {}
    for name in ("upstream_artifact", "upgrade_artifact"):
        descriptor = exact(item.get(name), {"path", "sha256"}, f"{kit} {name}")
        path = Path(descriptor.get("path", ""))
        digest = descriptor.get("sha256")
        if not path.is_absolute() or path.is_symlink() or not path.is_file() or path.resolve() != path.absolute():
            fail(f"{kit} original artifact path is invalid")
        if not valid_hex(digest, 64) or sha(path) != digest:
            fail(f"{kit} original artifact digest mismatch")
        forbidden_literals.add(str(path))
        forbidden_literals.add(str(path.parent))
        loaded[name] = (path, load_json(path, f"{kit} {name}"), digest)
    upstream = loaded["upstream_artifact"][1]
    upgrade = loaded["upgrade_artifact"][1]
    exact(upstream, {"schema", "kit", "repository", "source_revision", "source_tree", "review", "managed_files", "managed_file_count"}, f"{kit} upstream attestation")
    exact(upgrade, {"schema", "record_version", "operation", "kit", "destination", "scope", "source", "pre", "post", "managed_path_count", "managed_paths"}, f"{kit} upgrade attestation")
    if upstream.get("schema") != 1 or upgrade.get("schema") != 1 or upstream.get("kit") != kit or upgrade.get("kit") != kit:
        fail(f"{kit} original artifact kit/schema pairing mismatch")
    if upgrade.get("record_version") != 3 or upgrade.get("operation") != "upgrade" or upgrade.get("destination") != str(project):
        fail(f"{kit} original upgrade destination/version binding mismatch")
    managed = upgrade.get("managed_paths")
    if not isinstance(managed, list):
        fail(f"{kit} original managed inventory is invalid")
    inventory_digest = hashlib.sha256(json.dumps({"schema": 1, "managed_paths": sorted(managed, key=lambda value: value.get("path", ""))}, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    projected_paths = []
    for entry in managed:
        exact(entry, {"path", "action", "ownership", "source", "pre", "post"}, f"{kit} original managed entry")
        projected_paths.append({"path": entry["path"], "ownership": entry["ownership"], "source": entry["source"], "post": entry["post"]})
    derived.append({
        "kit": kit,
        "upstream_attestation_id": item["upstream_attestation_id"],
        "upgrade_attestation_id": item["upgrade_attestation_id"],
        "repository": upstream["repository"],
        "source_revision": upstream["source_revision"],
        "source_tree": upstream["source_tree"],
        "upstream_review": upstream["review"],
        "upstream_attestation_sha256": loaded["upstream_artifact"][2],
        "upgrade_attestation_sha256": loaded["upgrade_artifact"][2],
        "upgrade_scope": upgrade["scope"],
        "upgrade_pre": upgrade["pre"],
        "upgrade_post": upgrade["post"],
        "record_inventory_sha256": inventory_digest,
        "managed_path_count": upgrade["managed_path_count"],
        "managed_paths": sorted(projected_paths, key=lambda value: value["path"]),
    })
    originals.append((kit, loaded["upstream_artifact"][0], loaded["upgrade_artifact"][0], upstream, upgrade))
derived.sort(key=lambda value: value["kit"])
forbidden_bytes = sorted(
    {value.encode("utf-8") for value in forbidden_literals if value},
    key=len,
    reverse=True,
)
for directory, _, files in os.walk(root):
    for name in files:
        path = Path(directory) / name
        if any(value in path.read_bytes() for value in forbidden_bytes):
            fail(
                "path-neutral review bundle contains a physical "
                f"checkout/home/artifact path: {path.relative_to(root)}"
            )
projection_value = {"schema": 1, "attestation_projections": derived}
projection_digest = hashlib.sha256(json.dumps(projection_value, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
if manifest.get("attestation_projections") != derived or manifest.get("projection_sha256") != projection_digest:
    fail("path-neutral attestation projection mismatch")

shutil.copytree(root, compat, dirs_exist_ok=True)
compat_manifest = compat / ".review-input/maintenance-manifest.json"
compat_manifest.chmod(0o600)
if len(originals) == 1:
    _, up_path, upgrade_path, upstream, upgrade = originals[0]
    legacy = {
        "schema": 1, "mode": "maintenance", "base_commit": manifest["base_commit"],
        "head_commit": manifest["head_commit"], "head_tree": manifest["head_tree"],
        "patch_sha256": manifest["patch_sha256"], "authorization_sha256": manifest["authorization_sha256"],
        "upstream_attestation_sha256": sha(up_path), "upgrade_attestation_sha256": sha(upgrade_path),
        "instruction_closure_sha256": manifest["instruction_closure_sha256"],
        "patch_paths_sha256": manifest["patch_paths_sha256"], "upstream": upstream,
        "upgrade": upgrade, "ownership": manifest["ownership"],
    }
    shutil.copy2(up_path, compat / ".review-input/upstream-release-attestation.json")
    shutil.copy2(upgrade_path, compat / ".review-input/upgrade-attestation.json")
else:
    sets = []
    for kit, up_path, upgrade_path, upstream, upgrade in originals:
        sets.append({"kit": kit, "upstream_attestation_sha256": sha(up_path), "upgrade_attestation_sha256": sha(upgrade_path), "upstream": upstream, "upgrade": upgrade})
        target = compat / ".review-input/attestations" / kit
        target.mkdir(parents=True)
        shutil.copy2(up_path, target / "upstream-release-attestation.json")
        shutil.copy2(upgrade_path, target / "upgrade-attestation.json")
    legacy = {
        "schema": 2, "mode": "maintenance", "base_commit": manifest["base_commit"],
        "head_commit": manifest["head_commit"], "head_tree": manifest["head_tree"],
        "patch_sha256": manifest["patch_sha256"], "authorization_sha256": manifest["authorization_sha256"],
        "instruction_closure_sha256": manifest["instruction_closure_sha256"],
        "patch_paths_sha256": manifest["patch_paths_sha256"], "attestation_sets": sets,
        "managed_union": manifest["managed_union"], "ownership": manifest["ownership"],
    }
compat_manifest.write_text(json.dumps(legacy, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
compat_inventory = compat / ".review-input/bundle-inventory.json"
compat_inventory.chmod(0o600)
entries = []
for directory, _, files in os.walk(compat):
    for name in files:
        path = Path(directory) / name
        if path == compat_inventory:
            continue
        path.chmod(stat.S_IMODE(path.stat().st_mode) & ~0o222)
        entries.append({"path": path.relative_to(compat).as_posix(), "sha256": sha(path), "mode": stat.S_IMODE(path.stat().st_mode)})
compat_inventory.write_text(json.dumps({"schema": 1, "files": sorted(entries, key=lambda value: value["path"])}, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
compat_inventory.chmod(0o400)
print("inventory=" + sha(compat_inventory))
print("maintenance=" + sha(compat_manifest))
PY
)" || { rm -rf -- "$compat"; return 2; }
  compat_digest="$(printf '%s\n' "$compat_output" | sed -n 's/^inventory=//p')"
  compat_manifest_digest="$(printf '%s\n' "$compat_output" | sed -n 's/^maintenance=//p')"
  if ! verify_review_bundle "$compat" "$compat_digest" "$3" "$compat_manifest_digest" "$5" "$6" "$7"; then
    rm -rf -- "$compat"
    return 2
  fi
  rm -rf -- "$compat"
}

assert_review_cwd() {
  local output="$1" expected_parent="$2" forbidden_repo="$3"
  local actual_cwd actual_parent cwd_count
  cwd_count="$(grep -c '^cwd=' "$output" || :)"
  [ "$cwd_count" -eq 1 ] ||
    { echo "FAIL: expected exactly one reviewer cwd, found $cwd_count" >&2; return 1; }
  actual_cwd="$(sed -n 's/^cwd=//p' "$output")"
  case "$(basename "$actual_cwd")" in
    agent-kit-claude-review.*) ;;
    *) echo "FAIL: reviewer cwd is not a disposable Claude review directory: $actual_cwd" >&2; return 1 ;;
  esac
  actual_parent="$(CDPATH= cd -- "$(dirname "$actual_cwd")" && pwd -P)"
  [ "$actual_parent" = "$(CDPATH= cd -- "$expected_parent" && pwd -P)" ] ||
    { echo "FAIL: reviewer cwd escaped the expected temporary parent" >&2; return 1; }
  [ "$actual_cwd" != "$forbidden_repo" ] ||
    { echo "FAIL: reviewer ran from the project directory" >&2; return 1; }
}

self_test() {
  local tmp fake out clean_out review_home repo bad review_tmp digest
  local missing tampered leaked leaked_digest intersection intersection_digest
  local maintenance maintenance_digest maintenance_inventory_digest maintenance_nonce
  local maintenance_project maintenance_crosscheck maintenance_unknown
  local maintenance_crosscheck_digest maintenance_crosscheck_inventory_digest
  local maintenance_unknown_digest maintenance_unknown_inventory_digest
  local projection projection_sidecar projection_digest projection_inventory_digest
  local composite_parent composite_project composite_success composite_nonce
  local composite_digest composite_inventory_digest variant
  local composite_projection composite_projection_sidecar
  local composite_projection_originals
  local composite_projection_digest composite_projection_inventory_digest
  local composite_projection_tamper composite_projection_tamper_digest
  local composite_projection_tamper_inventory_digest
  seal_test_bundle() {
    python3 - "$1" <<'PY'
import hashlib
import json
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
review_input = root / ".review-input"
inventory_path = review_input / "bundle-inventory.json"
if inventory_path.exists():
    inventory_path.chmod(inventory_path.stat().st_mode | 0o200)
    inventory_path.unlink()
for path in root.rglob("*"):
    if path.is_file() and not path.is_symlink():
        path.chmod(path.stat().st_mode & ~0o222)
files = []
for path in root.rglob("*"):
    if path.is_file() and not path.is_symlink() and path != inventory_path:
        files.append(
            {
                "path": path.relative_to(root).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "mode": stat.S_IMODE(path.stat().st_mode),
            }
        )
inventory_path.write_text(json.dumps({"schema": 1, "files": sorted(files, key=lambda item: item["path"])}, sort_keys=True) + "\n")
inventory_path.chmod(inventory_path.stat().st_mode & ~0o222)
PY
  }
  make_test_bundle() {
    python3 - "$1" <<'PY'
import json
from pathlib import Path
import sys

review_input = Path(sys.argv[1]) / ".review-input"
for name, value in (
    ("instruction-closure.json", {"schema": 1, "paths": []}),
    ("patch-paths.json", {"schema": 1, "paths": ["a"]}),
    ("omitted-symlinks.json", {"schema": 1, "paths": []}),
):
    (review_input / name).write_text(json.dumps(value, sort_keys=True) + "\n")
PY
    seal_test_bundle "$1"
  }
  make_composite_bundles() {
    python3 - "$1" "$2" 9<<< "$3" <<'PY'
import copy
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

parent = Path(sys.argv[1])
project = Path(sys.argv[2])
nonce_bytes = __import__("os").read(9, 130)
assert nonce_bytes.endswith(b"\n") and b"\n" not in nonce_bytes[:-1]
nonce = nonce_bytes[:-1].decode("utf-8")
assert nonce not in sys.argv
known_kits = ("agent_policies-claude", "agent_policies-codex")


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def state(data):
    return {"sha256": hashlib.sha256(data).hexdigest(), "mode": 0o644}


def file_state(path):
    return state(path.read_bytes())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


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
        ).encode("utf-8")
    ).hexdigest()


project.mkdir()
subprocess.check_call(["git", "init", "-q", str(project)])
subprocess.check_call(["git", "-C", str(project), "config", "user.name", "reviewer-self-test"])
subprocess.check_call(["git", "-C", str(project), "config", "user.email", "reviewer-self-test@example.invalid"])
old_values = {
    ".claude/kit-overrides": b"old claude override\n",
    ".claude/managed": b"old claude managed\n",
    ".codex/kit-overrides": b"old codex override\n",
    ".codex/managed": b"old codex managed\n",
    "shared": b"old shared\n",
}
new_values = {
    ".claude/kit-overrides": b"claude project override\n",
    ".claude/managed": b"claude upstream\n",
    ".codex/kit-overrides": b"codex project override\n",
    ".codex/managed": b"codex upstream\n",
    "shared": b"shared project\n",
}
for rel, data in old_values.items():
    path = project / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
subprocess.check_call(["git", "-C", str(project), "add", "."])
subprocess.check_call(["git", "-C", str(project), "commit", "-qm", "base"])
base = run("git", "-C", str(project), "rev-parse", "HEAD")
base_tree = run("git", "-C", str(project), "rev-parse", "HEAD^{tree}")
for rel, data in new_values.items():
    (project / rel).write_bytes(data)
subprocess.check_call(["git", "-C", str(project), "add", "."])
subprocess.check_call(["git", "-C", str(project), "commit", "-qm", "head"])
head = run("git", "-C", str(project), "rev-parse", "HEAD")
head_tree = run("git", "-C", str(project), "rev-parse", "HEAD^{tree}")
branch = run("git", "-C", str(project), "branch", "--show-current")
patch = subprocess.check_output(
    [
        "git", "-C", str(project), "diff", "--no-renames", "--binary",
        "--relative", f"{base}...{head}", "--", ".",
    ]
)
empty_digest = hashlib.sha256(b"").hexdigest()

success = parent / "success"
review_input = success / ".review-input"
review_input.mkdir(parents=True)
(success / "REVIEW_POLICY.md").write_text("policy\n", encoding="utf-8")
(review_input / "patch.diff").write_bytes(patch)
closure = {
    "schema": 1,
    "paths": [
        {
            "git_visibility": "tracked",
            "imported_from": [],
            "kinds": ["fixed-control-plane"],
            "path": ".claude",
            "sha256": None,
            "type": "directory",
        },
        {
            "git_visibility": "tracked",
            "imported_from": [],
            "kinds": ["fixed-control-plane"],
            "path": ".codex",
            "sha256": None,
            "type": "directory",
        },
    ],
}
patch_paths = {"schema": 1, "paths": sorted(new_values)}
write_json(review_input / "instruction-closure.json", closure)
write_json(review_input / "patch-paths.json", patch_paths)
write_json(review_input / "omitted-symlinks.json", {"schema": 1, "paths": []})

kit_specs = {
    "agent_policies-claude": {
        "managed": ".claude/managed",
        "override": ".claude/kit-overrides",
        "source": {
            ".claude/managed": new_values[".claude/managed"],
            ".claude/kit-overrides": b"claude source override\n",
            "shared": b"shared claude source\n",
        },
        "post": {
            ".claude/managed": new_values[".claude/managed"],
            ".claude/kit-overrides": b"claude recorded override\n",
            "shared": b"shared claude post\n",
        },
    },
    "agent_policies-codex": {
        "managed": ".codex/managed",
        "override": ".codex/kit-overrides",
        "source": {
            ".codex/managed": new_values[".codex/managed"],
            ".codex/kit-overrides": b"codex source override\n",
            "shared": b"shared codex source\n",
        },
        "post": {
            ".codex/managed": new_values[".codex/managed"],
            ".codex/kit-overrides": b"codex recorded override\n",
            "shared": b"shared codex post\n",
        },
    },
}
sets = []
reconstructed = {}
for index, kit in enumerate(known_kits):
    spec = kit_specs[kit]
    revision = str(index + 5) * 40
    source_tree = str(index + 7) * 40
    managed_paths = sorted(spec["source"])
    upstream_entries = [
        {"path": rel, **state(spec["source"][rel])} for rel in managed_paths
    ]
    upstream = {
        "schema": 1,
        "kit": kit,
        "repository": f"https://example.invalid/{kit}.git",
        "source_revision": revision,
        "source_tree": source_tree,
        "review": {
            "milestone": "M7-D",
            "patch_sha256": str(index + 1) * 64,
            "archive_manifest_sha256": str(index + 3) * 64,
            "verdict": "approve",
            "criteria_met": "10/10",
            "blocking": "none",
        },
        "managed_files": upstream_entries,
        "managed_file_count": len(upstream_entries),
    }
    upgrade_entries = []
    for rel in managed_paths:
        ownership = "upstream-identical" if rel == spec["managed"] else "project-override"
        upgrade_entries.append(
            {
                "path": rel,
                "action": "upgrade" if ownership == "upstream-identical" else "override",
                "ownership": ownership,
                "source": state(spec["source"][rel]),
                "pre": state(old_values[rel]),
                "post": state(spec["post"][rel]),
            }
        )
    upgrade = {
        "schema": 1,
        "record_version": 3,
        "operation": "upgrade",
        "kit": kit,
        "destination": str(project),
        "scope": "git-root",
        "source": {"revision": revision, "tree": source_tree, "dirty": False},
        "pre": {
            "head": base,
            "tree": base_tree,
            "branch": branch,
            "status_sha256": empty_digest,
        },
        "post": {
            "status_sha256": empty_digest,
            "managed_projection_sha256": projection_digest(upgrade_entries),
        },
        "managed_path_count": len(upgrade_entries),
        "managed_paths": upgrade_entries,
    }
    artifact_root = review_input / "attestations" / kit
    upstream_path = artifact_root / "upstream-release-attestation.json"
    upgrade_path = artifact_root / "upgrade-attestation.json"
    write_json(upstream_path, upstream)
    write_json(upgrade_path, upgrade)
    sets.append(
        {
            "kit": kit,
            "upstream_attestation_sha256": hashlib.sha256(upstream_path.read_bytes()).hexdigest(),
            "upgrade_attestation_sha256": hashlib.sha256(upgrade_path.read_bytes()).hexdigest(),
            "upstream": upstream,
            "upgrade": upgrade,
        }
    )
    for entry in upgrade_entries:
        reconstructed.setdefault(entry["path"], []).append(
            {
                "kit": kit,
                "ownership": entry["ownership"],
                "source": entry["source"],
                "post": entry["post"],
            }
        )

managed_union = [
    {"path": rel, "bindings": sorted(bindings, key=lambda item: item["kit"])}
    for rel, bindings in sorted(reconstructed.items())
]
union_map = {item["path"]: item["bindings"] for item in managed_union}
ownership = []
for rel in sorted(new_values):
    if rel.endswith("/kit-overrides"):
        classification = "instruction-delta"
        instruction_kinds = ["fixed-control-plane"]
        instruction_sources = [rel.split("/", 2)[0]]
    elif rel == "shared":
        classification = "project-owned"
        instruction_kinds = []
        instruction_sources = []
    else:
        classification = "upstream-identical"
        instruction_kinds = ["fixed-control-plane"]
        instruction_sources = [rel.split("/", 2)[0]]
    item = {
        "path": rel,
        "classification": classification,
        "candidate": {"type": "file", **file_state(project / rel)},
        "instruction_kinds": instruction_kinds,
        "instruction_sources": instruction_sources,
        "managed_bindings": [
            {
                "kit": binding["kit"],
                "upgrade_ownership": binding["ownership"],
                "upstream": binding["source"],
                "upgrade_post": binding["post"],
            }
            for binding in union_map[rel]
        ],
    }
    ownership.append(item)

manifest = {
    "schema": 2,
    "mode": "maintenance",
    "base_commit": base,
    "head_commit": head,
    "head_tree": head_tree,
    "patch_sha256": hashlib.sha256(patch).hexdigest(),
    "authorization_sha256": hashlib.sha256(nonce.encode()).hexdigest(),
    "instruction_closure_sha256": hashlib.sha256(
        (review_input / "instruction-closure.json").read_bytes()
    ).hexdigest(),
    "patch_paths_sha256": hashlib.sha256(
        (review_input / "patch-paths.json").read_bytes()
    ).hexdigest(),
    "attestation_sets": sets,
    "managed_union": managed_union,
    "ownership": ownership,
}
write_json(review_input / "maintenance-manifest.json", manifest)

variant_names = (
    "artifact-tamper",
    "digest-tamper",
    "unknown-field",
    "duplicate-set",
    "missing-set",
    "cross-swap",
    "union-omission",
    "union-extra",
    "union-tamper",
    "mixed-overlap",
    "ownership-omission",
    "ownership-extra",
    "ownership-tamper",
)
for name in variant_names:
    shutil.copytree(success, parent / name)

def variant(name):
    root = parent / name / ".review-input"
    return root, json.loads((root / "maintenance-manifest.json").read_text())

root, value = variant("artifact-tamper")
path = root / "attestations" / known_kits[0] / "upstream-release-attestation.json"
path.write_bytes(path.read_bytes() + b"\n")

root, value = variant("digest-tamper")
value["attestation_sets"][0]["upstream_attestation_sha256"] = "0" * 64
write_json(root / "maintenance-manifest.json", value)

root, value = variant("unknown-field")
value["unrecognized"] = "must-not-enter-reviewer"
write_json(root / "maintenance-manifest.json", value)

root, value = variant("duplicate-set")
value["attestation_sets"] = [value["attestation_sets"][0], copy.deepcopy(value["attestation_sets"][0])]
write_json(root / "maintenance-manifest.json", value)

root, value = variant("missing-set")
value["attestation_sets"] = value["attestation_sets"][:1]
write_json(root / "maintenance-manifest.json", value)

root, value = variant("cross-swap")
first, second = value["attestation_sets"]
first_path = root / "attestations" / first["kit"] / "upgrade-attestation.json"
second_path = root / "attestations" / second["kit"] / "upgrade-attestation.json"
first_bytes, second_bytes = first_path.read_bytes(), second_path.read_bytes()
first["upgrade"], second["upgrade"] = second["upgrade"], first["upgrade"]
first["upgrade_attestation_sha256"], second["upgrade_attestation_sha256"] = (
    second["upgrade_attestation_sha256"], first["upgrade_attestation_sha256"]
)
first_path.write_bytes(second_bytes)
second_path.write_bytes(first_bytes)
write_json(root / "maintenance-manifest.json", value)

root, value = variant("union-omission")
value["managed_union"] = value["managed_union"][1:]
write_json(root / "maintenance-manifest.json", value)

root, value = variant("union-extra")
extra = copy.deepcopy(value["managed_union"][0])
extra["path"] = "zzz-extra"
value["managed_union"].append(extra)
write_json(root / "maintenance-manifest.json", value)

root, value = variant("union-tamper")
value["managed_union"][0]["bindings"][0]["post"]["sha256"] = "0" * 64
write_json(root / "maintenance-manifest.json", value)

root, value = variant("mixed-overlap")
codex_set = value["attestation_sets"][1]
codex_upgrade = codex_set["upgrade"]
shared_entry = next(item for item in codex_upgrade["managed_paths"] if item["path"] == "shared")
shared_entry["action"] = "upgrade"
shared_entry["ownership"] = "upstream-identical"
shared_entry["post"] = copy.deepcopy(shared_entry["source"])
codex_upgrade["post"]["managed_projection_sha256"] = projection_digest(codex_upgrade["managed_paths"])
codex_path = root / "attestations" / known_kits[1] / "upgrade-attestation.json"
write_json(codex_path, codex_upgrade)
codex_set["upgrade_attestation_sha256"] = hashlib.sha256(codex_path.read_bytes()).hexdigest()
union_shared = next(item for item in value["managed_union"] if item["path"] == "shared")
union_binding = next(item for item in union_shared["bindings"] if item["kit"] == known_kits[1])
union_binding["ownership"] = "upstream-identical"
union_binding["post"] = copy.deepcopy(union_binding["source"])
ownership_shared = next(item for item in value["ownership"] if item["path"] == "shared")
ownership_binding = next(item for item in ownership_shared["managed_bindings"] if item["kit"] == known_kits[1])
ownership_binding["upgrade_ownership"] = "upstream-identical"
ownership_binding["upgrade_post"] = copy.deepcopy(ownership_binding["upstream"])
write_json(root / "maintenance-manifest.json", value)

root, value = variant("ownership-omission")
value["ownership"] = value["ownership"][1:]
write_json(root / "maintenance-manifest.json", value)

root, value = variant("ownership-extra")
value["ownership"].append(
    {
        "path": "zzz-extra",
        "classification": "project-owned",
        "candidate": {"type": "missing"},
        "instruction_kinds": [],
        "instruction_sources": [],
    }
)
write_json(root / "maintenance-manifest.json", value)

root, value = variant("ownership-tamper")
value["ownership"][0]["managed_bindings"][0]["upgrade_post"]["sha256"] = "0" * 64
write_json(root / "maintenance-manifest.json", value)
PY
  }
  tmp="$(mktemp -d "$TMP_ROOT/reviewer-claude-selftest.XXXXXX")"
  trap 'rm -rf "$tmp"' RETURN
  fake="$tmp/fake-claude"
  out="$tmp/invocation.txt"
  clean_out="$tmp/invocation-clean.txt"
  review_home="$tmp/reviewer-home"
  repo="$tmp/repo"
  bad="$tmp/bad-bundle"
  missing="$tmp/missing-bundle"
  tampered="$tmp/tampered-bundle"
  leaked="$tmp/leaked-bundle"
  intersection="$tmp/intersection-bundle"
  maintenance="$tmp/maintenance-bundle"
  maintenance_project="$tmp/maintenance-project"
  maintenance_nonce="maintenance-selftest-nonce-20260730"
  review_tmp="$tmp/review-tmp"
  mkdir -p "$review_home" "$repo/.review-input" "$review_tmp"
  printf 'policy\n' > "$repo/REVIEW_POLICY.md"
  printf 'diff --git a/a b/a\n' > "$repo/.review-input/patch.diff"
  make_test_bundle "$repo"
  digest="$(sha256_path "$repo/.review-input/bundle-inventory.json")"
  cp -R "$repo/." "$bad/"
  ln -s REVIEW_POLICY.md "$bad/escape"
  cp -R "$repo" "$missing"
  rm "$missing/.review-input/instruction-closure.json"
  cp -R "$repo" "$tampered"
  chmod u+w "$tampered/.review-input/instruction-closure.json"
  printf 'tamper\n' >> "$tampered/.review-input/instruction-closure.json"
  cp -R "$repo" "$leaked"
  chmod u+w "$leaked/.review-input/instruction-closure.json"
  mkdir -p "$leaked/rules"
  printf 'leaked instruction\n' > "$leaked/rules/leaked.md"
  printf '%s\n' \
    '{"schema":1,"paths":[{"git_visibility":"tracked","imported_from":["AGENTS.md"],"kinds":["imported"],"path":"rules/leaked.md","sha256":"unused","type":"file"}]}' \
    > "$leaked/.review-input/instruction-closure.json"
  seal_test_bundle "$leaked"
  leaked_digest="$(sha256_path "$leaked/.review-input/bundle-inventory.json")"
  cp -R "$repo" "$intersection"
  chmod u+w "$intersection/.review-input/instruction-closure.json"
  printf '%s\n' \
    '{"schema":1,"paths":[{"git_visibility":"tracked","imported_from":[],"kinds":["fixed-root"],"path":"a","sha256":"unused","type":"file"}]}' \
    > "$intersection/.review-input/instruction-closure.json"
  seal_test_bundle "$intersection"
  intersection_digest="$(sha256_path "$intersection/.review-input/bundle-inventory.json")"
  cp -R "$repo" "$maintenance"
  git init -q "$maintenance_project"
  git -C "$maintenance_project" config user.name reviewer-self-test
  git -C "$maintenance_project" config user.email reviewer-self-test@example.invalid
  printf 'old\n' > "$maintenance_project/a"
  git -C "$maintenance_project" add a
  git -C "$maintenance_project" commit -qm base
  printf 'new\n' > "$maintenance_project/a"
  git -C "$maintenance_project" add a
  git -C "$maintenance_project" commit -qm head
  python3 - "$maintenance" "$maintenance_project" "$KIT_NAME" \
    9<<< "$maintenance_nonce" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
project = Path(sys.argv[2])
kit = sys.argv[3]
nonce_bytes = __import__("os").read(9, 130)
assert nonce_bytes.endswith(b"\n") and b"\n" not in nonce_bytes[:-1]
nonce = nonce_bytes[:-1].decode("utf-8")
assert nonce not in sys.argv
review_input = root / ".review-input"
import subprocess

base = subprocess.check_output(
    ["git", "-C", str(project), "rev-parse", "HEAD^"], text=True
).strip()
head = subprocess.check_output(
    ["git", "-C", str(project), "rev-parse", "HEAD"], text=True
).strip()
tree = subprocess.check_output(
    ["git", "-C", str(project), "rev-parse", "HEAD^{tree}"], text=True
).strip()
patch = subprocess.check_output(
    [
        "git", "-C", str(project), "diff", "--no-renames", "--binary",
        "--relative", f"{base}...{head}", "--", ".",
    ]
)
(review_input / "patch.diff").chmod(0o644)
(review_input / "patch.diff").write_bytes(patch)
new_state = {
    "sha256": hashlib.sha256(b"new\n").hexdigest(),
    "mode": 0o644,
}
old_state = {
    "sha256": hashlib.sha256(b"old\n").hexdigest(),
    "mode": 0o644,
}
source_revision = "5" * 40
source_tree = "6" * 40
upstream = {
    "schema": 1,
    "kit": kit,
    "repository": f"https://example.invalid/{kit}.git",
    "source_revision": source_revision,
    "source_tree": source_tree,
    "review": {
        "milestone": "M7",
        "patch_sha256": "7" * 64,
        "archive_manifest_sha256": "8" * 64,
        "verdict": "approve",
        "criteria_met": "14/14",
        "blocking": "none",
    },
    "managed_files": [{"path": "a", **new_state}],
    "managed_file_count": 1,
}
empty_digest = hashlib.sha256(b"").hexdigest()
branch = subprocess.check_output(
    ["git", "-C", str(project), "branch", "--show-current"], text=True
).strip()
base_tree = subprocess.check_output(
    ["git", "-C", str(project), "rev-parse", f"{base}^{{tree}}"], text=True
).strip()
managed_entry = {
    "path": "a",
    "action": "upgrade",
    "ownership": "upstream-identical",
    "source": new_state,
    "pre": old_state,
    "post": new_state,
}
projection_digest = hashlib.sha256(
    json.dumps(
        {
            "schema": 1,
            "paths": [
                {
                    "path": "a",
                    "ownership": "upstream-identical",
                    "source": new_state,
                    "post": new_state,
                }
            ],
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
).hexdigest()
upgrade = {
    "schema": 1,
    "record_version": 3,
    "operation": "upgrade",
    "kit": kit,
    "destination": str(project),
    "scope": "git-root",
    "source": {
        "revision": source_revision,
        "tree": source_tree,
        "dirty": False,
    },
    "pre": {
        "head": base,
        "tree": base_tree,
        "branch": branch,
        "status_sha256": empty_digest,
    },
    "post": {
        "status_sha256": empty_digest,
        "managed_projection_sha256": projection_digest,
    },
    "managed_path_count": 1,
    "managed_paths": [managed_entry],
}
upstream_bytes = (json.dumps(upstream, sort_keys=True) + "\n").encode()
upgrade_bytes = (json.dumps(upgrade, sort_keys=True) + "\n").encode()
(review_input / "upstream-release-attestation.json").write_bytes(upstream_bytes)
(review_input / "upgrade-attestation.json").write_bytes(upgrade_bytes)
manifest = {
    "schema": 1,
    "mode": "maintenance",
    "base_commit": base,
    "head_commit": head,
    "head_tree": tree,
    "patch_sha256": hashlib.sha256(patch).hexdigest(),
    "authorization_sha256": hashlib.sha256(nonce.encode()).hexdigest(),
    "upstream_attestation_sha256": hashlib.sha256(upstream_bytes).hexdigest(),
    "upgrade_attestation_sha256": hashlib.sha256(upgrade_bytes).hexdigest(),
    "instruction_closure_sha256": hashlib.sha256(
        (review_input / "instruction-closure.json").read_bytes()
    ).hexdigest(),
    "patch_paths_sha256": hashlib.sha256(
        (review_input / "patch-paths.json").read_bytes()
    ).hexdigest(),
    "upstream": upstream,
    "upgrade": upgrade,
    "ownership": [{
        "path": "a",
        "classification": "upstream-identical",
        "candidate": {
            "type": "file",
            "sha256": new_state["sha256"],
            "mode": 0o644,
        },
        "instruction_kinds": [],
        "instruction_sources": [],
        "upgrade_ownership": "upstream-identical",
        "upstream": new_state,
        "upgrade_post": new_state,
    }],
}
(review_input / "maintenance-manifest.json").write_text(
    json.dumps(manifest, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
  seal_test_bundle "$maintenance"
  maintenance_digest="$(sha256_path "$maintenance/.review-input/maintenance-manifest.json")"
  maintenance_inventory_digest="$(sha256_path "$maintenance/.review-input/bundle-inventory.json")"
  projection="$tmp/path-neutral-maintenance-bundle"
  projection_sidecar="$tmp/path-neutral-prelaunch.json"
  cp -R "$maintenance" "$projection"
  python3 - "$projection" "$projection_sidecar" "$maintenance" \
    "$maintenance_project" 9<<< "$maintenance_nonce" <<'PY'
import hashlib
import json
from pathlib import Path
import stat
import sys

root = Path(sys.argv[1])
sidecar_path = Path(sys.argv[2])
original_root = Path(sys.argv[3])
project = Path(sys.argv[4])
nonce = __import__("os").read(9, 130)[:-1].decode()
review_input = root / ".review-input"
manifest_path = review_input / "maintenance-manifest.json"
manifest_path.chmod(0o600)
legacy = json.loads(manifest_path.read_text())
up_path = original_root / ".review-input/upstream-release-attestation.json"
upgrade_path = original_root / ".review-input/upgrade-attestation.json"
upstream = json.loads(up_path.read_text())
upgrade = json.loads(upgrade_path.read_text())
for path in (review_input / "upstream-release-attestation.json", review_input / "upgrade-attestation.json"):
    path.chmod(0o600)
    path.unlink()
managed = upgrade["managed_paths"]
record_inventory = hashlib.sha256(json.dumps({"schema": 1, "managed_paths": sorted(managed, key=lambda item: item["path"])}, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
projection = {
    "kit": upstream["kit"],
    "upstream_attestation_id": "release/singleton/upstream.json",
    "upgrade_attestation_id": "install/singleton/maintenance-attestation.json",
    "repository": upstream["repository"],
    "source_revision": upstream["source_revision"], "source_tree": upstream["source_tree"],
    "upstream_review": upstream["review"],
    "upstream_attestation_sha256": hashlib.sha256(up_path.read_bytes()).hexdigest(),
    "upgrade_attestation_sha256": hashlib.sha256(upgrade_path.read_bytes()).hexdigest(),
    "upgrade_scope": upgrade["scope"], "upgrade_pre": upgrade["pre"], "upgrade_post": upgrade["post"],
    "record_inventory_sha256": record_inventory, "managed_path_count": upgrade["managed_path_count"],
    "managed_paths": sorted([{"path": item["path"], "ownership": item["ownership"], "source": item["source"], "post": item["post"]} for item in managed], key=lambda item: item["path"]),
}
projection_digest = hashlib.sha256(json.dumps({"schema": 1, "attestation_projections": [projection]}, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
sidecar = {
    "schema": 1, "mode": "path-neutral-maintenance-prelaunch",
    "physical_project_root": str(project), "base_commit": legacy["base_commit"],
    "head_commit": legacy["head_commit"], "head_tree": legacy["head_tree"],
    "patch_sha256": legacy["patch_sha256"],
    "authorization_sha256": hashlib.sha256(nonce.encode()).hexdigest(),
    "projection_sha256": projection_digest,
    "attestation_sets": [{"kit": upstream["kit"], "upstream_attestation_id": "release/singleton/upstream.json", "upgrade_attestation_id": "install/singleton/maintenance-attestation.json", "upstream_artifact": {"path": str(up_path), "sha256": hashlib.sha256(up_path.read_bytes()).hexdigest()}, "upgrade_artifact": {"path": str(upgrade_path), "sha256": hashlib.sha256(upgrade_path.read_bytes()).hexdigest()}}],
}
sidecar_path.write_text(json.dumps(sidecar, indent=2, sort_keys=True) + "\n")
sidecar_path.chmod(0o400)
value = {
    "schema": 3, "mode": "maintenance", "projection_mode": "path-neutral-v1",
    "base_commit": legacy["base_commit"], "head_commit": legacy["head_commit"],
    "head_tree": legacy["head_tree"], "patch_sha256": legacy["patch_sha256"],
    "authorization_sha256": legacy["authorization_sha256"],
    "prelaunch_sidecar_sha256": hashlib.sha256(sidecar_path.read_bytes()).hexdigest(),
    "instruction_closure_sha256": legacy["instruction_closure_sha256"],
    "patch_paths_sha256": legacy["patch_paths_sha256"],
    "projection_sha256": projection_digest, "attestation_projections": [projection],
    "managed_union": [{"path": "a", "bindings": [{"kit": upstream["kit"], "ownership": "upstream-identical", "source": managed[0]["source"], "post": managed[0]["post"]}]}],
    "ownership": legacy["ownership"],
}
manifest_path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
  seal_test_bundle "$projection"
  projection_digest="$(sha256_path "$projection_sidecar")"
  projection_inventory_digest="$(sha256_path "$projection/.review-input/bundle-inventory.json")"
  maintenance_crosscheck="$tmp/maintenance-crosscheck-bundle"
  maintenance_unknown="$tmp/maintenance-unknown-bundle"
  cp -R "$maintenance" "$maintenance_crosscheck"
  cp -R "$maintenance" "$maintenance_unknown"
  python3 - "$maintenance_crosscheck" "$maintenance_unknown" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

crosscheck = Path(sys.argv[1]) / ".review-input"
unknown = Path(sys.argv[2]) / ".review-input"

for directory in (crosscheck, unknown):
    for name in (
        "maintenance-manifest.json",
        "upstream-release-attestation.json",
        "upgrade-attestation.json",
    ):
        path = directory / name
        path.chmod(path.stat().st_mode | 0o200)

manifest = json.loads(
    (crosscheck / "maintenance-manifest.json").read_text(encoding="utf-8")
)
upstream = json.loads(
    (crosscheck / "upstream-release-attestation.json").read_text(encoding="utf-8")
)
upgrade = json.loads(
    (crosscheck / "upgrade-attestation.json").read_text(encoding="utf-8")
)
wrong = {"sha256": "0" * 64, "mode": 0o644}
upstream["managed_files"][0].update(wrong)
upgrade["managed_paths"][0]["source"] = wrong
upgrade["managed_paths"][0]["post"] = wrong
projection = [{
    "path": "a",
    "ownership": "upstream-identical",
    "source": wrong,
    "post": wrong,
}]
upgrade["post"]["managed_projection_sha256"] = hashlib.sha256(
    json.dumps(
        {"schema": 1, "paths": projection},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
).hexdigest()
upstream_bytes = (json.dumps(upstream, sort_keys=True) + "\n").encode()
upgrade_bytes = (json.dumps(upgrade, sort_keys=True) + "\n").encode()
(crosscheck / "upstream-release-attestation.json").write_bytes(upstream_bytes)
(crosscheck / "upgrade-attestation.json").write_bytes(upgrade_bytes)
manifest["upstream"] = upstream
manifest["upgrade"] = upgrade
manifest["upstream_attestation_sha256"] = hashlib.sha256(upstream_bytes).hexdigest()
manifest["upgrade_attestation_sha256"] = hashlib.sha256(upgrade_bytes).hexdigest()
(crosscheck / "maintenance-manifest.json").write_text(
    json.dumps(manifest, sort_keys=True) + "\n",
    encoding="utf-8",
)

manifest = json.loads(
    (unknown / "maintenance-manifest.json").read_text(encoding="utf-8")
)
upgrade = json.loads(
    (unknown / "upgrade-attestation.json").read_text(encoding="utf-8")
)
upgrade["unrecognized"] = "must-not-enter-reviewer"
upgrade_bytes = (json.dumps(upgrade, sort_keys=True) + "\n").encode()
(unknown / "upgrade-attestation.json").write_bytes(upgrade_bytes)
manifest["upgrade"] = upgrade
manifest["upgrade_attestation_sha256"] = hashlib.sha256(upgrade_bytes).hexdigest()
(unknown / "maintenance-manifest.json").write_text(
    json.dumps(manifest, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY
  seal_test_bundle "$maintenance_crosscheck"
  seal_test_bundle "$maintenance_unknown"
  maintenance_crosscheck_digest="$(
    sha256_path "$maintenance_crosscheck/.review-input/maintenance-manifest.json"
  )"
  maintenance_crosscheck_inventory_digest="$(
    sha256_path "$maintenance_crosscheck/.review-input/bundle-inventory.json"
  )"
  maintenance_unknown_digest="$(
    sha256_path "$maintenance_unknown/.review-input/maintenance-manifest.json"
  )"
  maintenance_unknown_inventory_digest="$(
    sha256_path "$maintenance_unknown/.review-input/bundle-inventory.json"
  )"
  composite_parent="$tmp/composite-bundles"
  composite_project="$tmp/composite-project"
  composite_success="$composite_parent/success"
  composite_nonce="composite-maintenance-selftest-nonce-20260801"
  mkdir -p "$composite_parent"
  make_composite_bundles "$composite_parent" "$composite_project" "$composite_nonce"
  for variant in "$composite_parent"/*; do
    seal_test_bundle "$variant"
  done
  composite_digest="$(sha256_path "$composite_success/.review-input/maintenance-manifest.json")"
  composite_inventory_digest="$(sha256_path "$composite_success/.review-input/bundle-inventory.json")"
  composite_projection="$tmp/composite-path-neutral-bundle"
  composite_projection_sidecar="$tmp/composite-path-neutral-sidecar.json"
  composite_projection_originals="$tmp/composite-path-neutral-originals"
  cp -R "$composite_success" "$composite_projection_originals"
  cp -R "$composite_success" "$composite_projection"
  python3 - "$composite_projection" "$composite_projection_sidecar" \
    "$composite_projection_originals" "$composite_project" 9<<< "$composite_nonce" <<'PY'
import hashlib
import json
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
sidecar_path = Path(sys.argv[2])
original_root = Path(sys.argv[3])
project = Path(sys.argv[4])
nonce = __import__("os").read(9, 130)[:-1].decode()
review_input = root / ".review-input"
manifest_path = review_input / "maintenance-manifest.json"
manifest_path.chmod(0o600)
legacy = json.loads(manifest_path.read_text())
projections = []
side_sets = []
for item in legacy["attestation_sets"]:
    kit = item["kit"]
    artifact_root = original_root / ".review-input/attestations" / kit
    up_path = artifact_root / "upstream-release-attestation.json"
    upgrade_path = artifact_root / "upgrade-attestation.json"
    upstream = json.loads(up_path.read_text())
    upgrade = json.loads(upgrade_path.read_text())
    managed = upgrade["managed_paths"]
    inventory_digest = hashlib.sha256(json.dumps({"schema": 1, "managed_paths": sorted(managed, key=lambda value: value["path"])}, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
    projections.append({
        "kit": kit,
        "upstream_attestation_id": f"release/{kit}/upstream.json",
        "upgrade_attestation_id": f"install/{kit}/maintenance-attestation.json",
        "repository": upstream["repository"],
        "source_revision": upstream["source_revision"], "source_tree": upstream["source_tree"],
        "upstream_review": upstream["review"],
        "upstream_attestation_sha256": hashlib.sha256(up_path.read_bytes()).hexdigest(),
        "upgrade_attestation_sha256": hashlib.sha256(upgrade_path.read_bytes()).hexdigest(),
        "upgrade_scope": upgrade["scope"], "upgrade_pre": upgrade["pre"], "upgrade_post": upgrade["post"],
        "record_inventory_sha256": inventory_digest, "managed_path_count": upgrade["managed_path_count"],
        "managed_paths": sorted([{"path": entry["path"], "ownership": entry["ownership"], "source": entry["source"], "post": entry["post"]} for entry in managed], key=lambda value: value["path"]),
    })
    side_sets.append({"kit": kit, "upstream_attestation_id": f"release/{kit}/upstream.json", "upgrade_attestation_id": f"install/{kit}/maintenance-attestation.json", "upstream_artifact": {"path": str(up_path), "sha256": hashlib.sha256(up_path.read_bytes()).hexdigest()}, "upgrade_artifact": {"path": str(upgrade_path), "sha256": hashlib.sha256(upgrade_path.read_bytes()).hexdigest()}})
projections.sort(key=lambda value: value["kit"])
side_sets.sort(key=lambda value: value["kit"])
projection_digest = hashlib.sha256(json.dumps({"schema": 1, "attestation_projections": projections}, separators=(",", ":"), sort_keys=True).encode()).hexdigest()
sidecar = {
    "schema": 1, "mode": "path-neutral-maintenance-prelaunch",
    "physical_project_root": str(project), "base_commit": legacy["base_commit"],
    "head_commit": legacy["head_commit"], "head_tree": legacy["head_tree"],
    "patch_sha256": legacy["patch_sha256"], "authorization_sha256": hashlib.sha256(nonce.encode()).hexdigest(),
    "projection_sha256": projection_digest, "attestation_sets": side_sets,
}
sidecar_path.write_text(json.dumps(sidecar, indent=2, sort_keys=True) + "\n")
sidecar_path.chmod(0o400)
shutil.rmtree(review_input / "attestations")
value = {
    "schema": 3, "mode": "maintenance", "projection_mode": "path-neutral-v1",
    "base_commit": legacy["base_commit"], "head_commit": legacy["head_commit"], "head_tree": legacy["head_tree"],
    "patch_sha256": legacy["patch_sha256"], "authorization_sha256": legacy["authorization_sha256"],
    "prelaunch_sidecar_sha256": hashlib.sha256(sidecar_path.read_bytes()).hexdigest(),
    "instruction_closure_sha256": legacy["instruction_closure_sha256"], "patch_paths_sha256": legacy["patch_paths_sha256"],
    "projection_sha256": projection_digest, "attestation_projections": projections,
    "managed_union": legacy["managed_union"], "ownership": legacy["ownership"],
}
manifest_path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
  seal_test_bundle "$composite_projection"
  composite_projection_digest="$(sha256_path "$composite_projection_sidecar")"
  composite_projection_inventory_digest="$(sha256_path "$composite_projection/.review-input/bundle-inventory.json")"
  composite_projection_tamper="$tmp/composite-path-neutral-projection-tamper"
  cp -R "$composite_projection" "$composite_projection_tamper"
  python3 - "$composite_projection_tamper" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1]) / ".review-input/maintenance-manifest.json"
path.chmod(0o600)
value = json.loads(path.read_text())
value["attestation_projections"][0]["source_tree"] = "0" * 40
path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
PY
  seal_test_bundle "$composite_projection_tamper"
  composite_projection_tamper_digest="$(sha256_path "$composite_projection_tamper/.review-input/maintenance-manifest.json")"
  composite_projection_tamper_inventory_digest="$(sha256_path "$composite_projection_tamper/.review-input/bundle-inventory.json")"
  printf '%s\n' \
    '#!/bin/sh' \
    'printf "cwd=%s\n" "$PWD" > "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "review_mode=%s\n" "${AGENT_KIT_REVIEW_MODE:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "review_bundle=%s\n" "${AGENT_KIT_REVIEW_BUNDLE:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "repo_root=%s\n" "${AGENT_KIT_REPO_ROOT:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "maintenance_authorization=%s\n" "${AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "maintenance_project_root=%s\n" "${AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "maintenance_sidecar=%s\n" "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "maintenance_projection=%s\n" "${AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'printf "claude_config_dir=%s\n" "${CLAUDE_CONFIG_DIR:-}" >> "$REVIEW_WRAPPER_TEST_OUT"' \
    'env | grep -E "^(ANTHROPIC_|CLAUDE_CODE_)" >> "$REVIEW_WRAPPER_TEST_OUT" || :' \
    'for arg in "$@"; do printf "arg=%s\n" "$arg" >> "$REVIEW_WRAPPER_TEST_OUT"; done' \
    > "$fake"
  chmod +x "$fake"

  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    TMPDIR="$review_tmp/" \
    ANTHROPIC_BASE_URL=http://127.0.0.1:1 \
    ANTHROPIC_AUTH_TOKEN=developer-token \
    ANTHROPIC_API_KEY=developer-key \
    CLAUDE_CODE_API_BASE_URL=http://127.0.0.1:2 \
    CLAUDE_CODE_OAUTH_TOKEN=developer-oauth \
    CLAUDE_CODE_USE_BEDROCK=1 \
    CLAUDE_BIN="$fake" \
    CLAUDE_REVIEW_HOME="$review_home" \
    AGENT_KIT_REPO_ROOT="$repo" \
    AGENT_KIT_REVIEW_BUNDLE=1 \
    AGENT_KIT_REVIEW_BUNDLE_DIGEST="$digest" \
    REVIEW_WRAPPER_TEST_OUT="$out" \
    "$SELF" "wrapper-self-test-prompt"

  assert_review_cwd "$out" "$review_tmp" "$repo"
  grep -qx "review_mode=external" "$out"
  grep -qx "review_bundle=1" "$out"
  grep -qx "repo_root=$repo" "$out"
  grep -qx "claude_config_dir=$review_home" "$out"
  ! grep -Eq '^(ANTHROPIC_|CLAUDE_CODE_)' "$out"
  grep -qx 'arg=--safe-mode' "$out"
  grep -qx 'arg=-p' "$out"
  grep -qx 'arg=--permission-mode' "$out"
  grep -qx 'arg=plan' "$out"
  grep -qx 'arg=--tools' "$out"
  grep -qx 'arg=Read,Grep,Glob' "$out"
  grep -qx 'arg=--no-session-persistence' "$out"
  grep -qx 'arg=--' "$out"
  grep -qx 'arg=wrapper-self-test-prompt' "$out"
  symlink_host="$tmp/symlink-host-claude"
  ln -s "$(cd "$(dirname "$SELF")/.." && pwd -P)" "$symlink_host"
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    TMPDIR="$review_tmp/" \
    CLAUDE_BIN="$fake" \
    CLAUDE_REVIEW_HOME="$review_home" \
    AGENT_KIT_REPO_ROOT="$repo" \
    AGENT_KIT_REVIEW_BUNDLE=1 \
    AGENT_KIT_REVIEW_BUNDLE_DIGEST="$digest" \
    REVIEW_WRAPPER_TEST_OUT="$out.symlink-host" \
    "$symlink_host/hooks/$(basename "$SELF")" "symlink-host-prompt"
  assert_review_cwd "$out.symlink-host" "$review_tmp" "$repo"
  grep -qx 'arg=symlink-host-prompt' "$out.symlink-host"
  env -i \
    HOME="$HOME" \
    PATH="$PATH" \
    TMPDIR="$review_tmp/" \
    CLAUDE_BIN="$fake" \
    CLAUDE_REVIEW_HOME="$review_home" \
    AGENT_KIT_REPO_ROOT="$repo" \
    AGENT_KIT_REVIEW_BUNDLE=1 \
    AGENT_KIT_REVIEW_BUNDLE_DIGEST="$digest" \
    REVIEW_WRAPPER_TEST_OUT="$clean_out" \
    "$SELF" "clean-environment-prompt"
  assert_review_cwd "$clean_out" "$review_tmp" "$repo"
  grep -qx "claude_config_dir=$review_home" "$clean_out"
  ! grep -Eq '^(ANTHROPIC_|CLAUDE_CODE_)' "$clean_out"
  grep -qx 'arg=clean-environment-prompt' "$clean_out"
  CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
    AGENT_KIT_REPO_ROOT="$maintenance" AGENT_KIT_REVIEW_BUNDLE=1 \
    AGENT_KIT_REVIEW_BUNDLE_DIGEST="$maintenance_inventory_digest" \
    AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
    AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$maintenance_digest" \
    AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$maintenance_nonce" \
    AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$maintenance_project" \
    REVIEW_WRAPPER_TEST_OUT="$out.maintenance" \
    "$SELF" "maintenance-self-test-prompt"
  grep -qx 'maintenance_authorization=' "$out.maintenance"
  grep -qx 'maintenance_project_root=' "$out.maintenance"
  CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
    AGENT_KIT_REPO_ROOT="$projection" AGENT_KIT_REVIEW_BUNDLE=1 \
    AGENT_KIT_REVIEW_BUNDLE_DIGEST="$projection_inventory_digest" \
    AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
    AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$(sha256_path "$projection/.review-input/maintenance-manifest.json")" \
    AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$maintenance_nonce" \
    AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$maintenance_project" \
    AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION=path-neutral-v1 \
    AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR="$projection_sidecar" \
    AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST="$projection_digest" \
    REVIEW_WRAPPER_TEST_OUT="$out.projection" \
    "$SELF" "path-neutral-maintenance-self-test-prompt"
  grep -qx 'maintenance_authorization=' "$out.projection"
  grep -qx 'maintenance_project_root=' "$out.projection"
  grep -qx 'maintenance_sidecar=' "$out.projection"
  grep -qx 'maintenance_projection=' "$out.projection"
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$projection" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$projection_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$(sha256_path "$projection/.review-input/maintenance-manifest.json")" \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$maintenance_nonce" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$maintenance_project" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION=path-neutral-v1 \
      AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR="$projection_sidecar" \
      AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST=0000000000000000000000000000000000000000000000000000000000000000 \
      REVIEW_WRAPPER_TEST_OUT="$out.projection-tamper" \
      "$SELF" "must-fail-path-neutral-tamper" >/dev/null 2>&1; then
    echo "FAIL: path-neutral wrapper accepted a tampered sidecar binding" >&2
    return 1
  fi
  [ ! -e "$out.projection-tamper" ] || {
    echo "FAIL: path-neutral sidecar tamper reached the engine" >&2
    return 1
  }
  CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
    AGENT_KIT_REPO_ROOT="$composite_success" AGENT_KIT_REVIEW_BUNDLE=1 \
    AGENT_KIT_REVIEW_BUNDLE_DIGEST="$composite_inventory_digest" \
    AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
    AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$composite_digest" \
    AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$composite_nonce" \
    AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$composite_project" \
    REVIEW_WRAPPER_TEST_OUT="$out.composite" \
    "$SELF" "composite-maintenance-self-test-prompt"
  grep -qx 'maintenance_authorization=' "$out.composite"
  grep -qx 'maintenance_project_root=' "$out.composite"
  CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
    AGENT_KIT_REPO_ROOT="$composite_projection" AGENT_KIT_REVIEW_BUNDLE=1 \
    AGENT_KIT_REVIEW_BUNDLE_DIGEST="$composite_projection_inventory_digest" \
    AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
    AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$(sha256_path "$composite_projection/.review-input/maintenance-manifest.json")" \
    AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$composite_nonce" \
    AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$composite_project" \
    AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION=path-neutral-v1 \
    AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR="$composite_projection_sidecar" \
    AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST="$composite_projection_digest" \
    REVIEW_WRAPPER_TEST_OUT="$out.composite-projection" \
    "$SELF" "composite-path-neutral-self-test-prompt"
  grep -qx 'maintenance_authorization=' "$out.composite-projection"
  grep -qx 'maintenance_project_root=' "$out.composite-projection"
  grep -qx 'maintenance_sidecar=' "$out.composite-projection"
  grep -qx 'maintenance_projection=' "$out.composite-projection"
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$composite_projection_tamper" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$composite_projection_tamper_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$composite_projection_tamper_digest" \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$composite_nonce" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$composite_project" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION=path-neutral-v1 \
      AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR="$composite_projection_sidecar" \
      AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST="$composite_projection_digest" \
      REVIEW_WRAPPER_TEST_OUT="$out.composite-projection-tamper" \
      "$SELF" "must-fail-composite-projection-tamper" >/dev/null 2>&1; then
    echo "FAIL: composite path-neutral wrapper accepted projection tamper" >&2
    return 1
  fi
  [ ! -e "$out.composite-projection-tamper" ] || {
    echo "FAIL: composite projection tamper reached the engine" >&2
    return 1
  }
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$composite_projection" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$composite_projection_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$(sha256_path "$composite_projection/.review-input/maintenance-manifest.json")" \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$composite_nonce" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$composite_project" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION=path-neutral-v1 \
      REVIEW_WRAPPER_TEST_OUT="$out.composite-projection-partial" \
      "$SELF" "must-fail-composite-projection-partial" >/dev/null 2>&1; then
    echo "FAIL: partial composite path-neutral opt-in was accepted" >&2
    return 1
  fi
  [ ! -e "$out.composite-projection-partial" ] || {
    echo "FAIL: partial composite path-neutral opt-in reached the engine" >&2
    return 1
  }
  chmod u+w "$composite_projection_originals/.review-input/attestations/agent_policies-claude/upstream-release-attestation.json"
  printf ' ' >> "$composite_projection_originals/.review-input/attestations/agent_policies-claude/upstream-release-attestation.json"
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$composite_projection" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$composite_projection_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$(sha256_path "$composite_projection/.review-input/maintenance-manifest.json")" \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$composite_nonce" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$composite_project" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION=path-neutral-v1 \
      AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR="$composite_projection_sidecar" \
      AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST="$composite_projection_digest" \
      REVIEW_WRAPPER_TEST_OUT="$out.composite-original-tamper" \
      "$SELF" "must-fail-composite-original-tamper" >/dev/null 2>&1; then
    echo "FAIL: composite path-neutral wrapper accepted original artifact tamper" >&2
    return 1
  fi
  [ ! -e "$out.composite-original-tamper" ] || {
    echo "FAIL: composite original artifact tamper reached the engine" >&2
    return 1
  }
  expect_composite_failure() {
    local bundle="$1" label="$2" failure_out="$out.composite-$2"
    local manifest_digest inventory_digest
    manifest_digest="$(sha256_path "$bundle/.review-input/maintenance-manifest.json")"
    inventory_digest="$(sha256_path "$bundle/.review-input/bundle-inventory.json")"
    rm -f "$failure_out"
    if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
        AGENT_KIT_REPO_ROOT="$bundle" AGENT_KIT_REVIEW_BUNDLE=1 \
        AGENT_KIT_REVIEW_BUNDLE_DIGEST="$inventory_digest" \
        AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
        AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$manifest_digest" \
        AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$composite_nonce" \
        AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$composite_project" \
        REVIEW_WRAPPER_TEST_OUT="$failure_out" \
        "$SELF" "must-fail-$label" >/dev/null 2>&1; then
      echo "FAIL: composite wrapper accepted $label" >&2
      return 1
    fi
    [ ! -e "$failure_out" ] || {
      echo "FAIL: composite wrapper launched the engine for $label" >&2
      return 1
    }
  }
  for variant in \
    artifact-tamper digest-tamper unknown-field duplicate-set missing-set \
    cross-swap union-omission union-extra union-tamper mixed-overlap \
    ownership-omission ownership-extra ownership-tamper; do
    expect_composite_failure "$composite_parent/$variant" "$variant"
  done
  rm -f "$out.composite-partial"
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$composite_success" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$composite_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$composite_nonce" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$composite_project" \
      REVIEW_WRAPPER_TEST_OUT="$out.composite-partial" \
      "$SELF" "must-fail-partial-composite" >/dev/null 2>&1; then
    echo "FAIL: partial composite opt-in was accepted" >&2
    return 1
  fi
  [ ! -e "$out.composite-partial" ] || {
    echo "FAIL: partial composite opt-in reached the engine" >&2
    return 1
  }
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$maintenance_crosscheck" \
      AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$maintenance_crosscheck_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$maintenance_crosscheck_digest" \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$maintenance_nonce" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$maintenance_project" \
      REVIEW_WRAPPER_TEST_OUT="$out.maintenance-crosscheck" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: wrapper trusted ownership summaries over raw attestations" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$maintenance_unknown" \
      AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$maintenance_unknown_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$maintenance_unknown_digest" \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION="$maintenance_nonce" \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$maintenance_project" \
      REVIEW_WRAPPER_TEST_OUT="$out.maintenance-unknown" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: wrapper accepted an unknown attestation field" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$intersection" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$intersection_digest" \
      REVIEW_WRAPPER_TEST_OUT="$out.intersection" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: wrapper accepted a direct closure/patch intersection" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$maintenance" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$maintenance_inventory_digest" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="$maintenance_digest" \
      AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION=wrong-maintenance-nonce \
      AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT="$maintenance_project" \
      REVIEW_WRAPPER_TEST_OUT="$out.wrong-maintenance-nonce" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: wrapper accepted a wrong maintenance authorization" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$bad" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$digest" \
      REVIEW_WRAPPER_TEST_OUT="$out.bad" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: malformed review bundle accepted" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$repo" AGENT_KIT_REVIEW_BUNDLE=1 \
      REVIEW_WRAPPER_TEST_OUT="$out.missing-digest" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: review bundle without a bound digest was accepted" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$repo" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST=0000000000000000000000000000000000000000000000000000000000000000 \
      REVIEW_WRAPPER_TEST_OUT="$out.wrong-digest" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: review bundle with the wrong digest was accepted" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$missing" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$digest" \
      REVIEW_WRAPPER_TEST_OUT="$out.missing-manifest" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: review bundle missing its closure manifest was accepted" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$tampered" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$digest" \
      REVIEW_WRAPPER_TEST_OUT="$out.tampered" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: review bundle with a tampered manifest was accepted" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REPO_ROOT="$leaked" AGENT_KIT_REVIEW_BUNDLE=1 \
      AGENT_KIT_REVIEW_BUNDLE_DIGEST="$leaked_digest" \
      REVIEW_WRAPPER_TEST_OUT="$out.leaked" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: review bundle containing a closure path was accepted" >&2
    return 1
  fi
  if CLAUDE_BIN="$fake" CLAUDE_REVIEW_HOME="$review_home" \
      AGENT_KIT_REVIEW_BUNDLE_MODE=maintenance \
      REVIEW_WRAPPER_TEST_OUT="$out.partial-maintenance" \
      "$SELF" "must-fail" >/dev/null 2>&1; then
    echo "FAIL: partial maintenance opt-in was accepted" >&2
    return 1
  fi
  echo "SELF-TEST PASS"
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi
[ "$#" -eq 1 ] || { echo "usage: $0 <review-prompt>" >&2; exit 2; }

PROMPT=$1
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
REPO_ROOT="${AGENT_KIT_REPO_ROOT:-$PROJECT_ROOT}"
REVIEW_HOME="${CLAUDE_REVIEW_HOME:-${HOME:?HOME is required}/.claude-reviewer}"
CLAUDE_COMMAND="${CLAUDE_BIN:-claude}"

if [ "${AGENT_KIT_REVIEW_BUNDLE:-0}" != 1 ] && {
  [ "${AGENT_KIT_REVIEW_BUNDLE_MODE:-standard}" != standard ] ||
    [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_DIGEST:-}" ] ||
    [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION:-}" ] ||
    [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT:-}" ] ||
    [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION:-}" ] ||
    [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR:-}" ] ||
    [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST:-}" ]
}; then
  echo "maintenance review bindings require AGENT_KIT_REVIEW_BUNDLE=1" >&2
  exit 2
fi
case "${AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION:-}" in
  "")
    [ -z "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR:-}${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST:-}" ] || {
      echo "path-neutral maintenance sidecar bindings require projection opt-in" >&2
      exit 2
    }
    ;;
  path-neutral-v1)
    [ "${AGENT_KIT_REVIEW_BUNDLE_MODE:-standard}" = maintenance ] &&
      [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR:-}" ] &&
      [ -n "${AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST:-}" ] || {
        echo "path-neutral maintenance projection bindings are incomplete" >&2
        exit 2
      }
    ;;
  *) echo "unsupported maintenance review projection" >&2; exit 2 ;;
esac
if [ "${AGENT_KIT_REVIEW_BUNDLE:-0}" = 1 ]; then
  verify_review_bundle \
    "$REPO_ROOT" \
    "${AGENT_KIT_REVIEW_BUNDLE_DIGEST:-}" \
    "${AGENT_KIT_REVIEW_BUNDLE_MODE:-standard}" \
    "${AGENT_KIT_REVIEW_MAINTENANCE_DIGEST:-}" \
    "${AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION:-}" \
    "${AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT:-}" \
    "$KIT_NAME" || exit 2
fi

if [ ! -d "$REVIEW_HOME" ]; then
  echo "Claude reviewer home is missing: $REVIEW_HOME" >&2
  echo "Initialize it once with: mkdir -p \"$REVIEW_HOME\" && CLAUDE_CONFIG_DIR=\"$REVIEW_HOME\" claude auth login" >&2
  exit 2
fi

WORK="$(mktemp -d "$TMP_ROOT/agent-kit-claude-review.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM HUP
cd "$WORK"

ENV_UNSET_ARGS=(
  -u ANTHROPIC_BASE_URL
  -u AGENT_KIT_REVIEW_MAINTENANCE_AUTHORIZATION
  -u AGENT_KIT_REVIEW_MAINTENANCE_PROJECT_ROOT
  -u AGENT_KIT_REVIEW_MAINTENANCE_PROJECTION
  -u AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR
  -u AGENT_KIT_REVIEW_MAINTENANCE_SIDECAR_DIGEST
)
while IFS= read -r name; do
  case "$name" in
    ANTHROPIC_*|CLAUDE_CODE_*) ENV_UNSET_ARGS+=(-u "$name") ;;
  esac
done < <(compgen -e)

env "${ENV_UNSET_ARGS[@]}" \
AGENT_KIT_REVIEW_MODE=external \
AGENT_KIT_REVIEW_BUNDLE="${AGENT_KIT_REVIEW_BUNDLE:-0}" \
AGENT_KIT_REVIEW_BUNDLE_DIGEST="${AGENT_KIT_REVIEW_BUNDLE_DIGEST:-}" \
AGENT_KIT_REVIEW_BUNDLE_MODE="${AGENT_KIT_REVIEW_BUNDLE_MODE:-standard}" \
AGENT_KIT_REVIEW_MAINTENANCE_DIGEST="${AGENT_KIT_REVIEW_MAINTENANCE_DIGEST:-}" \
AGENT_KIT_REPO_ROOT="$REPO_ROOT" \
CLAUDE_CONFIG_DIR="$REVIEW_HOME" \
"$CLAUDE_COMMAND" \
  --safe-mode \
  -p \
  --permission-mode plan \
  --tools Read,Grep,Glob \
  --no-session-persistence \
  -- \
  "$PROMPT"
