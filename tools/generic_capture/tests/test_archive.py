from __future__ import annotations

import gzip
import io
import json
import os
import tarfile
import unittest
from pathlib import Path

from generic_capture.archive import _archive_bytes
from generic_capture.canonical import canonical_bytes
from generic_capture.tests.support import (
    cli,
    copy_package,
    parse_stdout,
    temporary_root,
)


def archive_entries(path: Path) -> list[tuple[str, int, bytes]]:
    with gzip.GzipFile(fileobj=io.BytesIO(path.read_bytes()), mode="rb") as compressed:
        tar_data = compressed.read()
    result: list[tuple[str, int, bytes]] = []
    with tarfile.open(fileobj=io.BytesIO(tar_data), mode="r:") as archive:
        for member in archive.getmembers():
            extracted = archive.extractfile(member)
            result.append((member.name, member.mode, extracted.read() if extracted else b""))
    return result


def replace_archive(path: Path, entries: list[tuple[str, int, bytes]]) -> None:
    path.chmod(0o600)
    path.write_bytes(_archive_bytes(entries))
    path.chmod(0o444)


def special_archive(path: Path, special_name: str, special_type: bytes) -> None:
    original = archive_entries(path)
    tar_buffer = io.BytesIO()
    with tarfile.open(fileobj=tar_buffer, mode="w", format=tarfile.USTAR_FORMAT) as output:
        all_names = sorted([name for name, _, _ in original] + [special_name])
        original_map = {name: (mode, data) for name, mode, data in original}
        for name in all_names:
            info = tarfile.TarInfo(name)
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            if name == special_name:
                info.mode = 0o444
                info.type = special_type
                info.linkname = "generic_capture/__init__.py"
                info.size = 0
                output.addfile(info)
            else:
                mode, data = original_map[name]
                info.mode = mode
                info.type = tarfile.REGTYPE
                info.size = len(data)
                output.addfile(info, io.BytesIO(data))
    compressed_buffer = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed_buffer, mtime=0) as compressed:
        compressed.write(tar_buffer.getvalue())
    path.chmod(0o600)
    path.write_bytes(compressed_buffer.getvalue())
    path.chmod(0o444)


