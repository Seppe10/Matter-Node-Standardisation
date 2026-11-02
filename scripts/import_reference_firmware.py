#!/usr/bin/env python3
"""Safely import allowlisted firmware sources from matter-dht11.zip.

Rejects path traversal, symlinks, files outside the allowlist, duplicate
destination paths, and overwrites unless --force is supplied.

Generated firmware workspaces read node-data/firmware/template, not this imported tree.
The default destination is node-data/firmware/import/matter-dht11, an inspection
directory. It is not the firmware template, the catalogue, or reference/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import stat
import sys
import zipfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

ALLOWLIST = (
    "CMakeLists.txt",
    "partitions.csv",
    "sdkconfig.defaults",
    "sdkconfig.defaults.esp32h2",
    "dependencies.lock",
    "main/CMakeLists.txt",
    "main/app_main.cpp",
    "main/app_openthread_config.h",
    "main/idf_component.yml",
    "main/Kconfig.projbuild",
    "main/drivers/dht11.c",
    "main/drivers/dht11.h",
)

MACOSX_PREFIX = "__MACOSX/"

# These match packages/contracts/src/repository-paths.ts. The importer must not
# write into canonical firmware, catalogue, or application data.
PROTECTED_RELATIVE = (
    "reference",
    "docs",
    "node-data/firmware/template",
    "node-data/firmware/components",
    "node-data/catalogue",
    "node-data/board-profiles",
    "node-data/component-manifests",
    "node-data/data",
)


def repository_root() -> Path:
    return Path(__file__).resolve().parents[1]


def default_import_destination(repo_root: Path | None = None) -> Path:
    root = repo_root or repository_root()
    return root / "node-data" / "firmware" / "import" / "matter-dht11"


def default_import_report(repo_root: Path | None = None) -> Path:
    root = repo_root or repository_root()
    return root / "node-data" / "firmware" / "import" / "source-import-report.json"


def protected_destination_reason(repo_root: Path, dest: Path) -> str | None:
    """Refuse canonical source trees and the removed root reference/ and docs/ directories."""
    root = repo_root.resolve()
    resolved = dest.resolve()
    try:
        relative = resolved.relative_to(root).as_posix()
    except ValueError:
        return None
    for area in PROTECTED_RELATIVE:
        if relative == area or relative.startswith(f"{area}/"):
            return (
                f"refusing to import into {area}; "
                "use node-data/firmware/import or a directory outside the repository"
            )
    return None


@dataclass
class ImportedFile:
    original_path: str
    destination_path: str
    sha256: str
    size: int
    crc32: int


def _unix_mode(info: zipfile.ZipInfo) -> int:
    return (info.external_attr >> 16) & 0xFFFF


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = _unix_mode(info)
    return bool(mode) and stat.S_ISLNK(mode)


def _normalise_member(name: str) -> str:
    return name.replace("\\", "/")


def _strip_enclosing_directory(member: str, enclosing: str | None) -> str | None:
    if enclosing is None:
        return member
    prefix = enclosing.rstrip("/") + "/"
    if member == enclosing.rstrip("/"):
        return ""
    if member.startswith(prefix):
        return member[len(prefix) :]
    return None


def detect_enclosing_directory(names: list[str]) -> str | None:
    """If every non-__MACOSX entry shares a single top-level directory, return it."""
    tops: set[str] = set()
    for name in names:
        if name.startswith(MACOSX_PREFIX) or name.startswith("/"):
            continue
        parts = [p for p in name.split("/") if p]
        if not parts:
            continue
        tops.add(parts[0])
    if len(tops) == 1:
        return next(iter(tops))
    return None


def plan_import(archive: zipfile.ZipFile) -> tuple[list[tuple[zipfile.ZipInfo, str]], list[str]]:
    errors: list[str] = []
    planned: list[tuple[zipfile.ZipInfo, str]] = []
    destinations: dict[str, str] = {}
    found: dict[str, str] = {}

    names = [_normalise_member(i.filename) for i in archive.infolist()]
    enclosing = detect_enclosing_directory(names)

    for info in archive.infolist():
        member = _normalise_member(info.filename)
        if member.endswith("/") or member.startswith(MACOSX_PREFIX):
            continue

        relative = _strip_enclosing_directory(member, enclosing)
        if relative is None:
            continue
        if relative == "":
            continue

        parts = relative.split("/")
        if any(p in ("", ".", "..") for p in parts) or relative.startswith("/"):
            # Only fail the import when a traversal path would collide with the allowlist.
            if any(p not in ("", ".", "..") for p in parts) and Path(*[p for p in parts if p not in ("", ".")]).as_posix() in ALLOWLIST:
                errors.append(f"rejected path traversal or empty segment: {member}")
            continue
        if relative not in ALLOWLIST:
            continue
        if _is_symlink(info):
            errors.append(f"rejected symlink: {member}")
            continue

        if relative in destinations:
            errors.append(
                f"duplicate destination {relative}: {destinations[relative]} and {member}"
            )
            continue
        destinations[relative] = member
        found[relative] = member
        planned.append((info, relative))

    missing = [path for path in ALLOWLIST if path not in found]
    if missing:
        errors.append("missing required files: " + ", ".join(missing))

    extra = [path for path in found if path not in ALLOWLIST]
    if extra:
        errors.append("unexpected allowlist mismatch: " + ", ".join(extra))

    return planned, errors


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def import_archive(
    zip_path: Path,
    dest_root: Path,
    *,
    force: bool = False,
    dry_run: bool = False,
) -> dict:
    if not zip_path.is_file():
        raise FileNotFoundError(f"archive not found: {zip_path}")

    imported: list[ImportedFile] = []
    with zipfile.ZipFile(zip_path) as archive:
        planned, errors = plan_import(archive)
        if errors:
            raise SystemExit("import rejected:\n- " + "\n- ".join(errors))

        dest_root = dest_root.resolve()
        for info, relative in planned:
            data = archive.read(info)
            dest = dest_root / relative
            dest_resolved = dest.resolve()
            if dest_root not in dest_resolved.parents and dest_resolved != dest_root:
                raise SystemExit(f"refusing to write outside destination: {dest}")
            if dest.exists() and not force:
                existing = dest.read_bytes()
                if existing != data:
                    raise SystemExit(
                        f"refusing to overwrite modified file without --force: {relative}"
                    )
            if not dry_run:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)

            imported.append(
                ImportedFile(
                    original_path=_normalise_member(info.filename),
                    destination_path=relative,
                    sha256=sha256_bytes(data),
                    size=len(data),
                    crc32=info.CRC,
                )
            )

    try:
        reported_destination = dest_root.resolve().relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        reported_destination = dest_root.resolve().as_posix()
    report = {
        "archiveName": zip_path.name,
        "destination": reported_destination,
        "imported_at": datetime.now(timezone.utc).isoformat(),
        "force": force,
        "dry_run": dry_run,
        "files": [asdict(item) for item in imported],
    }
    return report


def main(argv: list[str] | None = None) -> int:
    root = repository_root()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path, help="Path to matter-dht11.zip")
    parser.add_argument(
        "--dest",
        type=Path,
        default=default_import_destination(root),
        help="Inspection directory. Defaults to node-data/firmware/import/matter-dht11",
    )
    parser.add_argument("--force", action="store_true", help="Overwrite existing files")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--report",
        type=Path,
        default=default_import_report(root),
        help="Write import hashes and original paths as JSON",
    )
    args = parser.parse_args(argv)
    for label, candidate in (("destination", args.dest), ("report", args.report)):
        reason = protected_destination_reason(root, candidate)
        if reason:
            raise SystemExit(f"{label}: {reason}")

    report = import_archive(args.archive, args.dest, force=args.force, dry_run=args.dry_run)
    if not args.dry_run:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
