"""Loader test for the v2 synthetic dataset."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from eden.observability.telemetry_collector import TelemetryEvent

# Allow importing the synthetic_v2 loader via the synthetic root.
SYNTHETIC_V2_ROOT = Path(__file__).parent


def _v2_traces() -> list[Path]:
    return sorted((SYNTHETIC_V2_ROOT / "traces").glob("*.json"))


def _v2_gts() -> list[Path]:
    return sorted((SYNTHETIC_V2_ROOT / "ground_truth").glob("*.json"))


def test_v2_dataset_exists():
    """v2 dataset has 24 traces (8 archetypes × 3 variants)."""
    traces = _v2_traces()
    assert len(traces) == 24, f"expected 24 traces, got {len(traces)}"


def test_v2_dataset_has_ground_truth():
    """Each trace has a matching ground truth file."""
    traces = _v2_traces()
    gts = _v2_gts()
    trace_names = {p.stem for p in traces}
    gt_names = {p.stem for p in gts}
    assert trace_names == gt_names, "trace/ground_truth mismatch"


def test_v2_traces_are_valid_telemetry_events():
    """Every event in v2 traces round-trips through TelemetryEvent.from_dict."""
    from json import loads
    for trace_path in _v2_traces():
        blob = loads(trace_path.read_text())
        for event_blob in blob["events"]:
            ev = TelemetryEvent.from_dict(event_blob)
            assert ev.trace_id == blob["trace_id"]
            assert ev.tenant_id == "org_eden_synth"


def test_v2_ground_truth_has_required_keys():
    """Each GT has expected_TAS, expected_intervention, archetype_id."""
    for gt_path in _v2_gts():
        blob = __import__("json").loads(gt_path.read_text())
        assert "expected_TAS" in blob
        assert "expected_intervention" in blob
        assert "archetype_id" in blob


def test_v2_empty_traces_have_no_real_events():
    """empty-trace archetype has only span.start + span.end (zero agents events)."""
    empty_traces = [p for p in _v2_traces() if "empty_trace" in p.stem]
    assert len(empty_traces) == 3
    from json import loads
    for p in empty_traces:
        blob = loads(p.read_text())
        # Real events only - exclude span.start / span.end which are infrastructure
        real = [e for e in blob["events"]
                if e["event_type"] not in ("span.start", "span.end")]
        assert len(real) == 0


def test_v2_large_traces_have_at_least_30_events():
    """large-trace-50-events archetype has 30+ real events."""
    large = [p for p in _v2_traces() if "large_trace_50_events" in p.stem]
    assert len(large) == 3
    from json import loads
    for p in large:
        blob = loads(p.read_text())
        real = [e for e in blob["events"]
                if e["event_type"] not in ("span.start", "span.end")]
        assert len(real) >= 30, (
            f"{p.name} has only {len(real)} real events (expected >= 30)"
        )


def test_v2_archetype_set_is_complete():
    """v2 has all 8 new archetypes."""
    expected = {
        "prompt-injection-via-tool-result",
        "pair-attempt",
        "crescendo",
        "tap-burst-cluster",
        "empty-trace",
        "single-event-trace",
        "mixed-loop-and-hallucination",
        "large-trace-50-events",
    }
    from json import loads
    actual = set()
    for p in _v2_gts():
        actual.add(loads(p.read_text())["archetype_id"])
    assert expected.issubset(actual)
