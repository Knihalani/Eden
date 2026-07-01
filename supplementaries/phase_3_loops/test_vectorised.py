"""Tests for numpy-backed 4-detector ensemble."""
from __future__ import annotations

import numpy as np
import pytest

from eden.observability.telemetry_collector import TelemetryEvent

from supplementaries.phase_3_loops.vectorised import (
    ConsecutiveNoveltyResult,
    NumpyEnsembleReport,
    _shingle_vector,
    consecutive_novelty_collapse_numpy,
    cosine_sqrt_jaccard_numpy,
    hash_ring_numpy,
    jaccard_numpy,
    novelty_novelty_collapse_numpy,
    scan_ensemble_numpy,
)


# ── Helper to make synthetic events ────────────────────────────


def _make_event(event_type: str, ts_offset: int, **kwargs) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=f"evt_{ts_offset:08d}",
        tenant_id="t", project_id="p", trace_id="tr",
        realm="production", event_type=event_type,
        timestamp=f"2026-06-28T12:00:{ts_offset % 60:02d}+00:00",
        agent_id="a", agent_version="v1", environment_id="e",
        parent_span_id=None, span_id=f"spn_{ts_offset:08d}",
        name=kwargs.get("name"),
        duration_ms=kwargs.get("duration_ms", 100.0),
        payload=kwargs.get("payload", {}),
        metrics=kwargs.get("metrics", {}),
        attributes=kwargs.get("attributes", {}),
        tags=kwargs.get("tags", []),
        outcome=kwargs.get("outcome"),
        response_body=kwargs.get("response_body"),
        request_body=kwargs.get("request_body"),
        tool_results=kwargs.get("tool_results", []),
        tool_calls_full=kwargs.get("tool_calls_full", []),
        finish_reason=kwargs.get("finish_reason"),
    )


# ── Jaccard numpy tests ────────────────────────────────────────


def test_jaccard_numpy_identical():
    a = "send email to alice@eden.co with subject hello"
    b = "send email to alice@eden.co with subject hello"
    assert jaccard_numpy(a, b) == 1.0


def test_jaccard_numpy_disjoint():
    a = "the weather in tokyo today is sunny"
    b = "quantum physics is hard to understand"
    assert jaccard_numpy(a, b) < 0.1


def test_jaccard_numpy_paraphrase_high():
    """Paraphrases share some tokens → non-zero Jaccard."""
    a = "send email to alice@eden.co with subject hello body hi"
    b = "dispatch mail to alice@eden.co with title hello message hi"
    sim = jaccard_numpy(a, b, k=3)
    # Many shared tokens (alice, eden, co, hello, hi) → > 0
    assert sim > 0.0


def test_cosine_sqrt_jaccard_numpy_in_unit_interval():
    """Sqrt-Jaccard is in [0, 1]."""
    pairs = [
        ("hello world", "hello world"),
        ("hello world", "goodbye world"),
        ("hello", "completely different text here"),
    ]
    for a, b in pairs:
        s = cosine_sqrt_jaccard_numpy(a, b)
        assert 0.0 <= s <= 1.0


# ── Shingle vector tests ────────────────────────────────────────


def test_shingle_vector_returns_numpy_array():
    """_shingle_vector returns a numpy ndarray of dtype object."""
    arr = _shingle_vector("the quick brown fox")
    assert isinstance(arr, np.ndarray)
    assert arr.dtype == object


def test_shingle_vector_short_text_padded():
    """Very short text returns a single padded shingle."""
    arr = _shingle_vector("hi", k=3)
    assert len(arr) == 1
    # The padded shingle is "hi" followed by sentinels
    assert arr[0].startswith("hi")


# ── Novelty collapse numpy ─────────────────────────────────────


def test_novelty_collapse_first_step_is_one():
    """The first step has no priors → novelty = 1.0."""
    texts = ["the weather is sunny"]
    novelty = novelty_novelty_collapse_numpy(texts)
    assert novelty[0] == 1.0


