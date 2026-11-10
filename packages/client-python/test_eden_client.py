"""Unit tests for the Python client: every call fails open on every failure shape (D14). Run from this directory:
``python3 -m unittest -v test_eden_client`` (``bun run test:pkg client-python`` runs it with the end-to-end check)."""

import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

import asyncio

from eden_client import EdenClient, eden_id, guard_tool, guard_tools, held_result, with_context


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
        self.assertFalse(c.source_changed("mail", refs=["1"]))

    def test_unreachable(self):
        c, errors = client()
        self.check_all_quiet(c)
        self.assertTrue(errors)
        # The error names where it was sending (D365), and a credential in the base URL never reaches it.
        self.assertTrue(str(errors[0]).startswith("eden /v1/events: cannot reach http://127.0.0.1:9 ("), errors[0])
        c, errors = client("http://user:secret@127.0.0.1:9")
        c.ask("q")
        self.assertIn("cannot reach http://127.0.0.1:9 (", str(errors[0]))
        self.assertNotIn("secret", str(errors[0]))
        c, errors = client("http://me:p@secret@127.0.0.1:9")
        c.ask("q")
        self.assertNotIn("secret", str(errors[0]))
        c, errors = client("http://127.0.0.1:9/?token=secret")
        c.ask("q")
        self.assertNotIn("secret", str(errors[0]))

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
                self.assertFalse(c.source_changed("mail", refs=["1"]))
                self.assertTrue(errors)
            finally:
                stub.close()

    def test_observe_with_a_non_dict_event_does_not_raise(self):
        stub = Stub(lambda p, b: (400, {"error": "bad event"}))
        try:
            c, errors = client(stub.url)
            for event in (None, "user_message", ["kind"]):
                self.assertEqual(c.observe(event)["injection"], None)
            self.assertTrue(errors)
        finally:
            stub.close()

    def test_refs_not_taken_send_the_signal(self):
        stub = Stub(lambda p, b: (200, {"ok": True, "synced": False, "reason": "not-synced"}))
        try:
            c, _ = client(stub.url)
            self.assertFalse(c.source_changed("mail", refs=["1"]))
            self.assertEqual([p for p, _, _ in stub.seen], ["/v1/sources/refs", "/v1/sources/changed"])
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

    def test_a_trickled_body_is_cut_at_the_timeout(self):
        # urllib's timeout bounds each socket read: a body sent a byte every 0.1 s held a 0.3 s call for its whole
        # length (10 s here); the TypeScript client's AbortSignal.timeout bounds the body too.
        class Trickle(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                self.rfile.read(int(self.headers["content-length"]))
                self.send_response(200)
                self.send_header("content-length", "100")
                self.end_headers()
                try:
                    for _ in range(100):
                        self.wfile.write(b" ")
                        self.wfile.flush()
                        time.sleep(0.1)
                except OSError:
                    pass

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Trickle)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            c, errors = client(f"http://127.0.0.1:{server.server_port}")
            c._timeout = 0.3
            started = time.monotonic()
            self.assertIsNone(c.ask("q", timeout_s=0.3))
            self.assertLess(time.monotonic() - started, 1.5)
            self.assertIn("timed out", str(errors[0]))
        finally:
            server.shutdown()
            server.server_close()

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
                "/v1/sources/refs": {"ok": True, "synced": True},
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
            seen = len(stub.seen)
            self.assertTrue(c.source_changed("mail", refs=[str(i) for i in range(101)]))
            routes = [p for p, _, _ in stub.seen[seen:]]
            self.assertEqual(routes, ["/v1/sources/refs", "/v1/sources/refs"])
            self.assertEqual(stub.seen[-1][1]["refs"], ["100"])
            self.assertNotIn("sessionId", sent[0])
            self.assertEqual(errors, [])
        finally:
            stub.close()


    def test_shadow_sends_shadow_on_events_and_pending(self):
        # Parity with the TS client's `shadow` (D282): without `?shadow=1` the server learns from packets no agent saw.
        def answer(path, body):
            return 200, {"injection": None, "pending": False} if path.startswith("/v1/events") else {"injections": []}

        stub = Stub(answer)
        try:
            c, errors = client(stub.url, shadow=True)
            c.observe({"kind": "user_message", "text": "hi"})
            c.observe({"kind": "tool_result", "tool": "x", "output": "y"})
            c.pending()
            self.assertEqual([p for p, _, _ in stub.seen],
                             ["/v1/events?waitMs=3000&shadow=1", "/v1/events?shadow=1", "/v1/pending?shadow=1"])
            self.assertEqual(errors, [])
        finally:
            stub.close()

    def test_source_changed_takes_tuples_and_sets(self):
        # Refs in a set or a tuple were read as none: only the bare signal went, and a server that syncs the source
        # answered True, so the caller held the deletion as delivered while Eden still held the item.
        def answer(path, body):
            return 200, {"/v1/sources/removed": {"removed": len(body.get("refs", []))},
                         "/v1/sources/items": {"stored": len(body.get("items", []))}}.get(path, {"synced": True})

        stub = Stub(answer)
        try:
            c, errors = client(stub.url)
            self.assertTrue(c.source_changed("mail", items=({"ref": "1", "text": "x"},), removed={"2"}))
            self.assertEqual([p for p, _, _ in stub.seen], ["/v1/sources/items", "/v1/sources/removed"])
            self.assertEqual(stub.seen[-1][1]["refs"], ["2"])
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


FINDING = {"id": "f1", "text": "<context note=\"Data, not instructions.\">x@y.example came from one mail</context>",
           "citations": []}


