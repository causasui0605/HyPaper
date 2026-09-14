"""Independent verifier for immutable command captures."""

from __future__ import annotations

import hashlib
import os
import re
import stat
from pathlib import Path
from typing import Any

from . import CAPTURE_FILES, RUNTIME_FILES, SCHEMA_VERSION
from .canonical import (
    CaptureValidationError,
    canonical_bytes,
    exact_int,
    exact_keys,
    exact_string,
    parse_canonical_bytes,
    sha256_bytes,
    validate_request,
)
from .paths import (
    absent_path,
    existing_directory,
    existing_regular,
    physical_allowed_root,
)
from .policy import enforce_environment, validate_policy


_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
_RC_RE = re.compile(rb"-?(?:0|[1-9][0-9]*)\n\Z")
_BOUND_METADATA_KEYS = ("device", "inode", "mode", "nlink", "sha256", "size")


def _sha(value: Any, label: str) -> str:
    text = exact_string(value, label)
    if _SHA256_RE.fullmatch(text) is None:
        raise CaptureValidationError("invalid_sha256", label)
    return text


def _stat_fingerprint(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _stable_file_read(
    path: Path, label: str, *, retain_bytes: bool = False
) -> tuple[dict[str, int | str], bytes | None]:
    try:
        before = path.lstat()
    except FileNotFoundError as exc:
        raise CaptureValidationError("path_missing", label) from exc
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise CaptureValidationError("path_not_regular", label)
    if before.st_nlink != 1:
        raise CaptureValidationError("hardlink_rejected", label)

    digest = hashlib.sha256()
    retained: list[bytes] | None = [] if retain_bytes else None
    descriptor = -1
    try:
        descriptor = os.open(
            path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        )
        with os.fdopen(descriptor, "rb", buffering=0) as stream:
            descriptor = -1
            opened_before = os.fstat(stream.fileno())
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
                if retained is not None:
                    retained.append(block)
            opened_after = os.fstat(stream.fileno())
        after = path.lstat()
    except OSError as exc:
        raise CaptureValidationError("file_changed_during_verification", label) from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    state = _stat_fingerprint(before)
    if not (
        state
        == _stat_fingerprint(opened_before)
        == _stat_fingerprint(opened_after)
        == _stat_fingerprint(after)
    ):
        raise CaptureValidationError("file_changed_during_verification", label)
    fingerprint: dict[str, int | str] = {
        "ctime_ns": before.st_ctime_ns,
        "device": before.st_dev,
        "inode": before.st_ino,
        "mode": stat.S_IMODE(before.st_mode),
        "mtime_ns": before.st_mtime_ns,
        "nlink": before.st_nlink,
        "sha256": digest.hexdigest(),
        "size": before.st_size,
    }
    return fingerprint, b"".join(retained) if retained is not None else None


def _stable_file_fingerprint(path: Path, label: str) -> dict[str, int | str]:
    fingerprint, _ = _stable_file_read(path, label)
    return fingerprint


def _load_stable_canonical(
    path: Path, label: str
) -> tuple[Any, bytes, dict[str, int | str]]:
    fingerprint, data = _stable_file_read(path, label, retain_bytes=True)
    assert data is not None
    return parse_canonical_bytes(data, label), data, fingerprint


def _bound_metadata(fingerprint: dict[str, int | str]) -> dict[str, int | str]:
    return {key: fingerprint[key] for key in _BOUND_METADATA_KEYS}


def _directory_fingerprint(path: Path, label: str) -> dict[str, int]:
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise CaptureValidationError("path_missing", label) from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise CaptureValidationError("path_not_physical_directory", label)
    return {
        "ctime_ns": info.st_ctime_ns,
        "device": info.st_dev,
        "inode": info.st_ino,
        "mode": stat.S_IMODE(info.st_mode),
        "mtime_ns": info.st_mtime_ns,
        "nlink": info.st_nlink,
        "size": info.st_size,
    }


def _require_stable(initial: Any, final: Any, label: str) -> None:
    if final != initial:
        raise CaptureValidationError("verification_input_changed", label)


def _runtime_digest_independent(
    package_root: Path,
) -> tuple[str, dict[str, dict[str, int | str]]]:
    inventory: list[dict[str, Any]] = []
    fingerprints: dict[str, dict[str, int | str]] = {}
    for relative in RUNTIME_FILES:
        path = package_root / relative
        try:
            fingerprint = _stable_file_fingerprint(path, f"runtime.{relative}")
        except CaptureValidationError as exc:
            if exc.code == "path_not_regular":
                raise CaptureValidationError("runtime_member_not_regular", relative) from exc
            if exc.code == "hardlink_rejected":
                raise CaptureValidationError("runtime_member_hardlink", relative) from exc
            raise
        fingerprints[relative] = fingerprint
        inventory.append(
            {
                "mode": fingerprint["mode"],
                "path": relative,
                "sha256": fingerprint["sha256"],
                "size": fingerprint["size"],
            }
        )
    return sha256_bytes(canonical_bytes(inventory)), fingerprints


def _validate_metadata(value: Any, label: str) -> dict[str, int | str]:
    obj = exact_keys(
        value,
        ("device", "inode", "mode", "nlink", "sha256", "size"),
        label,
    )
    result: dict[str, int | str] = {
        "device": exact_int(obj["device"], f"{label}.device"),
        "inode": exact_int(obj["inode"], f"{label}.inode"),
        "mode": exact_int(obj["mode"], f"{label}.mode"),
        "nlink": exact_int(obj["nlink"], f"{label}.nlink"),
        "sha256": _sha(obj["sha256"], f"{label}.sha256"),
        "size": exact_int(obj["size"], f"{label}.size"),
    }
    return result


def _write_evidence(path: Path, data: bytes) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    try:
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.chmod(path, 0o444)


def verify_capture(
    *,
    allowed_root_text: str,
    request_path_text: str,
    policy_path_text: str,
    runner_package_root_text: str,
    output_path_text: str | None = None,
) -> dict[str, Any]:
    allowed_root = physical_allowed_root(allowed_root_text)
    allowed_root_fingerprint = _directory_fingerprint(allowed_root, "allowed_root")
    request_path, _ = existing_regular(request_path_text, allowed_root, "request")
    policy_path, _ = existing_regular(policy_path_text, allowed_root, "policy")
    runner_package_root, _ = existing_directory(
        runner_package_root_text, allowed_root, "runner_package"
    )
    runner_package_fingerprint = _directory_fingerprint(
        runner_package_root, "runner_package"
    )
    request_value, request_bytes, request_fingerprint = _load_stable_canonical(
        request_path, "request"
    )
    policy_value, _, policy_fingerprint = _load_stable_canonical(
        policy_path, "policy"
    )
    request = validate_request(request_value)
    policy = validate_policy(policy_value)
    enforce_environment(policy, request.environment, allowed_root)
    cwd, _ = existing_directory(request.cwd, allowed_root, "cwd")
    cwd_fingerprint = _directory_fingerprint(cwd, "cwd")
    capture_root, _ = existing_directory(
        request.capture_root, allowed_root, "capture_root"
    )
    capture_root_fingerprint = _directory_fingerprint(capture_root, "capture_root")
    if capture_root_fingerprint["mode"] != 0o555:
        raise CaptureValidationError("mode_mismatch", "capture_root")

    observed_names = sorted(path.name for path in capture_root.iterdir())
    if observed_names != sorted(CAPTURE_FILES):
        raise CaptureValidationError("capture_member_set_mismatch", ",".join(observed_names))

    initial_fingerprints = {
        name: _stable_file_fingerprint(capture_root / name, name)
        for name in CAPTURE_FILES
    }
    record_path = capture_root / "record.json"
    if initial_fingerprints["record.json"]["mode"] != 0o444:
        raise CaptureValidationError("mode_mismatch", "record.json")
    record_value, record_bytes, record_fingerprint = _load_stable_canonical(
        record_path, "record"
    )
    if record_fingerprint != initial_fingerprints["record.json"]:
        raise CaptureValidationError("capture_changed_during_verification", "record.json")
    record = exact_keys(
        record_value,
        (
            "argv_sha256",
            "capture_binding",
            "cwd_binding",
            "environment_keys",
            "environment_sha256",
            "expected_return_codes",
            "files",
            "invocation_id",
            "popen_count",
            "request_sha256",
            "retry_count",
            "returncode",
            "runtime_sha256",
            "schema_version",
        ),
        "record",
    )
    if exact_int(record["schema_version"], "record.schema_version") != SCHEMA_VERSION:
        raise CaptureValidationError("unsupported_schema_version", "record")
    if exact_string(record["invocation_id"], "record.invocation_id") != request.invocation_id:
        raise CaptureValidationError("invocation_binding_mismatch")
    if exact_int(record["popen_count"], "record.popen_count") != 1:
        raise CaptureValidationError("popen_count_mismatch")
    if exact_int(record["retry_count"], "record.retry_count") != 0:
        raise CaptureValidationError("retry_count_mismatch")
    if _sha(record["request_sha256"], "record.request_sha256") != sha256_bytes(request_bytes):
        raise CaptureValidationError("request_digest_mismatch")
    if _sha(record["argv_sha256"], "record.argv_sha256") != sha256_bytes(
        canonical_bytes(list(request.argv))
    ):
        raise CaptureValidationError("argv_digest_mismatch")
    if _sha(record["environment_sha256"], "record.environment_sha256") != sha256_bytes(
        canonical_bytes(request.environment)
    ):
        raise CaptureValidationError("environment_digest_mismatch")
    if record["environment_keys"] != sorted(request.environment):
        raise CaptureValidationError("environment_keys_mismatch")
    if record["expected_return_codes"] != list(request.expected_return_codes):
        raise CaptureValidationError("expected_return_codes_mismatch")

    cwd_identity = {
        "device": cwd_fingerprint["device"],
        "inode": cwd_fingerprint["inode"],
        "mode": cwd_fingerprint["mode"],
    }
    expected_cwd = {**cwd_identity, "sha256": sha256_bytes(canonical_bytes(cwd_identity))}
    cwd_record = exact_keys(
        record["cwd_binding"], ("device", "inode", "mode", "sha256"), "record.cwd_binding"
    )
    for key in ("device", "inode", "mode"):
        exact_int(cwd_record[key], f"record.cwd_binding.{key}")
    _sha(cwd_record["sha256"], "record.cwd_binding.sha256")
    if cwd_record != expected_cwd:
        raise CaptureValidationError("cwd_binding_mismatch")

    capture_binding = exact_keys(
        record["capture_binding"], ("device", "inode", "mode"), "record.capture_binding"
    )
    expected_capture_binding = {
        "device": capture_root_fingerprint["device"],
        "inode": capture_root_fingerprint["inode"],
        "mode": capture_root_fingerprint["mode"],
    }
    for key in expected_capture_binding:
        exact_int(capture_binding[key], f"record.capture_binding.{key}")
    if capture_binding != expected_capture_binding:
        raise CaptureValidationError("capture_binding_mismatch")

    runtime_digest, runtime_fingerprints = _runtime_digest_independent(
        runner_package_root
    )
    if _sha(record["runtime_sha256"], "record.runtime_sha256") != runtime_digest:
        raise CaptureValidationError("runtime_digest_mismatch")

    files = exact_keys(record["files"], ("stdout.bin", "stderr.bin", "rc.txt"), "record.files")
    for name in ("stdout.bin", "stderr.bin", "rc.txt"):
        expected_metadata = _validate_metadata(files[name], f"record.files.{name}")
        observed_metadata = _bound_metadata(initial_fingerprints[name])
        if observed_metadata != expected_metadata:
            raise CaptureValidationError("capture_metadata_mismatch", name)
        if observed_metadata["mode"] != 0o444:
            raise CaptureValidationError("mode_mismatch", name)
    rc_fingerprint, rc_data = _stable_file_read(
        capture_root / "rc.txt", "rc.txt", retain_bytes=True
    )
    if rc_fingerprint != initial_fingerprints["rc.txt"]:
        raise CaptureValidationError("capture_changed_during_verification", "rc.txt")
    assert rc_data is not None
    rc_bytes = rc_data
    if _RC_RE.fullmatch(rc_bytes) is None:
        raise CaptureValidationError("invalid_rc_file")
    returncode = int(rc_bytes[:-1].decode("ascii"))
    if exact_int(record["returncode"], "record.returncode") != returncode:
        raise CaptureValidationError("returncode_binding_mismatch")
    if returncode not in request.expected_return_codes:
        raise CaptureValidationError("unexpected_returncode", str(returncode))

    registry, _ = existing_directory(
        str(allowed_root / ".generic-capture-invocations"),
        allowed_root,
        "invocation_registry",
    )
    registry_fingerprint = _directory_fingerprint(registry, "invocation_registry")
    marker_path = registry / f"{sha256_bytes(request.invocation_id.encode('utf-8'))}.json"
    marker_value, _, marker_fingerprint = _load_stable_canonical(
        marker_path, "invocation_marker"
    )
    if marker_fingerprint["mode"] != 0o444:
        raise CaptureValidationError("mode_mismatch", "invocation_marker")
    marker = exact_keys(
        marker_value,
        ("capture_root_sha256", "invocation_id", "request_sha256", "schema_version"),
        "invocation_marker",
    )
    expected_marker = {
        "capture_root_sha256": sha256_bytes(request.capture_root.encode("utf-8")),
        "invocation_id": request.invocation_id,
        "request_sha256": sha256_bytes(request_bytes),
        "schema_version": SCHEMA_VERSION,
    }
    if marker != expected_marker:
        raise CaptureValidationError("invocation_marker_mismatch")

    _require_stable(
        request_fingerprint,
        _stable_file_fingerprint(request_path, "request"),
        "request",
    )
    _require_stable(
        policy_fingerprint,
        _stable_file_fingerprint(policy_path, "policy"),
        "policy",
    )
    _require_stable(cwd_fingerprint, _directory_fingerprint(cwd, "cwd"), "cwd")
    _require_stable(
        capture_root_fingerprint,
        _directory_fingerprint(capture_root, "capture_root"),
        "capture_root",
    )
    _require_stable(
        observed_names,
        sorted(path.name for path in capture_root.iterdir()),
        "capture_member_set",
    )
    _require_stable(
        marker_fingerprint,
        _stable_file_fingerprint(marker_path, "invocation_marker"),
        "invocation_marker",
    )
    _require_stable(
        registry_fingerprint,
        _directory_fingerprint(registry, "invocation_registry"),
        "invocation_registry",
    )
    final_runtime_digest, final_runtime_fingerprints = _runtime_digest_independent(
        runner_package_root
    )
    _require_stable(runtime_digest, final_runtime_digest, "runtime_digest")
    _require_stable(
        runtime_fingerprints, final_runtime_fingerprints, "runtime_members"
    )
    _require_stable(
        runner_package_fingerprint,
        _directory_fingerprint(runner_package_root, "runner_package"),
        "runner_package",
    )
    _require_stable(
        allowed_root_fingerprint,
        _directory_fingerprint(allowed_root, "allowed_root"),
        "allowed_root",
    )

    final_fingerprints = {
        name: _stable_file_fingerprint(capture_root / name, name)
        for name in CAPTURE_FILES
    }
    if final_fingerprints != initial_fingerprints:
        raise CaptureValidationError("capture_changed_during_verification")
    if parse_canonical_bytes(record_bytes, "record") != record_value:
        raise CaptureValidationError("record_reparse_mismatch")

    result = {
        "capture_fingerprint_sha256": sha256_bytes(
            canonical_bytes(
                {
                    name: _bound_metadata(fingerprint)
                    for name, fingerprint in initial_fingerprints.items()
                }
            )
        ),
        "environment_keys": sorted(request.environment),
        "invocation_id": request.invocation_id,
        "marker_sha256": marker_fingerprint["sha256"],
        "popen_count": 1,
        "record_sha256": initial_fingerprints["record.json"]["sha256"],
        "request_sha256": sha256_bytes(request_bytes),
        "retry_count": 0,
        "returncode": returncode,
        "runtime_sha256": runtime_digest,
        "schema_version": SCHEMA_VERSION,
        "state": "verified",
    }
    if output_path_text is not None:
        output_path = absent_path(output_path_text, allowed_root, "verification_output")
        _write_evidence(output_path, canonical_bytes(result))
    return result
