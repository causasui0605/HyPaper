"""Repeatable fresh-extraction qualification using only the public CLI."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

from generic_capture.canonical import canonical_bytes
from generic_capture.tests.support import SSH_COMMAND, cli, copy_package


def _require_success(result: subprocess.CompletedProcess[bytes], label: str) -> dict[str, Any]:
    if result.returncode != 0:
        raise RuntimeError(
            f"{label} failed rc={result.returncode}: {result.stderr.decode('utf-8', 'replace')}"
        )
    return json.loads(result.stdout.decode("utf-8"))


def qualify(work_root: Path) -> dict[str, Any]:
    if not work_root.is_absolute() or work_root.resolve() != work_root:
        raise RuntimeError("work root must be an absolute physical path")
    if not work_root.is_dir() or any(work_root.iterdir()):
        raise RuntimeError("work root must be an existing empty directory")

    staging_parent, staging_package = copy_package(work_root, "staging")
    archive = work_root / "generic-capture.tar.gz"
    build = _require_success(
        cli(
            staging_parent,
            [
                "package",
                "--allowed-root",
                str(work_root),
                "--package-root",
                str(staging_package),
                "--archive",
                str(archive),
            ],
        ),
        "package build",
    )
    extraction = work_root / "extracted"
    package_verification = _require_success(
        cli(
            staging_parent,
            [
                "verify-package",
                "--allowed-root",
                str(work_root),
                "--archive",
                str(archive),
                "--extract-root",
                str(extraction),
            ],
        ),
        "package verification",
    )

    # This request and every input it names are created only after extraction.
    extracted_package = extraction / "generic_capture"
    executable_directory = work_root / "fixture-bin"
    executable_directory.mkdir(mode=0o700)
    executable = executable_directory / "git"
    shutil.copyfile(
        extracted_package / "tests" / "fixtures" / "command_fixture.py", executable
    )
    executable.chmod(0o755)
    policy = work_root / "policy.json"
    shutil.copyfile(
        extracted_package / "tests" / "fixtures" / "environment-policy.json", policy
    )
    policy.chmod(0o644)
    cwd = work_root / "post extraction cwd with spaces"
    home = work_root / "home"
    temporary = work_root / "tmp"
    cwd.mkdir()
    home.mkdir()
    temporary.mkdir()
    request = work_root / "post-extraction-request.json"
    request_value = {
        "argv": [
            str(executable),
            "--stdout",
            "post-extraction",
            "--stderr-hex",
            "00ff",
            "--environment-key",
            "GIT_SSH_COMMAND",
        ],
        "capture_root": str(work_root / "capture"),
        "cwd": str(cwd),
        "environment": {
            "GIT_SSH_COMMAND": SSH_COMMAND,
            "GIT_TERMINAL_PROMPT": "0",
            "HOME": str(home),
            "PATH": "/usr/bin:/bin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TMPDIR": str(temporary),
        },
        "expected_return_codes": [0],
        "invocation_id": "post-extraction-m11-p01",
        "schema_version": 1,
    }
    request.write_bytes(canonical_bytes(request_value))
    request.chmod(0o644)

    extracted_parent = extraction
    capture = _require_success(
        cli(
            extracted_parent,
            [
                "capture",
                "--allowed-root",
                str(work_root),
                "--request",
                str(request),
                "--policy",
                str(policy),
            ],
        ),
        "post-extraction capture",
    )
    verification_output = work_root / "verification.json"
    verification = _require_success(
        cli(
            extracted_parent,
            [
                "verify",
                "--allowed-root",
                str(work_root),
                "--request",
                str(request),
                "--policy",
                str(policy),
                "--runner-package-root",
                str(extracted_package),
                "--output",
                str(verification_output),
            ],
        ),
        "post-extraction capture verification",
    )
    if (work_root / "capture" / "stdout.bin").read_bytes() != (
        b"post-extraction" + SSH_COMMAND.encode("utf-8")
    ):
        raise RuntimeError("post-extraction stdout mismatch")
    if (work_root / "capture" / "stderr.bin").read_bytes() != b"\x00\xff":
        raise RuntimeError("post-extraction stderr mismatch")

    return {
        "archive_bytes": build["archive_bytes"],
        "archive_sha256": build["archive_sha256"],
        "capture_fingerprint_sha256": verification["capture_fingerprint_sha256"],
        "manifest_sha256": package_verification["manifest_sha256"],
        "member_count": package_verification["member_count"],
        "m11_p01_git_ssh_command": "accepted_as_exact_opaque_value",
        "popen_count": capture["popen_count"],
        "post_extraction_request": True,
        "prohibited_operation_counts": {
            "container": 0,
            "credential": 0,
            "gateway_or_service": 0,
            "model": 0,
            "network": 0,
            "repository": 0,
            "reviewer": 0,
        },
        "retry_count": capture["retry_count"],
        "runtime_sha256": verification["runtime_sha256"],
        "schema_version": 1,
        "state": "qualification_passed",
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-root", required=True)
    arguments = parser.parse_args(argv)
    try:
        result = qualify(Path(arguments.work_root))
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"qualification failed: {exc}", file=sys.stderr)
        return 1
    sys.stdout.buffer.write(canonical_bytes(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
