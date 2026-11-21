"""The Devin CLI adapter's obligations: per-event reporting and on-disk dedup like the
other per-process adapters, the packet as additionalContext, the party check as a decision
block, failures reported as the call's result, post_compaction as a context_reset, and
fail-open. Run: ``python3 -m unittest test_devincli``."""

import tempfile
import unittest

from eden_client import held_result
from eden_client.devincli import EdenDevinCli, dispatch

PACKET = {"text": "packet-text"}


class FakeClient:
    made = []
    all_events = []
    fail_all = False

    def __init__(self, **kw):
        self.kw = kw
        self.events = FakeClient.all_events
        self.check_answer = {"verdict": "proceed", "finding": None}
        self.inject_kinds = set()
        self.fail = FakeClient.fail_all
        FakeClient.made.append(self)

    def observe(self, event, wait_ms=None):
        if self.fail:
            raise RuntimeError("down")
        self.events.append((event, wait_ms))
        kinds = {"user_message"} | self.inject_kinds
        packet = PACKET if event.get("kind") in kinds else None
        return {"injection": packet, "pending": False}

    def collect(self, injection):
        return [injection] if injection else []

    def pending(self):
        return []

    def check(self, tool, data):
        if self.fail:
            raise RuntimeError("down")
        return self.check_answer


def plugin(env=None, home=None):
    FakeClient.made = []
    tmp = home or tempfile.mkdtemp()
    return EdenDevinCli(env={"EDEN_USER_ID": "alice@x.com", "EDEN_URL": "http://eden:8790",
                             "EDEN_CHECK_TOOLS": "*", **(env or {})},
                        client_factory=FakeClient, home=tmp)


def kinds(events):
    return [e[0]["kind"] for e in events]


class EdenDevinCliTests(unittest.TestCase):
    def setUp(self):
        FakeClient.all_events = []
        FakeClient.fail_all = False

    def test_user_prompt_submit_reports_waits_and_returns_the_packet(self):
        p = plugin()
        out = dispatch(p, "user_prompt_submit",
                       {"session_id": "s1", "prompt": "when is my lunch?"})
        self.assertEqual(out["context"], PACKET["text"])
        self.assertEqual(kinds(FakeClient.all_events), ["user_message"])
        self.assertIsNone(FakeClient.all_events[0][1])

    def test_pre_tool_use_denies_on_a_finding(self):
        p = plugin()
        dispatch(p, "pre_tool_use",  # a first call constructs the lazy client
                 {"session_id": "s1", "tool_name": "ls", "tool_input": {}})
        FakeClient.made[0].check_answer = {"verdict": "finding",
                                           "finding": {"text": "bob is external"}}
        out = dispatch(p, "pre_tool_use",
                       {"session_id": "s1", "tool_name": "exec",
                        "tool_input": {"command": "mail bob"}})
        self.assertEqual(out["deny"], held_result("exec", {"text": "bob is external"}))

    def test_tool_results_report_the_response_output(self):
        p = plugin()
        dispatch(p, "post_tool_use",
                 {"session_id": "s1", "tool_name": "exec",
                  "tool_response": {"success": True, "output": "listed", "error": None}})
        results = [e for e in FakeClient.all_events if e[0]["kind"] == "tool_result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0]["output"], "listed")

    def test_a_failed_call_reports_its_error_as_the_result(self):
        p = plugin()
        dispatch(p, "post_tool_use",
                 {"session_id": "s1", "tool_name": "exec",
                  "tool_response": {"success": False, "output": "", "error": "timed out"}})
        results = [e for e in FakeClient.all_events if e[0]["kind"] == "tool_result"]
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0][0]["output"], "timed out")

    def test_post_compaction_resets_context(self):
        p = plugin()
        dispatch(p, "post_compaction", {"session_id": "s1"})
        self.assertEqual(kinds(FakeClient.all_events), ["context_reset"])

    def test_dispatch_dedupes_across_processes(self):
        home = tempfile.mkdtemp()
        resp = {"session_id": "s1", "tool_name": "exec",
                "tool_response": {"success": True, "output": "same", "error": None}}
        dispatch(plugin(home=home), "post_tool_use", resp)
        dispatch(plugin(home=home), "post_tool_use", dict(resp))
        results = [e for e in FakeClient.all_events if e[0]["kind"] == "tool_result"]
        self.assertEqual(len(results), 1)

    def test_everything_fails_open(self):
        p = plugin()
        FakeClient.fail_all = True
        self.assertIsNone(dispatch(p, "user_prompt_submit",
                                   {"session_id": "s1", "prompt": "q?"}))
        self.assertIsNone(dispatch(p, "pre_tool_use",
                                   {"session_id": "s1", "tool_name": "t",
                                    "tool_input": {}}))
        self.assertIsNone(dispatch(p, "post_tool_use",
                                   {"session_id": "s1", "tool_name": "t",
                                    "tool_response": {"success": True, "output": "o"}}))
        self.assertIsNone(dispatch(p, "unknown_event", {"session_id": "s1"}))


if __name__ == "__main__":
    unittest.main()
