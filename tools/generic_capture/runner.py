"""One-shot public command-capture runner."""

from __future__ import annotations

import hashlib
import os
import stat
import subprocess
from pathlib import Path
from typing import Any

from . import RUNTIME_FILES, SCHEMA_VERSION
from .canonical import (
    CaptureValidationError,
    canonical_bytes,
    load_canonical,
    sha256_bytes,
    validate_request,
)
from .paths import (
    absent_path,
    existing_directory,
    existing_regular,
    physical_allowed_root,
    regular_metadata,
)
from .policy import enforce_environment, validate_policy


READ_ONLY_MODE = 0o444
CAPTURE_DIRECTORY_MODE = 0o555


def _write_exclusive(path: Path, data: bytes, mode: int = 0o600) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, mode)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
    finally:
        os.close(descriptor)


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb", buffering=0) as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _runtime_digest(package_root: Path) -> str:
    members: list[dict[str, Any]] = []
    for name in RUNTIME_FILES:
        path = package_root / name
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise CaptureValidationError("runtime_member_not_regular", name)
        members.append(
            {
                "mode": stat.S_IMODE(info.st_mode),
                "path": name,
                "sha256": _file_digest(path),
                "size": info.st_size,
            }
        )
    return sha256_bytes(canonical_bytes(members))


def _cwd_binding(info: os.stat_result) -> dict[str, int | str]:
    identity: dict[str, int] = {
        "device": info.st_dev,
        "inode": info.st_ino,
        "mode": stat.S_IMODE(info.st_mode),
    }
    return {**identity, "sha256": sha256_bytes(canonical_bytes(identity))}


def _capture_file_metadata(path: Path, label: str) -> dict[str, int | str]:
    metadata = regular_metadata(path, label, required_mode=READ_ONLY_MODE)
    metadata["sha256"] = _file_digest(path)
    return metadata


def _fsync_directory(path: Path) -> None:
    flags = os.O_RDONLY
    if hasattr(os, "O_DIRECTORY"):
        flags |= os.O_DIRECTORY
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def capture_command(
    *, allowed_root_text: str, request_path_text: str, policy_path_text: str
) -> dict[str, Any]:
    """Validate one request and execute exactly one accepted subprocess."""

    allowed_root = physical_allowed_root(allowed_root_text)
    request_path, _ = existing_regular(request_path_text, allowed_root, "request")
    policy_path, _ = existing_regular(policy_path_text, allowed_root, "policy")
    request_value, request_bytes = load_canonical(request_path, "request")
    policy_value, _ = load_canonical(policy_path, "policy")
    request = validate_request(request_value)
    policy = validate_policy(policy_value)

    cwd, cwd_info = existing_directory(request.cwd, allowed_root, "cwd")
    capture_root = absent_path(request.capture_root, allowed_root, "capture_root")
    enforce_environment(policy, request.environment, allowed_root)

    package_root, _ = existing_directory(
        str(Path(__file__).absolute().parent), allowed_root, "runtime_package"
    )
    runtime_sha256 = _runtime_digest(package_root)
    request_sha256 = sha256_bytes(request_bytes)
    argv_sha256 = sha256_bytes(canonical_bytes(list(request.argv)))
    environment_sha256 = sha256_bytes(canonical_bytes(request.environment))

    registry = allowed_root / ".generic-capture-invocations"
    try:
        registry.mkdir(mode=0o700)
    except FileExistsError:
        existing_directory(str(registry), allowed_root, "invocation_registry")
    marker_path = registry / f"{sha256_bytes(request.invocation_id.encode('utf-8'))}.json"
    marker = {
        "capture_root_sha256": sha256_bytes(request.capture_root.encode("utf-8")),
        "invocation_id": request.invocation_id,
        "request_sha256": request_sha256,
        "schema_version": SCHEMA_VERSION,
    }
    try:
        _write_exclusive(marker_path, canonical_bytes(marker))
    except FileExistsError as exc:
        raise CaptureValidationError("duplicate_invocation", request.invocation_id) from exc
    os.chmod(marker_path, READ_ONLY_MODE)
    _fsync_directory(registry)

    capture_root.mkdir(mode=0o700)
    stdout_path = capture_root / "stdout.bin"
    stderr_path = capture_root / "stderr.bin"
    stdout_fd = os.open(
        stdout_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    stderr_fd = os.open(
        stderr_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    process: subprocess.Popen[bytes] | None = None
    try:
        with os.fdopen(stdout_fd, "wb", buffering=0, closefd=True) as stdout_stream, os.fdopen(
            stderr_fd, "wb", buffering=0, closefd=True
        ) as stderr_stream:
            process = subprocess.Popen(
                list(request.argv),
                shell=False,
                cwd=str(cwd),
                env=dict(request.environment),
                stdout=stdout_stream,
                stderr=stderr_stream,
                close_fds=True,
            )
            returncode = process.wait()
            os.fsync(stdout_stream.fileno())
            os.fsync(stderr_stream.fileno())
    except BaseException:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        raise

    rc_path = capture_root / "rc.txt"
    _write_exclusive(rc_path, f"{returncode}\n".encode("ascii"))
    for path in (stdout_path, stderr_path, rc_path):
        os.chmod(path, READ_ONLY_MODE)

    capture_info = capture_root.lstat()
    record = {
        "argv_sha256": argv_sha256,
        "capture_binding": {
            "device": capture_info.st_dev,
            "inode": capture_info.st_ino,
            "mode": CAPTURE_DIRECTORY_MODE,
        },
        "cwd_binding": _cwd_binding(cwd_info),
        "environment_keys": sorted(request.environment),
        "environment_sha256": environment_sha256,
        "expected_return_codes": list(request.expected_return_codes),
        "files": {
            "rc.txt": _capture_file_metadata(rc_path, "rc.txt"),
            "stderr.bin": _capture_file_metadata(stderr_path, "stderr.bin"),
            "stdout.bin": _capture_file_metadata(stdout_path, "stdout.bin"),
        },
        "invocation_id": request.invocation_id,
        "popen_count": 1,
        "request_sha256": request_sha256,
        "retry_count": 0,
        "returncode": returncode,
        "runtime_sha256": runtime_sha256,
        "schema_version": SCHEMA_VERSION,
    }
    temporary_record = capture_root / ".record.json.tmp"
    _write_exclusive(temporary_record, canonical_bytes(record))
    os.chmod(temporary_record, READ_ONLY_MODE)
    record_path = capture_root / "record.json"
    os.replace(temporary_record, record_path)
    _fsync_directory(capture_root)
    os.chmod(capture_root, CAPTURE_DIRECTORY_MODE)
    _fsync_directory(capture_root.parent)

    expected = returncode in request.expected_return_codes
    return {
        "expected_returncode": expected,
        "invocation_id": request.invocation_id,
        "popen_count": 1,
        "record_sha256": _file_digest(record_path),
        "retry_count": 0,
        "returncode": returncode,
        "schema_version": SCHEMA_VERSION,
        "state": "captured" if expected else "unexpected_returncode",
    }
