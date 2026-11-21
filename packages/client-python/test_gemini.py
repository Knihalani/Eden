"""The Gemini CLI adapter's obligations: the same per-event reporting and on-disk dedup as the
Claude adapter (each hook is its own process), the packet as additionalContext, the party check
as a deny, the final reply reported once per copy without a transcript, compression as a
context_reset, and fail-open. Run: ``python3 -m unittest test_gemini``."""

import tempfile
import unittest

from eden_client import held_result
from eden_client.gemini import EdenGemini, dispatch

PACKET = {"text": "packet-text"}


class FakeClient:
    made = []
    all_events = []  # survives `made` resets: the cross-process test reads every "process"'s events
    fail_all = False  # set before the lazy client is constructed

    def __init__(self, **kw):
        self.kw = kw
        self.events = FakeClient.all_events
        self.check_answer = {"verdict": "proceed", "finding": None}
        self.inject_kinds = set()  # extra event kinds an observe answers with a packet
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
    return EdenGemini(env={"EDEN_USER_ID": "alice@x.com", "EDEN_URL": "http://eden:8790",
                           "EDEN_CHECK_TOOLS": "*", **(env or {})},
                      client_factory=FakeClient, home=tmp)


def kinds(events):
    return [e[0]["kind"] for e in events]


class EdenGeminiTests(unittest.TestCase):
    def setUp(self):
        FakeClient.all_events = []
        FakeClient.fail_all = False

    def test_before_agent_reports_waits_and_returns_the_packet(self):
        p = plugin()
        out = dispatch(p, "before_agent", {"session_id": "s1", "prompt": "when is my lunch?"})
        self.assertEqual(out["context"], PACKET["text"])
        self.assertEqual(kinds(FakeClient.all_events), ["user_message"])
        self.assertIsNone(FakeClient.all_events[0][1])  # the user message waits (default wait)

    def test_before_tool_denies_on_a_finding(self):
        p = plugin()
        dispatch(p, "before_tool",  # a first call constructs the lazy client
                 {"session_id": "s1", "tool_name": "ls", "tool_input": {}})
        c = FakeClient.made[0]
        c.check_answer = {"verdict": "finding", "finding": {"text": "bob is external"}}
        out = dispatch(p, "before_tool",
                       {"session_id": "s1", "tool_name": "run_shell", "tool_input": {"command": "mail bob"}})
        self.assertEqual(out["deny"], held_result("run_shell", {"text": "bob is external"}))

    def test_identical_tool_calls_each_report(self):
        # Gemini sends no tool_use_id: a repeated identical call is its own event, not deduped.
        p = plugin()
        dispatch(p, "before_tool", {"session_id": "s1", "tool_name": "ls", "tool_input": {}})
        dispatch(p, "before_tool", {"session_id": "s1", "tool_name": "ls", "tool_input": {}})
        calls = [e for e in FakeClient.all_events if e[0]["kind"] == "tool_call"]
        self.assertEqual(len(calls), 2)

    def test_after_agent_reports_the_reply_once_per_copy(self):
        p = plugin()
        dispatch(p, "after_agent", {"session_id": "s1", "prompt_response": "done it"})
        dispatch(p, "after_agent", {"session_id": "s1", "prompt_response": "done it"})
        msgs = [e for e in FakeClient.all_events if e[0]["kind"] == "agent_message"]
        self.assertEqual(len(msgs), 2)
        self.assertEqual(msgs[0][0]["text"], "done it")

    def test_pre_compress_resets_context(self):
        p = plugin()
        dispatch(p, "pre_compress", {"session_id": "s1"})
        self.assertEqual(kinds(FakeClient.all_events), ["context_reset"])

    def test_session_start_clear_resets_first(self):
        p = plugin()
        dispatch(p, "session_start", {"session_id": "s1", "source": "clear"})
        self.assertEqual(kinds(FakeClient.all_events), ["context_reset", "session_start"])

    def test_dispatch_dedupes_across_processes(self):
        # Each hook is its own process: the on-disk dedup keys keep a replayed identical result
        # (a retried hook fires the event again) from reporting twice.
        home = tempfile.mkdtemp()
        resp = {"session_id": "s1", "tool_name": "ls", "tool_response": {"llmContent": "same result"}}
        dispatch(plugin(home=home), "after_tool", resp)
        dispatch(plugin(home=home), "after_tool", dict(resp))
        results = [e for e in FakeClient.all_events if e[0]["kind"] == "tool_result"]
        self.assertEqual(len(results), 1)

    def test_everything_fails_open(self):
        p = plugin()
        FakeClient.fail_all = True
        self.assertIsNone(dispatch(p, "before_agent", {"session_id": "s1", "prompt": "q?"}))
        self.assertIsNone(dispatch(p, "before_tool",
                                   {"session_id": "s1", "tool_name": "t", "tool_input": {}}))
        self.assertIsNone(dispatch(p, "after_tool",
                                   {"session_id": "s1", "tool_name": "t", "tool_response": {}}))
        self.assertIsNone(dispatch(p, "unknown_event", {"session_id": "s1"}))


if __name__ == "__main__":
    unittest.main()
