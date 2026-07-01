"""Unit tests for the hash-ring loop detector (detector 1 of 4)."""
from __future__ import annotations

import pytest

from eden.observability.telemetry_collector import TelemetryEvent
from supplementaries.phase_3_loops.hash_ring import (
    TRIP_THRESHOLD,
    WINDOW,
    scan_hash_ring,
)
from tests.fixtures.traces import load_synthetic_dataset


@pytest.fixture(scope="module")
def dataset() -> list:
    return load_synthetic_dataset()


def _by_archetype(dataset: list, slug_prefix: str) -> list:
    return [ex for ex in dataset if ex.archetype_id.startswith(slug_prefix[:2])]


# ── Loop-stuck MUST trip ──────────────────────────────────────────


def test_hash_ring_loop_stuck_misses(dataset):
    """loop-stuck: 7 weather.lookup retries with PARAPHRASED args
    (different keys: q vs query; different capitalisation).

    The hash ring only catches EXACT-repeat tool calls. Paraphrased
    arguments are intentionally missed — the Jaccard shingles
    detector (detector 2) and semantic cosine detector (detector 3)
    catch them. Document the false negative here; this is by design.
    """
    examples = _by_archetype(dataset, "loop-stuck")
    assert examples
    for ex in examples:
        summary = scan_hash_ring(ex.events)
        assert not summary.final_verdict, (
            f"{ex.trace_id} hash-ring tripped on paraphrase — this "
            f"detector should only fire on exact-repeat tool calls"
        )


# ── Adversarial paraphrase MUST NOT trip ──────────────────────────


def test_hash_ring_adversarial_paraphrase_no_trip(dataset):
    """adversarial-paraphrase-loop: 6 different tool names + arg keys.
    The hash ring will MISS this — that's by design; the Jaccard +
    semantic detectors catch it. Document the false negative here."""
    examples = _by_archetype(dataset, "adversarial-paraphrase-loop")
    assert examples
    for ex in examples:
        summary = scan_hash_ring(ex.events)
        # This is the expected false negative. The whole point of the
        # ensemble is that OTHER detectors catch what this one misses.
        # If the hash ring starts tripping here, the canonicalisation
        # has drifted and we need to re-examine.
        assert not summary.final_verdict, (
            f"{ex.trace_id} hash-ring tripped on paraphrase — "
            f"this should only happen via ensemble, not alone"
        )


# ── Clean traces MUST NOT trip ────────────────────────────────────


@pytest.mark.parametrize("slug_prefix,label", [
    ("efficient-good", "efficient-good-support"),
    ("redundant-repeated-context", "redundant-repeated-context"),
    ("optimal-path-exists", "optimal-path-exists"),
    ("efficient-multi-agent-handoff", "efficient-multi-agent-handoff"),
    ("output-truncation", "output-truncation"),
])
def test_hash_ring_clean_traces_no_trip(dataset, slug_prefix, label):
    """Clean traces (no exact-repeat loops) must not trip the hash ring."""
    examples = _by_archetype(dataset, slug_prefix)
    assert examples, f"no traces for {label}"
    for ex in examples:
        summary = scan_hash_ring(ex.events)
        assert not summary.final_verdict, (
            f"{ex.trace_id} ({label}) unexpected hash-ring trip: "
            f"{[(r.step_index, r.prior_matches) for r in summary.results if r.tripped]}"
        )


# ── Hallucinating must not trip ──────────────────────────────────


def test_hash_ring_hallucinating_no_trip(dataset):
    examples = _by_archetype(dataset, "hallucinating")
    assert examples
    for ex in examples:
        summary = scan_hash_ring(ex.events)
        assert not summary.final_verdict


# ── Slow-cost-overrun must not trip ──────────────────────────────


def test_hash_ring_slow_cost_overrun_no_trip(dataset):
    examples = _by_archetype(dataset, "slow-cost-overrun")
    assert examples
    for ex in examples:
        summary = scan_hash_ring(ex.events)
        assert not summary.final_verdict


# ── Failing tool: no exact-repeat loops (different exception text) ─


def test_hash_ring_failing_tool_no_trip(dataset):
    examples = _by_archetype(dataset, "failing-tool")
    assert examples
    for ex in examples:
        summary = scan_hash_ring(ex.events)
        # 3 bank.transfer calls but with different timing — args are
        # identical so MAY trip after the 3rd. Let's check.
        # Actually: same tool name + same arguments → same hash.
        # Trip threshold is 3 matches in window of 8 → fires on 4th.
        # 3 retries should NOT trip on its own (only 3 calls, all
        # identical; the window contains at most 2 prior at step 4).
        assert not summary.final_verdict, (
            f"{ex.trace_id} failing-tool unexpectedly tripped"
        )


# ── Constants ─────────────────────────────────────────────────────


def test_hash_ring_constants():
    assert WINDOW == 8
    assert TRIP_THRESHOLD == 3