"""The Qwen adapter's obligations: per-event reporting and on-disk dedup like the other
per-process adapters, the packet as additionalContext, the party check as a
permissionDecision deny, tool_use_id-keyed reporting (Qwen supplies it), failures reported
as the call's result, pre_compact as a context_reset, stop via the transcript tail, and
fail-open. Run: ``python3 -m unittest test_qwen``."""

import json
import tempfile
import unittest
from pathlib import Path

from eden_client import held_result
from eden_client.qwen import EdenQwen, dispatch

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
    return EdenQwen(env={"EDEN_USER_ID": "alice@x.com", "EDEN_URL": "http://eden:8790",
                         "EDEN_CHECK_TOOLS": "*", **(env or {})},
                    client_factory=FakeClient, home=tmp)


def kinds(events):
    return [e[0]["kind"] for e in events]


class EdenQwenTests(unittest.TestCase):
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
                 {"session_id": "s1", "tool_name": "ls", "tool_input": {}, "tool_use_id": "u1"})
        FakeClient.made[0].check_answer = {"verdict": "finding",
                                           "finding": {"text": "bob is external"}}
        out = dispatch(p, "pre_tool_use",
                       {"session_id": "s1", "tool_name": "run_shell",
                        "tool_input": {"command": "mail bob"}, "tool_use_id": "u2"})
        self.assertEqual(out["deny"], held_result("run_shell", {"text": "bob is external"}))

    def test_tool_results_report_once_per_tool_use_id(self):
        p = plugin()
        for _ in range(2):
            dispatch(p, "post_tool_use",
                     {"session_id": "s1", "tool_name": "ls", "tool_response": "out",
                      "tool_use_id": "u1"})
        results = [e for e in FakeClient.all_events if e[0]["kind"] == "tool_result"]
        self.assertEqual(len(results), 1)

    def test_a_failure_reports_as_the_calls_result(self):
        p = plugin()
        dispatch(p, "post_tool_use_failure",
                 {"session_id": "s1", "tool_name": "ls",
                  "tool_use_id": "u9", "error": "timed out"})
        results = [e for e in FakeClient.all_events if e[0]["kind"] == "tool_result"]
        self.assertEqual(len(results), 1)
        self.assertIn("timed out", results[0][0]["output"])

    def test_stop_reports_the_transcripts_last_reply_once_per_copy(self):
        home = tempfile.mkdtemp()
        transcript = Path(home) / "t.jsonl"
        transcript.write_text("\n".join(json.dumps(r) for r in [
            {"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "done it"}]}},
        ]))
        p = plugin(home=home)
        dispatch(p, "stop", {"session_id": "s1", "transcript_path": str(transcript)})
        dispatch(p, "stop", {"session_id": "s1", "transcript_path": str(transcript)})
        msgs = [e for e in FakeClient.all_events if e[0]["kind"] == "agent_message"]
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0][0]["text"], "done it")

    def test_pre_compact_resets_context(self):
        p = plugin()
        dispatch(p, "pre_compact", {"session_id": "s1"})
        self.assertEqual(kinds(FakeClient.all_events), ["context_reset"])

    def test_dispatch_dedupes_across_processes(self):
        home = tempfile.mkdtemp()
        resp = {"session_id": "s1", "tool_name": "ls", "tool_response": "same",
                "tool_use_id": "u1"}
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
                                    "tool_input": {}, "tool_use_id": "u1"}))
        self.assertIsNone(dispatch(p, "post_tool_use",
                                   {"session_id": "s1", "tool_name": "t",
                                    "tool_response": "o", "tool_use_id": "u1"}))
        self.assertIsNone(dispatch(p, "unknown_event", {"session_id": "s1"}))


if __name__ == "__main__":
    unittest.main()
