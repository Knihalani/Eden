"""Unit tests for the Python client: every call fails open on every failure shape (D14). Run from this directory:
``python3 -m unittest -v test_eden_client`` (``bun run test:pkg client-python`` runs it with the end-to-end check)."""

import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from eden_client import EdenClient, eden_id, held_result, with_context


class Stub:
    """A local server answering every POST with ``(status, body)`` from ``answer(path, body)``."""

    def __init__(self, answer):
        stub = self
        self.seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"null")
                stub.seen.append((self.path, body, self.headers.get("authorization")))
                status, out = answer(self.path, body)
                data = out if isinstance(out, bytes) else json.dumps(out).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def client(url="http://127.0.0.1:9", **kw):
    errors = []
    c = EdenClient(user_id="u", session_id="s", base_url=url, timeout_s=0.5, on_error=errors.append, **kw)
    return c, errors


INJ = {"id": "inj_1", "text": "<context>x</context>", "citations": []}


class FailOpen(unittest.TestCase):
    def check_all_quiet(self, c):
        self.assertEqual(c.observe({"kind": "user_message", "text": "hi"}, wait_ms=0), {"injection": None,
                                                                                        "pending": False})
        self.assertEqual(c.pending(), [])
        self.assertEqual(c.collect(None), [])
        self.assertIsNone(c.ask("q"))
        self.assertEqual(c.check("send", {})["verdict"], "proceed")
        self.assertIsNone(c.feedback("inj_1", True))
        self.assertFalse(c.health()["ok"])
        self.assertEqual(c.explain(), [])
        self.assertFalse(c.source_changed("mail"))
        self.assertFalse(c.source_changed("mail", items=[{"ref": "1", "text": "x"}]))

    def test_unreachable(self):
        c, errors = client()
        self.check_all_quiet(c)
        self.assertTrue(errors)

    def test_non_2xx_carries_the_server_reason(self):
        stub = Stub(lambda p, b: (401, {"error": "missing or unknown API key"}))
        try:
            c, errors = client(stub.url)
            self.check_all_quiet(c)
            self.assertEqual(c.health(), {"ok": False, "error": "eden /v1/whoami: 401 missing or unknown API key"})
        finally:
            stub.close()

    def test_wrong_shapes_and_bad_json(self):
        for body in ([1], {"injection": {"id": 3}}, b"<html>", None):
            stub = Stub(lambda p, b, body=body: (200, body))
            try:
                c, errors = client(stub.url)
                self.assertEqual(c.observe({"kind": "user_message", "text": "hi"})["injection"], None)
                self.assertEqual(c.pending(), [])
                self.assertIsNone(c.ask("q"))
                self.assertEqual(c.check("send", {})["verdict"], "proceed")
                self.assertEqual(c.explain(), [])
                self.assertTrue(errors)
            finally:
                stub.close()

    def test_unserialisable_bodies_and_odd_counts_never_throw(self):
        import datetime

        odd = b'{"stored": Infinity, "removed": NaN, "decisions": [{"decision": "s", "why": "w", "itemIds": 3}]}'
        stub = Stub(lambda p, b: (200, odd))
        try:
            c, errors = client(stub.url)
            self.assertEqual(c.check("t", {"d": datetime.datetime.now()})["verdict"], "proceed")
            self.assertEqual(c.observe({"kind": "tool_result", "tool": "t", "output": b"x"})["injection"], None)
            self.assertFalse(c.source_changed("mail", items=[{"ref": "1", "text": "x"}], removed=["2"]))
            self.assertEqual(c.explain(), [])
            self.assertTrue(errors)
        finally:
            stub.close()

    def test_a_throwing_on_error_never_throws(self):
        def boom(e):
            raise RuntimeError("logger down")

        c = EdenClient(user_id="u", session_id="s", base_url="http://127.0.0.1:9", timeout_s=0.3, on_error=boom)
        self.assertIsNone(c.ask("q"))

    def test_a_redirect_is_not_followed_and_never_carries_the_key(self):
        # urllib follows a 301/302/303 as a GET with every header, Authorization included, to any host; the
        # TypeScript client's fetch drops the key on a cross-origin redirect. Eden never redirects: none is followed.
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def answer(self):
                if self.server is redirect:
                    self.rfile.read(int(self.headers["content-length"]))
                    self.send_response(302)
                    self.send_header("location", f"http://localhost:{other.server_port}/v1/ask")
                else:
                    seen.append(self.headers.get("authorization"))
                    self.send_response(404)
                self.send_header("content-length", "0")
                self.end_headers()

            do_GET = do_POST = answer  # noqa: N815

            def log_message(self, *args):
                pass

        redirect, other = HTTPServer(("127.0.0.1", 0), Handler), HTTPServer(("127.0.0.1", 0), Handler)
        for s in (redirect, other):
            threading.Thread(target=s.serve_forever, daemon=True).start()
        try:
            c, errors = client(f"http://127.0.0.1:{redirect.server_port}", api_key="k_0123456789abcdef")
            self.assertIsNone(c.ask("q"))
            self.assertEqual(seen, [])
            self.assertEqual(str(errors[0]), "eden /v1/ask: 302")
        finally:
            for s in (redirect, other):
                s.shutdown()
                s.server_close()

    def test_none_options_take_the_defaults(self):
        # `base_url=os.environ.get("EDEN_URL")` is None when unset: the TypeScript client's `??` takes the default
        # there, where this one threw (base_url) or made observe throw in the agent's loop (timeout_s).
        stub = Stub(lambda p, b: (200, {"injection": None, "answer": "a", "citations": []}))
        try:
            self.assertEqual(EdenClient(user_id="u", session_id="s", base_url=None)._base, "http://127.0.0.1:8790")
            c = EdenClient(user_id="u", session_id="s", base_url=stub.url, timeout_s=None, default_wait_ms=None)
            self.assertEqual(c.observe({"kind": "user_message", "text": "hi"}), {"injection": None, "pending": False})
            self.assertEqual(stub.seen[-1][0], "/v1/events?waitMs=3000")
            self.assertEqual(c.ask("q", timeout_s=None)["answer"], "a")
        finally:
            stub.close()

    def test_bad_ids_reported_once_without_the_ids(self):
        errors = []
        EdenClient(user_id="alice+x@y.com", session_id="s", on_error=errors.append)
        self.assertEqual(len(errors), 1)
        self.assertIn("userId", str(errors[0]))
        self.assertNotIn("alice", str(errors[0]))


