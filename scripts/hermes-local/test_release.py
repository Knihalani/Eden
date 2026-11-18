import hashlib
import json
import lzma
import os
import platform
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from types import SimpleNamespace

from build import HERE, reproducible_zip
from install import MARKER, TARGETS, binary_name, digest, host_target, select_home

HOST = host_target(platform.system(), platform.machine())


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory(prefix="eden-release-test-")
        self.addCleanup(work.cleanup)
        self.work = Path(work.name)
        self.home = self.work / "Hermes home"
        self.release = self.work / "release"
        self.release.mkdir()
        self.installer = self.release / "install.py"
        self.installer.write_bytes((HERE / "install.py").read_bytes())
        self.env = {**os.environ, "HERMES_HOME": str(self.home)}
        self.binary = f"bin/{binary_name(HOST)}"
        self.payload = self.release / "eden"
        self.dest = self.home / "plugins" / "eden"
        self.write_release("v1")

    def write_release(self, version, packed=True):
        self.files = {
            "__init__.py": b"from .eden_client import register\n",
            "plugin.yaml": b"name: eden\n",
            "eden_client/__init__.py": b"def register(ctx): pass\n",
            self.binary: version.encode("ascii"),
        }
        digests = {}
        for name, data in self.files.items():
            path = self.payload / name
            path.parent.mkdir(exist_ok=True, parents=True)
            if packed and name == self.binary:
                path = self.payload / f"{name}.xz"
                path.write_bytes(lzma.compress(data))
                digests[name] = hashlib.sha256(data).hexdigest()
            else:
                path.write_bytes(data)
                digests[name] = digest(path)
        self.manifest = {"format": 1, "target": HOST, "version": version,
                         "files": digests}
        if packed:
            self.manifest["packed"] = [self.binary]
        self.save_manifest()

    def save_manifest(self):
        (self.release / "manifest.json").write_text(json.dumps(self.manifest), encoding="utf-8")

    def run_installer(self, *args, ok=True):
        p = subprocess.run([sys.executable, str(self.installer), *args], cwd=self.work, env=self.env,
                           capture_output=True, text=True, timeout=10)
        self.assertEqual(p.returncode, 0 if ok else 1, p.stdout + p.stderr)
        return p.stdout + p.stderr

    def test_install_reinstall_upgrade(self):
        self.home.mkdir()
        config = self.home / "config.yaml"
        config.write_bytes(b"test config\n")
        self.assertIn("plugins enable eden", self.run_installer())
        for name, data in self.files.items():
            self.assertEqual((self.dest / name).read_bytes(), data)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE((self.dest / self.binary).stat().st_mode), 0o755)
        self.assertEqual(json.loads((self.dest / MARKER).read_text(encoding="utf-8")), self.manifest)
        cache = self.dest / "eden_client" / "__pycache__"
        cache.mkdir()
        (cache / "__init__.cpython-311.pyc").write_bytes(b"cache")
        self.assertIn("already installed", self.run_installer())
        self.write_release("v2")
        self.run_installer()
        self.assertEqual((self.dest / self.binary).read_bytes(), b"v2")
        self.assertEqual(config.read_bytes(), b"test config\n")
        self.assertFalse(list(self.dest.parent.glob(".eden-backup-*")))

    def test_sticky_explicit_and_dedicated_profiles(self):
        profile = self.home / "profiles" / "work"
        profile.mkdir(parents=True)
        (profile / "config.yaml").touch()
        (self.home / "active_profile").write_text("work\n", encoding="utf-8")
        text = self.run_installer("--dry-run")
        self.assertIn(str((profile / "plugins" / "eden").resolve()), text)
        self.assertFalse((profile / "plugins").exists())
        self.assertIn(str(profile.resolve()), self.run_installer())
        self.assertTrue((profile / "plugins" / "eden" / MARKER).exists())
        self.assertFalse(self.dest.exists())
        self.env["HERMES_HOME"] = str(profile)
        self.assertIn("already installed", self.run_installer())
        self.assertIn("--profile default plugins enable eden", self.run_installer("--profile", "default"))
        self.assertTrue(self.dest.exists())
        dedicated = self.work / "dedicated"
        text = self.run_installer("--hermes-home", str(dedicated))
        self.assertIn(str(dedicated.resolve()), text)
        self.assertTrue((dedicated / "plugins" / "eden" / MARKER).exists())
        self.assertIn("does not exist", self.run_installer("--profile", "missing", ok=False))

    def test_named_and_sticky_profiles_must_be_live(self):
        profiles = self.home / "profiles"
        work = profiles / "work"
        work.mkdir(parents=True)
        reserved = profiles / "sudo"
        reserved.mkdir()
        (reserved / "config.yaml").touch()
        active = self.home / "active_profile"
        for name, message in (("work", "does not exist"), ("sudo", "reserved")):
            active.write_text(f"  {name.upper()}\n", encoding="utf-8")
            self.assertIn(message, self.run_installer("--dry-run", ok=False))
            self.assertIn(message, self.run_installer("--profile", name, "--dry-run", ok=False))
        (work / "state.db").touch()
        active.write_text("  Work \n", encoding="utf-8")
        self.assertIn(str(work.resolve()), self.run_installer("--dry-run"))
        self.assertIn(str(work.resolve()), self.run_installer("--profile", "work", "--dry-run"))
        (profiles / ".deleted").mkdir()
        (profiles / ".deleted" / "work").touch()
        self.assertIn("does not exist", self.run_installer("--dry-run", ok=False))
        self.assertIn("does not exist", self.run_installer("--profile", "work", "--dry-run", ok=False))
        self.assertIn(str(work.resolve()), self.run_installer("--hermes-home", str(work), "--dry-run"))
        self.env["HERMES_HOME"] = str(work)
        self.assertIn(str(work.resolve()), self.run_installer("--dry-run"))
        self.assertIn("does not exist", self.run_installer("--profile", "work", "--dry-run", ok=False))

    def test_active_profile_read_errors_fall_back_but_bom_is_invalid(self):
        self.home.mkdir()
        active = self.home / "active_profile"
        active.write_bytes(b"\xff")
        self.assertIn(str(self.dest.resolve()), self.run_installer("--dry-run"))
        active.unlink()
        active.mkdir()
        self.assertIn(str(self.dest.resolve()), self.run_installer("--dry-run"))
        active.rmdir()
        active.write_text("work", encoding="utf-8-sig")
        self.assertIn("Invalid Hermes profile name", self.run_installer("--dry-run", ok=False))

    def test_refuse_clobber_and_preserve_backup(self):
        self.dest.mkdir(parents=True)
        unrelated = self.dest / "unrelated"
        unrelated.write_bytes(b"owner's data")
        self.assertIn("Refusing to replace", self.run_installer(ok=False))
        self.assertEqual(unrelated.read_bytes(), b"owner's data")
        self.assertIn("Previous plugin preserved", self.run_installer("--force"))
        saved, = self.dest.parent.glob(".eden-backup-*/eden/unrelated")
        self.assertEqual(saved.read_bytes(), b"owner's data")
        (self.dest / "plugin.yaml").write_bytes(b"edited")
        self.assertIn("modified", self.run_installer(ok=False))
        self.assertEqual((self.dest / "plugin.yaml").read_bytes(), b"edited")

    def test_reject_wrong_platform_and_tampering(self):
        self.manifest["target"] = "linux-arm64" if HOST != "linux-arm64" else "linux-x64"
        if HOST.startswith("windows-"):
            self.manifest["files"]["bin/eden-local"] = self.manifest["files"].pop(self.binary)
        self.save_manifest()
        self.assertIn("download " + HOST, self.run_installer(ok=False))
        self.write_release("v1")
        (self.payload / f"{self.binary}.xz").write_bytes(lzma.compress(b"tampered"))
        self.assertIn("modified file", self.run_installer(ok=False))
        self.assertFalse(self.home.exists())
        self.write_release("v1")
        (self.payload / f"{self.binary}.xz").write_bytes(b"not xz")
        self.assertIn("modified file", self.run_installer(ok=False))
        self.assertFalse(self.home.exists())
        self.write_release("v1")
        (self.payload / self.binary).write_bytes(b"v1")
        self.assertIn("modified file", self.run_installer(ok=False))
        self.assertFalse(self.home.exists())
        self.write_release("v1")
        self.manifest["files"]["../escape"] = "0" * 64
        self.save_manifest()
        self.assertIn("Invalid payload entry", self.run_installer(ok=False))

    def test_unpacked_release_still_installs(self):
        self.home.mkdir()
        for orphan in self.payload.rglob("*.xz"):
            orphan.unlink()
        self.write_release("v1", packed=False)
        self.run_installer()
        for name, data in self.files.items():
            self.assertEqual((self.dest / name).read_bytes(), data)

    @unittest.skipIf(os.name == "nt", "Windows symlinks need additional privileges")
    def test_refuse_redirected_plugins_directory(self):
        self.home.mkdir()
        target = self.work / "unrelated"
        target.mkdir()
        (self.home / "plugins").symlink_to(target, target_is_directory=True)
        self.assertIn("Unexpected file type", self.run_installer("--force", ok=False))
        self.assertEqual(list(target.iterdir()), [])

    def test_target_matrix_and_default_homes(self):
        systems = ["Linux", "Darwin", "Windows"]
        self.assertEqual({host_target(system, arch) for system in systems for arch in ("AMD64", "aarch64")},
                         set(TARGETS))
        self.assertEqual(host_target("Windows", "ARM64"), "windows-arm64")
        self.assertEqual(host_target("Linux", "x86_64"), "linux-x64")
        self.assertEqual(TARGETS["linux-x64"], "bun-linux-x64-baseline")
        self.assertEqual(TARGETS["windows-arm64"], "bun-windows-arm64")
        with self.assertRaisesRegex(ValueError, "No Eden release"):
            host_target("Linux", "i686")
        args = SimpleNamespace(hermes_home=None, profile=None)
        self.assertEqual(select_home(args, {}, "Linux", self.work), (self.work / ".hermes").resolve())
        self.assertEqual(select_home(args, {}, "Windows", self.work),
                         (self.work / "AppData" / "Local" / "hermes").resolve())
        self.assertEqual(select_home(args, {"LOCALAPPDATA": str(self.work)}, "Windows", self.home),
                         (self.work / "hermes").resolve())
        self.assertEqual(select_home(args, {"LOCALAPPDATA": f"  {self.work}  "}, "Windows", self.home),
                         (self.work / "hermes").resolve())
        self.assertEqual(select_home(args, {"LOCALAPPDATA": "  "}, "Windows", self.work),
                         (self.work / "AppData" / "Local" / "hermes").resolve())

    def test_zip_layout_and_reproducible_metadata(self):
        a, b = self.work / "a.zip", self.work / "b.zip"
        entries = {"install.py": self.installer, f"eden/{self.binary}.xz": self.payload / f"{self.binary}.xz"}
        reproducible_zip(a, entries, f"eden/{self.binary}")
        os.utime(self.installer, (100, 100))
        reproducible_zip(b, dict(reversed(list(entries.items()))), f"eden/{self.binary}")
        self.assertEqual(a.read_bytes(), b.read_bytes())
        with zipfile.ZipFile(a) as archive:
            self.assertEqual(archive.namelist(), sorted(entries))
            file = archive.getinfo(f"eden/{self.binary}.xz")
            self.assertEqual(file.date_time, (1980, 1, 1, 0, 0, 0))
            self.assertEqual(stat.S_IMODE(file.external_attr >> 16), 0o644)
            self.assertEqual(file.compress_type, zipfile.ZIP_STORED)


