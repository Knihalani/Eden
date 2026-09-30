"""Behavior tests for the eden Python SDK against a stub HTTP server.

Covers: happy-path run_tool, auth header, wrap play/fallback semantics,
timeout fallback speed, and best-effort recording. Pure stdlib only.
"""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

_here = Path(__file__).resolve().parent
sys.path.insert(0, str(_here))
sys.path.insert(0, str(_here.parent))

from eden import DEFAULT_BASE_URL, EdenClient, EdenError, run_tool, wrap_tools  # noqa: E402
from eden.client import EDEN_PROTOCOL_VERSION  # noqa: E402
from stub import make_stub_server  # noqa: E402


class StubTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.server: Any = None

    def tearDown(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()

    def start(self, routes: dict[str, Any]) -> tuple[EdenClient, Any]:
        server, seen = make_stub_server(routes)
        self.server = server
        host, port = server.server_address[:2]
        client = EdenClient(base_url=f"http://{host}:{port}", api_key="test-key", timeout=2.0)
        return client, seen


class RunToolTests(StubTestCase):
    def test_happy_path_sends_auth_and_returns_receipt(self) -> None:
        receipt = {"tool": "refund", "steps": 3, "ok": True}
        client, seen = self.start({"/v1/play": {"code": 200, "body": receipt}})

        result = run_tool("refund", {"order": "T-100"}, client=client)

        self.assertEqual(result, receipt)
        self.assertEqual(len(seen), 1)
        req = seen[0]
        self.assertEqual(req["path"], "/v1/play")
        self.assertEqual(req["authorization"], "Bearer test-key")
        self.assertEqual(req["content_type"], "application/json")
        self.assertEqual(req["body"]["name"], "refund")
        self.assertEqual(req["body"]["args"], {"order": "T-100"})

    def test_http_error_raises_clear_eden_error(self) -> None:
        client, _ = self.start({"/v1/play": {"code": 404, "body": {"error": "not found"}}})
        with self.assertRaises(EdenError) as ctx:
            run_tool("nope", {}, client=client)
        self.assertEqual(ctx.exception.status, 404)
        self.assertIn("not found", str(ctx.exception))

    def test_env_config_used_when_args_omitted(self) -> None:
        import os

        server, seen = make_stub_server({"/v1/play": {"code": 200, "body": {"ok": True}}})
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        host, port = server.server_address[:2]
        old_url, old_key = os.environ.get("EDEN_PLANE_URL"), os.environ.get("EDEN_API_KEY")
        os.environ["EDEN_PLANE_URL"] = f"http://{host}:{port}"
        os.environ["EDEN_API_KEY"] = "env-key"
        try:
            client = EdenClient()
            run_tool("x", {}, client=client)
            self.assertEqual(seen[0]["authorization"], "Bearer env-key")
            self.assertEqual(urlsplit(client.base_url).port, port)
        finally:
            if old_url is None:
                del os.environ["EDEN_PLANE_URL"]
            else:
                os.environ["EDEN_PLANE_URL"] = old_url
            if old_key is None:
                del os.environ["EDEN_API_KEY"]
            else:
                os.environ["EDEN_API_KEY"] = old_key


class WrapToolsTests(StubTestCase):
    def original(self, name: str, args: dict[str, Any]) -> Any:
        return {"source": "original", "name": name, **args}

    def test_compiled_tool_answers_without_running_original(self) -> None:
        routes = {"/v1/wrap": {"code": 200, "body": {"action": "play", "facts": {"ok": True}}}}
        client, seen = self.start(routes)
        called: list[str] = []

        def original(name: str, args: dict[str, Any]) -> Any:
            called.append("original")
            return {"source": "original", "name": name, **args}

        wrapped = wrap_tools({"refund": original}, client)

        result = wrapped["refund"]("refund", {"order": "T-1"})

        self.assertEqual(result, {"ok": True})
        self.assertEqual(called, [])  # original is NEVER called on play
        self.assertEqual([r["path"] for r in seen], ["/v1/wrap"])
        self.assertEqual(seen[0]["x_eden_version"], "1")

    def test_protocol_defaults(self) -> None:
        self.assertEqual(EDEN_PROTOCOL_VERSION, 1)
        self.assertEqual(DEFAULT_BASE_URL, "http://127.0.0.1:8788")

    def test_hosted_origin_does_not_default_eden_dev(self) -> None:
        import os
        import tempfile
        from eden.client import _resolve

        old_key = os.environ.pop("EDEN_API_KEY", None)
        old_home = os.environ.get("EDEN_HOME")
        try:
            # Never the real ~/.eden: the loopback default reads config.json from EDEN_HOME.
            with tempfile.TemporaryDirectory() as home:
                os.environ["EDEN_HOME"] = home
                _, loop_key = _resolve("http://127.0.0.1:8788", None)
                self.assertEqual(loop_key, "eden_dev")
                _, hosted_key = _resolve("https://useeden.vercel.app", None)
                self.assertEqual(hosted_key, "")
        finally:
            if old_key is not None:
                os.environ["EDEN_API_KEY"] = old_key
            if old_home is None:
                os.environ.pop("EDEN_HOME", None)
            else:
                os.environ["EDEN_HOME"] = old_home

    def test_loopback_uses_the_key_eden_wrap_stored(self) -> None:
        import json
        import os
        import tempfile
        from eden.client import _resolve

        key = "eden_local_" + "ab" * 32
        old_key = os.environ.pop("EDEN_API_KEY", None)
        old_home = os.environ.get("EDEN_HOME")
        try:
            with tempfile.TemporaryDirectory() as home:
                os.environ["EDEN_HOME"] = home
                with open(os.path.join(home, "config.json"), "w", encoding="utf-8") as f:
                    json.dump({"api_key": key, "base_url": "http://127.0.0.1:8788"}, f)
                self.assertEqual(_resolve("http://127.0.0.1:8788", None)[1], key)
                self.assertEqual(_resolve("https://useeden.vercel.app", None)[1], "")
                self.assertEqual(_resolve("http://127.0.0.1:8788", "explicit")[1], "explicit")
        finally:
            if old_key is not None:
                os.environ["EDEN_API_KEY"] = old_key
            if old_home is None:
                os.environ.pop("EDEN_HOME", None)
            else:
                os.environ["EDEN_HOME"] = old_home

    def test_action_original_runs_the_real_callable(self) -> None:
        routes = {
            "/v1/wrap": {"code": 200, "body": {"action": "original"}},
            "/v1/ingest": {"code": 200, "body": {"ok": True}},
        }
        client, seen = self.start(routes)
        wrapped = wrap_tools({"refund": self.original}, client)

        result = wrapped["refund"]("refund", {"order": "T-2"})

        self.assertEqual(result["source"], "original")
        self.assertEqual(seen[0]["path"], "/v1/wrap")
        # Recording happens off-thread; give the daemon a moment.
        deadline = time.time() + 2
        while time.time() < deadline and not any(r["path"] == "/v1/ingest" for r in seen):
            time.sleep(0.01)
        ingest = [r for r in seen if r["path"] == "/v1/ingest"]
        self.assertEqual(len(ingest), 1)
        event = ingest[0]["body"]["events"][0]
        self.assertEqual(event["name"], "refund")
        self.assertTrue(event["ok"])
        self.assertEqual(ingest[0]["authorization"], "Bearer test-key")

    def test_endpoint_error_falls_back_to_original(self) -> None:
        routes = {"/v1/wrap": {"code": 500, "body": {"error": "boom"}}}
        client, seen = self.start(routes)
        wrapped = wrap_tools({"refund": self.original}, client)

        started = time.time()
        result = wrapped["refund"]("refund", {"order": "T-3"})

        self.assertEqual(result["source"], "original")
        self.assertLess(time.time() - started, 1.0)

    def test_unreachable_runtime_runs_original(self) -> None:
        client = EdenClient(base_url="http://127.0.0.1:1", api_key="k", timeout=0.25)
        called: list[str] = []

        def original(name: str, args: dict[str, Any]) -> Any:
            called.append("original")
            return {"source": "original"}

        wrapped = wrap_tools({"refund": original}, client)
        result = wrapped["refund"]("refund", {})
        self.assertEqual(result["source"], "original")
        self.assertEqual(called, ["original"])

    def test_timeout_falls_back_quickly(self) -> None:
        routes = {"/v1/wrap": {"code": 200, "body": {"action": "play"}, "delay": 5.0}}
        server, _seen = make_stub_server(routes)
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        host, port = server.server_address[:2]
        client = EdenClient(base_url=f"http://{host}:{port}", api_key="k", timeout=0.25)
        wrapped = wrap_tools({"refund": self.original}, client)

        started = time.time()
        result = wrapped["refund"]("refund", {})
        elapsed = time.time() - started

        self.assertEqual(result["source"], "original")  # user call unbroken
        self.assertLess(elapsed, 2.0)  # never waited out the 5s stall

    def test_recording_failure_never_breaks_the_call(self) -> None:
        routes = {
            "/v1/wrap": {"code": 200, "body": {"action": "original"}},
            "/v1/ingest": {"code": 500, "body": {"error": "nope"}},
        }
        client, _seen = self.start(routes)
        wrapped = wrap_tools({"refund": self.original}, client)
        self.assertEqual(wrapped["refund"]("refund", {})["source"], "original")


if __name__ == "__main__":
    unittest.main()
