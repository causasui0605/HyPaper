"""Strict canonical JSON and schema primitives used by the public interfaces."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from . import SCHEMA_VERSION


class CaptureValidationError(ValueError):
    """A stable, caller-visible validation rejection."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise CaptureValidationError("duplicate_json_key", key)
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise CaptureValidationError("nonfinite_json_number", value)


def canonical_bytes(value: Any) -> bytes:
    try:
        body = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as exc:
        raise CaptureValidationError("json_not_serializable", str(exc)) from exc
    return body.encode("utf-8") + b"\n"


def parse_canonical_bytes(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise CaptureValidationError("invalid_utf8", label) from exc
    try:
        value = json.loads(
            text,
            object_pairs_hook=_unique_object,
            parse_constant=_reject_constant,
        )
    except CaptureValidationError:
        raise
    except json.JSONDecodeError as exc:
        raise CaptureValidationError("invalid_json", f"{label}:{exc.msg}") from exc
    if canonical_bytes(value) != data:
        raise CaptureValidationError("noncanonical_json", label)
    return value


def load_canonical(path: Path, label: str) -> tuple[Any, bytes]:
    data = path.read_bytes()
    return parse_canonical_bytes(data, label), data


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def exact_keys(value: Any, keys: Iterable[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise CaptureValidationError("wrong_json_type", f"{label}:object")
    expected = set(keys)
    observed = set(value)
    if observed != expected:
        missing = ",".join(sorted(expected - observed)) or "-"
        extra = ",".join(sorted(observed - expected)) or "-"
        raise CaptureValidationError(
            "json_keys_mismatch", f"{label}:missing={missing}:extra={extra}"
        )
    return value


def exact_int(value: Any, label: str) -> int:
    if type(value) is not int:
        raise CaptureValidationError("wrong_json_type", f"{label}:integer")
    return value


def exact_string(value: Any, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str):
        raise CaptureValidationError("wrong_json_type", f"{label}:string")
    if not allow_empty and value == "":
        raise CaptureValidationError("empty_string", label)
    if "\x00" in value:
        raise CaptureValidationError("nul_in_string", label)
    return value


_INVOCATION_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
_ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


@dataclass(frozen=True)
class CaptureRequest:
    schema_version: int
    invocation_id: str
    argv: tuple[str, ...]
    cwd: str
    environment: dict[str, str]
    expected_return_codes: tuple[int, ...]
    capture_root: str


def validate_request(value: Any) -> CaptureRequest:
    obj = exact_keys(
        value,
        (
            "schema_version",
            "invocation_id",
            "argv",
            "cwd",
            "environment",
            "expected_return_codes",
            "capture_root",
        ),
        "request",
    )
    version = exact_int(obj["schema_version"], "request.schema_version")
    if version != SCHEMA_VERSION:
        raise CaptureValidationError("unsupported_schema_version", str(version))
    invocation_id = exact_string(obj["invocation_id"], "request.invocation_id")
    if _INVOCATION_RE.fullmatch(invocation_id) is None:
        raise CaptureValidationError("invalid_invocation_id", invocation_id)

    raw_argv = obj["argv"]
    if not isinstance(raw_argv, list) or not raw_argv:
        raise CaptureValidationError("invalid_argv", "nonempty_array_required")
    argv = tuple(exact_string(item, f"request.argv[{index}]") for index, item in enumerate(raw_argv))

    cwd = exact_string(obj["cwd"], "request.cwd")
    capture_root = exact_string(obj["capture_root"], "request.capture_root")

    raw_env = obj["environment"]
    if not isinstance(raw_env, dict):
        raise CaptureValidationError("wrong_json_type", "request.environment:object")
    environment: dict[str, str] = {}
    for key, raw_value in raw_env.items():
        if not isinstance(key, str) or _ENV_KEY_RE.fullmatch(key) is None:
            raise CaptureValidationError("invalid_environment_key", repr(key))
        environment[key] = exact_string(
            raw_value, f"request.environment.{key}", allow_empty=True
        )

    raw_codes = obj["expected_return_codes"]
    if not isinstance(raw_codes, list) or not raw_codes:
        raise CaptureValidationError(
            "invalid_expected_return_codes", "nonempty_array_required"
        )
    codes = tuple(
        exact_int(item, f"request.expected_return_codes[{index}]")
        for index, item in enumerate(raw_codes)
    )
    if any(code < -255 or code > 255 for code in codes):
        raise CaptureValidationError("invalid_expected_return_codes", "range")
    if list(codes) != sorted(set(codes)):
        raise CaptureValidationError(
            "invalid_expected_return_codes", "sorted_unique_required"
        )

    return CaptureRequest(
        schema_version=version,
        invocation_id=invocation_id,
        argv=argv,
        cwd=cwd,
        environment=environment,
        expected_return_codes=codes,
        capture_root=capture_root,
    )