@unittest.skipUnless(os.getenv("HERMES_RELEASE_SMOKE") and HOST in ("linux-x64", "darwin-arm64", "darwin-x64",
                                                                  "windows-x64"),
                     "set HERMES_RELEASE_SMOKE=1 to run the compiled smoke on its own platform")
class CompiledSmoke(unittest.TestCase):
    def test_install_and_run(self):
        with tempfile.TemporaryDirectory(prefix="eden-compiled-test-") as directory:
            work = Path(directory)
            supplied = os.getenv("HERMES_RELEASE_SMOKE_ARCHIVE")
            if supplied:
                archive = Path(supplied)
            else:
                subprocess.run([sys.executable, str(HERE / "build.py"), "--version", "smoke",
                                "--target", HOST, "--out-dir", str(work)], check=True, timeout=120)
                archive = work / f"eden-hermes-local-smoke-{HOST}.zip"
            line = f"{digest(archive)}  {archive.name}"
            self.assertIn(line, (archive.parent / "SHA256SUMS").read_text(encoding="ascii").splitlines())
            extracted = work / "extracted"
            with zipfile.ZipFile(archive) as package:
                package.extractall(extracted)
            home = work / "Hermes profile"
            subprocess.run([sys.executable, str(extracted / "install.py"), "--hermes-home", str(home)],
                           cwd=work, check=True, timeout=15)
            binary = home / "plugins" / "eden" / "bin" / binary_name(HOST)
            sources = work / "sources.json"
            sources.write_text(json.dumps({"sources": [{"id": "mail", "description": "Mail", "docs": [
                {"ref": "mandate", "title": "Change to your account mandate",
                 "text": "Your joint account now needs both holders to approve any invoice payment."},
                {"ref": "gym", "title": "Gym renewal", "text": "Your gym membership renews on 1 December."},
            ]}]}), encoding="utf-8")
            self.run_sidecar(binary, work, sources)

    def run_sidecar(self, binary, work, sources):
        token = secrets.token_hex(32)
        env = {"HOME": str(work), "EDEN_LOCAL": "1", "EDEN_LOCAL_TOKEN": token,
               "EDEN_SOURCES_FILE": str(sources)}
        if HOST.startswith("windows-"):
            for key in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PATH"):
                if key in os.environ:
                    env[key] = os.environ[key]
        stdout, stderr = work / "sidecar.stdout", work / "sidecar.stderr"
        with stdout.open("wb") as output, stderr.open("wb") as errors:
            process = subprocess.Popen([str(binary)], cwd=work, env=env, stdin=subprocess.PIPE,
                                       stdout=output, stderr=errors)
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline and process.poll() is None:
                    details = stdout.read_text(encoding="utf-8")
                    match = re.search(r"^EDEN_LOCAL_READY ([1-9][0-9]{0,4})\r?\n", details, re.MULTILINE)
                    if match:
                        break
                    time.sleep(0.05)
                else:
                    self.fail(stdout.read_text(encoding="utf-8") + stderr.read_text(encoding="utf-8"))
                base = f"http://127.0.0.1:{match[1]}"
                self.assertEqual(self.request(base + "/healthz"), {"ok": True})
                who = {"tenantId": "local", "userId": "u", "sessionId": "s"}
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    self.request(base + "/v1/whoami", who)
                self.assertEqual(denied.exception.code, 401)
                self.assertEqual(self.request(base + "/v1/whoami", who, token), {"ok": True})
                question = "Ich muss heute die Rechnung des Küchenbauers über 1.450 Pfund vom gemeinsamen Konto bezahlen."
                response = self.request(base + "/v1/ask", {**who, "question": question}, token)
                cited = [item["itemId"] for item in response["citations"]]
                self.assertIn("mail:mandate", cited, stderr.read_text(encoding="utf-8"))
                self.assertNotIn("turn-gate.bin could not be read", stderr.read_text(encoding="utf-8"))
            finally:
                process.stdin.close()
                try:
                    exit_code = process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                    raise
            self.assertEqual(exit_code, 0, stderr.read_text(encoding="utf-8"))

    def request(self, url, body=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        request = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None, headers)
        with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=10) as response:
            return json.load(response)


if __name__ == "__main__":
    unittest.main(verbosity=2)
