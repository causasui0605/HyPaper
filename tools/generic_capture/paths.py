"""Physical-path containment and file identity checks."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from .canonical import CaptureValidationError


def _absolute_lexical(path_text: str, label: str) -> Path:
    path = Path(path_text)
    if not path.is_absolute():
        raise CaptureValidationError("path_not_absolute", label)
    normalized = os.path.normpath(path_text)
    if normalized != path_text:
        raise CaptureValidationError("path_not_canonical", label)
    return path


def _beneath(path: Path, root: Path, label: str, *, allow_equal: bool = False) -> None:
    try:
        relative = path.relative_to(root)
    except ValueError as exc:
        raise CaptureValidationError("path_escape", label) from exc
    if not allow_equal and relative == Path("."):
        raise CaptureValidationError("path_must_be_child", label)


def physical_allowed_root(path_text: str) -> Path:
    path = _absolute_lexical(path_text, "allowed_root")
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise CaptureValidationError("path_missing", "allowed_root") from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise CaptureValidationError("path_not_physical_directory", "allowed_root")
    if Path(os.path.realpath(path)) != path:
        raise CaptureValidationError("path_not_physical", "allowed_root")
    return path


def existing_directory(
    path_text: str, root: Path, label: str, *, allow_root: bool = False
) -> tuple[Path, os.stat_result]:
    path = _absolute_lexical(path_text, label)
    _beneath(path, root, label, allow_equal=allow_root)
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise CaptureValidationError("path_missing", label) from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise CaptureValidationError("path_not_physical_directory", label)
    if Path(os.path.realpath(path)) != path:
        raise CaptureValidationError("path_not_physical", label)
    return path, info


def existing_regular(path_text: str, root: Path, label: str) -> tuple[Path, os.stat_result]:
    path = _absolute_lexical(path_text, label)
    _beneath(path, root, label)
    try:
        info = path.lstat()
    except FileNotFoundError as exc:
        raise CaptureValidationError("path_missing", label) from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise CaptureValidationError("path_not_regular", label)
    if info.st_nlink != 1:
        raise CaptureValidationError("hardlink_rejected", label)
    if Path(os.path.realpath(path)) != path:
        raise CaptureValidationError("path_not_physical", label)
    return path, info


def absent_path(path_text: str, root: Path, label: str) -> Path:
    path = _absolute_lexical(path_text, label)
    _beneath(path, root, label)
    if path.exists() or path.is_symlink():
        raise CaptureValidationError("path_already_exists", label)
    parent, _ = existing_directory(
        str(path.parent), root, f"{label}.parent", allow_root=True
    )
    if Path(os.path.realpath(parent)) != parent:
        raise CaptureValidationError("path_not_physical", f"{label}.parent")
    return path


def regular_metadata(path: Path, label: str, *, required_mode: int | None = None) -> dict[str, int | str]:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise CaptureValidationError("path_not_regular", label)
    if info.st_nlink != 1:
        raise CaptureValidationError("hardlink_rejected", label)
    mode = stat.S_IMODE(info.st_mode)
    if required_mode is not None and mode != required_mode:
        raise CaptureValidationError(
            "mode_mismatch", f"{label}:expected={required_mode:o}:observed={mode:o}"
        )
    return {
        "device": info.st_dev,
        "inode": info.st_ino,
        "mode": mode,
        "nlink": info.st_nlink,
        "size": info.st_size,
    }
