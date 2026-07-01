"""Loader test for the v3 synthetic dataset.

v3 covers 39 new archetypes x 3 variants = 117 new traces.

The combined dataset is now:
- v1: 30 traces x 10 archetypes
- v2: 24 traces x 8 archetypes
- v3: 117 traces x 39 archetypes
- TOTAL: 171 traces across 57 distinct archetypes (28 negative-control pairs
  for v2/v3 have positive counterparts in earlier versions).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from eden.observability.telemetry_collector import TelemetryEvent

V3_ROOT = Path(__file__).parent


def _v3_traces() -> list[Path]:
    return sorted((V3_ROOT / "traces").glob("*.json"))


def _v3_gts() -> list[Path]:
    return sorted((V3_ROOT / "ground_truth").glob("*.json"))


def test_v3_dataset_exists():
    """v3 dataset has 117 traces (39 archetypes x 3 variants)."""
    traces = _v3_traces()
    assert len(traces) == 117, f"expected 117 traces, got {len(traces)}"


def test_v3_dataset_has_ground_truth():
    """Each trace has a matching ground truth file."""
    traces = _v3_traces()
    gts = _v3_gts()
    trace_names = {p.stem for p in traces}
    gt_names = {p.stem for p in gts}
    assert trace_names == gt_names, "trace/ground_truth mismatch"


def test_v3_traces_are_valid_telemetry_events():
    """Every event in v3 traces round-trips through TelemetryEvent.from_dict."""
    failures: list[str] = []
    for trace_path in _v3_traces():
        blob = json.loads(trace_path.read_text())
        for event_blob in blob["events"]:
            try:
                ev = TelemetryEvent.from_dict(event_blob)
                assert ev.trace_id == blob["trace_id"], (
                    f"trace_id mismatch in {trace_path.name}"
                )
                assert ev.tenant_id == "org_eden_synth", (
                    f"tenant_id mismatch in {trace_path.name}"
                )
            except Exception as exc:
                failures.append(f"{trace_path.name}: {exc}")
    assert not failures, f"{len(failures)} round-trip failures: {failures[:3]}"


def test_v3_ground_truth_has_required_keys():
    """Each v3 GT has expected_TAS, expected_intervention, archetype_id,
    expected_metrics (dict), expected_detector_fires (list)."""
    required = {
        "expected_TAS", "expected_intervention", "archetype_id",
        "expected_metrics", "expected_detector_fires",
    }
    for gt_path in _v3_gts():
        blob = json.loads(gt_path.read_text())
        missing = required - blob.keys()
        assert not missing, f"{gt_path.name} missing keys: {missing}"
        assert isinstance(blob["expected_metrics"], dict)
        assert isinstance(blob["expected_detector_fires"], list)


def test_v3_archetype_set_is_complete():
    """v3 has all 39 expected archetypes across 7 categories A-G.

    The category is encoded in the filename prefix (e.g., ``A_01_high-srr_01.json``)
    since the ground-truth ``archetype_id`` field is the canonical kebab-case name.
    """
    expected_categories = {
        "A_": 8,   # ETEC per-metric extremes
        "B_": 3,   # Loop variants
        "C_": 6,   # Quality variants
        "D_": 12,  # Phase 7 detector one-each
        "E_": 3,   # A2A
        "F_": 2,   # Cat 22
        "G_": 5,   # Edge / structural
    }
    actual: dict[str, int] = {cat: 0 for cat in expected_categories}
    for p in _v3_gts():
        for prefix in expected_categories:
            if p.name.startswith(prefix):
                actual[prefix] += 1
                break
    for prefix, expected in expected_categories.items():
        assert actual[prefix] == expected * 3, (
            f"category {prefix} expected {expected*3} GT files ({expected} archetypes × "
            f"3 variants), got {actual[prefix]}"
        )


def test_v3_traces_have_at_least_one_event():
    """No v3 trace is empty."""
    for trace_path in _v3_traces():
        blob = json.loads(trace_path.read_text())
        assert blob["event_count"] >= 3, (
            f"{trace_path.name} has only {blob['event_count']} events"
        )


def test_v3_combined_dataset_count_with_v1_v2():
    """v1 + v2 + v3 = 30 + 24 + 117 = 171 traces."""
    v1_dir = V3_ROOT.parent / "synthetic" / "traces"
    v2_dir = V3_ROOT.parent / "synthetic_v2" / "traces"
    v3 = _v3_traces()
    assert len(list(v1_dir.glob("*.json"))) == 30
    assert len(list(v2_dir.glob("*.json"))) == 24
    assert len(v3) == 117
    assert 30 + 24 + len(v3) == 171
