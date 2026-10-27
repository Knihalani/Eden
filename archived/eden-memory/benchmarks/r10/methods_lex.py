"""Lexical incumbents: BM25F on the prompt alone, and BM25F on the situation (prompt ⊕ previous turn ⊕ path tokens).

These are R1's M1 / M1+M7 (lexpy is the verified Python port of lex.ts), re-run on every fixture under R10's protocol.
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../memory-cues/nim"))
from lexpy import BM25F, toks, ctx_cue  # noqa: E402


def cue_text(c, ctx=True):
    if not ctx:
        return c["cue"]
    return ctx_cue(c["cue"], c.get("last_paths") or [], c.get("prev_turn") or "")


class BM25:
    def __init__(self, fx, ctx=True):
        self.fx, self.ctx = fx, ctx
        self.idx = BM25F([{"subject": m.get("subject", ""), "text": m["text"]} for m in fx.memories])
        self.pos = {m["id"]: i for i, m in enumerate(fx.memories)}

    def scores(self, c):
        q = toks(cue_text(c, self.ctx))
        out = {}
        for m in self.fx.visible(c):
            s = self.idx.score(q, self.pos[m["id"]])
            if s > 0:
                out[m["id"]] = s
        return out
