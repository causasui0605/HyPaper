from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from generic_capture.paths import physical_allowed_root
from generic_capture.tests import support
from generic_capture.tests.support import temporary_root


class FreshExtractionIntegrationTests(unittest.TestCase):
    def _qualification(self, root: Path) -> dict[str, object]:
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "generic_capture.tests.qualification",
                "--work-root",
                str(root),
            ],
            env={
                "PATH": "/usr/bin:/bin",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONPATH": "tools",
            },
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout.decode("utf-8"))

    def test_new_request_after_fresh_extraction_uses_public_cli(self) -> None:
        with temporary_root("generic-capture-qualification-") as name:
            root = Path(name)
            summary = self._qualification(root)
            self.assertEqual(summary["state"], "qualification_passed")
            self.assertTrue(summary["post_extraction_request"])
            self.assertEqual(
                summary["m11_p01_git_ssh_command"], "accepted_as_exact_opaque_value"
            )
            self.assertEqual(summary["popen_count"], 1)
            self.assertEqual(summary["retry_count"], 0)
            self.assertTrue((root / "extracted" / "generic_capture" / "__main__.py").is_file())
            self.assertGreaterEqual(
                (root / "post-extraction-request.json").stat().st_mtime_ns,
                (root / "generic-capture.tar.gz").stat().st_mtime_ns,
            )
            self.assertEqual(set(summary["prohibited_operation_counts"].values()), {0})

    def test_complete_fresh_extraction_qualification_is_repeatable(self) -> None:
        with temporary_root("generic-capture-repeat-a-") as first_name, temporary_root(
            "generic-capture-repeat-b-"
        ) as second_name:
            first = self._qualification(Path(first_name))
            second = self._qualification(Path(second_name))
            for key in ("archive_bytes", "archive_sha256", "manifest_sha256", "member_count", "runtime_sha256"):
                self.assertEqual(first[key], second[key], key)

    def test_temporary_root_returns_physical_path_through_symlink_parent(self) -> None:
        with temporary_root("generic-capture-physical-parent-") as outer_name:
            outer = Path(outer_name)
            physical_parent = outer / "physical"
            physical_parent.mkdir()
            alias_parent = outer / "alias"
            alias_parent.symlink_to(physical_parent, target_is_directory=True)

            with mock.patch.object(tempfile, "tempdir", str(alias_parent)):
                with temporary_root("generic-capture-symlink-parent-") as name:
                    root = Path(name)
                    self.assertEqual(root, root.resolve(strict=True))
                    self.assertEqual(root.parent, physical_parent)
                    self.assertEqual(physical_allowed_root(name), root)

    def test_temporary_root_skips_parent_without_exact_mode_support(self) -> None:
        with temporary_root("generic-capture-mode-selection-") as outer_name:
            outer = Path(outer_name)
            incompatible = outer / "drvfs-like"
            compatible = outer / "posix"
            incompatible.mkdir()
            compatible.mkdir()

            def capability(candidate: Path) -> bool:
                return candidate == compatible

            with mock.patch.object(
                support,
                "_candidate_temporary_parents",
                return_value=(incompatible, compatible),
            ), mock.patch.object(
                support,
                "_supports_exact_capture_modes",
                side_effect=capability,
            ) as probe:
                with temporary_root("generic-capture-selected-") as name:
                    root = Path(name)
                    self.assertEqual(root.parent, compatible)
                    self.assertEqual(physical_allowed_root(name), root)
            self.assertEqual(
                [call.args[0] for call in probe.call_args_list],
                [incompatible, compatible],
            )


if __name__ == "__main__":
    unittest.main()
