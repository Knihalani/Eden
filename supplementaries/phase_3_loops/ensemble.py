"""Loop detector ensemble — 4-detector orchestrator with "2 of 4 in 5" rule.

Reference: Felix et al. 2025 (arXiv 2511.10650), Section 4.4 —
"hybrid ensemble". The 4 detectors each emit per-step trip
booleans; the ensemble emits a final trip when at least 2 of 4
detectors tripped within a 5-step rolling window.

Why "2 of 4 in 5":
    - 1 detector alone (especially the hash ring) is too noisy.
    - 3 of 4 is too strict — paraphrase loops typically trip only
      detectors 2 + 3 (Jaccard + semantic), not the hash ring.
    - 2 of 4 in a 5-step window captures the "consistent multi-
      signal" pattern of a real loop while tolerating single-
      detector noise.

Detectors
---------
1. SHA-256 hash ring on (tool_name, sorted_args).
2. Jaccard on k=3 word-shingles.
3. Semantic cosine (proxy stub here; swap in MiniLM in production).
4. Page-Hinkley CUSUM on novelty scalar.

Output
------
LoopReport verdict ∈ {OK, LOOP}
action  ∈ {ok, skip_step, block, escalate} per spec.

Mapping (per spec):
    verdict=LOOP → action=block
    verdict=LOOP with severity=high (3+ detectors agreed) → action=escalate
    verdict=OK   → action=ok
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Iterable

from eden.observability.telemetry_collector import TelemetryEvent

from supplementaries.phase_3_loops.hash_ring import scan_hash_ring
from supplementaries.phase_3_loops.jaccard_shingles import scan_jaccard_shingles
from supplementaries.phase_3_loops.page_hinkley import scan_page_hinkley
from supplementaries.phase_3_loops.semantic_cosine import scan_semantic_cosine

OUTER_WINDOW = 5
MIN_DETECTORS = 2
HIGH_SEVERITY_DETECTORS = 3


@dataclass(frozen=True)
class DetectorVote:
    """One detector's per-step vote."""

    name: str
    tripped: bool


@dataclass(frozen=True)
class LoopReport:
    """Final ensemble outcome."""

    verdict: str             # "OK" | "LOOP"
    action: str              # "ok" | "skip_step" | "block" | "escalate"
    detectors_tripped: list[str]
    tripped_count: int       # per current 5-step window
    severity: str            # "low" | "medium" | "high"


def check(events: Iterable[TelemetryEvent]) -> LoopReport:
    """Run all 4 detectors and apply the "2 of 4 in 5" rule.

    Algorithm
    ---------
    1. Run all 4 detectors; collect per-step trips.
    2. For each step in the trace, count how many detectors
       tripped in the prior OUTER_WINDOW steps (inclusive of current).
    3. If count >= MIN_DETECTORS at any step, verdict = LOOP.
    4. severity = "high" if peak count >= HIGH_SEVERITY_DETECTORS.
    """
    # Run detectors — each returns its own per-step structure.
    events_list = list(events)
    h = scan_hash_ring(events_list)
    j = scan_jaccard_shingles(events_list)
    s = scan_semantic_cosine(events_list)
    p = scan_page_hinkley(events_list)

    # Build per-step vote maps indexed by step_index.
    h_votes = {r.step_index: r.tripped for r in h.results}
    j_votes = {r.step_index: r.tripped for r in j.results}
    s_votes = {r.step_index: r.tripped for r in s.results}
    p_votes = {r.step_index: r.tripped for r in p.results}

    # Collect every step_index any detector visited.
    all_idx = sorted(set(h_votes) | set(j_votes) | set(s_votes) | set(p_votes))
    # Sliding window over the trace.
    recent_trips: deque[bool] = deque(maxlen=OUTER_WINDOW)
    detectors_tripped_global: set[str] = set()
    peak_count = 0

    # Build a per-step list of detector votes for sliding-window count.
    per_step_votes: list[DetectorVote] = []
    # We need to slide across step indices; for each step, count votes
    # in the prior OUTER_WINDOW steps (including current). We track
    # the count using a deque of {name: bool} dicts.
    per_step_vote_lists: list[list[bool]] = []
    for i in all_idx:
        this_step_votes = [
            h_votes.get(i, False),
            j_votes.get(i, False),
            s_votes.get(i, False),
            p_votes.get(i, False),
        ]
        per_step_vote_lists.append(this_step_votes)

    # Now slide across the per-step list and compute the trip count
    # in the prior OUTER_WINDOW steps at each position.
    for pos, this_step in enumerate(per_step_vote_lists):
        window_lo = max(0, pos - OUTER_WINDOW + 1)
        window = per_step_vote_lists[window_lo:pos + 1]
        window_count = sum(sum(v) for v in window)
        if window_count >= MIN_DETECTORS:
            detectors_tripped_global.update(
                n for n, v in zip(
                    ["hash_ring", "jaccard", "semantic", "page_hinkley"],
                    this_step,
                ) if v
            )
            if window_count > peak_count:
                peak_count = window_count

    if peak_count >= HIGH_SEVERITY_DETECTORS:
        severity = "high"
        action = "escalate"
    elif peak_count >= MIN_DETECTORS:
        severity = "medium"
        action = "block"
    else:
        severity = "low"
        action = "ok"

    verdict = "LOOP" if peak_count >= MIN_DETECTORS else "OK"

    return LoopReport(
        verdict=verdict,
        action=action,
        detectors_tripped=sorted(detectors_tripped_global),
        tripped_count=peak_count,
        severity=severity,
    )


__all__ = [
    "OUTER_WINDOW",
    "MIN_DETECTORS",
    "HIGH_SEVERITY_DETECTORS",
    "DetectorVote",
    "LoopReport",
    "check",
]