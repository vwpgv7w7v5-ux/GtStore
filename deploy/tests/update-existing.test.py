#!/usr/bin/env python3
"""Isolated update/rollback checks; never call systemd or production URLs."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("existing_update", Path(__file__).resolve().parents[1] / "update-existing.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


class FakeSystem:
    def __init__(self, project):
        self.project = project
        self.actions = []
        self.fail_dependencies = False
        self.fail_health = False
        self.stale_admin = False
        self.fail_stop = False
        self.data_write = False

    def inspect(self, project):
        return project / "data/v6.json", project / "uploads/v6", Path(shutil.which("node"))

    def run(self, args, **kwargs):
        if args[0] == "npm":
            if self.fail_dependencies:
                raise RuntimeError("dependency failure")
            write(kwargs["cwd"] / "node_modules/installed", "new dependencies")
            executable = kwargs["cwd"] / "node_modules/tool"
            executable.write_text("executable")
            executable.chmod(0o700)
        return b""

    def service(self, action):
        self.actions.append(action)
        if action == "stop" and self.fail_stop:
            raise RuntimeError("stop failed")
        if action == "start" and self.data_write:
            p = self.project / "data/v6.json"
            state = json.loads(p.read_text())
            state["newOrder"] = True
            state["revision"] += 1
            p.write_text(json.dumps(state))

    def request(self, route, **kwargs):
        is_new = (self.project / "apps/api-v6/src/imports/jobs.js").exists()
        if route == "/api/v6/health":
            return json.dumps({"ok": True, "backgroundImport": is_new and not self.fail_health,
                               "revision": json.loads((self.project / "data/v6.json").read_text())["revision"]}).encode()
        if self.stale_admin and route == "/admin/src/main.js":
            return b"stale proxy/browser asset"
        path = {"/admin/": "apps/admin-v6/index.html", "/admin/src/main.js": "apps/admin-v6/src/main.js",
                "/storefront.js": "apps/storefront-v6/storefront.js"}[route]
        return (self.project / path).read_bytes()


class ExistingUpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gtstore-existing-test-")
        self.root = Path(self.temporary.name)
        self.project = self.root / "project"
        self.source = self.root / "source"
        base = {"package.json": '{"name":"gtstore-fixture"}', "package-lock.json": "{}",
                "scripts/serve-static.js": "old static script", "apps/api-v6/src/server.js": "old server",
                "apps/admin-v6/index.html": "old admin", "apps/admin-v6/src/main.js": "old main",
                "apps/storefront-v6/storefront.js": "old storefront"}
        for name, value in base.items():
            write(self.project / name, value)
            write(self.source / name, value if name.startswith("package") else "new " + value)
        write(self.source / "apps/api-v6/src/imports/jobs.js", "background imports")
        write(self.project / "node_modules/installed", "old dependencies")
        write(self.project / ".env", "existing server configuration")
        write(self.project / ".git/marker", "existing git metadata")
        write(self.project / "data/v6.json", json.dumps({"revision": 99, "users": [{"id": "owner"}], "products": [1, 2]}))
        write(self.project / "uploads/v6/photo.jpg", "existing photograph")
        write(self.project / "uploads/v6/.import-cache/photo.json", "existing cache")
        self.system = FakeSystem(self.project)
        self.update = module.Update(self.project, self.source, module.DEFAULT_COMMIT, self.system, self.root / "backups")
        self.update.attempts = 1
        self.update.delay = 0

    def tearDown(self):
        self.temporary.cleanup()

    def preserved(self):
        self.assertEqual((self.project / ".env").read_text(), "existing server configuration")
        self.assertEqual((self.project / ".git/marker").read_text(), "existing git metadata")
        self.assertEqual((self.project / "uploads/v6/photo.jpg").read_text(), "existing photograph")
        self.assertEqual((self.project / "uploads/v6/.import-cache/photo.json").read_text(), "existing cache")

    def restored(self):
        self.preserved()
        self.assertEqual((self.project / "apps/admin-v6/index.html").read_text(), "old admin")
        self.assertEqual((self.project / "node_modules/installed").read_text(), "old dependencies")
        self.assertFalse((self.project / "apps/api-v6/src/imports/jobs.js").exists())
        self.assertEqual(self.system.actions[-1], "restart")

    def test_success_preserves_data_and_backs_up_existing_installation(self):
        with patch.dict(os.environ, {}, clear=False):
            old_umask = os.umask(0o077)
            try:
                self.update.run()
            finally:
                os.umask(old_umask)
        self.preserved()
        self.assertEqual(self.system.actions, ["stop", "start"])
        self.assertEqual((self.project / "node_modules/installed").read_text(), "new dependencies")
        self.assertEqual((self.update.backup / "node_modules/installed").read_text(), "old dependencies")
        self.assertEqual((self.project / "apps/api-v6/src/imports").stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.project / "node_modules/tool").stat().st_mode & 0o111, 0o111)
        self.assertEqual((self.project / ".gtstore-source-commit").read_text().strip(), module.DEFAULT_COMMIT)
        with tarfile.open(self.update.backup / "installation.tar.gz") as archive:
            self.assertEqual(archive.extractfile("project/.env").read(), b"existing server configuration")
            self.assertEqual(archive.extractfile("project/uploads/v6/photo.jpg").read(), b"existing photograph")
            self.assertIn("project/uploads/v6/.import-cache/photo.json", archive.getnames())
            self.assertNotIn("project/node_modules/installed", archive.getnames())
            self.assertNotIn("project/.git/marker", archive.getnames())

    def test_failed_health_restores_code_and_dependencies_without_rolling_back_data(self):
        self.system.fail_health = self.system.data_write = True
        with self.assertRaisesRegex(RuntimeError, "readiness"):
            self.update.run()
        self.restored()
        self.assertTrue(json.loads((self.project / "data/v6.json").read_text())["newOrder"])
        self.assertFalse((self.project / ".gtstore-source-commit").exists())

    def test_stale_https_admin_does_not_report_success(self):
        self.system.stale_admin = True
        with self.assertRaisesRegex(RuntimeError, "readiness"):
            self.update.run()
        self.restored()

    def test_dependency_failure_never_stops_site(self):
        self.system.fail_dependencies = True
        with self.assertRaisesRegex(RuntimeError, "dependency failure"):
            self.update.run()
        self.assertEqual(self.system.actions, [])
        self.preserved()

    def test_copy_failure_restores_partially_replaced_files(self):
        original = self.update.replace
        failed = False
        def replacement(source, target, **kwargs):
            nonlocal failed
            if str(source).startswith(str(self.source)) and target.name == "server.js" and not failed:
                failed = True
                raise OSError("fixture disk failure")
            return original(source, target, **kwargs)
        with patch.object(self.update, "replace", side_effect=replacement):
            with self.assertRaisesRegex(OSError, "disk failure"):
                self.update.run()
        self.restored()

    def test_partial_stop_attempts_restart(self):
        self.system.fail_stop = True
        with self.assertRaisesRegex(RuntimeError, "stop failed"):
            self.update.run()
        self.assertEqual(self.system.actions, ["stop", "restart"])
        self.preserved()

    def test_snapshot_failure_restarts_existing_services(self):
        with patch.object(self.update, "snapshot", side_effect=OSError("backup disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.update.run()
        self.restored()

    def test_console_interruption_restores_code_and_restarts_services(self):
        original = self.system.service
        def service(action):
            if action == "start":
                raise KeyboardInterrupt()
            return original(action)
        with patch.object(self.system, "service", side_effect=service):
            with self.assertRaises(KeyboardInterrupt):
                self.update.run()
        self.restored()

    def test_symlink_cannot_redirect_source_writes(self):
        path = self.project / "apps/admin-v6/src/main.js"
        path.unlink()
        path.symlink_to(self.project / ".env")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.update.run()
        self.assertEqual(self.system.actions, [])
        self.preserved()

    def test_missing_database_cannot_create_empty_store(self):
        (self.project / "data/v6.json").unlink()
        with self.assertRaises(FileNotFoundError):
            self.update.run()
        self.assertEqual(self.system.actions, [])

    def test_dependencies_cutover_failure_restores_old_dependencies(self):
        original = os.rename
        def rename(source, target):
            if Path(source) == self.source / "node_modules":
                raise OSError("cutover failure")
            return original(source, target)
        with patch.object(module.os, "rename", side_effect=rename):
            with self.assertRaisesRegex(OSError, "cutover failure"):
                self.update.run()
        self.restored()

    def test_unsafe_archive_is_rejected(self):
        for mode in ("traversal", "link", "wrong-root", "duplicate"):
            archive = self.root / (mode + ".tar.gz")
            with tarfile.open(archive, "w:gz") as bundle:
                item = tarfile.TarInfo("GtStore-" + module.DEFAULT_COMMIT + "/test")
                item.size = 1
                if mode == "traversal":
                    item.name = "GtStore-" + module.DEFAULT_COMMIT + "/../../escape"
                if mode == "link":
                    item.type = tarfile.SYMTYPE
                    item.linkname = "/etc/passwd"
                    item.size = 0
                if mode == "wrong-root":
                    item.name = "GtStore-other/test"
                bundle.addfile(item, io.BytesIO(b"x"))
                if mode == "duplicate":
                    bundle.addfile(item, io.BytesIO(b"x"))
            with self.assertRaises(RuntimeError):
                module.unpack(archive, self.root / "unpack", module.DEFAULT_COMMIT)
            self.assertFalse((self.root / "escape").exists())


if __name__ == "__main__":
    unittest.main()