def test_novelty_collapse_identical_steps_low():
    """Identical consecutive steps → novelty ≈ 0."""
    texts = ["the weather is sunny"] * 5
    novelty = novelty_novelty_collapse_numpy(texts)
    # Step 0: 1.0; steps 1-4: low (~0)
    assert novelty[0] == 1.0
    for n in novelty[1:]:
        assert n < 0.5


def test_novelty_collapse_returns_numpy_array():
    texts = ["alpha", "beta", "gamma"]
    novelty = novelty_novelty_collapse_numpy(texts)
    assert isinstance(novelty, np.ndarray)
    assert novelty.dtype == np.float64


# ── Consecutive novelty collapse ───────────────────────────────


def test_consecutive_novelty_collapse_trips_at_threshold():
    """5 consecutive low-novelty steps → tripped=True.

    The consecutive counter is incremented AFTER checking, so the
    first step to reach consecutive_low_count == 5 is the 5th
    low-novelty step (index 5 with 5 prior low steps).
    """
    texts = ["the weather is sunny today in tokyo japan"] * 7
    results = consecutive_novelty_collapse_numpy(texts)
    # The detector trips when consecutive_low_count reaches 5.
    # Step 0 has no priors, so it's not "low" (novelty=1.0).
    # Steps 1-5 are consecutive low-novelty (counts 1, 2, 3, 4, 5).
    # Step 5 is the first to reach 5 → tripped.
    assert results[5].consecutive_low_count == 5
    assert results[5].tripped
    # All subsequent steps should also be tripped.
    for r in results[6:]:
        assert r.tripped


def test_consecutive_novelty_collapse_resets_on_high():
    """A high-novelty step resets the counter."""
    texts = [
        "the weather is sunny",  # step 0
        "the weather is sunny",  # step 1 (low)
        "the weather is sunny",  # step 2 (low)
        "completely different query xyz",  # step 3 (HIGH)
        "the weather is sunny",  # step 4 (low again, counter resets)
    ]
    results = consecutive_novelty_collapse_numpy(texts, consecutive_threshold=5)
    # After step 3 (high), counter resets. Step 4 starts fresh at 1.
    assert results[4].consecutive_low_count == 1


def test_consecutive_novelty_collapse_returns_correct_type():
    results = consecutive_novelty_collapse_numpy(["a", "b"])
    assert all(isinstance(r, ConsecutiveNoveltyResult) for r in results)


# ── Hash ring numpy ─────────────────────────────────────────────


def test_hash_ring_numpy_no_repeat_no_trip():
    """Distinct hashes → no trips."""
    events = [
        _make_event("tool.call", i, request_body={"tool": f"t{i}", "arguments": {}})
        for i in range(5)
    ]
    results = hash_ring_numpy(events)
    assert len(results) == 5
    for step_idx, prior, trip in results:
        assert prior == 0
        assert trip == 0


def test_hash_ring_numpy_trips_at_threshold():
    """3+ matches in window → trip."""
    events = [
        _make_event("tool.call", i, request_body={"tool": "t", "arguments": {}})
        for i in range(5)
    ]
    results = hash_ring_numpy(events, window=8, trip_threshold=3)
    # Step 3 is the 4th occurrence → trip
    assert results[3][2] == 1


# ── Full ensemble ───────────────────────────────────────────────


def test_scan_ensemble_numpy_clean_traces_no_loops():
    """Clean distinct events → no loop detected."""
    events = [
        _make_event("tool.call", i, request_body={"tool": f"t{i}", "arguments": {"x": str(i)}})
        for i in range(10)
    ]
    results = scan_ensemble_numpy(events)
    assert len(results) == 10
    assert all(r.severity == "stable" for r in results)


def test_scan_ensemble_numpy_loop_stuck_detected():
    """Loop-stuck pattern (same args repeated) → medium or high severity."""
    events = [
        _make_event("tool.call", i, request_body={
            "tool": "weather.lookup", "arguments": {"q": "weather tokyo"},
        })
        for i in range(10)
    ]
    results = scan_ensemble_numpy(events)
    # At least one step should be medium or high.
    assert any(r.severity in {"medium", "high"} for r in results)


