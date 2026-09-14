from __future__ import annotations

import unittest

from generic_capture.canonical import (
    CaptureValidationError,
    canonical_bytes,
    parse_canonical_bytes,
    validate_request,
)


class CanonicalJsonTests(unittest.TestCase):
    def test_round_trip_canonical_utf8(self) -> None:
        value = {"alpha": "汉字", "number": 3}
        self.assertEqual(parse_canonical_bytes(canonical_bytes(value), "value"), value)

    def test_duplicate_key_rejected(self) -> None:
        with self.assertRaisesRegex(CaptureValidationError, "duplicate_json_key"):
            parse_canonical_bytes(b'{"a":1,"a":2}\n', "duplicate")

    def test_invalid_utf8_rejected(self) -> None:
        with self.assertRaisesRegex(CaptureValidationError, "invalid_utf8"):
            parse_canonical_bytes(b'{"a":"\xff"}\n', "utf8")

    def test_noncanonical_spacing_rejected(self) -> None:
        with self.assertRaisesRegex(CaptureValidationError, "noncanonical_json"):
            parse_canonical_bytes(b'{"a": 1}\n', "spacing")

    def test_missing_terminal_lf_rejected(self) -> None:
        with self.assertRaisesRegex(CaptureValidationError, "noncanonical_json"):
            parse_canonical_bytes(b'{"a":1}', "lf")

    def test_nan_and_infinity_rejected(self) -> None:
        for token in (b"NaN", b"Infinity", b"-Infinity"):
            with self.subTest(token=token), self.assertRaisesRegex(
                CaptureValidationError, "nonfinite_json_number"
            ):
                parse_canonical_bytes(b'{"a":' + token + b"}\n", "number")

    def test_request_unknown_key_rejected(self) -> None:
        request = self._request()
        request["unknown"] = True
        with self.assertRaisesRegex(CaptureValidationError, "json_keys_mismatch"):
            validate_request(request)

    def test_request_missing_key_rejected(self) -> None:
        request = self._request()
        del request["cwd"]
        with self.assertRaisesRegex(CaptureValidationError, "json_keys_mismatch"):
            validate_request(request)

    def test_boolean_integer_rejected(self) -> None:
        request = self._request()
        request["schema_version"] = True
        with self.assertRaisesRegex(CaptureValidationError, "wrong_json_type"):
            validate_request(request)
        request = self._request()
        request["expected_return_codes"] = [False]
        with self.assertRaisesRegex(CaptureValidationError, "wrong_json_type"):
            validate_request(request)

    def test_empty_argv_and_shell_string_rejected(self) -> None:
        request = self._request()
        request["argv"] = []
        with self.assertRaisesRegex(CaptureValidationError, "invalid_argv"):
            validate_request(request)
        request["argv"] = "command --option"
        with self.assertRaisesRegex(CaptureValidationError, "invalid_argv"):
            validate_request(request)

    def test_expected_codes_must_be_sorted_unique(self) -> None:
        request = self._request()
        request["expected_return_codes"] = [3, 0, 3]
        with self.assertRaisesRegex(CaptureValidationError, "sorted_unique_required"):
            validate_request(request)

    @staticmethod
    def _request() -> dict[str, object]:
        return {
            "argv": ["/bin/true"],
            "capture_root": "/tmp/capture",
            "cwd": "/tmp",
            "environment": {},
            "expected_return_codes": [0],
            "invocation_id": "unit-001",
            "schema_version": 1,
        }


if __name__ == "__main__":
    unittest.main()
