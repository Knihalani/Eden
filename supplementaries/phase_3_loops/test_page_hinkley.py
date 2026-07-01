"""Unit tests for the Page-Hinkley CUSUM loop detector (detector 4 of 4)."""
from __future__ import annotations

import pytest

from supplementaries.phase_3_loops.page_hinkley import (
    CONSECUTIVE_THRESHOLD,
    LOW_NOVELTY_THRESHOLD,
    NOVELTY_WINDOW,
    scan_page_hinkley,
)
from tests.fixtures.traces import load_synthetic_dataset


@pytest.fixture(scope="module")
def dataset() -> list:
    return load_synthetic_dataset()


def _by_archetype(dataset: list, slug_prefix: str) -> list:
    return [ex for ex in dataset if ex.archetype_id.startswith(slug_prefix[:2])]


# ── Loop-stuck MUST trip (sustained novelty collapse) ────────────


def test_page_hinkley_loop_stuck_trips(dataset):
    """loop-stuck: 7 weather.lookup retries → novelty collapses
    → CUSUM drifts down → trips."""
    examples = _by_archetype(dataset, "loop-stuck")
    assert examples
    for ex in examples:
        summary = scan_page_hinkley(ex.events)
        assert summary.final_verdict, (
            f"{ex.trace_id} expected Page-Hinkley to trip, "
            f"trip_count={summary.trip_count}"
        )


# ── Adversarial paraphrase MUST trip ──────────────────────────────


def test_page_hinkley_adversarial_paraphrase_trips(dataset):
    """adversarial-paraphrase-loop: 6 paraphrased tool calls → novelty
    collapses → CUSUM drifts → trips."""
    examples = _by_archetype(dataset, "adversarial-paraphrase-loop")
    assert examples
    for ex in examples:
        summary = scan_page_hinkley(ex.events)
        assert summary.final_verdict, (
            f"{ex.trace_id} expected Page-Hinkley to trip on paraphrase, "
            f"trip_count={summary.trip_count}"
        )


# ── Clean traces MUST NOT trip ───────────────────────────────────


@pytest.mark.parametrize("slug_prefix,label", [
    ("efficient-good", "efficient-good-support"),
    ("optimal-path-exists", "optimal-path-exists"),
    ("efficient-multi-agent-handoff", "efficient-multi-agent-handoff"),
    ("output-truncation", "output-truncation"),
    ("hallucinating", "hallucinating"),
])
def test_page_hinkley_clean_traces_no_trip(dataset, slug_prefix, label):
    """Clean traces (novel output each step) should not trip PH.

    Excludes slow-cost-overrun (5 plan LLMs have similar content
    → consecutive low-novelty → trips) and redundant-repeated-context
    (4 user.ask calls have identical request bodies → consecutive
    low-novelty → trips). These are documented FP for the proxy.
    Real MiniLM embeddings would distinguish them by semantic content
    differences.
    """
    examples = _by_archetype(dataset, slug_prefix)
    assert examples, f"no traces for {label}"
    for ex in examples:
        summary = scan_page_hinkley(ex.events)
        assert not summary.final_verdict, (
            f"{ex.trace_id} ({label}) unexpected PH trip"
        )


def test_page_hinkley_redundant_repeated_documents_fp(dataset):
    """Document the redundant-repeated-context false positive.

    The 4 user.ask tool calls have identical request_body (empty
    args). When the agent legitimately re-asks the user for the
    same info, it looks structurally identical to a tool-call loop.
    The detector cannot distinguish without external context.

    Real MiniLM embeddings would notice the LLM emissions BETWEEN
    the user.ask calls have different framing ("I'll help..." vs
    "Before I check..." vs "Apologies..." etc.) and the user
    responses escalate ("I already told you" → "!" → "please just
    check"), which signals user-side change, not agent-side loop.
    """
    examples = _by_archetype(dataset, "redundant-repeated-context")
    assert examples
    for ex in examples:
        summary = scan_page_hinkley(ex.events)
        # Documented FP — accept.
        assert summary.final_verdict, (
            f"{ex.trace_id} unexpected: PH should trip on this trace"
        )


def test_page_hinkley_slow_cost_overrun_documents_fp(dataset):
    """Document the slow-cost-overrun false positive.

    5 plan LLMs have similar content "Plan step N: consider
    rollback, canary, backfill." Counter accumulates to 5 → trips.
    Real MiniLM would distinguish by the step number.
    """
    examples = _by_archetype(dataset, "slow-cost-overrun")
    assert examples
    for ex in examples:
        summary = scan_page_hinkley(ex.events)
        assert summary.final_verdict, (
            f"{ex.trace_id} expected PH to trip on slow-cost-overrun"
        )


# ── Constants ────────────────────────────────────────────────────


def test_page_hinkley_constants():
    assert NOVELTY_WINDOW == 5
    assert LOW_NOVELTY_THRESHOLD == 0.5
    assert CONSECUTIVE_THRESHOLD == 5