def test_scan_ensemble_numpy_paraphrase_loops():
    """Paraphrased tool calls: ensemble may or may not detect (proxy limitation)."""
    paraphrases = [
        ("send_email", {"to": "alice", "subject": "hi", "body": "hello"}),
        ("dispatch_mail", {"recipient": "alice", "title": "hi", "message": "hello"}),
        ("mail.send", {"to": "alice", "subject": "hi", "text": "hello"}),
    ]
    events = [
        _make_event("tool.call", i * 2, request_body={"tool": name, "arguments": args})
        for i, (name, args) in enumerate(paraphrases)
    ]
    results = scan_ensemble_numpy(events)
    # Verify the ensemble runs without crashing; severity may vary.
    assert len(results) == 3
    for r in results:
        assert r.severity in {"stable", "medium", "high"}


def test_scan_ensemble_numpy_empty_events():
    """Empty event list → empty results."""
    results = scan_ensemble_numpy([])
    assert results == []


def test_scan_ensemble_numpy_single_event():
    """Single event → 1 result, no trip."""
    events = [_make_event("tool.call", 0, request_body={"tool": "x", "arguments": {"a": 1}})]
    results = scan_ensemble_numpy(events)
    assert len(results) == 1
    assert results[0].severity == "stable"


def test_scan_ensemble_numpy_returns_correct_type():
    """Each result is a NumpyEnsembleReport."""
    events = [
        _make_event("tool.call", i, request_body={"tool": f"t{i}", "arguments": {}})
        for i in range(5)
    ]
    results = scan_ensemble_numpy(events)
    assert all(isinstance(r, NumpyEnsembleReport) for r in results)


def test_scan_ensemble_numpy_numerical_stability():
    """Empty / whitespace-only step texts don't crash."""
    events = [
        _make_event("tool.call", 0, request_body={"tool": "", "arguments": {}}),
        _make_event("tool.call", 1, request_body={"tool": "", "arguments": {}}),
    ]
    results = scan_ensemble_numpy(events)
    assert len(results) == 2
    for r in results:
        assert r.severity in {"stable", "medium", "high"}


def test_scan_ensemble_numpy_50_events_under_50ms():
    """50 events through the numpy ensemble in <50ms."""
    events = [
        _make_event("tool.call", i, request_body={"tool": f"t{i}", "arguments": {"x": str(i)}})
        for i in range(50)
    ]
    import time
    t0 = time.perf_counter()
    results = scan_ensemble_numpy(events)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    assert len(results) == 50
    assert elapsed_ms < 50.0, f"50 events took {elapsed_ms:.1f}ms"


def test_scan_ensemble_numpy_100_events_under_150ms():
    """100 events through the numpy ensemble in <150ms."""
    events = [
        _make_event("tool.call", i, request_body={"tool": f"t{i}", "arguments": {"x": str(i)}})
        for i in range(100)
    ]
    import time
    t0 = time.perf_counter()
    results = scan_ensemble_numpy(events)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    assert len(results) == 100
    assert elapsed_ms < 150.0, f"100 events took {elapsed_ms:.1f}ms"


# ── Numerical correctness vs pure-Python ─────────────────────


def test_jaccard_numpy_matches_python_baseline():
    """Verify numpy Jaccard matches pure-Python Jaccard on known inputs.

    Both implementations use the same shingle tokenisation and
    set-based Jaccard — they should produce identical results.
    """
    from supplementaries.phase_3_loops.jaccard_shingles import (
        _jaccard as _py_jaccard,
        _shingles as _py_shingles,
    )
    pairs = [
        ("the quick brown fox", "the quick brown fox"),
        ("hello world", "goodbye world"),
    ]
    for a, b in pairs:
        sa = set(_py_shingles(a))
        sb = set(_py_shingles(b))
        expected = _py_jaccard(sa, sb)
        actual = jaccard_numpy(a, b, k=5)
        # Allow small float tolerance.
        assert abs(expected - actual) < 0.01, (
            f"mismatch for ({a!r}, {b!r}): expected {expected}, got {actual}"
        )