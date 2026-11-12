"""A length-only model for the LOGO screen (M14): scores an item by its character length and nothing else. A model
whose twin or fact-@1 score on a source is near this one's may be reading length, the cue D908's tagger learned."""

from __future__ import annotations

import math

from logo_core import item_text


class LengthCue:
    def __init__(self, cfg: dict):
        self.sign = 1.0

    def fit(self, rows: list[dict]) -> "LengthCue":
        # The direction from training: are facts longer or shorter than their twins there?
        longer = sum(len(item_text(r["fact"])) > len(item_text(r["decoy"])) for r in rows)
        self.sign = 1.0 if longer >= len(rows) / 2 else -1.0
        return self

    def _s(self, it: dict) -> float:
        return self.sign * math.log1p(len(item_text(it)))

    def score(self, rows: list[dict]):
        items, pairs = [], []
        for r in rows:
            s = {"fact": self._s(r["fact"]), "decoy": self._s(r["decoy"]),
                 "neutrals": [self._s(x) for x in r["neutrals"]], "others": [self._s(x) for x in r["others"]]}
            items.append(s)
            cr = lambda v: (v, v)  # noqa: E731
            pairs.append([{"fact": cr(s["fact"]), "decoy": cr(s["decoy"]), "neutrals": [cr(v) for v in s["neutrals"]],
                           "others": [cr(v) for v in s["others"]]} for _ in r["requests"]])
        return items, pairs


def make(cfg: dict) -> LengthCue:
    return LengthCue(cfg)
