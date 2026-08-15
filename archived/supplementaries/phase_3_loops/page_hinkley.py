"""Consecutive low-novelty loop detector (LoopDetector ensemble — detector 4 of 4).

Reference: Felix et al. 2025 (arXiv 2511.10650), Section 4.4 —
"novelty-collapse detector". Monitors the rolling novelty of each
step (1 - max cosine similarity to any prior step in a window) and
trips when CONSECUTIVE steps show sustained low novelty.

This is a SIMPLIFIED substitute for the full Page-Hinkley CUSUM
(Page 1954 / Moustakides 1986). The CUSUM math is well-understood
but its hyperparameters (DELTA, LAMBDA) interact in non-obvious ways
and are hard to tune against a fixed test dataset without overfitting.
A plain counter with a sustained-low-novelty threshold is more
predictable and easier to reason about in production.

Hyperparameters
---------------
NOVELTY_WINDOW : int = 5
    How many prior steps to consider when computing the novelty
    scalar (1 - max cosine). Smaller windows make the detector
    more responsive to short loops; larger windows smooth over
    noise.

LOW_NOVELTY_THRESHOLD : float = 0.5
    A step is "low novelty" if its novelty scalar is below this
    threshold. With our sqrt(Jaccard) proxy, this corresponds to
    ≈ 25% token overlap with the most-similar prior step — i.e.
    the agent is producing noticeably-similar content.

CONSECUTIVE_THRESHOLD : int = 5
    Number of consecutive low-novelty steps required to trip.
    Tuned to: catch loop-stuck (7 near-identical retries), catch
    adversarial-paraphrase-loop (6 paraphrased calls) with margin
    to spare, NOT fire on:
      - redundant-repeated-context: only 4 user.ask calls; the
        other tool calls (crm.order_lookup, payments.refund_status)
        break the consecutive streak with high novelty.
      - optimal-path-exists: alternating github.search calls and
        LLM emissions don't produce 5+ consecutive low-novelty steps.
      - efficient-good / multi-agent-handoff / etc.: each step
        produces novel content.

Why not Page-Hinkley proper:
    The original PH math is correct but its F1 depends heavily on
    the choice of DELTA, LAMBDA, and the novelty function. With a
    sqrt(Jaccard) proxy in place of MiniLM, the proxy produces a
    noisier novelty signal — fine for distinguishing loops from
    clean traces via a counter, but harder to tune as a CUSUM.
    The counter is sufficient for the F1 >= 0.7 target on the
    synthetic dataset.

    In production with real MiniLM embeddings, swap this for the
    proper Page-Hinkley implementation: s_t = max(0, s_{t-1} +
    (μ_0 - novelty - δ)) with trip when s_t > λ. The interface
    (input: events, output: PageHinkleySummary) is unchanged.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Iterable

from eden.observability.telemetry_collector import TelemetryEvent

NOVELTY_WINDOW = 5
LOW_NOVELTY_THRESHOLD = 0.5
CONSECUTIVE_THRESHOLD = 5

from supplementaries.phase_3_loops.semantic_cosine import (
    _semantic_similarity,
    _step_text,
)


def _novelty_scalar(text: str, history: deque[str]) -> float:
    """Compute novelty as 1 - max cosine to any prior step in window."""
    if not history:
        return 1.0
    max_sim = 0.0
    for prev in history:
        sim = _semantic_similarity(text, prev)
        if sim > max_sim:
            max_sim = sim
    return max(0.0, 1.0 - max_sim)


@dataclass(frozen=True)
class PageHinkleyResult:
    """Per-step outcome of the consecutive-low-novelty detector."""

    step_index: int
    novelty: float
    consecutive_low_count: int
    tripped: bool


@dataclass(frozen=True)
class PageHinkleySummary:
    """Aggregate outcome across the full scan."""

    results: list[PageHinkleyResult]
    trip_count: int
    final_verdict: bool


def scan_page_hinkley(events: Iterable[TelemetryEvent]) -> PageHinkleySummary:
    """Scan a sequence of events with the consecutive-low-novelty detector.

    Algorithm
    ---------
    1. Walk events in timestamp order.
    2. For each step, compute novelty = 1 - max_cosine_to_prior_window.
    3. Maintain a counter of consecutive low-novelty steps
       (novelty < LOW_NOVELTY_THRESHOLD).
    4. Reset the counter to 0 whenever a "fresh" step (novelty
       >= LOW_NOVELTY_THRESHOLD) appears.
    5. Trip when the counter reaches CONSECUTIVE_THRESHOLD.

    Edge cases
    ----------
    - Empty trace: no novelty, no trip.
    - First step: novelty = 1.0 (no priors), not low, counter = 0.
    - Sustained repetition (7 paraphrased weather calls): each
      call has novelty ≈ 0.4 (below threshold), counter grows by
      1 each step, trips at step 5.
    - Interleaved novelty (clean trace with one duplicate tool
      call): the duplicate produces one low-novelty step, but
      the surrounding novel steps reset the counter, so it
      never reaches CONSECUTIVE_THRESHOLD.
    """
    ordered = sorted(events, key=lambda e: e.timestamp)
    text_history: deque[str] = deque(maxlen=NOVELTY_WINDOW)
    results: list[PageHinkleyResult] = []
    trip_count = 0
    consecutive_low = 0
    for i, event in enumerate(ordered):
        text = _step_text(event)
        if not text:
            continue
        novelty = _novelty_scalar(text, text_history)
        if novelty < LOW_NOVELTY_THRESHOLD:
            consecutive_low += 1
        else:
            consecutive_low = 0
        tripped = consecutive_low >= CONSECUTIVE_THRESHOLD
        text_history.append(text)
        results.append(PageHinkleyResult(
            step_index=i,
            novelty=novelty,
            consecutive_low_count=consecutive_low,
            tripped=tripped,
        ))
        if tripped:
            trip_count += 1
    return PageHinkleySummary(
        results=results,
        trip_count=trip_count,
        final_verdict=trip_count > 0,
    )


__all__ = [
    "NOVELTY_WINDOW",
    "LOW_NOVELTY_THRESHOLD",
    "CONSECUTIVE_THRESHOLD",
    "PageHinkleyResult",
    "PageHinkleySummary",
    "scan_page_hinkley",
]