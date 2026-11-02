"""The Eden plugin's contract with Hermes (stdlib only): it never raises into the agent's turn.

Run: python3 -I packages/sim/lab/hermes/test_plugin.py (hermes-host.test.ts runs it when python3 exists).
"""

import http.server
import importlib.util
import json
import os
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("eden_plugin", os.path.join(HERE, "eden", "__init__.py"))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)


class Eden(http.server.BaseHTTPRequestHandler):
    """A fake Eden: 'observe' gives a packet, 'pending' a queued one; status set per test."""

    status = 200
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        Eden.seen.append((self.path.rsplit("/", 1)[-1], body))
        self.send_response(Eden.status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        route = self.path.rsplit("/", 1)[-1]
        out = {"observe": {"context": "PACKET"}, "pending": {"context": "LATER"}}.get(route, {})
        self.wfile.write(json.dumps(out if Eden.status == 200 else {"error": "x"}).encode())

    def log_message(self, *args):
        pass


class PluginTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.HTTPServer(("127.0.0.1", 0), Eden)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Eden.status = 200
        Eden.seen = []
        os.environ["EDEN_LAB_URL"] = f"http://127.0.0.1:{self.server.server_port}/s/a/eden"
        os.environ["EDEN_LAB_TASK"] = "tok"

    def test_delivers_with_the_task_token(self):
        self.assertEqual(plugin.pre_llm_call(user_message="book it"), {"context": "PACKET"})
        self.assertEqual(plugin.transform_tool_result(tool_name="mcp_sources_search_gmail", result="R"), "R\n\nLATER")
        self.assertIsNone(plugin.post_tool_call(tool_name="mcp_sources_search_gmail", result={"a": 1}))
        self.assertEqual([b["token"] for _, b in Eden.seen], ["tok", "tok", "tok"])
        want = {"tool": "mcp_sources_search_gmail", "output": '{"a": 1}', "token": "tok"}
        self.assertEqual(Eden.seen[2], ("tool", want))

    def test_eden_own_answers_are_not_reported_back(self):
        plugin.post_tool_call(tool_name="mcp_eden_ask_context", result="answer")
        self.assertEqual(Eden.seen, [])

    def test_refusal_and_server_error_are_no_context(self):
        for status in (409, 503):
            Eden.status = status
            self.assertIsNone(plugin.pre_llm_call(user_message="x"))
            self.assertIsNone(plugin.transform_tool_result(tool_name="t", result="R"))
            self.assertIsNone(plugin.post_tool_call(tool_name="t", result="R"))

    def test_no_eden_at_all_is_no_context(self):
        os.environ["EDEN_LAB_URL"] = "http://127.0.0.1:9/s/a/eden"  # nothing listens on the discard port
        self.assertIsNone(plugin.pre_llm_call(user_message="x"))
        self.assertIsNone(plugin.transform_tool_result(tool_name="t", result="R"))
        del os.environ["EDEN_LAB_URL"]
        self.assertIsNone(plugin.pre_llm_call(user_message="x"))

    def test_a_result_json_cannot_encode_is_sent_as_text(self):
        self.assertIsNone(plugin.post_tool_call(tool_name="t", result={"when": object()}))
        self.assertEqual(Eden.seen[0][0], "tool")
        self.assertIn("object object", Eden.seen[0][1]["output"])

    def test_odd_inputs_from_the_host_are_ignored(self):
        self.assertIsNone(plugin.pre_llm_call(user_message=None))
        self.assertIsNone(plugin.transform_tool_result(tool_name="t", result={"not": "text"}))
        self.assertIsNone(plugin.post_tool_call(tool_name=None, result="R"))


if __name__ == "__main__":
    unittest.main()
