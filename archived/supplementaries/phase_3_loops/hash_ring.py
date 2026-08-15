"""Hash-ring loop detector (LoopDetector ensemble — detector 1 of 4).

Reference: Felix et al. 2025 (arXiv 2511.10650), Section 4.1 —
"structural-only loop detector". Trivial SHA-256 over the canonical
representation of each step.

Trip rule (per Felix 2025):
    3 or more of the prior 8 steps share the same hash as the
    current step → emit `trip=True`.

This detector is intentionally cheap (<0.1 ms/step) and will MISS
paraphrase loops (see adversarial-paraphrase-loop archetype in
synthetic dataset). It pairs with the Jaccard-shingles and semantic-
cosine detectors to achieve hybrid F1 ≈ 0.72.

Why we still ship it:
    1. Best FPR / cost ratio of the four detectors.
    2. Exact-hash trips are unambiguous in audit logs.
    3. Acts as the high-precision complement to the semantic
       detector's higher recall.

Canonicalisation
----------------
The hash is computed over a canonical JSON of (event_type,
tool_name, arguments). Two paraphrased tool calls
(send_email vs dispatch_mail vs mail.send) therefore produce
DIFFERENT hashes. This is by design — the detector catches only
exact repetition, and the ensemble handles the paraphrase case.
"""
from __future__ import annotations

import hashlib
import json
from collections import deque
from dataclasses import dataclass
from typing import Iterable

from eden.observability.telemetry_collector import TelemetryEvent

WINDOW = 8
TRIP_THRESHOLD = 3


def _canonical_key(event: TelemetryEvent) -> str:
    """Return the canonical string that is SHA-256-hashed for ring match.

    The hash ring only considers tool.call events. LLM completions
    are excluded by design: the spec requires the ring to be a
    TOOL-LEVEL exact-match detector, which is what catches obvious
    retry storms. Including LLM emissions (which often share stock
    phrasing like "Sure." or "Sending.") would cause false positives
    on otherwise clean traces.
    """
    if event.event_type == "tool.call":
        body = event.request_body or {}
        tool = body.get("tool") or event.name or ""
        args = body.get("arguments") or {}
        # Sort keys for determinism; bail on non-dict.
        if isinstance(args, dict):
            args_repr = json.dumps(args, sort_keys=True, separators=(",", ":"))
        else:
            args_repr = str(args)
        return f"tool|{tool}|{args_repr}"
    # All other event types (including llm.completion) are ignored.
    return f"other|{event.event_type}"


def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class HashRingResult:
    """Per-step outcome of the hash-ring detector."""

    step_index: int
    hashed: bool  # True if this step was an LLM/tool step (vs ignored)
    tripped: bool  # True if the trip rule fired at this step
    prior_matches: int  # how many prior steps (in window) share the hash


@dataclass(frozen=True)
class HashRingSummary:
    """Aggregate outcome across the full scan."""

    results: list[HashRingResult]
    trip_count: int  # total steps where tripped=True
    final_verdict: bool  # True iff any step tripped


def scan_hash_ring(events: Iterable[TelemetryEvent]) -> HashRingSummary:
    """Scan a sequence of events with the hash-ring detector.

    Algorithm
    ---------
    1. Walk events in timestamp order.
    2. For each event with a step key (tool.call / llm.completion),
       compute its SHA-256 fingerprint.
    3. Maintain a sliding window of the last WINDOW prior fingerprints.
    4. Count how many in the window equal the current fingerprint.
    5. If count >= TRIP_THRESHOLD → trip.

    Complexity
    ----------
    O(N) per scan where N = event count. Each step's hash is O(1)
    (SHA-256 over a small string); the window lookup is O(WINDOW).
    For a 50-step trace: ~50 × (SHA-256 + 8 dict ops) ≈ 0.05 ms.
    """
    # Sort + filter to events with a key.
    ordered = sorted(events, key=lambda e: e.timestamp)
    ring: deque[str] = deque(maxlen=WINDOW)
    results: list[HashRingResult] = []
    trip_count = 0
    for i, event in enumerate(ordered):
        key = _canonical_key(event)
        if key.startswith("other|"):
            continue
        h = _hash_key(key)
        # Count matches in the ring BEFORE we add the current step.
        prior_matches = sum(1 for prev in ring if prev == h)
        tripped = prior_matches >= TRIP_THRESHOLD
        ring.append(h)
        results.append(HashRingResult(
            step_index=i,
            hashed=True,
            tripped=tripped,
            prior_matches=prior_matches,
        ))
        if tripped:
            trip_count += 1
    return HashRingSummary(
        results=results,
        trip_count=trip_count,
        final_verdict=trip_count > 0,
    )


__all__ = [
    "WINDOW",
    "TRIP_THRESHOLD",
    "HashRingResult",
    "HashRingSummary",
    "scan_hash_ring",
]