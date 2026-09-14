"""Documented command-line interface for capture and package operations."""

from __future__ import annotations

import argparse
import sys
from typing import Any, Sequence

from .archive import build_package, verify_package
from .canonical import CaptureValidationError, canonical_bytes
from .runner import capture_command
from .verifier import verify_capture


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m generic_capture")
    subcommands = parser.add_subparsers(dest="command", required=True)

    capture = subcommands.add_parser("capture", help="execute one canonical request")
    capture.add_argument("--allowed-root", required=True)
    capture.add_argument("--request", required=True)
    capture.add_argument("--policy", required=True)

    verify = subcommands.add_parser("verify", help="independently verify one capture")
    verify.add_argument("--allowed-root", required=True)
    verify.add_argument("--request", required=True)
    verify.add_argument("--policy", required=True)
    verify.add_argument("--runner-package-root", required=True)
    verify.add_argument("--output")

    package = subcommands.add_parser("package", help="build a deterministic package")
    package.add_argument("--allowed-root", required=True)
    package.add_argument("--package-root", required=True)
    package.add_argument("--archive", required=True)

    package_verify = subcommands.add_parser(
        "verify-package", help="verify and optionally extract a deterministic package"
    )
    package_verify.add_argument("--allowed-root", required=True)
    package_verify.add_argument("--archive", required=True)
    package_verify.add_argument("--extract-root")
    return parser


def _emit(value: Any) -> None:
    sys.stdout.buffer.write(canonical_bytes(value))
    sys.stdout.buffer.flush()


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "capture":
            result = capture_command(
                allowed_root_text=arguments.allowed_root,
                request_path_text=arguments.request,
                policy_path_text=arguments.policy,
            )
            _emit(result)
            return 0 if result["expected_returncode"] else 65
        if arguments.command == "verify":
            _emit(
                verify_capture(
                    allowed_root_text=arguments.allowed_root,
                    request_path_text=arguments.request,
                    policy_path_text=arguments.policy,
                    runner_package_root_text=arguments.runner_package_root,
                    output_path_text=arguments.output,
                )
            )
            return 0
        if arguments.command == "package":
            _emit(
                build_package(
                    allowed_root_text=arguments.allowed_root,
                    package_root_text=arguments.package_root,
                    archive_path_text=arguments.archive,
                )
            )
            return 0
        if arguments.command == "verify-package":
            _emit(
                verify_package(
                    allowed_root_text=arguments.allowed_root,
                    archive_path_text=arguments.archive,
                    extract_root_text=arguments.extract_root,
                )
            )
            return 0
        raise AssertionError(arguments.command)
    except CaptureValidationError as exc:
        detail = f": {exc.detail}" if exc.detail else ""
        print(f"generic-capture: {exc.code}{detail}", file=sys.stderr)
        return 64
    except OSError as exc:
        print(f"generic-capture: operating_system_error: {exc.strerror or exc}", file=sys.stderr)
        return 74


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
