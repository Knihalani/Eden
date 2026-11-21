"""The Windsurf adapter's obligations: the same per-event reporting and on-disk dedup as the
Claude adapter (each hook is its own process), a prompt that reports and stashes its packet
(Cascade's stdout is UI-only), a deny via the exit-2 marker, the reply reported once per copy,
and fail-open. Run: ``python3 -m unittest test_windsurf``."""

import tempfile
import unittest

from eden_client import held_result
from eden_client.windsurf import EdenWindsurf, dispatch

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

    def check(self, tool, args):
        self.events.append(({"kind": "check", "tool": tool}, 0))
        return self.check_answer

    def end_session(self):
        self.events.append(({"kind": "end"}, None))


def make(home=None, **kw):
    kw.setdefault("env", {"EDEN_USER_ID": "alice@x.com", "EDEN_URL": "http://eden:8790",
                          "EDEN_API_KEY": "key", "EDEN_TENANT_ID": "t", "EDEN_CHECK_TOOLS": "*"})
    FakeClient.made = []
    FakeClient.all_events = []
    FakeClient.fail_all = False
    return EdenWindsurf(home=home or tempfile.mkdtemp(), client_factory=FakeClient, **kw)


def payload(event, info=None, sid="t-1", exec_id="e-1"):
    return {"agent_action_name": event, "trajectory_id": sid,
            "execution_id": exec_id, "model_name": "swe-1",
            "timestamp": "2026-01-01T00:00:00Z", "tool_info": info or {}}


def kinds():
    return [e[0]["kind"] for e in FakeClient.all_events]


class WindsurfHookTest(unittest.TestCase):
    def test_prompt_reports_and_stashes(self):
        p = make()
        self.assertIsNone(dispatch(p, payload("pre_user_prompt", {"user_prompt": "hi"})))
        self.assertIn("user_message", kinds())
        # The packet rides no channel from a pre hook: it stays stashed for a post hook or MCP.
        state = p._load("t-1")
        self.assertIn(PACKET, state.get("stashed", []))

    def test_pre_blocks_on_finding(self):
        p = make()
        dispatch(p, payload("pre_user_prompt", {"user_prompt": "hi"}))  # constructs the client
        FakeClient.made[0].check_answer = {"verdict": "finding", "finding": {"text": "bob is external"}}
        out = dispatch(p, payload("pre_run_command", {"command_line": "rm -rf /"}))
        self.assertTrue(str(out).startswith("DENY:"))
        self.assertEqual(out[len("DENY:"):], held_result("run_command", {"text": "bob is external"}))
        self.assertIn("tool_call", kinds())
        self.assertIn("check", kinds())

    def test_pre_passes_when_clean(self):
        p = make()
        out = dispatch(p, payload("pre_write_code",
                                  {"file_path": "a", "edits": [{"old_string": "x"}]}))
        self.assertIsNone(out)
        self.assertIn("tool_call", kinds())

    def test_post_reports_and_surfaces_stash(self):
        p = make()
        dispatch(p, payload("pre_user_prompt", {"user_prompt": "hi"}))
        out = dispatch(p, payload("post_run_command", {"command_line": "ls"}))
        self.assertIn("tool_result", kinds())
        self.assertIn("packet-text", out or "")
        # And the stash is drained once shown.
        self.assertIsNone(dispatch(p, payload("post_read_code", {"file_path": "a"}), ))

    def test_mcp_events_map_tool_names(self):
        p = make()
        dispatch(p, payload("pre_mcp_tool_use", {"mcp_server_name": "s", "mcp_tool_name": "fs.read",
                                               "mcp_tool_arguments": {}}))
        calls = [e[0] for e in FakeClient.all_events if e[0].get("kind") == "tool_call"]
        self.assertEqual(calls[-1]["tool"], "fs.read")

    def test_reply_reported_once_per_copy(self):
        # Every copy reports: Cascade re-sends the same response and each is its own event.
        p = make()
        dispatch(p, payload("post_cascade_response", {"response": "done"}))
        dispatch(p, payload("post_cascade_response", {"response": "done"}))
        self.assertEqual(kinds().count("agent_message"), 2)

    def test_fail_open(self):
        p = make()
        FakeClient.fail_all = True
        self.assertIsNone(dispatch(p, payload("pre_user_prompt", {"user_prompt": "hi"})))
        self.assertIsNone(dispatch(p, payload("pre_run_command", {"command_line": "ls"})))

    def test_ignored_events_report_nothing(self):
        p = make()
        for ev in ("post_user_prompt", "post_setup_worktree", "post_cascade_response_with_transcript"):
            self.assertIsNone(dispatch(p, payload(ev, {"response": "x"})))
        self.assertEqual(kinds(), [])


if __name__ == "__main__":
    unittest.main()
