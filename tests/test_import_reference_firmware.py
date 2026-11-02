"""Allowlist importer tests. Uses the supplied archive when present."""

from __future__ import annotations

import hashlib
import io
import os
import stat
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from import_reference_firmware import (  # noqa: E402
    ALLOWLIST,
    default_import_destination,
    default_import_report,
    import_archive,
    main,
    plan_import,
    protected_destination_reason,
)

ARCHIVE = Path(os.environ.get("MATTER_DHT11_ZIP", str(Path.home() / "matter-dht11.zip")))
EXPECTED_HASHES = {
    "CMakeLists.txt": "f52c4cb93322c9ed74e62bf55c172b45750b502afb6b27d8970fb51964baea66",
    "sdkconfig.defaults.esp32h2": "dab703a8d278f6ab4e452c48e00732cc8fa06bcce985c256f25c8c6ad0fa7a8a",
    "partitions.csv": "235146db08d657522030042da8288cd18f069c07211b434a406a5f7e96403be7",
    "sdkconfig.defaults": "ff10578a754e0c958c9fd64fc066703f159a06479ba3c82d9bbb1dd81f9a6e91",
    "dependencies.lock": "86d766fce6e730433be382c805a6a3679332cb38e56bf41f81618c73045a1115",
    "main/CMakeLists.txt": "bcda095efa9a4295f1de6f7c9ec08e932f041ab502aba06bbdb14abb700b09e2",
    "main/app_openthread_config.h": "1b5a5008ae5744eba85f4ff671203357d35ae05172ed8880028fc68d06b43fbc",
    "main/idf_component.yml": "3a71b33cd709d61a8107b6def58a90fb56a7adfdf52926320968f487bed906f4",
    "main/app_main.cpp": "6f8da2ebc69f0d154961deaf0f26973107595588602f936202e8772062614bb3",
    "main/Kconfig.projbuild": "d0284d00d1de10487bb1ce862aeff540c4f5578859f4496c6e9eb64a823241a2",
    "main/drivers/dht11.c": "52c62933a4fa2ae05f6949ac4cdeaf096148dd32023e4cf354c560b7a02925c6",
    "main/drivers/dht11.h": "1052a9e243504f70bf3470bd27bbbf917578e9c1bd60f9a03dc3c96b3331cd42",
}


def _zip_bytes(entries: dict[str, bytes], *, symlink_names: set[str] | None = None) -> bytes:
    symlink_names = symlink_names or set()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in entries.items():
            info = zipfile.ZipInfo(name)
            if name in symlink_names:
                info.external_attr = (stat.S_IFLNK | 0o644) << 16
            else:
                info.external_attr = (stat.S_IFREG | 0o644) << 16
            zf.writestr(info, data)
    return buf.getvalue()


class ImportPlannerTests(unittest.TestCase):
    def test_plan_rejects_path_traversal_onto_allowlist(self) -> None:
        payload = _zip_bytes({"matter-dht11/../CMakeLists.txt": b"bad"})
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            _, errors = plan_import(zf)
        self.assertTrue(any("traversal" in error or "missing required" in error for error in errors))

    def test_plan_rejects_allowlisted_symlink(self) -> None:
        entries = {f"matter-dht11/{path}": b"ok" for path in ALLOWLIST}
        payload = _zip_bytes(entries, symlink_names={"matter-dht11/CMakeLists.txt"})
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            _, errors = plan_import(zf)
        self.assertTrue(any("symlink" in error for error in errors))

    def test_ignores_build_artifacts_and_macosx(self) -> None:
        entries = {f"matter-dht11/{path}": path.encode() for path in ALLOWLIST}
        entries["matter-dht11/build/sensors.bin"] = b"artifact"
        entries["__MACOSX/matter-dht11/._CMakeLists.txt"] = b"resource-fork"
        payload = _zip_bytes(entries)
        with zipfile.ZipFile(io.BytesIO(payload)) as zf:
            planned, errors = plan_import(zf)
        self.assertEqual(errors, [])
        planned_relatives = {relative for _, relative in planned}
        self.assertEqual(planned_relatives, set(ALLOWLIST))
        self.assertNotIn("build/sensors.bin", planned_relatives)


