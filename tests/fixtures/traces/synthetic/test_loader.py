"""Smoke tests for the synthetic trace dataset loader.

These tests are intentionally minimal — they verify that the loader
returns 30 examples that round-trip through ``TelemetryEvent.from_dict``
and that each archetype's label shape is sane. They are NOT the place
to put evaluator assertions; the evaluator's own unit tests should
import ``load_synthetic_dataset`` and assert against
``expected_TAS`` / ``expected_intervention``.
"""
from __future__ import annotations

import pytest

from tests.fixtures.traces import (
    SYNTH_ROOT,
    SyntheticExample,
    load_synthetic_dataset,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def dataset() -> list[SyntheticExample]:
    return load_synthetic_dataset()


# ---------------------------------------------------------------------------
# Loader integrity
# ---------------------------------------------------------------------------

def test_synthetic_root_exists() -> None:
    assert SYNTH_ROOT.exists(), f"synthetic root missing: {SYNTH_ROOT}"


def test_loader_returns_30(dataset: list[SyntheticExample]) -> None:
    assert len(dataset) == 30


def test_three_variants_per_archetype(dataset: list[SyntheticExample]) -> None:
    from collections import Counter
    counts = Counter(e.archetype_id for e in dataset)
    assert len(counts) == 10, f"expected 10 archetypes, got {len(counts)}"
    for slug, n in counts.items():
        assert n == 3, f"archetype {slug!r} has {n} variants, expected 3"


def test_all_event_types_recognised(dataset: list[SyntheticExample]) -> None:
    allowed = {"llm.completion", "tool.call", "env.step",
               "span.start", "span.end"}
    for ex in dataset:
        types = {ev.event_type for ev in ex.events}
        assert types <= allowed, f"{ex.trace_id}: unexpected event_types {types - allowed}"


def test_timestamps_monotonic(dataset: list[SyntheticExample]) -> None:
    for ex in dataset:
        ts = [ev.timestamp for ev in ex.events]
        assert ts == sorted(ts), f"{ex.trace_id}: timestamps not monotonic"


def test_every_trace_has_root_span(dataset: list[SyntheticExample]) -> None:
    for ex in dataset:
        starts = [e for e in ex.events if e.event_type == "span.start"]
        ends = [e for e in ex.events if e.event_type == "span.end"]
        assert len(starts) == 1 and len(ends) == 1, (
            f"{ex.trace_id}: expected exactly one span.start and one span.end, "
            f"got {len(starts)}/{len(ends)}"
        )


def test_event_count_in_range(dataset: list[SyntheticExample]) -> None:
    for ex in dataset:
        n = len(ex.events)
        assert 5 <= n <= 50, f"{ex.trace_id}: event count {n} outside [5, 50]"


# ---------------------------------------------------------------------------
# Ground-truth shape
# ---------------------------------------------------------------------------

def test_ground_truth_required_keys(dataset: list[SyntheticExample]) -> None:
    required = {"trace_id", "archetype_id", "expected_TAS", "expected_intervention"}
    for ex in dataset:
        missing = required - set(ex.ground_truth)
        assert not missing, f"{ex.trace_id}: missing {missing}"


def test_tas_in_range(dataset: list[SyntheticExample]) -> None:
    for ex in dataset:
        assert 0 <= ex.expected_tas <= 100, (
            f"{ex.trace_id}: expected_TAS={ex.expected_tas} out of range"
        )


def test_intervention_in_enum(dataset: list[SyntheticExample]) -> None:
    allowed = {"allow", "warn", "skip_step", "block", "summarize", "escalate"}
    for ex in dataset:
        assert ex.expected_intervention in allowed, (
            f"{ex.trace_id}: unexpected intervention {ex.expected_intervention!r}"
        )


def test_redundancy_pct_in_range(dataset: list[SyntheticExample]) -> None:
    for ex in dataset:
        assert 0.0 <= ex.expected_redundancy_pct <= 1.0, (
            f"{ex.trace_id}: redundancy {ex.expected_redundancy_pct} out of [0,1]"
        )


# ---------------------------------------------------------------------------
# Per-archetype signal spot-checks — lock down the intended evaluation story
# so a generator edit cannot silently change the contract.
# ---------------------------------------------------------------------------

def test_loop_stuck_has_seven_retry_calls(dataset: list[SyntheticExample]) -> None:
    stuck = [e for e in dataset if e.archetype_id == "loop-stuck"]
    assert len(stuck) == 3
    for ex in stuck:
        assert ex.expected_loop_detected is True
        assert ex.expected_intervention == "block"
        tool_calls = [ev for ev in ex.events if ev.event_type == "tool.call"]
        # 7 retries, all weather.lookup, all failure
        assert len(tool_calls) == 7
        assert all(ev.name == "weather.lookup" for ev in tool_calls)
        assert all(ev.outcome == "failure" for ev in tool_calls)


def test_adversarial_paraphrase_uses_different_tool_names(
    dataset: list[SyntheticExample],
) -> None:
    adv = [e for e in dataset if e.archetype_id == "adversarial-paraphrase-loop"]
    assert len(adv) == 3
    for ex in adv:
        assert ex.expected_loop_detected is True
        assert ex.expected_intervention == "block"
        tool_calls = [ev for ev in ex.events if ev.event_type == "tool.call"]
        names = [ev.name for ev in tool_calls]
        # Exact-hash loop detector MUST miss this — at least 2 distinct
        # tool names, despite every call doing the same thing.
        assert len(set(names)) >= 2, (
            f"{ex.trace_id}: expected paraphrased tool names, got {names}"
        )


def test_hallucinating_trace_contains_fabricated_figure(
    dataset: list[SyntheticExample],
) -> None:
    hal = [e for e in dataset if e.archetype_id == "hallucinating"]
    assert len(hal) == 3
    for ex in hal:
        assert ex.expected_hallucination_detected is True
        llm_calls = [ev for ev in ex.events if ev.event_type == "llm.completion"]
        joined = " ".join(
            (ev.response_body or {})
            .get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
            for ev in llm_calls
        )
        # The fabricated "144%" figure must appear; the truthful "122%" must NOT.
        assert "144%" in joined, f"{ex.trace_id}: missing fabricated figure"
        assert "122%" not in joined, (
            f"{ex.trace_id}: hallucinated trace leaked the truthful figure"
        )


def test_output_truncation_finish_reason_is_length(
    dataset: list[SyntheticExample],
) -> None:
    trunc = [e for e in dataset if e.archetype_id == "output-truncation"]
    assert len(trunc) == 3
    for ex in trunc:
        llm_calls = [ev for ev in ex.events if ev.event_type == "llm.completion"]
        length_calls = [ev for ev in llm_calls if ev.finish_reason == "length"]
        assert length_calls, f"{ex.trace_id}: no llm call with finish_reason=length"


def test_efficient_good_has_high_tas_and_allows(
    dataset: list[SyntheticExample],
) -> None:
    good = [e for e in dataset if e.archetype_id == "efficient-good"]
    assert len(good) == 3
    for ex in good:
        assert ex.expected_tas > 85
        assert ex.expected_intervention == "allow"


def test_failing_tool_outcome_is_failure(
    dataset: list[SyntheticExample],
) -> None:
    fail = [e for e in dataset if e.archetype_id == "failing-tool"]
    assert len(fail) == 3
    for ex in fail:
        assert ex.expected_intervention == "escalate"
        # Outcome at the trace level is carried by the root span.end,
        # but every tool call here must report failure.
        tool_calls = [ev for ev in ex.events if ev.event_type == "tool.call"]
        assert tool_calls and all(ev.outcome == "failure" for ev in tool_calls)
