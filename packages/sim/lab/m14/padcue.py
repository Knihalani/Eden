"""A boilerplate-only model for the length-debiased M2 (M14, D1024): scores an item by the characters of
`debias.ts`'s boilerplate it holds. Its twin score on `m2lb` is the cue the debiasing leaves (the twin carries more
padding when it must end longer); a model near it may be reading padding, not content."""

from __future__ import annotations

import re

from lengthcue import LengthCue

# The chunks debias.ts adds (kept in step with its lists; a missed chunk only weakens this reference).
_CHUNKS = [
    "Kind regards,\nThe Customer Team", "This email and any attachments are confidential", "Sent from my phone",
    "Please consider the environment before printing this email.", "You are receiving this message because",
    "Office hours Monday to Friday", "Thanks again, and have a lovely week.", "Page 1 of 1",
    "This document is for information only", "Last reviewed: see revision history.", "Internal use only.",
    "Contents: 1. Summary 2. Details 3. Contacts", "Questions? See the shared FAQ", "Manage notifications in the app",
    "This is an automated message.", "Download the app for faster access.", "Need help? Visit the help centre.",
    "Ref: AUTO-NOTICE",
]
_CHAT = re.compile(r"^(?:Sam|Alex|Jo): (?:ok|👍|lol|thx|see you later|brb|nice one|haha yes|cool cool|on my way)$", re.M)


class PadCue(LengthCue):
    def _s(self, it: dict) -> float:
        t = it.get("text", "")
        return self.sign * float(sum(len(c) * t.count(c) for c in _CHUNKS) + sum(len(m) for m in _CHAT.findall(t)))

    def fit(self, rows: list[dict]) -> "PadCue":
        more = sum(self._s(r["fact"]) > self._s(r["decoy"]) for r in rows)
        less = sum(self._s(r["fact"]) < self._s(r["decoy"]) for r in rows)
        self.sign = 1.0 if more >= less else -1.0
        return self


def make(cfg: dict) -> PadCue:
    return PadCue(cfg)
