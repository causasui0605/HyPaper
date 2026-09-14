"""Persistent, policy-separated arbitrary command capture."""

from __future__ import annotations

SCHEMA_VERSION = 1
CAPTURE_FILES = ("stdout.bin", "stderr.bin", "rc.txt", "record.json")
RUNTIME_FILES = (
    "__init__.py",
    "__main__.py",
    "archive.py",
    "canonical.py",
    "cli.py",
    "paths.py",
    "policy.py",
    "runner.py",
    "verifier.py",
)

__all__ = ["CAPTURE_FILES", "RUNTIME_FILES", "SCHEMA_VERSION"]