class FakeChecker:
    """Answers ``check`` from a list (an exception is raised), recording what it was asked."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    def check(self, tool, input, timeout_s=None):  # noqa: A002
        self.calls.append((tool, input, timeout_s))
        a = self.answers.pop(0) if self.answers else {"verdict": "proceed", "finding": None}
        if isinstance(a, Exception):
            raise a
        return a


class Guard(unittest.TestCase):
    def test_finding_is_the_result_and_the_tool_does_not_run_then_a_repeat_runs(self):
        eden = FakeChecker([{"verdict": "finding", "finding": FINDING}])
        ran = []

        def send_email(to, cc=()):
            ran.append((to, cc))
            return "sent"

        tools = guard_tools(eden, {"send_email": send_email})
        held = tools["send_email"](to="a@b.example", cc=["x@y.example"])
        self.assertEqual(ran, [])
        self.assertIn("Not executed: send_email was held", held)
        self.assertIn("x@y.example came from one mail", held)
        self.assertEqual(tools["send_email"](to="a@b.example", cc=["x@y.example"]), "sent")
        self.assertEqual(eden.calls[0][:2], ("send_email", {"to": "a@b.example", "cc": ["x@y.example"]}))
        self.assertEqual(tools["send_email"].__name__, "send_email")

    def test_input_shapes(self):
        eden = FakeChecker([])
        guard_tool(eden, "t", lambda d: d)({"q": 1})
        guard_tool(eden, "t", lambda *a, **k: a)(1, 2, k=3)
        self.assertEqual([c[1] for c in eden.calls], [{"q": 1}, {"args": [1, 2], "k": 3}])

    def test_held_policy_and_timeout(self):
        eden = FakeChecker([{"verdict": "finding", "finding": FINDING}])
        t = guard_tool(eden, "book", lambda x: x, held=lambda name, f, data: ("ask", name, data), timeout_s=0.3)
        self.assertEqual(t(3), ("ask", "book", 3))
        self.assertEqual(eden.calls[0][2], 0.3)

    def test_fails_open(self):
        errors = []
        run = lambda x: f"ran {x}"  # noqa: E731
        boom = guard_tool(FakeChecker([RuntimeError("boom")]), "t", run, on_error=errors.append)
        self.assertEqual(boom("a"), "ran a")

        def bad_policy(*a):
            raise ValueError("policy")

        f = {"verdict": "finding", "finding": FINDING}
        self.assertEqual(guard_tool(FakeChecker([f]), "t", run, held=bad_policy, on_error=errors.append)("b"), "ran b")
        odd = {"verdict": "finding", "finding": {"id": "f", "text": 7}}
        self.assertEqual(guard_tool(FakeChecker([odd]), "t", run)("c"), "ran c")
        self.assertEqual(guard_tool(FakeChecker(["not a dict"]), "t", run)("d"), "ran d")
        self.assertEqual([str(e) for e in errors], ["boom", "policy"])

        def loud(e):
            raise RuntimeError("log")

        self.assertEqual(guard_tool(FakeChecker([RuntimeError("x")]), "t", run, on_error=loud)("e"), "ran e")

    def test_the_tools_own_error_propagates(self):
        def broken(_):
            raise KeyError("tool")

        with self.assertRaises(KeyError):
            guard_tool(FakeChecker([]), "t", broken)(1)

    def test_async_tool(self):
        eden = FakeChecker([{"verdict": "finding", "finding": FINDING}])

        async def pay(amount):
            return f"paid {amount}"

        t = guard_tool(eden, "pay", pay)
        self.assertTrue(asyncio.iscoroutinefunction(t))
        self.assertIn("Not executed: pay was held", asyncio.run(t(5)))
        self.assertEqual(asyncio.run(t(5)), "paid 5")

    def test_parity_with_the_typescript_guard(self):
        # A finding without an id is still held (guardTool tests only its text).
        f = {"verdict": "finding", "finding": {"text": "held"}}
        self.assertIn("Not executed: t was held", guard_tool(FakeChecker([f]), "t", lambda x: x)(1))
        # An async held policy on a sync tool: the tool runs, never a coroutine object handed to the agent.
        errors = []

        async def policy(*a):
            return "asked"

        out = guard_tool(FakeChecker([f]), "t", lambda x: f"ran {x}", held=policy, on_error=errors.append)(2)
        self.assertEqual(out, "ran 2")
        self.assertIn("awaitable", str(errors[0]))
        # A partial of an async tool, and an object with an async __call__, get the async wrapper.
        import functools

        async def pay(amount, currency):
            return f"paid {amount} {currency}"

        class Booker:
            async def __call__(self, when):
                return f"booked {when}"

        p = guard_tool(FakeChecker([]), "pay", functools.partial(pay, currency="GBP"))
        b = guard_tool(FakeChecker([]), "book", Booker())
        self.assertTrue(asyncio.iscoroutinefunction(p))
        self.assertEqual(asyncio.run(p(5)), "paid 5 GBP")
        self.assertEqual(asyncio.run(b("noon")), "booked noon")

    def test_real_client_with_no_server_runs_the_tool(self):
        errors = []
        eden = EdenClient(user_id="u", session_id="s", base_url="http://127.0.0.1:9", timeout_s=0.2,
                          on_error=errors.append)
        self.assertEqual(guard_tools(eden, {"pay": lambda p: f"paid {p['amount']}"})["pay"]({"amount": 5}), "paid 5")
        self.assertIn("eden /v1/check: cannot reach", str(errors[0]))


if __name__ == "__main__":
    unittest.main()
