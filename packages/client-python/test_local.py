"""Local supervisor lifecycle and transport checks; no Hermes or model dependencies."""

import concurrent.futures
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from eden_client import EdenClient
from eden_client.local import LocalEden


SCRIPT = '''#!{python}
import http.server, json, os, signal, sys, threading, time
from pathlib import Path
root = Path({root!r})
mode = {mode!r}
with open(root / "starts", "a") as f: f.write(str(os.getpid()) + "\\n")
if mode == "dump-env":
    (root / "env").write_text(json.dumps(dict(os.environ)))
if mode == "exit-before-ready": sys.exit(1)
if mode == "garbage-port": print("EDEN_LOCAL_READY 99999", flush=True)
if mode == "garbage": print("x" * 70000, flush=True)
if mode in ("never-ready", "garbage-port", "garbage"):
    time.sleep(60)
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/followed": (root / "followed").touch()
        if self.headers.get("Authorization") != "Bearer " + os.environ["EDEN_LOCAL_TOKEN"]:
            self.send_response(401); self.end_headers(); return
        if (root / "redirect").exists():
            self.send_response(302)
            self.send_header("Location", "/followed")
            self.end_headers(); return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b'{{}}')
        with open(root / "requests", "a") as f:
            f.write(json.dumps({{"path": self.path, "body": body}}) + "\\n")
        if self.path == "/v1/ask": out = {{"answer": "answer to " + body["question"], "citations": []}}
        elif self.path.startswith("/v1/events"): out = {{"injection": None, "pending": False}}
        elif self.path == "/v1/pending": out = {{"injections": []}}
        elif self.path == "/v1/check": out = {{"verdict": "proceed", "finding": None}}
        else: out = {{"ok": True}}
        self.send_response(200); self.end_headers(); self.wfile.write(json.dumps(out).encode())
    do_GET = do_POST
    def log_message(self, *args): pass
http.server.HTTPServer.request_queue_size = 64
server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
def lifetime():
    sys.stdin.buffer.read()
    os._exit(0)
if mode != "ignores-stdin": threading.Thread(target=lifetime, daemon=True).start()
else: signal.signal(signal.SIGTERM, signal.SIG_IGN)
# Raw bytes: text-mode stdout on Windows translates LF again, so crlf mode must not use print(end=...).
sys.stdout.buffer.write(b"EDEN_LOCAL_READY %d%s" % (server.server_port, b"\\r\\n" if mode == "crlf" else b"\\n"))
sys.stdout.buffer.flush()
if mode == "spam-stdout":
    sys.stdout.write("x" * (256 * 1024)); sys.stdout.flush()
if mode == "spam-stderr":
    sys.stderr.write("x" * (3 * 1024 * 1024)); sys.stderr.flush()
if mode == "crash-after-ready":
    threading.Timer(0.2, lambda: os._exit(1)).start()
server.serve_forever()
'''