class ImportExecutionTests(unittest.TestCase):
    def test_cli_refuses_to_recreate_reference_or_canonical_firmware(self) -> None:
        entries = {f"matter-dht11/{path}": b"v1" for path in ALLOWLIST}
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "ok.zip"
            archive_path.write_bytes(_zip_bytes(entries))
            for dest in ("reference/matter-dht11", "node-data/firmware/template", "docs/import"):
                with self.assertRaises(SystemExit) as raised:
                    main([str(archive_path), "--dest", str(ROOT / dest), "--dry-run"])
                self.assertIn("refusing to import", str(raised.exception))
        self.assertFalse((ROOT / "reference").exists())
        self.assertFalse((ROOT / "docs").exists())

    def test_cli_default_destination_is_the_import_directory(self) -> None:
        entries = {f"matter-dht11/{path}": path.encode() for path in ALLOWLIST}
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "ok.zip"
            archive_path.write_bytes(_zip_bytes(entries))
            report_path = Path(tmp) / "report.json"
            with redirect_stdout(io.StringIO()):
                code = main([str(archive_path), "--dest", str(Path(tmp) / "matter-dht11"), "--report", str(report_path)])
            self.assertEqual(code, 0)
            self.assertTrue((Path(tmp) / "matter-dht11" / "CMakeLists.txt").is_file())
        self.assertFalse((ROOT / "reference").exists())
    def test_imports_only_allowlist(self) -> None:
        entries = {f"matter-dht11/{path}": path.encode() for path in ALLOWLIST}
        entries["matter-dht11/build/sensors.bin"] = b"artifact"
        entries["__MACOSX/matter-dht11/._CMakeLists.txt"] = b"resource-fork"
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "ok.zip"
            archive_path.write_bytes(_zip_bytes(entries))
            dest = Path(tmp) / "out"
            report = import_archive(archive_path, dest)
            self.assertEqual((dest / "CMakeLists.txt").read_bytes(), b"CMakeLists.txt")
            self.assertFalse((dest / "build" / "sensors.bin").exists())
            imported = {item["destination_path"] for item in report["files"]}
            self.assertEqual(imported, set(ALLOWLIST))
            self.assertNotIn("reference/", report["destination"])

    def test_refuses_overwrite_without_force(self) -> None:
        entries = {f"matter-dht11/{path}": b"v1" for path in ALLOWLIST}
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "v1.zip"
            archive_path.write_bytes(_zip_bytes(entries))
            dest = Path(tmp) / "out"
            import_archive(archive_path, dest)
            (dest / "CMakeLists.txt").write_bytes(b"changed")
            with self.assertRaises(SystemExit) as raised:
                import_archive(archive_path, dest)
            self.assertIn("overwrite", str(raised.exception))


class TemplateTests(unittest.TestCase):
    def test_firmware_template_keeps_the_reusable_reference_files(self) -> None:
        template = ROOT / "node-data" / "firmware" / "template"
        reusable = {
            "CMakeLists.txt",
            "sdkconfig.defaults",
            "sdkconfig.defaults.esp32h2",
            "partitions.csv",
            "dependencies.lock",
            "main/idf_component.yml",
        }
        self.assertFalse((ROOT / "reference" / "matter-dht11").exists())
        self.assertFalse((ROOT / "reference").exists())
        self.assertFalse((ROOT / "docs").exists())
        for name in ("baseline_build.sh", "build_modular_dht11.sh"):
            script = (ROOT / "scripts" / name).read_text(encoding="utf-8")
            self.assertNotIn("docs/", script)
            self.assertNotIn("reference/", script)
            self.assertIn("node-data/firmware/out/", script)
        dest = default_import_destination(ROOT)
        self.assertEqual(dest, ROOT / "node-data" / "firmware" / "import" / "matter-dht11")
        self.assertEqual(default_import_report(ROOT), ROOT / "node-data" / "firmware" / "import" / "source-import-report.json")
        self.assertIsNone(protected_destination_reason(ROOT, dest))
        for blocked in (
            ROOT / "reference" / "matter-dht11",
            ROOT / "docs",
            ROOT / "node-data" / "firmware" / "template",
            ROOT / "node-data" / "catalogue" / "components" / "dht11",
            ROOT / "node-data" / "data" / "application",
        ):
            self.assertIsNotNone(protected_destination_reason(ROOT, blocked), blocked)
        for relative in reusable:
            data = (template / relative).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), EXPECTED_HASHES[relative], relative)
        header = (ROOT / "node-data" / "firmware" / "components" / "iotedu_core" / "app_openthread_config.h").read_bytes()
        self.assertEqual(hashlib.sha256(header).hexdigest(), EXPECTED_HASHES["main/app_openthread_config.h"])


@unittest.skipUnless(ARCHIVE.is_file(), "matter-dht11.zip not present on this machine")
class RealArchiveTests(unittest.TestCase):
    def test_real_archive_allowlist_and_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "reference"
            report = import_archive(ARCHIVE, dest)
            imported = {item["destination_path"]: item for item in report["files"]}
            self.assertEqual(set(imported), set(ALLOWLIST))
            with zipfile.ZipFile(ARCHIVE) as zf:
                _, errors = plan_import(zf)
                self.assertEqual(errors, [])
            for path, item in imported.items():
                data = (dest / path).read_bytes()
                self.assertEqual(hashlib.sha256(data).hexdigest(), item["sha256"])
                self.assertEqual(item["sha256"], EXPECTED_HASHES[path])
                self.assertEqual(item["original_path"], f"matter-dht11/{path}")


if __name__ == "__main__":
    unittest.main()