class Calls(unittest.TestCase):
    def test_requests_and_answers(self):
        def answer(path, body):
            route = path.split("?")[0]
            return 200, {
                "/v1/events": {"injection": INJ, "pending": True},
                "/v1/pending": {"injections": [INJ, {"id": 1}]},
                "/v1/ask": {"answer": "a", "citations": []},
                "/v1/whoami": {"ok": True},
                "/v1/explain": {"decisions": [{"decision": "silent", "why": "w", "itemIds": []}, {"why": 1},
                                              {"decision": "silent", "why": "w"}]},
                "/v1/sources/items": {"ok": True, "stored": 2},
                "/v1/sources/changed": {"ok": True, "synced": False, "reason": "not-synced"},
            }.get(route, {"ok": True})

        stub = Stub(answer)
        try:
            c, errors = client(stub.url, api_key="k_0123456789abcdef")
            r = c.observe({"kind": "user_message", "text": "hi"})
            self.assertEqual(r, {"injection": INJ, "pending": True})
            path, body, auth = stub.seen[-1]
            self.assertEqual(path, "/v1/events?waitMs=3000")
            self.assertEqual(auth, "Bearer k_0123456789abcdef")
            self.assertEqual((body["userId"], body["sessionId"], body["text"]), ("u", "s", "hi"))
            c.observe({"kind": "tool_result", "tool": "x", "output": "y"})
            self.assertEqual(stub.seen[-1][0], "/v1/events")
            c.observe({"kind": "user_message", "text": "hi"}, wait_ms=99_999)
            self.assertEqual(stub.seen[-1][0], "/v1/events?waitMs=5000")
            self.assertEqual(c.collect(INJ), [INJ, INJ])
            self.assertEqual(c.ask("q", max_items=3)["answer"], "a")
            self.assertEqual(stub.seen[-1][1]["maxItems"], 3)
            self.assertEqual(c.health(), {"ok": True})
            self.assertEqual(c.explain(), [{"decision": "silent", "why": "w", "itemIds": []}])
            self.assertEqual(c.source_notice("mail"), {"synced": False, "reason": "not-synced"})
            self.assertTrue(c.source_changed("mail", items=[{"ref": str(i), "text": "t"} for i in range(150)]))
            sent = [b for p, b, _ in stub.seen if p == "/v1/sources/items"]
            self.assertEqual([len(b["items"]) for b in sent], [100, 50])
            self.assertNotIn("sessionId", sent[0])
            self.assertEqual(errors, [])
        finally:
            stub.close()


class Helpers(unittest.TestCase):
    def test_with_context_before_the_latest_user_message(self):
        msgs = [{"role": "system", "content": "s"}, {"role": "user", "content": "a"},
                {"role": "assistant", "content": "b"}, {"role": "user", "content": "c"}]
        out = with_context(msgs, [INJ])
        self.assertEqual([m["role"] for m in out], ["system", "user", "assistant", "system", "user"])
        self.assertEqual(out[3]["content"], INJ["text"])
        self.assertIs(with_context(msgs, []), msgs)

    def test_with_context_takes_message_objects(self):
        # The OpenAI SDK's reply message is an object with `.role`, often appended to the list as is; `.get` on it
        # threw in the agent's loop (the TypeScript withContext reads `.role` on anything).
        class Message:
            def __init__(self, role, content):
                self.role, self.content = role, content

        msgs = [{"role": "user", "content": "a"}, Message("assistant", "b"), Message("user", "c"), "odd"]
        out = with_context(msgs, [INJ])
        self.assertEqual(out[2:4], [{"role": "system", "content": INJ["text"]}, msgs[2]])
        self.assertEqual(len(out), 5)

    def test_held_result(self):
        self.assertIn(INJ["text"], held_result("send", INJ))

    def test_eden_id(self):
        self.assertEqual(eden_id("alice-work@x.com"), "alice-work@x.com")
        self.assertEqual(eden_id("alice+work@x.com"), "e:alice_2bwork@x.com")
        self.assertEqual(eden_id("\ud800"), "e:_ud800")
        self.assertNotEqual(eden_id("\ud800"), eden_id("�"))
        self.assertTrue(eden_id("x" * 200).startswith("h:"))
        self.assertEqual(eden_id("e:a"), "e:e:a")
        self.assertEqual(eden_id("abc\n"), "e:abc_0a")


if __name__ == "__main__":
    unittest.main()
