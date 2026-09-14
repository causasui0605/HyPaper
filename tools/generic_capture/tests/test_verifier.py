from __future__ import annotations

import json
import os
import stat
import unittest
from pathlib import Path
from unittest import mock

from generic_capture import verifier as verifier_module
from generic_capture.canonical import CaptureValidationError, canonical_bytes
from generic_capture.tests.support import (
    capture_fixture,
    cli,
    copy_package,
    make_mutable_capture,
    parse_stdout,
    replace_file,
    temporary_root,
    write_canonical,
)


class VerifierTests(unittest.TestCase):
    def _case(self, root: Path) -> dict[str, object]:
        case = capture_fixture(
            root,
            arguments=("--stdout", "stdout-value", "--stderr", "stderr-value"),
        )
        self.assertEqual(case["result"].returncode, 0, case["result"].stderr)
        verifier_parent, _ = copy_package(root, "verifier-package")
        case["verifier_parent"] = verifier_parent
        return case

    def _verify(
        self, root: Path, case: dict[str, object], output: Path | None = None
    ):
        arguments = [
            "verify",
            "--allowed-root",
            str(root),
            "--request",
            str(case["request"]),
            "--policy",
            str(case["policy"]),
            "--runner-package-root",
            str(case["package"]),
        ]
        if output is not None:
            arguments.extend(("--output", str(output)))
        return cli(case["verifier_parent"], arguments)

    def _verify_direct(self, root: Path, case: dict[str, object]) -> dict[str, object]:
        return verifier_module.verify_capture(
            allowed_root_text=str(root),
            request_path_text=str(case["request"]),
            policy_path_text=str(case["policy"]),
            runner_package_root_text=str(case["package"]),
        )

    def _replace_same_file(self, path: Path) -> None:
        replace_file(
            path,
            path.read_bytes(),
            mode=stat.S_IMODE(path.stat().st_mode),
        )

    def test_valid_capture_independently_verifies_with_evidence_output(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            output = root / "verification.json"
            result = self._verify(root, case, output)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = parse_stdout(result)
            self.assertEqual(summary["state"], "verified")
            self.assertEqual(summary["popen_count"], 1)
            self.assertEqual(summary["retry_count"], 0)
            self.assertEqual(output.read_bytes(), canonical_bytes(summary))
            self.assertEqual(output.stat().st_mode & 0o777, 0o444)

    def test_stream_digest_drift_same_size_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            stdout = capture / "stdout.bin"
            replace_file(stdout, b"Stdout-value")
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_metadata_mismatch", result.stderr)

    def test_stream_size_drift_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            replace_file(capture / "stderr.bin", b"longer-stderr-value")
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_metadata_mismatch", result.stderr)

    def test_missing_and_unexpected_empty_required_stream_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            (capture / "stderr.bin").chmod(0o600)
            (capture / "stderr.bin").unlink()
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_member_set_mismatch", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            replace_file(capture / "stderr.bin", b"")
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_metadata_mismatch", result.stderr)

    def test_swapped_streams_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            stdout = (capture / "stdout.bin").read_bytes()
            stderr = (capture / "stderr.bin").read_bytes()
            replace_file(capture / "stdout.bin", stderr)
            replace_file(capture / "stderr.bin", stdout)
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_metadata_mismatch", result.stderr)

    def test_invalid_and_unexpected_rc_rejected(self) -> None:
        for rc_bytes in (b"true\n", b"3\n"):
            with self.subTest(rc=rc_bytes), temporary_root() as name:
                root = Path(name)
                case = self._case(root)
                capture = make_mutable_capture(root)
                replace_file(capture / "rc.txt", rc_bytes)
                capture.chmod(0o555)
                result = self._verify(root, case)
                self.assertEqual(result.returncode, 64)
                self.assertTrue(
                    b"capture_metadata_mismatch" in result.stderr
                    or b"invalid_rc_file" in result.stderr
                    or b"unexpected_returncode" in result.stderr
                )

    def test_tampered_record_json_and_duplicate_key_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            record_path = capture / "record.json"
            record = json.loads(record_path.read_bytes())
            record["popen_count"] = False
            replace_file(record_path, canonical_bytes(record))
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"wrong_json_type", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            record_path = capture / "record.json"
            replace_file(record_path, b'{"schema_version":1,"schema_version":1}\n')
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"duplicate_json_key", result.stderr)

    def test_boolean_returncode_and_record_binding_drift_rejected(self) -> None:
        mutations = (
            ("boolean-returncode", lambda record: record.__setitem__("returncode", False), b"wrong_json_type"),
            ("argv", lambda record: record.__setitem__("argv_sha256", "0" * 64), b"argv_digest_mismatch"),
            (
                "environment",
                lambda record: record.__setitem__("environment_sha256", "0" * 64),
                b"environment_digest_mismatch",
            ),
            (
                "runtime",
                lambda record: record.__setitem__("runtime_sha256", "0" * 64),
                b"runtime_digest_mismatch",
            ),
            (
                "device",
                lambda record: record["files"]["stdout.bin"].__setitem__(
                    "device", record["files"]["stdout.bin"]["device"] + 1
                ),
                b"capture_metadata_mismatch",
            ),
        )
        for label, mutate, expected in mutations:
            with self.subTest(binding=label), temporary_root() as name:
                root = Path(name)
                case = self._case(root)
                capture = make_mutable_capture(root)
                record_path = capture / "record.json"
                record = json.loads(record_path.read_bytes())
                mutate(record)
                replace_file(record_path, canonical_bytes(record))
                capture.chmod(0o555)
                result = self._verify(root, case)
                self.assertEqual(result.returncode, 64)
                self.assertIn(expected, result.stderr)

    def test_capture_symlink_hardlink_and_fifo_rejected(self) -> None:
        for kind in ("symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind), temporary_root() as name:
                root = Path(name)
                case = self._case(root)
                capture = make_mutable_capture(root)
                stdout = capture / "stdout.bin"
                stdout.chmod(0o600)
                stdout.unlink()
                target = root / "special-target"
                if kind == "symlink":
                    target.write_bytes(b"stdout-value")
                    stdout.symlink_to(target)
                elif kind == "hardlink":
                    target.write_bytes(b"stdout-value")
                    target.chmod(0o444)
                    os.link(target, stdout)
                else:
                    os.mkfifo(stdout, 0o444)
                capture.chmod(0o555)
                result = self._verify(root, case)
                self.assertEqual(result.returncode, 64)
                expected = {
                    "symlink": b"path_not_regular",
                    "hardlink": b"hardlink_rejected",
                    "fifo": b"path_not_regular",
                }[kind]
                self.assertIn(expected, result.stderr)

    def test_mode_and_inode_drift_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            (capture / "stdout.bin").chmod(0o644)
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_metadata_mismatch", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            stdout = capture / "stdout.bin"
            original_inode = stdout.stat().st_ino
            replace_file(stdout, stdout.read_bytes())
            self.assertNotEqual(stdout.stat().st_ino, original_inode)
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_metadata_mismatch", result.stderr)

    def test_runtime_request_and_cwd_binding_drift_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            runner = Path(case["package"]) / "runner.py"
            runner.write_text(runner.read_text(encoding="utf-8") + "\n# drift\n", encoding="utf-8")
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"runtime_digest_mismatch", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            request = dict(case["request_value"])
            request["argv"] = [*request["argv"], "--stdout", "changed"]
            write_canonical(Path(case["request"]), request)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"request_digest_mismatch", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            cwd = Path(case["request_value"]["cwd"])
            old = cwd.with_name("old-working-directory")
            cwd.rename(old)
            cwd.mkdir()
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"cwd_binding_mismatch", result.stderr)

    def test_runtime_member_mutation_during_hash_is_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            runtime_member = Path(case["package"]) / "__init__.py"
            original_fstat = verifier_module.os.fstat
            fstat_calls = 0

            def mutate_before_path_recheck(descriptor: int):
                nonlocal fstat_calls
                info = original_fstat(descriptor)
                fstat_calls += 1
                if fstat_calls == 2:
                    self._replace_same_file(runtime_member)
                return info

            with mock.patch.object(
                verifier_module.os, "fstat", side_effect=mutate_before_path_recheck
            ):
                with self.assertRaisesRegex(
                    CaptureValidationError,
                    "file_changed_during_verification: runtime.__init__.py",
                ):
                    verifier_module._runtime_digest_independent(Path(case["package"]))

    def test_bound_inputs_changed_after_initial_use_are_rejected(self) -> None:
        for label in ("request", "policy", "cwd", "capture_root", "runtime_members"):
            with self.subTest(binding=label), temporary_root() as name:
                root = Path(name)
                case = self._case(root)

                def mutate() -> None:
                    if label == "request":
                        self._replace_same_file(Path(case["request"]))
                    elif label == "policy":
                        self._replace_same_file(Path(case["policy"]))
                    elif label == "cwd":
                        request = case["request_value"]
                        assert isinstance(request, dict)
                        path = Path(request["cwd"])
                        info = path.stat()
                        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns - 1))
                    elif label == "capture_root":
                        path = root / "capture"
                        info = path.stat()
                        os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns - 1))
                    else:
                        self._replace_same_file(Path(case["package"]) / "runner.py")

                original_runtime_digest = verifier_module._runtime_digest_independent
                digest_calls = 0

                def mutate_after_initial_runtime(package_root: Path):
                    nonlocal digest_calls
                    result = original_runtime_digest(package_root)
                    digest_calls += 1
                    if digest_calls == 1:
                        mutate()
                    return result

                with mock.patch.object(
                    verifier_module,
                    "_runtime_digest_independent",
                    side_effect=mutate_after_initial_runtime,
                ):
                    with self.assertRaisesRegex(
                        CaptureValidationError,
                        f"verification_input_changed: {label}",
                    ):
                        self._verify_direct(root, case)

    def test_invocation_marker_changed_after_load_is_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            original_load = verifier_module._load_stable_canonical
            marker_mutated = False

            def mutate_after_marker_load(path: Path, label: str):
                nonlocal marker_mutated
                result = original_load(path, label)
                if label == "invocation_marker" and not marker_mutated:
                    self._replace_same_file(path)
                    marker_mutated = True
                return result

            with mock.patch.object(
                verifier_module,
                "_load_stable_canonical",
                side_effect=mutate_after_marker_load,
            ):
                with self.assertRaisesRegex(
                    CaptureValidationError,
                    "verification_input_changed: invocation_marker",
                ):
                    self._verify_direct(root, case)

    def test_extra_member_and_preexisting_evidence_output_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            capture = make_mutable_capture(root)
            (capture / "extra.bin").write_bytes(b"extra")
            (capture / "extra.bin").chmod(0o444)
            capture.chmod(0o555)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"capture_member_set_mismatch", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            output = root / "verification.json"
            output.write_bytes(b"preexisting")
            result = self._verify(root, case, output)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_already_exists", result.stderr)

    def test_runner_package_and_evidence_output_escape_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._case(root)
            result = cli(
                case["verifier_parent"],
                [
                    "verify",
                    "--allowed-root",
                    str(root),
                    "--request",
                    str(case["request"]),
                    "--policy",
                    str(case["policy"]),
                    "--runner-package-root",
                    str(Path(__file__).resolve().parents[1]),
                ],
            )
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_escape", result.stderr)

            result = self._verify(
                root,
                case,
                root.parent / f"{root.name}-forbidden-evidence.json",
            )
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_escape", result.stderr)


if __name__ == "__main__":
    unittest.main()
