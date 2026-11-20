"""The gptme adapter's obligations (D1990): packets into the log, every event reported, the party check
on the policy seam, and fail-open — the same contract as test_hermes.py, through gptme's surface.
Run: ``python3 -m unittest test_gptme``."""

import unittest

from eden_client import eden_id, held_result
from eden_client.gptme import EdenGptme

PACKET = {"text": "packet-text"}


class FakeClient:
    made = []

    def __init__(self, **kw):
        self.kw = kw
        self.events = []
        self.checks = []
        self.pending_queue = []
        self.check_answer = {"verdict": "proceed", "finding": None}
        self.fail = False
        FakeClient.made.append(self)

    def _maybe_fail(self):
        if self.fail:
            raise RuntimeError("down")

    def observe(self, event, wait_ms=None):
        self._maybe_fail()
        self.events.append((event, wait_ms))
        packet = PACKET if event.get("kind") == "user_message" else None
        return {"injection": packet, "pending": False}

    def collect(self, injection):
        return ([injection] if injection else []) + self.pending()

    def pending(self):
        self._maybe_fail()
        out, self.pending_queue = self.pending_queue, []
        return out

    def check(self, tool, data):
        self._maybe_fail()
        self.checks.append((tool, data))
        return self.check_answer

    def ask(self, question):
        self._maybe_fail()
        return {"answer": f"answer to {question}", "citations": []}


def plugin(env=None):
    FakeClient.made = []
    return EdenGptme(env={"EDEN_USER_ID": "alice+work@x.com", "EDEN_URL": "http://eden:8790",
                          "EDEN_CHECK_TOOLS": "*", **(env or {})},
                     client_factory=FakeClient)


class Msg:
    def __init__(self, role, content):
        self.role = role
        self.content = content


class Gptme(unittest.TestCase):
    def setUp(self):
        FakeClient.made = []

    def test_no_user_disables_everything(self):
        p = EdenGptme(env={"EDEN_URL": "http://eden:8790"}, client_factory=FakeClient)
        self.assertIsNone(p.generation([Msg("user", "hi")], "/tmp/l/1"))
        self.assertIsNone(p.tool_pre("shell", {"content": "ls"}, "/tmp/l/1"))
        self.assertIsNone(p.session_start("/tmp/l/1"))
        self.assertEqual(p.ask("q"), "No context available.")
        self.assertEqual(FakeClient.made, [])

    def test_session_start_then_generation_reports_only_the_latest_user(self):
        p = plugin({"EDEN_API_KEY": "k"})
        logdir = "/tmp/logs/1"
        p.session_start(logdir)
        messages = [Msg("user", "hi"), Msg("assistant", "hello"), Msg("user", "Move lunch with Priya")]
        self.assertEqual(p.generation(messages, logdir), PACKET["text"])
        c = FakeClient.made[0]
        self.assertEqual((c.kw["base_url"], c.kw["api_key"]), ("http://eden:8790", "k"))
        self.assertEqual((c.kw["user_id"], c.kw["session_id"]), ("e:alice_2bwork@x.com", eden_id("1")))
        kinds = [e["kind"] for e, _ in c.events]
        self.assertEqual(kinds, ["session_start", "user_message"])
        # A resumed log reports only its latest user message, and that one waits for its lookup.
        self.assertEqual([w for e, w in c.events if e["kind"] == "user_message"], [None])
        # The packet yielded once stays in gptme's log: a repeated call reports and yields nothing.
        self.assertIsNone(p.generation(messages, logdir))
        self.assertEqual(len(c.events), 2)
        # A fresh mid-turn message is still reported, with no wait.
        self.assertIsNone(p.generation(messages + [Msg("assistant", "done!")], logdir))
        self.assertEqual(c.events[-1], ({"kind": "agent_message", "text": "done!"}, 0))

    def test_one_client_per_session(self):
        p = plugin()
        p.generation([Msg("user", "hi")], "/tmp/logs/1")
        p.generation([Msg("user", "hi")], "/tmp/logs/2")
        p.generation([Msg("user", "hi")], None)  # no logdir: stays in the current session
        self.assertEqual(len(FakeClient.made), 2)
        p.generation([Msg("user", "hi")], "/tmp/logs/3")
        self.assertEqual(len(FakeClient.made), 3)
        self.assertEqual(FakeClient.made[2].kw["session_id"], eden_id("3"))

    def test_turn_end_reports_the_last_assistant_message_once(self):
        p = plugin()
        logdir = "/tmp/logs/1"
        p.generation([Msg("user", "hi")], logdir)
        c = FakeClient.made[0]
        before = len(c.events)
        messages = [Msg("user", "hi"), Msg("assistant", "done!")]
        p.turn_end(messages, logdir)
        self.assertEqual(c.events[-1][0], {"kind": "agent_message", "text": "done!"})
        self.assertEqual(len(c.events), before + 1)
        # The same message observed again by a later generation is not re-reported.
        p.generation(messages, logdir)
        self.assertEqual(len(c.events), before + 1)

    def test_tool_lifecycle_and_the_party_check(self):
        p = plugin()
        logdir = "/tmp/logs/1"
        p.generation([Msg("user", "hi")], logdir)
        c = FakeClient.made[0]
        self.assertIsNone(p.tool_pre("shell", {"content": "ls"}, logdir))
        self.assertEqual(c.events[-1][0]["kind"], "tool_call")
        p.tool_post("shell", "output", logdir)
        self.assertEqual(c.events[-1][0]["kind"], "tool_result")
        # Eden's own tool is never checked.
        self.assertIsNone(p.tool_pre("ask_context", {"question": "hi"}, logdir))
        self.assertNotIn(("ask_context", {"question": "hi"}), c.checks)
        # A finding denies with the held result, which Eden also sees reported.
        c.check_answer = {"verdict": "finding", "finding": {"text": "this looks off"}}
        held = p.tool_pre("shell", {"content": "rm -rf /"}, logdir)
        self.assertEqual(held, held_result("shell", c.check_answer["finding"]))
        self.assertTrue(any(e["kind"] == "tool_result" and e["output"] == held for e, _ in c.events))

    def test_fail_open(self):
        p = plugin()
        p.generation([Msg("user", "hi")], "/tmp/logs/1")
        c = FakeClient.made[0]
        c.fail = True
        self.assertIsNone(p.generation([Msg("user", "again")], "/tmp/logs/1"))
        self.assertIsNone(p.tool_pre("shell", {"content": "ls"}, "/tmp/logs/1"))
        self.assertIsNone(p.tool_post("shell", "out", "/tmp/logs/1"))
        self.assertEqual(p.ask("anything"), "No context available.")
        self.assertEqual(len(c.events), 1)

    def test_ask_answers_and_session_end_drops(self):
        p = plugin()
        p.session_start("/tmp/logs/1")
        self.assertEqual(FakeClient.made[0].events[0][0]["kind"], "session_start")
        self.assertEqual(p.ask("wifi?"), "answer to wifi?")
        p.session_end("/tmp/logs/1")
        # A new identity on the same logdir gets a fresh client (and its own packet).
        self.assertEqual(p.generation([Msg("user", "hi")], "/tmp/logs/1"), PACKET["text"])
        self.assertEqual(len(FakeClient.made), 2)


if __name__ == "__main__":
    unittest.main()
