from __future__ import annotations

import json
import unittest
from pathlib import Path

from generic_capture.canonical import CaptureValidationError
from generic_capture.policy import enforce_environment, validate_policy
from generic_capture.tests.support import SSH_COMMAND, fixture_environment, temporary_root


class EnvironmentPolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = temporary_root("generic-capture-policy-")
        self.root = Path(self.temporary.name)
        fixture_path = Path(__file__).resolve().parent / "fixtures" / "environment-policy.json"
        self.policy_value = json.loads(fixture_path.read_text(encoding="utf-8"))
        self.policy = validate_policy(self.policy_value)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_m11_p01_git_ssh_command_is_accepted_as_opaque_exact_value(self) -> None:
        environment = fixture_environment(self.root)
        self.assertEqual(environment["GIT_SSH_COMMAND"], SSH_COMMAND)
        enforce_environment(self.policy, environment, self.root)

    def test_git_ssh_command_must_match_exact_sanitized_value(self) -> None:
        environment = fixture_environment(self.root)
        environment["GIT_SSH_COMMAND"] = "ssh -o BatchMode=no"
        with self.assertRaisesRegex(CaptureValidationError, "environment_value_rejected"):
            enforce_environment(self.policy, environment, self.root)

    def test_home_escape_rejected_without_reinterpreting_opaque_values(self) -> None:
        environment = fixture_environment(self.root)
        environment["HOME"] = "/tmp"
        with self.assertRaisesRegex(CaptureValidationError, "path_escape"):
            enforce_environment(self.policy, environment, self.root)

    def test_symlink_environment_path_rejected(self) -> None:
        environment = fixture_environment(self.root)
        outside = self.root.parent / f"{self.root.name}-outside"
        outside.mkdir()
        link = self.root / "linked-home"
        link.symlink_to(outside, target_is_directory=True)
        environment["HOME"] = str(link)
        try:
            with self.assertRaisesRegex(CaptureValidationError, "path_not_physical_directory"):
                enforce_environment(self.policy, environment, self.root)
        finally:
            link.unlink()
            outside.rmdir()

    def test_missing_and_undeclared_keys_rejected(self) -> None:
        environment = fixture_environment(self.root)
        del environment["TMPDIR"]
        with self.assertRaisesRegex(CaptureValidationError, "missing_environment_key"):
            enforce_environment(self.policy, environment, self.root)
        environment = fixture_environment(self.root)
        environment["EXTRA"] = "value"
        with self.assertRaisesRegex(CaptureValidationError, "undeclared_environment_key"):
            enforce_environment(self.policy, environment, self.root)

    def test_unknown_policy_rule_and_boolean_version_rejected(self) -> None:
        value = dict(self.policy_value)
        value["schema_version"] = True
        with self.assertRaisesRegex(CaptureValidationError, "wrong_json_type"):
            validate_policy(value)
        value = json.loads(json.dumps(self.policy_value))
        value["environment"]["PATH"] = {"kind": "filesystem_guess"}
        with self.assertRaisesRegex(CaptureValidationError, "unsupported_environment_rule"):
            validate_policy(value)


if __name__ == "__main__":
    unittest.main()
