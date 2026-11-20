"""The gptme adapter's obligations (D1990): packets live through the turn and persist into the log,
every event reported, the party check stashed for the confirm seam, and fail-open — the same
contract as test_hermes.py, through gptme's surface. Run: ``python3 -m unittest test_gptme``."""

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


class ToolUse:
    """The bit of gptme's ToolUse the adapter reads."""

    def __init__(self, tool, content=None, args=None, kwargs=None):
        self.tool = tool
        self.content = content
        self.args = args
        self.kwargs = kwargs


class Gptme(unittest.TestCase):
    def setUp(self):
        FakeClient.made = []

    def test_no_user_disables_everything(self):
        p = EdenGptme(env={"EDEN_URL": "http://eden:8790"}, client_factory=FakeClient)
        self.assertEqual(p.generation([Msg("user", "hi")], "/tmp/l/1"), [])
        self.assertIsNone(p.tool_pre(ToolUse("shell", content="ls"), "/tmp/l/1"))
        self.assertIsNone(p.session_start("/tmp/l/1"))
        self.assertEqual(p.ask("q"), "No context available.")
        self.assertEqual(FakeClient.made, [])

    def test_session_start_then_generation_reports_only_the_latest_user(self):
        p = plugin({"EDEN_API_KEY": "k"})
        logdir = "/tmp/logs/1"
        p.session_start(logdir)
        messages = [Msg("user", "hi"), Msg("assistant", "hello"), Msg("user", "Move lunch with Priya")]
        self.assertEqual(p.generation(messages, logdir), [PACKET["text"]])
        c = FakeClient.made[0]
        self.assertEqual((c.kw["base_url"], c.kw["api_key"]), ("http://eden:8790", "k"))
        self.assertEqual((c.kw["user_id"], c.kw["session_id"]), ("e:alice_2bwork@x.com", eden_id("1")))
        kinds = [e["kind"] for e, _ in c.events]
        self.assertEqual(kinds, ["session_start", "user_message"])
        # A resumed log reports only its latest user message, and that one waits for its lookup.
        self.assertEqual([w for e, w in c.events if e["kind"] == "user_message"], [None])
        # An un-persisted packet is re-yielded every generation — GENERATION_PRE context is transient
        # and the turn's tool loop must keep seeing it — without re-reporting anything.
        self.assertEqual(p.generation(messages, logdir), [PACKET["text"]])
        self.assertEqual(len(c.events), 2)
        # A fresh mid-turn message is still reported, with no wait.
        self.assertEqual(p.generation(messages + [Msg("assistant", "done!")], logdir), [PACKET["text"]])
        self.assertEqual(c.events[-1], ({"kind": "agent_message", "text": "done!"}, 0))

    def test_persist_moves_packets_into_the_log_once(self):
        p = plugin()
        logdir = "/tmp/logs/1"
        p.generation([Msg("user", "hi")], logdir)
        # TURN_POST appends the packet to the log; after that it rides along in history.
        self.assertEqual(p.persist(logdir), [PACKET["text"]])
        self.assertEqual(p.persist(logdir), [])
        self.assertEqual(p.generation([Msg("user", "hi"), Msg("system", PACKET["text"])], logdir), [])
        # A packet that arrives next turn persists separately.
        c = FakeClient.made[0]
        c.pending_queue.append({"text": "later-packet"})
        self.assertEqual(p.generation([Msg("user", "hi"), Msg("system", PACKET["text"]),
                                       Msg("user", "next")], logdir), ["later-packet"])
        self.assertEqual(p.persist(logdir), ["later-packet"])

    def test_one_client_per_session(self):
        p = plugin()
        p.generation([Msg("user", "hi")], "/tmp/logs/1")
        p.generation([Msg("user", "hi")], "/tmp/logs/2")
        p.generation([Msg("user", "hi")], None)  # no logdir: stays in the current session
        self.assertEqual(len(FakeClient.made), 2)
        p.generation([Msg("user", "hi")], "/tmp/logs/3")
        self.assertEqual(len(FakeClient.made), 3)
        self.assertEqual(FakeClient.made[2].kw["session_id"], eden_id("3"))

    def test_repeated_identical_user_message_reports_again(self):
        p = plugin()
        logdir = "/tmp/logs/1"
        p.generation([Msg("user", "same words")], logdir)
        c = FakeClient.made[0]
        # The user asks the same thing twice: the second copy is a new message, keyed apart.
        p.generation([Msg("user", "same words"), Msg("assistant", "ok"), Msg("user", "same words")],
                     logdir)
        users = [w for e, w in c.events if e["kind"] == "user_message"]
        self.assertEqual(len(users), 2)

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
        self.assertIsNone(p.tool_pre(ToolUse("shell", content="ls"), logdir))
        self.assertEqual(c.events[-1][0]["kind"], "tool_call")
        p.tool_post(ToolUse("shell"), "output", logdir)
        self.assertEqual(c.events[-1][0]["kind"], "tool_result")
        # Eden's own tool is never checked.
        self.assertIsNone(p.tool_pre(ToolUse("ask_context", content="hi"), logdir))
        self.assertNotIn(("ask_context", {"question": "hi"}), c.checks)
        # A finding stashes the held result for the confirm hook, which skips with it once.
        c.check_answer = {"verdict": "finding", "finding": {"text": "this looks off"}}
        tool_use = ToolUse("shell", content="rm -rf /")
        held = p.tool_pre(tool_use, logdir)
        self.assertEqual(held, held_result("shell", c.check_answer["finding"]))
        self.assertEqual(p.tool_confirm(tool_use), held)
        self.assertIsNone(p.tool_confirm(tool_use))
        self.assertTrue(any(e["kind"] == "tool_result" and e["output"] == held for e, _ in c.events))

    def test_fail_open(self):
        p = plugin()
        p.generation([Msg("user", "hi")], "/tmp/logs/1")
        c = FakeClient.made[0]
        c.fail = True
        self.assertEqual(p.generation([Msg("user", "again")], "/tmp/logs/1"), [])
        self.assertIsNone(p.tool_pre(ToolUse("shell", content="ls"), "/tmp/logs/1"))
        self.assertIsNone(p.tool_post(ToolUse("shell"), "out", "/tmp/logs/1"))
        self.assertEqual(p.ask("anything"), "No context available.")
        self.assertEqual(len(c.events), 1)

    def test_ask_answers_and_session_end_drops(self):
        p = plugin()
        p.session_start("/tmp/logs/1")
        self.assertEqual(FakeClient.made[0].events[0][0]["kind"], "session_start")
        self.assertEqual(p.ask("wifi?"), "answer to wifi?")
        p.session_end("/tmp/logs/1")
        # A new identity on the same logdir gets a fresh client (and its own packet).
        self.assertEqual(p.generation([Msg("user", "hi")], "/tmp/logs/1"), [PACKET["text"]])
        self.assertEqual(len(FakeClient.made), 2)


if __name__ == "__main__":
    unittest.main()
