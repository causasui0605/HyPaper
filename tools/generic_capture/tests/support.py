"""Disposable fixture construction through the documented public CLI."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

from generic_capture.canonical import canonical_bytes


PACKAGE_SOURCE = Path(__file__).resolve().parents[1]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"


class _PhysicalTemporaryDirectory:
    """Temporary directory on a filesystem that preserves strict capture modes."""

    def __init__(self, prefix: str) -> None:
        parent = _select_temporary_parent()
        self._temporary = tempfile.TemporaryDirectory(prefix=prefix, dir=parent)
        try:
            self.name = str(Path(self._temporary.name).resolve(strict=True))
        except Exception:
            self._temporary.cleanup()
            raise

    def __enter__(self) -> str:
        return self.name

    def __exit__(self, *_exc: object) -> None:
        self.cleanup()

    def cleanup(self) -> None:
        self._temporary.cleanup()


def temporary_root(prefix: str = "generic-capture-test-") -> _PhysicalTemporaryDirectory:
    return _PhysicalTemporaryDirectory(prefix)


def _candidate_temporary_parents() -> tuple[Path, ...]:
    raw_candidates = [tempfile.gettempdir()]
    if os.name == "posix":
        raw_candidates.extend(("/tmp", "/var/tmp"))

    candidates: list[Path] = []
    for raw_candidate in raw_candidates:
        try:
            candidate = Path(raw_candidate).resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if candidate.is_dir() and candidate not in candidates:
            candidates.append(candidate)
    return tuple(candidates)


def _supports_exact_capture_modes(parent: Path) -> bool:
    probe = Path(tempfile.mkdtemp(prefix=".generic-capture-mode-probe-", dir=parent))
    probe_file = probe / "capture.bin"
    descriptor = -1
    try:
        descriptor = os.open(
            probe_file,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        os.close(descriptor)
        descriptor = -1
        probe_file.chmod(0o444)
        probe.chmod(0o555)
        return (
            stat.S_IMODE(probe_file.lstat().st_mode) == 0o444
            and stat.S_IMODE(probe.lstat().st_mode) == 0o555
        )
    except OSError:
        return False
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            probe.chmod(0o700)
        except OSError:
            pass
        try:
            probe_file.chmod(0o600)
        except OSError:
            pass
        try:
            probe_file.unlink()
        except FileNotFoundError:
            pass
        probe.rmdir()


def _select_temporary_parent() -> str:
    candidates = _candidate_temporary_parents()
    for candidate in candidates:
        if _supports_exact_capture_modes(candidate):
            return str(candidate)
    attempted = ",".join(str(candidate) for candidate in candidates) or "none"
    raise RuntimeError(
        "no physical temporary filesystem preserves exact 0444/0555 modes: "
        f"{attempted}"
    )


def copy_package(root: Path, parent_name: str) -> tuple[Path, Path]:
    parent = root / parent_name
    parent.mkdir(mode=0o700)
    package = parent / "generic_capture"
    shutil.copytree(
        PACKAGE_SOURCE,
        package,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )
    return parent, package


def cli(
    package_parent: Path,
    arguments: Sequence[str],
    *,
    cwd: Path | None = None,
    check: bool = False,
) -> subprocess.CompletedProcess[bytes]:
    environment = {
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": str(package_parent),
    }
    return subprocess.run(
        [sys.executable, "-m", "generic_capture", *arguments],
        cwd=str(cwd or package_parent),
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def parse_stdout(result: subprocess.CompletedProcess[bytes]) -> dict[str, Any]:
    return json.loads(result.stdout.decode("utf-8"))


def write_canonical(path: Path, value: Any, mode: int = 0o644) -> None:
    path.write_bytes(canonical_bytes(value))
    path.chmod(mode)


def fixture_environment(root: Path) -> dict[str, str]:
    home = root / "home"
    temporary = root / "tmp"
    home.mkdir(exist_ok=True)
    temporary.mkdir(exist_ok=True)
    return {
        "GIT_SSH_COMMAND": SSH_COMMAND,
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": str(home),
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "TMPDIR": str(temporary),
    }


def install_policy(root: Path, name: str = "policy.json") -> Path:
    destination = root / name
    shutil.copyfile(FIXTURES / "environment-policy.json", destination)
    destination.chmod(0o644)
    return destination


def fixture_executable(root: Path, name: str = "fixture-command") -> Path:
    directory = root / "bin"
    directory.mkdir(exist_ok=True)
    destination = directory / name
    shutil.copyfile(FIXTURES / "command_fixture.py", destination)
    destination.chmod(0o755)
    return destination


def request_value(
    root: Path,
    executable: Path,
    *,
    invocation_id: str = "invocation-001",
    arguments: Sequence[str] = (),
    cwd: Path | None = None,
    environment: dict[str, str] | None = None,
    expected_return_codes: Sequence[int] = (0,),
    capture_name: str = "capture",
) -> dict[str, Any]:
    working = cwd or root / "working directory with spaces"
    working.mkdir(exist_ok=True)
    return {
        "argv": [str(executable), *arguments],
        "capture_root": str(root / capture_name),
        "cwd": str(working),
        "environment": environment or fixture_environment(root),
        "expected_return_codes": list(expected_return_codes),
        "invocation_id": invocation_id,
        "schema_version": 1,
    }


def capture_fixture(
    root: Path,
    *,
    name: str = "fixture-command",
    invocation_id: str = "invocation-001",
    arguments: Sequence[str] = (),
    expected_return_codes: Sequence[int] = (0,),
    capture_name: str = "capture",
    package_parent_name: str = "runner-package",
) -> dict[str, Any]:
    package_parent, package = copy_package(root, package_parent_name)
    policy = install_policy(root)
    executable = fixture_executable(root, name)
    request = root / "request.json"
    value = request_value(
        root,
        executable,
        invocation_id=invocation_id,
        arguments=arguments,
        expected_return_codes=expected_return_codes,
        capture_name=capture_name,
    )
    write_canonical(request, value)
    result = cli(
        package_parent,
        [
            "capture",
            "--allowed-root",
            str(root),
            "--request",
            str(request),
            "--policy",
            str(policy),
        ],
    )
    return {
        "executable": executable,
        "package": package,
        "package_parent": package_parent,
        "policy": policy,
        "request": request,
        "request_value": value,
        "result": result,
    }


def make_mutable_capture(root: Path, capture_name: str = "capture") -> Path:
    capture = root / capture_name
    capture.chmod(0o700)
    return capture


def replace_file(path: Path, data: bytes, mode: int = 0o444) -> None:
    path.chmod(0o600)
    path.unlink()
    replacement = path.with_name(f".{path.name}.replacement")
    replacement.write_bytes(data)
    replacement.chmod(mode)
    replacement.replace(path)
