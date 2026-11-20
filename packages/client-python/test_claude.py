"""The Claude Code adapter's obligations (D1992): per-event reporting with on-disk dedup (each
hook is its own process), the packet as additionalContext, the party check as a deny, the
turn's last reply read once from the transcript, and fail-open. Run:
``python3 -m unittest test_claude``."""

import json
import tempfile
import unittest
from pathlib import Path

from eden_client import held_result
from eden_client.claude import EdenClaude

PACKET = {"text": "packet-text"}


class FakeClient:
    made = []

    def __init__(self, **kw):
        self.kw = kw
        self.events = []
        self.check_answer = {"verdict": "proceed", "finding": None}
        self.fail = False
        FakeClient.made.append(self)

    def observe(self, event, wait_ms=None):
        if self.fail:
            raise RuntimeError("down")
        self.events.append((event, wait_ms))
        packet = PACKET if event.get("kind") == "user_message" else None
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
    return EdenClaude(env={"EDEN_USER_ID": "alice@x.com", "EDEN_URL": "http://eden:8790",
                           "EDEN_CHECK_TOOLS": "*", **(env or {})},
                      client_factory=FakeClient, home=tmp)


def kinds(c):
    return [e[0]["kind"] for e in c.events]


class EdenClaudeTests(unittest.TestCase):
    def test_prompt_reports_waits_and_returns_the_packet(self):
        p = plugin()
        out = p.prompt("s1", "when is my lunch?")
        c = FakeClient.made[0]
        self.assertEqual(out["context"], PACKET["text"])
        self.assertEqual(kinds(c), ["user_message"])
        self.assertIsNone(c.events[0][1])  # the user message waits (default wait)

    def test_repeated_identical_prompt_reports_again(self):
        p = plugin()
        p.prompt("s1", "same text")
        p.prompt("s1", "same text")
        self.assertEqual(kinds(FakeClient.made[0]), ["user_message", "user_message"])

    def test_prompt_reports_once_across_processes(self):
        home = tempfile.mkdtemp()
        plugin(home=home).prompt("s1", "same text")
        plugin(home=home).pre_tool("bash", {"cmd": "x"}, "u1", "s1")
        # A second "process" shares the state file: the dedup keys persist.
        state = json.loads(next(Path(home, "eden", "state").glob("*.json")).read_text())
        self.assertTrue(any(k.endswith("#1") for k in state["reported"]))

    def test_finding_denies_and_reports_the_held_result(self):
        p = plugin()
        c = FakeClient.made
        out = p.pre_tool("bash", {"cmd": "rm -rf ~"}, "u1", "s1")
        # default check_answer proceeds; seed a finding
        self.assertIsNone(out)
        FakeClient.made[0].check_answer = {"verdict": "finding", "finding": {"text": "f"}}
        out = p.pre_tool("bash", {"cmd": "rm -rf ~"}, "u2", "s1")
        self.assertEqual(out["deny"], held_result("bash", {"text": "f"}))
        kinds_ = kinds(FakeClient.made[0])
        self.assertEqual(kinds_, ["tool_call", "tool_call", "tool_result"])
        self.assertIn("Not executed", FakeClient.made[0].events[2][0]["output"])

    def test_post_tool_reports_once_per_use_id(self):
        p = plugin()
        p.post_tool("bash", {"stdout": "ok"}, "u1", "s1")
        p.post_tool("bash", {"stdout": "ok"}, "u1", "s1")
        self.assertEqual(kinds(FakeClient.made[0]), ["tool_result"])

    def test_stop_reports_the_last_reply_once(self):
        with tempfile.TemporaryDirectory() as td:
            transcript = Path(td) / "t.jsonl"
            rows = [
                {"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "first"}]}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "All set."}]}},
            ]
            transcript.write_text("\n".join(json.dumps(r) for r in rows))
            p = plugin()
            p.stop("s1", str(transcript))
            p.stop("s1", str(transcript))
            events = FakeClient.made[0].events
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0][0], {"kind": "agent_message", "text": "All set."})

    def test_session_end_removes_the_state_file(self):
        home = tempfile.mkdtemp()
        p = plugin(home=home)
        p.prompt("s1", "hi")
        self.assertTrue(list(Path(home, "eden", "state").glob("*.json")))
        p.session_end("s1")
        self.assertFalse(list(Path(home, "eden", "state").glob("*.json")))

    def test_everything_fails_open(self):
        p = plugin()
        p.session_start("s1")  # makes the client
        FakeClient.made[0].fail = True
        self.assertIsNone(p.prompt("s1", "hello"))
        self.assertIsNone(p.pre_tool("bash", {}, "u1", "s1"))
        self.assertIsNone(p.post_tool("bash", "ok", "u1", "s1"))
        self.assertIsNone(p.stop("s1", "/nonexistent/t.jsonl"))
        self.assertIsNone(p.session_end("s1"))


if __name__ == "__main__":
    unittest.main()
