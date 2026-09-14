"""Caller-owned, key-aware environment policy validation."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import SCHEMA_VERSION
from .canonical import (
    CaptureValidationError,
    exact_int,
    exact_keys,
    exact_string,
)
from .paths import existing_directory


_ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")


@dataclass(frozen=True)
class EnvironmentRule:
    kind: str
    values: tuple[str, ...] = ()


@dataclass(frozen=True)
class RequestPolicy:
    schema_version: int
    required_environment_keys: tuple[str, ...]
    environment: dict[str, EnvironmentRule]


def validate_policy(value: Any) -> RequestPolicy:
    obj = exact_keys(
        value,
        ("schema_version", "required_environment_keys", "environment"),
        "policy",
    )
    version = exact_int(obj["schema_version"], "policy.schema_version")
    if version != SCHEMA_VERSION:
        raise CaptureValidationError("unsupported_schema_version", str(version))

    raw_environment = obj["environment"]
    if not isinstance(raw_environment, dict) or not raw_environment:
        raise CaptureValidationError("invalid_environment_policy", "nonempty_object_required")
    environment: dict[str, EnvironmentRule] = {}
    for key, raw_rule in raw_environment.items():
        if not isinstance(key, str) or _ENV_KEY_RE.fullmatch(key) is None:
            raise CaptureValidationError("invalid_environment_key", repr(key))
        if not isinstance(raw_rule, dict) or "kind" not in raw_rule:
            raise CaptureValidationError("invalid_environment_rule", key)
        kind = exact_string(raw_rule["kind"], f"policy.environment.{key}.kind")
        if kind == "path_under_allowed_root":
            exact_keys(raw_rule, ("kind",), f"policy.environment.{key}")
            environment[key] = EnvironmentRule(kind=kind)
        elif kind == "exact":
            exact_keys(raw_rule, ("kind", "values"), f"policy.environment.{key}")
            raw_values = raw_rule["values"]
            if not isinstance(raw_values, list) or not raw_values:
                raise CaptureValidationError("invalid_environment_rule", f"{key}:values")
            values = tuple(
                exact_string(item, f"policy.environment.{key}.values[{index}]", allow_empty=True)
                for index, item in enumerate(raw_values)
            )
            if list(values) != sorted(set(values)):
                raise CaptureValidationError(
                    "invalid_environment_rule", f"{key}:sorted_unique_values_required"
                )
            environment[key] = EnvironmentRule(kind=kind, values=values)
        else:
            raise CaptureValidationError("unsupported_environment_rule", f"{key}:{kind}")

    raw_required = obj["required_environment_keys"]
    if not isinstance(raw_required, list):
        raise CaptureValidationError(
            "wrong_json_type", "policy.required_environment_keys:array"
        )
    required = tuple(
        exact_string(item, f"policy.required_environment_keys[{index}]")
        for index, item in enumerate(raw_required)
    )
    if list(required) != sorted(set(required)):
        raise CaptureValidationError(
            "invalid_required_environment_keys", "sorted_unique_required"
        )
    unknown = set(required) - set(environment)
    if unknown:
        raise CaptureValidationError(
            "invalid_required_environment_keys", ",".join(sorted(unknown))
        )
    return RequestPolicy(version, required, environment)


def enforce_environment(
    policy: RequestPolicy, environment: dict[str, str], allowed_root: Path
) -> None:
    keys = set(environment)
    missing = set(policy.required_environment_keys) - keys
    extra = keys - set(policy.environment)
    if missing:
        raise CaptureValidationError("missing_environment_key", ",".join(sorted(missing)))
    if extra:
        raise CaptureValidationError("undeclared_environment_key", ",".join(sorted(extra)))
    for key, value in environment.items():
        rule = policy.environment[key]
        if rule.kind == "exact":
            if value not in rule.values:
                raise CaptureValidationError("environment_value_rejected", key)
        elif rule.kind == "path_under_allowed_root":
            existing_directory(value, allowed_root, f"environment.{key}")
        else:  # pragma: no cover - validate_policy makes this unreachable
            raise CaptureValidationError("unsupported_environment_rule", key)
