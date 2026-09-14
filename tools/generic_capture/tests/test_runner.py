from __future__ import annotations

import json
import os
import stat
import unittest
from pathlib import Path

from generic_capture.tests.support import (
    SSH_COMMAND,
    capture_fixture,
    cli,
    copy_package,
    fixture_environment,
    fixture_executable,
    install_policy,
    parse_stdout,
    request_value,
    temporary_root,
    write_canonical,
)


class RunnerTests(unittest.TestCase):
    def test_public_runner_has_one_popen_callsite_and_no_shell_path(self) -> None:
        runner_source = (Path(__file__).resolve().parents[1] / "runner.py").read_text(
            encoding="utf-8"
        )
        self.assertEqual(runner_source.count("subprocess.Popen("), 1)
        self.assertIn("shell=False", runner_source)
        self.assertNotIn("shell=True", runner_source)
        self.assertNotIn("tee", runner_source)

    def test_argv_options_cwd_spaces_explicit_environment_and_rc_zero(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = capture_fixture(
                root,
                arguments=(
                    "--stdout",
                    "alpha value",
                    "--stderr",
                    "beta value",
                    "--environment-key",
                    "GIT_TERMINAL_PROMPT",
                ),
            )
            self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
            capture = root / "capture"
            self.assertEqual((capture / "stdout.bin").read_bytes(), b"alpha value0")
            self.assertEqual((capture / "stderr.bin").read_bytes(), b"beta value")
            summary = parse_stdout(case["result"])
            self.assertEqual(summary["popen_count"], 1)
            self.assertEqual(summary["retry_count"], 0)
            self.assertEqual(summary["returncode"], 0)

    def test_predeclared_returncode_three(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = capture_fixture(
                root,
                arguments=("--exit", "3"),
                expected_return_codes=(0, 3),
            )
            self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
            self.assertEqual((root / "capture" / "rc.txt").read_bytes(), b"3\n")

    def test_empty_streams(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = capture_fixture(root)
            self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
            self.assertEqual((root / "capture" / "stdout.bin").stat().st_size, 0)
            self.assertEqual((root / "capture" / "stderr.bin").stat().st_size, 0)

    def test_binary_streams(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = capture_fixture(
                root,
                arguments=("--stdout-hex", "00ff10", "--stderr-hex", "fe0080"),
            )
            self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
            self.assertEqual((root / "capture" / "stdout.bin").read_bytes(), b"\x00\xff\x10")
            self.assertEqual((root / "capture" / "stderr.bin").read_bytes(), b"\xfe\x00\x80")

    def test_output_above_pipe_buffer_on_both_streams(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            size = 1024 * 1024
            case = capture_fixture(root, arguments=("--repeat-size", str(size)))
            self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
            self.assertEqual((root / "capture" / "stdout.bin").stat().st_size, size)
            self.assertEqual((root / "capture" / "stderr.bin").stat().st_size, size)

    def test_executable_like_basenames_are_local_shims(self) -> None:
        for index, executable_name in enumerate(("git", "bash", "codex", "upgrade.sh")):
            with self.subTest(executable=executable_name), temporary_root() as name:
                root = Path(name)
                case = capture_fixture(
                    root,
                    name=executable_name,
                    invocation_id=f"basename-{index}",
                    arguments=("--stdout", executable_name),
                )
                self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
                self.assertEqual((root / "capture" / "stdout.bin").read_text(), executable_name)

    def test_duplicate_invocation_is_rejected_before_second_capture(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = capture_fixture(root, invocation_id="duplicate-001")
            self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
            second_value = dict(case["request_value"])
            second_value["capture_root"] = str(root / "second-capture")
            write_canonical(case["request"], second_value)
            second = cli(
                case["package_parent"],
                [
                    "capture",
                    "--allowed-root",
                    str(root),
                    "--request",
                    str(case["request"]),
                    "--policy",
                    str(case["policy"]),
                ],
            )
            self.assertEqual(second.returncode, 64)
            self.assertIn(b"duplicate_invocation", second.stderr)
            self.assertFalse((root / "second-capture").exists())

    def test_preexisting_capture_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            package_parent, _ = copy_package(root, "runner-package")
            policy = install_policy(root)
            executable = fixture_executable(root)
            (root / "capture").mkdir()
            request = root / "request.json"
            write_canonical(request, request_value(root, executable))
            result = cli(
                package_parent,
                ["capture", "--allowed-root", str(root), "--request", str(request), "--policy", str(policy)],
            )
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_already_exists", result.stderr)

    def test_cwd_and_capture_escape_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            package_parent, _ = copy_package(root, "runner-package")
            policy = install_policy(root)
            executable = fixture_executable(root)
            request = root / "request.json"
            value = request_value(root, executable)
            value["cwd"] = "/tmp"
            write_canonical(request, value)
            result = cli(
                package_parent,
                ["capture", "--allowed-root", str(root), "--request", str(request), "--policy", str(policy)],
            )
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_escape", result.stderr)

            value = request_value(root, executable, invocation_id="escape-002")
            value["capture_root"] = "/tmp/generic-capture-forbidden-output"
            write_canonical(request, value)
            result = cli(
                package_parent,
                ["capture", "--allowed-root", str(root), "--request", str(request), "--policy", str(policy)],
            )
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_escape", result.stderr)

    def test_symlink_cwd_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            package_parent, _ = copy_package(root, "runner-package")
            policy = install_policy(root)
            executable = fixture_executable(root)
            outside = root.parent / f"{root.name}-outside"
            outside.mkdir()
            linked = root / "linked-cwd"
            linked.symlink_to(outside, target_is_directory=True)
            request = root / "request.json"
            write_canonical(request, request_value(root, executable, cwd=linked))
            try:
                result = cli(
                    package_parent,
                    ["capture", "--allowed-root", str(root), "--request", str(request), "--policy", str(policy)],
                )
                self.assertEqual(result.returncode, 64)
                self.assertIn(b"path_not_physical_directory", result.stderr)
            finally:
                linked.unlink()
                outside.rmdir()

    def test_symlink_hardlink_and_fifo_request_files_rejected(self) -> None:
        for kind in ("symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind), temporary_root() as name:
                root = Path(name)
                package_parent, _ = copy_package(root, "runner-package")
                policy = install_policy(root)
                executable = fixture_executable(root)
                target = root / "request-target.json"
                write_canonical(target, request_value(root, executable))
                request = root / "request.json"
                if kind == "symlink":
                    request.symlink_to(target)
                elif kind == "hardlink":
                    request.hardlink_to(target)
                else:
                    target.unlink()
                    os.mkfifo(request)
                result = cli(
                    package_parent,
                    ["capture", "--allowed-root", str(root), "--request", str(request), "--policy", str(policy)],
                )
                self.assertEqual(result.returncode, 64)
                expected = {
                    "symlink": b"path_not_regular",
                    "hardlink": b"hardlink_rejected",
                    "fifo": b"path_not_regular",
                }[kind]
                self.assertIn(expected, result.stderr)

    def test_unexpected_returncode_is_captured_once_and_reported(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = capture_fixture(root, arguments=("--exit", "3"))
            self.assertEqual(case["result"].returncode, 65)
            summary = parse_stdout(case["result"])
            self.assertEqual(summary["state"], "unexpected_returncode")
            self.assertEqual(summary["popen_count"], 1)
            self.assertEqual((root / "capture" / "rc.txt").read_bytes(), b"3\n")

    def test_sanitized_record_omits_raw_environment_values(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = capture_fixture(root)
            self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
            record_bytes = (root / "capture" / "record.json").read_bytes()
            self.assertNotIn(SSH_COMMAND.encode("utf-8"), record_bytes)
            self.assertNotIn(str(root / "home").encode("utf-8"), record_bytes)
            record = json.loads(record_bytes)
            self.assertEqual(record["environment_keys"], sorted(fixture_environment(root)))
            for path in ("stdout.bin", "stderr.bin", "rc.txt", "record.json"):
                info = (root / "capture" / path).lstat()
                self.assertTrue(stat.S_ISREG(info.st_mode))
                self.assertEqual(stat.S_IMODE(info.st_mode), 0o444)
                self.assertEqual(info.st_nlink, 1)
            self.assertEqual(stat.S_IMODE((root / "capture").lstat().st_mode), 0o555)


if __name__ == "__main__":
    unittest.main()