# A .cmd shim's interpreter needs the system variables LocalEden forwards to the child.
WINDOWS_ENV = ({k: os.environ[k] for k in ("SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT") if k in os.environ}
               if sys.platform == "win32" else {})


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class LocalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.owners = []

    def tearDown(self):
        for owner in self.owners:
            owner.close()
        self.temp.cleanup()

    def binary(self, mode="normal"):
        binary = self.root / "fake"
        binary.write_text(SCRIPT.format(python=sys.executable, root=str(self.root), mode=mode))
        if sys.platform == "win32":
            # Windows executes no shebang: a .cmd shim puts the script on PATH-free subprocess.Popen.
            shim = self.root / "fake.cmd"
            shim.write_text(f'@"{sys.executable}" "{binary}" %*\r\n', newline="")
            return shim
        binary.chmod(0o700)
        return binary

    def owner(self, mode="normal", **kwargs):
        owner = LocalEden(self.binary(mode), self.root / "data", **kwargs)
        self.owners.append(owner)
        return owner

    @unittest.skipUnless(sys.platform == "darwin", "the quarantine strip is macOS-only")
    def test_darwin_quarantine_stripped_before_spawn(self):
        with patch("eden_client.local.subprocess.run", wraps=subprocess.run) as run:
            owner = self.owner()
            self.assertIsNotNone(owner.endpoint())
            owner.close()
            self.assertIn(
                ["xattr", "-d", "com.apple.quarantine", str(self.root / "fake")],
                [call.args[0] for call in run.call_args_list],
            )

    def test_concurrent_ready_reuse_and_shutdown(self):
        owner = self.owner()
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            endpoints = list(pool.map(lambda _: owner.endpoint(), range(20)))
        self.assertIsNotNone(endpoints[0])
        self.assertTrue(all(e == endpoints[0] for e in endpoints))
        self.assertEqual(len((self.root / "starts").read_text().splitlines()), 1)
        process = owner._process
        url, token, generation = endpoints[0]
        with patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1",
                                    "NO_PROXY": "", "no_proxy": ""}):
            client = EdenClient("u", "s", api_key=token, base_url=url, bypass_proxies=True, on_error=None)
            self.assertTrue(client.health()["ok"])
            (self.root / "redirect").touch()
            self.assertFalse(client.health()["ok"])
            self.assertFalse((self.root / "followed").exists())
        owner.failed(generation)
        self.assertEqual(owner.endpoint(), endpoints[0])
        owner.close()
        owner.close()
        self.assertIsNotNone(process.poll())
        self.assertIsNone(owner.endpoint())

    def test_restart_backoff_and_stale_failure(self):
        owner = self.owner("crash-after-ready")
        first = owner.endpoint()
        process = owner._process
        self.assertTrue(wait_for(lambda: process.poll() is not None))
        owner.failed(first[2])
        start = time.monotonic()
        self.assertIsNone(owner.endpoint())
        self.assertLess(time.monotonic() - start, 0.1)
        time.sleep(1.02)
        second = owner.endpoint()
        self.assertGreater(second[2], first[2])
        self.assertNotEqual(second[1], first[1])
        self.assertNotEqual(second[0], first[0])
        owner.failed(first[2])
        self.assertEqual(owner.endpoint(), second)

    def test_start_failures_and_timeout(self):
        for mode in ("never-ready", "garbage-port", "exit-before-ready", "garbage"):
            with self.subTest(mode=mode):
                owner = self.owner(mode, ready_timeout=0.15)
                start = time.monotonic()
                self.assertIsNone(owner.endpoint())
                self.assertLess(time.monotonic() - start, 1.5)
                self.assertIsNone(owner.endpoint())
        missing = LocalEden(self.root / "missing", self.root)
        self.owners.append(missing)
        self.assertIsNone(missing.endpoint())

    def test_kill_fallback(self):
        owner = self.owner("ignores-stdin")
        self.assertIsNotNone(owner.endpoint())
        process = owner._process
        start = time.monotonic()
        owner.close()
        self.assertLess(time.monotonic() - start, 5)
        self.assertIsNotNone(process.poll())

    def test_stdout_drains_after_ready(self):
        owner = self.owner("spam-stdout")
        url, token, _ = owner.endpoint()
        client = EdenClient("u", "s", api_key=token, base_url=url, bypass_proxies=True, on_error=None)
        self.assertTrue(client.health()["ok"])

    def test_crlf_ready(self):
        self.assertIsNotNone(self.owner("crlf").endpoint())

    def test_backoff_doubles_caps_resets_and_warns_once(self):
        owner = LocalEden(self.root / "missing", self.root)
        self.owners.append(owner)
        warnings = io.StringIO()
        with patch("eden_client.local.time.monotonic", return_value=100), contextlib.redirect_stderr(warnings):
            for delay in (1, 2, 4, 8, 16, 32, 60, 60):
                owner._failure("test problem")
                self.assertEqual(owner._retry_at, 100 + delay)
            owner._started = 1
            owner._failure("test problem")
            self.assertEqual(owner._retry_at, 101)
        self.assertEqual(warnings.getvalue().count("test problem"), 1)

    def test_log_rotation(self):
        log = self.root / "logs" / "eden.log"
        owner = self.owner("spam-stderr", log_path=log)
        self.assertIsNotNone(owner.endpoint())
        self.assertTrue(wait_for(lambda: Path(str(log) + ".1").exists()))
        time.sleep(0.1)
        owner.close()
        self.assertLessEqual(log.stat().st_size, 1024 * 1024)
        self.assertLessEqual(Path(str(log) + ".1").stat().st_size, 1024 * 1024)

    def test_environment_and_no_argv_or_warning_secrets(self):
        sources = self.root / "sources.json"
        names = ["CONNECTOR_TOKEN", "EDEN_LOCAL_TOKEN", "LD_PRELOAD", "PATH", "HTTP_PROXY", "OPENROUTER_API_KEY"]
        sources.write_text(json.dumps({"users": {"dev/u": [{"headers": [{"env": n} for n in names]}]}}))
        env = {n: "secret-" + n for n in names}
        env.update(UNRELATED_SECRET="never", PATH=os.defpath, HOME=str(self.root), **WINDOWS_ENV)
        owner = self.owner("dump-env", user_sources_file=sources, base_env=env)
        warnings = io.StringIO()
        with contextlib.redirect_stderr(warnings):
            endpoint = owner.endpoint()
        child = json.loads((self.root / "env").read_text())
        self.assertEqual(child["CONNECTOR_TOKEN"], env["CONNECTOR_TOKEN"])
        for name in ("UNRELATED_SECRET", "OPENROUTER_API_KEY", "HTTP_PROXY", "LD_PRELOAD"):
            self.assertNotIn(name, child)
        self.assertEqual(child["PATH"], os.defpath)
        self.assertEqual(child["EDEN_LOCAL_TOKEN"], endpoint[1])
        self.assertEqual(child["HOST"], "127.0.0.1")
        self.assertEqual(child["PORT"], "0")
        self.assertNotIn(endpoint[1], str(owner._process.args) + warnings.getvalue())
        self.assertEqual(owner._process.args, [str(self.binary())])

    def test_invalid_sources_forward_no_credentials(self):
        source = self.root / "broken"
        source.write_text("not json")
        owner = self.owner("dump-env", user_sources_file=source,
                           base_env={"CONNECTOR_TOKEN": "secret", **WINDOWS_ENV})
        self.assertIsNotNone(owner.endpoint())
        self.assertNotIn("CONNECTOR_TOKEN", json.loads((self.root / "env").read_text()))

    @unittest.skipUnless(sys.platform.startswith("linux"), "SIGKILL and /proc check")
    def test_parent_sigkill_closes_lifetime_pipe(self):
        binary = self.binary()
        script = ("from eden_client.local import LocalEden; import time; "
                  f"e=LocalEden({str(binary)!r}, {str(self.root)!r}); "
                  "assert e.endpoint(); print(e._process.pid, flush=True); time.sleep(60)")
        helper = subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, text=True)
        child_pid = None
        try:
            child_pid = int(helper.stdout.readline())
            helper.kill()
            helper.wait(timeout=2)

            def gone():
                path = Path(f"/proc/{child_pid}/stat")
                return not path.exists() or path.read_text().split()[2] == "Z"

            self.assertTrue(wait_for(gone))
        finally:
            if helper.poll() is None:
                helper.kill()
                helper.wait()
            helper.stdout.close()
            if child_pid and Path(f"/proc/{child_pid}").exists():
                with contextlib.suppress(ProcessLookupError):
                    os.kill(child_pid, signal.SIGKILL)
