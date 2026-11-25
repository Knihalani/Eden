"""The Python client's copies of @eden/protocol's agent-facing texts match the TypeScript originals word for word.

D2022 added a sentence to ``ASK_CONTEXT_DESCRIPTION`` in TypeScript only, so the Hermes, Claude Code and gptme
integrations described the ask tool differently from every TypeScript one; this reads the source so the drift
cannot recur silently."""
import os
import re
import unittest

from eden_client import ASK_CONTEXT_DESCRIPTION, EDEN_CONTEXT_GUIDE

DESCRIBE = os.path.join(os.path.dirname(__file__), "..", "protocol", "src", "describe.ts")


def ts_constant(source: str, name: str) -> str:
    """A `export const NAME = "..." + "...";` string constant, its parts joined."""
    m = re.search(r"export const " + name + r" =\s*((?:\"(?:[^\"\\]|\\.)*\"\s*\+?\s*)+);", source)
    if m is None:
        raise AssertionError(f"{name} not found in describe.ts")
    return "".join(bytes(p, "utf-8").decode("unicode_escape") for p in re.findall(r"\"((?:[^\"\\]|\\.)*)\"", m.group(1)))


@unittest.skipUnless(os.path.exists(DESCRIBE), "run inside the repository")
class ProtocolParity(unittest.TestCase):
    def setUp(self):
        with open(DESCRIBE, encoding="utf-8") as f:
            self.source = f.read()

    def test_ask_context_description(self):
        self.assertEqual(ASK_CONTEXT_DESCRIPTION, ts_constant(self.source, "ASK_CONTEXT_DESCRIPTION"))

    def test_context_guide(self):
        self.assertEqual(EDEN_CONTEXT_GUIDE, ts_constant(self.source, "EDEN_CONTEXT_GUIDE"))


if __name__ == "__main__":
    unittest.main()