class ArchiveTests(unittest.TestCase):
    def _built(self, root: Path) -> dict[str, object]:
        package_parent, package = copy_package(root, "package-source")
        archive = root / "generic-capture.tar.gz"
        result = cli(
            package_parent,
            [
                "package",
                "--allowed-root",
                str(root),
                "--package-root",
                str(package),
                "--archive",
                str(archive),
            ],
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        verifier_parent, _ = copy_package(root, "package-verifier")
        return {
            "archive": archive,
            "package": package,
            "package_parent": package_parent,
            "result": result,
            "verifier_parent": verifier_parent,
        }

    def _verify(self, root: Path, case: dict[str, object], extract: Path | None = None):
        arguments = [
            "verify-package",
            "--allowed-root",
            str(root),
            "--archive",
            str(case["archive"]),
        ]
        if extract is not None:
            arguments.extend(("--extract-root", str(extract)))
        return cli(case["verifier_parent"], arguments)

    def test_deterministic_builds_are_byte_identical(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._built(root)
            second = root / "generic-capture-second.tar.gz"
            result = cli(
                case["package_parent"],
                [
                    "package",
                    "--allowed-root",
                    str(root),
                    "--package-root",
                    str(case["package"]),
                    "--archive",
                    str(second),
                ],
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(Path(case["archive"]).read_bytes(), second.read_bytes())
            self.assertEqual(
                parse_stdout(case["result"])["archive_sha256"],
                parse_stdout(result)["archive_sha256"],
            )

    def test_verify_and_safe_extract_round_trip(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._built(root)
            extract = root / "fresh-extraction"
            result = self._verify(root, case, extract)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = parse_stdout(result)
            self.assertEqual(summary["state"], "package_verified")
            self.assertTrue(summary["extracted"])
            self.assertTrue((extract / "generic_capture" / "runner.py").is_file())
            self.assertFalse(any(path.is_symlink() for path in extract.rglob("*")))

    def test_incomplete_manifest_and_extra_member_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._built(root)
            entries = archive_entries(Path(case["archive"]))
            manifest_index = next(index for index, item in enumerate(entries) if item[0] == "MANIFEST.json")
            manifest = json.loads(entries[manifest_index][2])
            manifest["members"] = manifest["members"][:-1]
            entries[manifest_index] = ("MANIFEST.json", 0o444, canonical_bytes(manifest))
            replace_archive(Path(case["archive"]), entries)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"archive_member_set_mismatch", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._built(root)
            entries = archive_entries(Path(case["archive"]))
            entries.append(("generic_capture/undeclared.txt", 0o444, b"extra"))
            replace_archive(Path(case["archive"]), entries)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"archive_member_set_mismatch", result.stderr)

    def test_archive_symlink_hardlink_fifo_and_traversal_rejected(self) -> None:
        for label, member_type in (
            ("symlink", tarfile.SYMTYPE),
            ("hardlink", tarfile.LNKTYPE),
            ("fifo", tarfile.FIFOTYPE),
        ):
            with self.subTest(kind=label), temporary_root() as name:
                root = Path(name)
                case = self._built(root)
                special_archive(
                    Path(case["archive"]),
                    f"generic_capture/aaa-{label}",
                    member_type,
                )
                result = self._verify(root, case)
                self.assertEqual(result.returncode, 64)
                self.assertIn(b"archive_nonregular_member", result.stderr)

        with temporary_root() as name:
            root = Path(name)
            case = self._built(root)
            entries = archive_entries(Path(case["archive"]))
            entries.append(("../escape", 0o444, b"escape"))
            replace_archive(Path(case["archive"]), entries)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"unsafe_archive_member", result.stderr)

    def test_manifest_mode_digest_and_size_drift_rejected(self) -> None:
        for field, value, expected in (
            ("mode", 0o555, b"archive_member_mode_mismatch"),
            ("sha256", "0" * 64, b"archive_member_digest_mismatch"),
            ("size", 999999, b"archive_member_size_mismatch"),
        ):
            with self.subTest(field=field), temporary_root() as name:
                root = Path(name)
                case = self._built(root)
                entries = archive_entries(Path(case["archive"]))
                manifest_index = next(
                    index for index, item in enumerate(entries) if item[0] == "MANIFEST.json"
                )
                manifest = json.loads(entries[manifest_index][2])
                manifest["members"][0][field] = value
                entries[manifest_index] = ("MANIFEST.json", 0o444, canonical_bytes(manifest))
                replace_archive(Path(case["archive"]), entries)
                result = self._verify(root, case)
                self.assertEqual(result.returncode, 64)
                self.assertIn(expected, result.stderr)

    def test_noncanonical_gzip_metadata_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            case = self._built(root)
            with gzip.GzipFile(
                fileobj=io.BytesIO(Path(case["archive"]).read_bytes()), mode="rb"
            ) as compressed:
                tar_data = compressed.read()
            output = io.BytesIO()
            with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=1) as compressed:
                compressed.write(tar_data)
            archive = Path(case["archive"])
            archive.chmod(0o600)
            archive.write_bytes(output.getvalue())
            archive.chmod(0o444)
            result = self._verify(root, case)
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"noncanonical_archive", result.stderr)

    def test_source_symlink_hardlink_and_fifo_rejected(self) -> None:
        for kind in ("symlink", "hardlink", "fifo"):
            with self.subTest(kind=kind), temporary_root() as name:
                root = Path(name)
                package_parent, package = copy_package(root, "package-source")
                special = package / f"special-{kind}"
                if kind == "symlink":
                    special.symlink_to(package / "__init__.py")
                elif kind == "hardlink":
                    os.link(package / "__init__.py", special)
                else:
                    os.mkfifo(special)
                result = cli(
                    package_parent,
                    [
                        "package",
                        "--allowed-root",
                        str(root),
                        "--package-root",
                        str(package),
                        "--archive",
                        str(root / "rejected.tar.gz"),
                    ],
                )
                self.assertEqual(result.returncode, 64)
                expected = {
                    "symlink": b"package_symlink_rejected",
                    "hardlink": b"package_hardlink_rejected",
                    "fifo": b"package_nonregular_rejected",
                }[kind]
                self.assertIn(expected, result.stderr)

    def test_package_input_and_archive_output_escape_rejected(self) -> None:
        with temporary_root() as name:
            root = Path(name)
            package_parent, package = copy_package(root, "package-source")
            result = cli(
                package_parent,
                [
                    "package",
                    "--allowed-root",
                    str(root),
                    "--package-root",
                    str(Path(__file__).resolve().parents[1]),
                    "--archive",
                    str(root / "rejected.tar.gz"),
                ],
            )
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_escape", result.stderr)

            result = cli(
                package_parent,
                [
                    "package",
                    "--allowed-root",
                    str(root),
                    "--package-root",
                    str(package),
                    "--archive",
                    str(root.parent / f"{root.name}-forbidden.tar.gz"),
                ],
            )
            self.assertEqual(result.returncode, 64)
            self.assertIn(b"path_escape", result.stderr)


if __name__ == "__main__":
    unittest.main()
