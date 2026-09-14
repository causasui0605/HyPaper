#!/usr/bin/env python3
"""Local-only command shim used under executable-like basenames."""

from __future__ import annotations

import argparse
import os
import sys


parser = argparse.ArgumentParser()
parser.add_argument("--stdout", default="")
parser.add_argument("--stderr", default="")
parser.add_argument("--stdout-hex", default="")
parser.add_argument("--stderr-hex", default="")
parser.add_argument("--repeat-size", type=int, default=0)
parser.add_argument("--exit", type=int, default=0)
parser.add_argument("--environment-key")
arguments = parser.parse_args()

stdout = arguments.stdout.encode("utf-8") + bytes.fromhex(arguments.stdout_hex)
stderr = arguments.stderr.encode("utf-8") + bytes.fromhex(arguments.stderr_hex)
if arguments.repeat_size:
    stdout += (b"0123456789abcdef" * ((arguments.repeat_size + 15) // 16))[
        : arguments.repeat_size
    ]
    stderr += (b"fedcba9876543210" * ((arguments.repeat_size + 15) // 16))[
        : arguments.repeat_size
    ]
if arguments.environment_key:
    stdout += os.environ[arguments.environment_key].encode("utf-8")
os.write(sys.stdout.fileno(), stdout)
os.write(sys.stderr.fileno(), stderr)
raise SystemExit(arguments.exit)
