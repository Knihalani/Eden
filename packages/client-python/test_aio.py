"""Unit tests for AsyncEden (D5): the sync surface as coroutines, the loop free while a call waits. Run from this
directory: ``python3 -m unittest -v test_aio``."""

import asyncio
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from eden_client import EdenClient
from eden_client.aio import AsyncEden


class Stub:
    """A local server answering every POST with ``(status, body)`` from ``answer(path, body)``; ``delay`` sleeps
    before replying."""

    def __init__(self, answer, delay=0.0):
        stub = self
        self.seen = []
        self.delay = delay

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])) or b"null")
                stub.seen.append((self.path, body))
                if stub.delay:
                    time.sleep(stub.delay)
                status, out = answer(self.path, body)
                self.send_response(status)
                self.send_header("content-type", "application/json")
                data = json.dumps(out).encode()
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


INJ = {"id": "inj_1", "text": "<context>x</context>", "citations": []}


def answer(path, _body):
    if path.startswith("/v1/events"):
        return 200, {"injection": INJ, "pending": True}
    if path == "/v1/pending":
        return 200, {"injections": [INJ]}
    if path == "/v1/ask":
        return 200, {"answer": "a", "citations": []}
    if path == "/v1/check":
        return 200, {"verdict": "proceed", "finding": None}
    if path == "/v1/whoami":
        return 200, {"ok": True}
    if path == "/v1/explain":
        return 200, {"decisions": [{"decision": "answer", "why": "w", "itemIds": []}]}
    if path == "/v1/sources/changed":
        return 200, {"synced": True}
    return 200, {}


class AsyncSurface(unittest.TestCase):
    def setUp(self):
        self.stub = Stub(answer)
        self.eden = AsyncEden(user_id="u", session_id="s", base_url=self.stub.url, timeout_s=2.0)

    def tearDown(self):
        self.stub.close()

    def test_every_call_is_a_coroutine_with_the_sync_semantics(self):
        async def run():
            e = self.eden
            self.assertEqual(await e.observe({"kind": "user_message", "text": "hi"}),
                             {"injection": INJ, "pending": True})
            self.assertEqual(await e.pending(), [INJ])
            self.assertEqual(await e.collect(INJ), [INJ, INJ])
            # The stub answers no `injections` (an older server): the queue comes from /v1/pending.
            self.assertEqual(await e.observe_all({"kind": "tool_result", "tool": "t", "output": "o"}),
                             {"injections": [INJ, INJ], "pending": True})
            self.assertEqual(await e.ask("q"), {"answer": "a", "citations": []})
            self.assertEqual((await e.check("send", {}))["verdict"], "proceed")
            self.assertIsNone(await e.feedback("inj_1", True))
            self.assertTrue((await e.health())["ok"])
            self.assertEqual(await e.explain(), [{"decision": "answer", "why": "w", "itemIds": []}])
            self.assertTrue(await e.source_changed("mail"))
            self.assertEqual(await e.source_notice("mail"), {"synced": True})

        asyncio.run(run())

    def test_a_call_does_not_block_the_loop(self):
        slow = Stub(answer, delay=0.3)
        try:
            async def run():
                e = AsyncEden(user_id="u", session_id="s", base_url=slow.url, timeout_s=2.0)
                state = {"ticks": 0, "done": False}

                async def tick():
                    while not state["done"]:
                        state["ticks"] += 1
                        await asyncio.sleep(0.05)

                ticking = asyncio.create_task(tick())
                await e.observe({"kind": "user_message", "text": "hi"})
                state["done"] = True
                await ticking
                # A call run on the loop lets no tick in for the whole 0.3 s; a worker thread does.
                self.assertGreater(state["ticks"], 0)

            asyncio.run(run())
        finally:
            slow.close()

    def test_concurrent_calls_each_answer(self):
        async def run():
            return await asyncio.gather(self.eden.ask("one"), self.eden.ask("two"), self.eden.pending())

        asks, _asks_again, pending = asyncio.run(run())
        self.assertEqual(asks["answer"], "a")
        self.assertEqual(pending, [INJ])

    def test_guard_tool_holds_a_finding(self):
        """An AsyncEden under guard_tool/guard_tools still runs the party check (review of D2013): the wrapper's
        coroutine `check` must not read as a pass."""

        def deny(path, _body):
            if path == "/v1/check":
                return 200, {"verdict": "finding",
                             "finding": {"id": "f1", "text": "the recipient is not Oskar"}}
            return answer(path, _body)

        stub = Stub(deny)
        try:
            e = AsyncEden(user_id="u", session_id="s", base_url=stub.url, timeout_s=2.0)
            from eden_client import guard_tool, guard_tools
            ran = []

            def send(to):
                ran.append(to)
                return "sent"

            guarded = guard_tool(e, "send", send)
            self.assertIn("Not executed", guarded("mallory"))
            self.assertEqual(ran, [])

            async def send_async(to):
                ran.append(to)
                return "sent"

            wrapped = guard_tools(e, {"send_async": send_async})["send_async"]
            self.assertIn("Not executed", asyncio.run(wrapped("mallory")))
            self.assertEqual(ran, [])
        finally:
            stub.close()

    def test_wraps_an_existing_client(self):
        errors = []
        sync = EdenClient(user_id="u", session_id="s", base_url="http://127.0.0.1:9", timeout_s=0.2,
                          on_error=errors.append)
        e = AsyncEden(sync=sync)
        self.assertIs(e.sync, sync)
        self.assertIsNone(asyncio.run(e.ask("q")))
        self.assertTrue(errors)


if __name__ == "__main__":
    unittest.main()
