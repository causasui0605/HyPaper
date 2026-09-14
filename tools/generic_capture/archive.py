"""Deterministic package builder and independent archive verifier."""

from __future__ import annotations

import gzip
import hashlib
import io
import os
import stat
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any

from . import SCHEMA_VERSION
from .canonical import (
    CaptureValidationError,
    canonical_bytes,
    exact_int,
    exact_keys,
    exact_string,
    parse_canonical_bytes,
    sha256_bytes,
)
from .paths import absent_path, existing_directory, existing_regular, physical_allowed_root


MANIFEST_NAME = "MANIFEST.json"


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_exclusive(path: Path, data: bytes, mode: int) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, mode)
    try:
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _tar_info(name: str, mode: int, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mode = mode
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    info.mtime = 0
    info.type = tarfile.REGTYPE
    return info


def _archive_bytes(entries: list[tuple[str, int, bytes]]) -> bytes:
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, mode, data in sorted(entries, key=lambda item: item[0]):
            archive.addfile(_tar_info(name, mode, len(data)), io.BytesIO(data))
    gzip_buffer = io.BytesIO()
    with gzip.GzipFile(
        filename="", mode="wb", compresslevel=9, fileobj=gzip_buffer, mtime=0
    ) as compressed:
        compressed.write(tar_buffer.getvalue())
    return gzip_buffer.getvalue()


def _source_entries(package_root: Path) -> list[tuple[str, int, bytes]]:
    if package_root.name != "generic_capture":
        raise CaptureValidationError("invalid_package_root_name", package_root.name)
    entries: list[tuple[str, int, bytes]] = []
    for path in sorted(package_root.rglob("*")):
        relative = path.relative_to(package_root)
        if "__pycache__" in relative.parts or path.name.endswith((".pyc", ".pyo")):
            continue
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise CaptureValidationError("package_symlink_rejected", relative.as_posix())
        if stat.S_ISDIR(info.st_mode):
            continue
        if not stat.S_ISREG(info.st_mode):
            raise CaptureValidationError("package_nonregular_rejected", relative.as_posix())
        if info.st_nlink != 1:
            raise CaptureValidationError("package_hardlink_rejected", relative.as_posix())
        mode = stat.S_IMODE(info.st_mode)
        if mode not in (0o444, 0o555, 0o644, 0o755):
            raise CaptureValidationError("package_mode_rejected", relative.as_posix())
        data = path.read_bytes()
        entries.append((f"generic_capture/{relative.as_posix()}", mode, data))
    if not entries:
        raise CaptureValidationError("empty_package")
    return entries


def build_package(
    *, allowed_root_text: str, package_root_text: str, archive_path_text: str
) -> dict[str, Any]:
    allowed_root = physical_allowed_root(allowed_root_text)
    package_root, _ = existing_directory(package_root_text, allowed_root, "package_root")
    archive_path = absent_path(archive_path_text, allowed_root, "archive")
    try:
        archive_path.relative_to(package_root)
    except ValueError:
        pass
    else:
        raise CaptureValidationError("archive_inside_package_rejected")
    source_entries = _source_entries(package_root)
    manifest = {
        "members": [
            {
                "mode": mode,
                "path": name,
                "sha256": _sha256(data),
                "size": len(data),
            }
            for name, mode, data in source_entries
        ],
        "package": "generic_capture",
        "schema_version": SCHEMA_VERSION,
    }
    manifest_bytes = canonical_bytes(manifest)
    entries = [(MANIFEST_NAME, 0o444, manifest_bytes), *source_entries]
    data = _archive_bytes(entries)
    _write_exclusive(archive_path, data, 0o444)
    return {
        "archive_bytes": len(data),
        "archive_sha256": _sha256(data),
        "manifest_sha256": _sha256(manifest_bytes),
        "member_count": len(source_entries),
        "schema_version": SCHEMA_VERSION,
        "state": "package_built",
    }


def _safe_member_name(name: str) -> None:
    if "\\" in name or name.startswith("/") or name == "":
        raise CaptureValidationError("unsafe_archive_member", name)
    pure = PurePosixPath(name)
    if any(part in ("", ".", "..") for part in pure.parts):
        raise CaptureValidationError("unsafe_archive_member", name)
    if pure.as_posix() != name:
        raise CaptureValidationError("unsafe_archive_member", name)


def _manifest_members(value: Any) -> list[dict[str, int | str]]:
    obj = exact_keys(value, ("members", "package", "schema_version"), "manifest")
    if exact_int(obj["schema_version"], "manifest.schema_version") != SCHEMA_VERSION:
        raise CaptureValidationError("unsupported_schema_version", "manifest")
    if exact_string(obj["package"], "manifest.package") != "generic_capture":
        raise CaptureValidationError("package_name_mismatch")
    raw_members = obj["members"]
    if not isinstance(raw_members, list) or not raw_members:
        raise CaptureValidationError("incomplete_manifest", "members")
    members: list[dict[str, int | str]] = []
    paths: list[str] = []
    for index, raw_member in enumerate(raw_members):
        member = exact_keys(
            raw_member, ("mode", "path", "sha256", "size"), f"manifest.members[{index}]"
        )
        path = exact_string(member["path"], f"manifest.members[{index}].path")
        _safe_member_name(path)
        if not path.startswith("generic_capture/"):
            raise CaptureValidationError("package_member_prefix_mismatch", path)
        digest = exact_string(member["sha256"], f"manifest.members[{index}].sha256")
        if len(digest) != 64 or any(character not in "0123456789abcdef" for character in digest):
            raise CaptureValidationError("invalid_sha256", path)
        mode = exact_int(member["mode"], f"manifest.members[{index}].mode")
        size = exact_int(member["size"], f"manifest.members[{index}].size")
        if mode not in (0o444, 0o555, 0o644, 0o755) or size < 0:
            raise CaptureValidationError("invalid_manifest_metadata", path)
        paths.append(path)
        members.append({"mode": mode, "path": path, "sha256": digest, "size": size})
    if paths != sorted(set(paths)):
        raise CaptureValidationError("manifest_member_order_or_duplicate")
    return members


def verify_package(
    *,
    allowed_root_text: str,
    archive_path_text: str,
    extract_root_text: str | None = None,
) -> dict[str, Any]:
    allowed_root = physical_allowed_root(allowed_root_text)
    archive_path, archive_info = existing_regular(archive_path_text, allowed_root, "archive")
    if stat.S_IMODE(archive_info.st_mode) != 0o444:
        raise CaptureValidationError("mode_mismatch", "archive")
    archive_data = archive_path.read_bytes()
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(archive_data), mode="rb") as compressed:
            tar_data = compressed.read()
    except (OSError, EOFError) as exc:
        raise CaptureValidationError("invalid_gzip_archive") from exc
    try:
        with tarfile.open(fileobj=io.BytesIO(tar_data), mode="r:") as archive:
            tar_members = archive.getmembers()
            names = [member.name for member in tar_members]
            if names != sorted(set(names)):
                raise CaptureValidationError("archive_member_order_or_duplicate")
            contents: dict[str, bytes] = {}
            modes: dict[str, int] = {}
            for member in tar_members:
                _safe_member_name(member.name)
                if not member.isreg() or member.issym() or member.islnk():
                    raise CaptureValidationError("archive_nonregular_member", member.name)
                if (
                    member.uid != 0
                    or member.gid != 0
                    or member.uname != ""
                    or member.gname != ""
                    or member.mtime != 0
                ):
                    raise CaptureValidationError("archive_metadata_mismatch", member.name)
                extracted = archive.extractfile(member)
                if extracted is None:
                    raise CaptureValidationError("archive_member_unreadable", member.name)
                data = extracted.read()
                if len(data) != member.size:
                    raise CaptureValidationError("archive_member_size_mismatch", member.name)
                contents[member.name] = data
                modes[member.name] = member.mode
    except CaptureValidationError:
        raise
    except tarfile.TarError as exc:
        raise CaptureValidationError("invalid_tar_archive") from exc

    if MANIFEST_NAME not in contents:
        raise CaptureValidationError("incomplete_manifest", "missing")
    if modes[MANIFEST_NAME] != 0o444:
        raise CaptureValidationError("archive_metadata_mismatch", MANIFEST_NAME)
    manifest_value = parse_canonical_bytes(contents[MANIFEST_NAME], "manifest")
    members = _manifest_members(manifest_value)
    declared_names = [str(member["path"]) for member in members]
    observed_names = sorted(name for name in contents if name != MANIFEST_NAME)
    if declared_names != observed_names:
        raise CaptureValidationError("archive_member_set_mismatch")
    for member in members:
        name = str(member["path"])
        data = contents[name]
        if member["mode"] != modes[name]:
            raise CaptureValidationError("archive_member_mode_mismatch", name)
        if member["size"] != len(data):
            raise CaptureValidationError("archive_member_size_mismatch", name)
        if member["sha256"] != _sha256(data):
            raise CaptureValidationError("archive_member_digest_mismatch", name)

    canonical_entries = [
        (name, modes[name], contents[name]) for name in sorted(contents)
    ]
    rebuilt = _archive_bytes(canonical_entries)
    if rebuilt != archive_data:
        raise CaptureValidationError("noncanonical_archive")

    extracted = False
    if extract_root_text is not None:
        extract_root = absent_path(extract_root_text, allowed_root, "extract_root")
        extract_root.mkdir(mode=0o700)
        created_directories = {extract_root}
        for member in members:
            relative = PurePosixPath(str(member["path"]))
            destination = extract_root.joinpath(*relative.parts)
            parent = destination.parent
            missing: list[Path] = []
            while parent != extract_root and not parent.exists():
                missing.append(parent)
                parent = parent.parent
            for directory in reversed(missing):
                directory.mkdir(mode=0o700)
                created_directories.add(directory)
            _write_exclusive(destination, contents[str(member["path"])], int(member["mode"]))
        for directory in sorted(created_directories, key=lambda item: len(item.parts), reverse=True):
            os.chmod(directory, 0o555)
        extracted = True

    return {
        "archive_bytes": len(archive_data),
        "archive_sha256": sha256_bytes(archive_data),
        "extracted": extracted,
        "manifest_sha256": sha256_bytes(contents[MANIFEST_NAME]),
        "member_count": len(members),
        "schema_version": SCHEMA_VERSION,
        "state": "package_verified",
    }
