"""Jaccard-shingles loop detector (LoopDetector ensemble — detector 2 of 4).

Reference: Felix et al. 2025 (arXiv 2511.10650), Section 4.2 —
"shingle-based loop detector". Catches paraphrase loops that the
exact-hash detector misses.

Trip rule:
    3 or more of the prior 5 steps share Jaccard(word-shingles) > 0.8
    with the current step → emit `trip=True`.

Why 5-step window (vs 8-step for hash ring): the Jaccard detector is
more expensive than the hash ring (computing 5-shingle sets on each
step), so we use a smaller window. The 5-step window is also
sufficient because paraphrase loops typically have a tighter cycle
length (1-3 steps) than exact-hash loops.

This detector requires no external models — pure-Python set
arithmetic over word-shingles.

NOTE: This file defines a pure-stdlib implementation of word-shingle
Jaccard. We reuse the srr.py helpers via direct calls rather than
re-importing to keep the ensemble module self-contained.
"""
from __future__ import annotations

import re
from collections import deque
from dataclasses import dataclass
from typing import Iterable

from eden.observability.telemetry_collector import TelemetryEvent

WINDOW = 5
TRIP_THRESHOLD = 3
JACCARD_THRESHOLD = 0.4
SHINGLE_K = 3  # word-shingle size — k=3 catches short paraphrases
                # that k=5 misses (e.g. shared args like
                # "alice@eden.co hello hi" which is only 3 tokens).

_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


def _shingles(text: str, k: int = SHINGLE_K) -> set[str]:
    if not text:
        return set()
    tokens = _TOKEN_RE.findall(text.lower())
    if len(tokens) < k:
        return {" ".join(tokens).strip()} if tokens else set()
    return {" ".join(tokens[i:i + k]) for i in range(len(tokens) - k + 1)}


def _step_text(event: TelemetryEvent) -> str:
    """Mirror of srr._step_text for self-contained operation."""
    if event.event_type == "llm.completion":
        body = event.response_body or {}
        choices = body.get("choices") or []
        bits: list[str] = []
        for c in choices:
            msg = (c or {}).get("message") or {}
            content = msg.get("content")
            if content:
                bits.append(str(content))
        for tc in (event.tool_calls_full or []):
            fn = (tc or {}).get("function") or {}
            name = fn.get("name")
            if name:
                bits.append(name)
        return " ".join(bits)
    if event.event_type == "tool.call":
        body = event.request_body or {}
        tool = body.get("tool") or event.name or ""
        args = body.get("arguments") or {}
        if isinstance(args, dict):
            keys = " ".join(sorted(args.keys()))
            vals = " ".join(sorted(str(v) for v in args.values()))
        else:
            keys = ""
            vals = str(args)
        return f"{tool} {keys} {vals}"
    if event.event_type == "env.step":
        obs = (event.payload or {}).get("observation")
        name = event.name or ""
        return f"{name} {obs or ''}".strip()
    parts: list[str] = []
    if event.name:
        parts.append(event.name)
    if event.payload:
        parts.extend(str(k) for k in event.payload.keys())
    return " ".join(parts)


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union > 0 else 0.0


@dataclass(frozen=True)
class JaccardResult:
    step_index: int
    hashed: bool
    tripped: bool
    max_prior_jaccard: float


@dataclass(frozen=True)
class JaccardSummary:
    results: list[JaccardResult]
    trip_count: int
    final_verdict: bool


def scan_jaccard_shingles(events: Iterable[TelemetryEvent]) -> JaccardSummary:
    """Scan a sequence of events with the Jaccard-shingles detector.

    Per step: compute the shingle set, compare against the last
    WINDOW prior shingle sets, count matches above the Jaccard
    threshold. Trip if match count >= TRIP_THRESHOLD.
    """
    ordered = sorted(events, key=lambda e: e.timestamp)
    shingle_history: deque[set[str]] = deque(maxlen=WINDOW)
    results: list[JaccardResult] = []
    trip_count = 0
    for i, event in enumerate(ordered):
        text = _step_text(event)
        sh = _shingles(text)
        if not sh:
            continue
        # Compute max Jaccard + count of matches above threshold
        # against prior shingle sets.
        max_sim = 0.0
        match_count = 0
        for prev in shingle_history:
            sim = _jaccard(sh, prev)
            if sim > max_sim:
                max_sim = sim
            if sim >= JACCARD_THRESHOLD:
                match_count += 1
        tripped = match_count >= TRIP_THRESHOLD
        shingle_history.append(sh)
        results.append(JaccardResult(
            step_index=i,
            hashed=True,
            tripped=tripped,
            max_prior_jaccard=max_sim,
        ))
        if tripped:
            trip_count += 1
    return JaccardSummary(
        results=results,
        trip_count=trip_count,
        final_verdict=trip_count > 0,
    )


__all__ = [
    "WINDOW",
    "TRIP_THRESHOLD",
    "JACCARD_THRESHOLD",
    "SHINGLE_K",
    "JaccardResult",
    "JaccardSummary",
    "scan_jaccard_shingles",
]