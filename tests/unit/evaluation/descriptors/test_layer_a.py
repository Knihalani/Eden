"""Unit + large benchmark tests for Layer A v2 DescriptorEngine."""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest

from eden.evaluation.descriptors import DescriptorEngine, describe_trace
from eden.evaluation.descriptors.taxonomy import DESCRIPTOR_IDS
from tests.unit.evaluation.descriptors.cases import LAYER_A_CASES


def _run(case: dict):
    engine = DescriptorEngine()
    report = engine.describe(
        case["events"],
        trace_id=case["id"],
        tool_schemas=case.get("tool_schemas"),
        expected_tools=case.get("expected_tools"),
        max_tool_calls=case.get("max_tool_calls"),
        timeout_ms=case.get("timeout_ms"),
    )
    return report


@pytest.mark.parametrize("case", LAYER_A_CASES, ids=[c["id"] for c in LAYER_A_CASES])
def test_layer_a_case(case: dict) -> None:
    report = _run(case)
    got = report.descriptor_ids
    expected = set(case["expected"])
    forbidden = set(case["forbidden"])
    missing = expected - got
    leaked = forbidden & got
    assert not missing, f"{case['id']}: missing {missing}; got={got}; rationales={[d.rationale for d in report.descriptors]}"
    assert not leaked, f"{case['id']}: unexpected {leaked}; got={got}"


def test_taxonomy_expanded() -> None:
    assert len(DESCRIPTOR_IDS) >= 25
    assert "output_fabrication" in DESCRIPTOR_IDS
    assert "wrong_tool" in DESCRIPTOR_IDS
    assert "dead_end" in DESCRIPTOR_IDS


def test_scores_present_on_healthy() -> None:
    case = next(c for c in LAYER_A_CASES if c["id"] == "healthy_transfer")
    report = _run(case)
    assert report.scores["trace_quality"] >= 0.95
    assert report.scores["tool_selection_quality"] == 1.0


def test_scores_penalize_failures() -> None:
    case = next(c for c in LAYER_A_CASES if c["id"] == "wrong_tool_weather_vs_transfer")
    report = _run(case)
    assert report.scores["tool_selection_quality"] < 0.5


def test_benchmark_summary_metrics() -> None:
    engine = DescriptorEngine()
    tp = fp = fn = 0
    latencies: list[float] = []
    failures: list[str] = []

    for case in LAYER_A_CASES:
        report = engine.describe(
            case["events"],
            trace_id=case["id"],
            tool_schemas=case.get("tool_schemas"),
            expected_tools=case.get("expected_tools"),
            max_tool_calls=case.get("max_tool_calls"),
            timeout_ms=case.get("timeout_ms"),
        )
        latencies.append(report.latency_ms)
        got = report.descriptor_ids
        expected = set(case["expected"])
        forbidden = set(case["forbidden"])
        for d in expected & got:
            tp += 1
        for d in expected - got:
            fn += 1
            failures.append(f"FN:{case['id']}:{d}")
        if case.get("tier") == "negative":
            for d in got - expected:
                fp += 1
                failures.append(f"FP:{case['id']}:{d}")
        else:
            for d in forbidden & got:
                fp += 1
                failures.append(f"FP:{case['id']}:{d}")

    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    avg_ms = sum(latencies) / len(latencies)
    p95_ms = sorted(latencies)[int(0.95 * (len(latencies) - 1))]

    assert len(LAYER_A_CASES) >= 100, f"suite too small: {len(LAYER_A_CASES)}"
    assert precision >= 0.92, f"precision={precision:.3f} tp={tp} fp={fp} failures={failures[:20]}"
    assert recall >= 0.90, f"recall={recall:.3f} tp={tp} fn={fn} failures={failures[:20]}"
    assert f1 >= 0.91, f"f1={f1:.3f}"
    assert avg_ms < 5.0, f"avg latency {avg_ms:.2f}ms"
    assert p95_ms < 15.0, f"p95 latency {p95_ms:.2f}ms"


def test_synthetic_failing_tool_and_loop() -> None:
    from tests.fixtures.traces import load_synthetic_dataset

    engine = DescriptorEngine()
    dataset = load_synthetic_dataset()
    failing = [ex for ex in dataset if ex.archetype_id == "failing-tool"]
    loops = [ex for ex in dataset if ex.archetype_id == "loop-stuck"]
    goods = [ex for ex in dataset if ex.archetype_id == "efficient-good"]

    for ex in failing:
        events = [asdict(e) for e in ex.events]
        report = engine.describe(events, trace_id=ex.trace_id)
        assert report.has("tool_error"), f"{ex.trace_id}: {report.descriptor_ids}"

    for ex in loops:
        events = [asdict(e) for e in ex.events]
        report = engine.describe(events, trace_id=ex.trace_id)
        assert report.has("looping") or report.has("repetitive_tool_call"), (
            f"{ex.trace_id}: {report.descriptor_ids}"
        )

    for ex in goods:
        events = [asdict(e) for e in ex.events]
        report = engine.describe(events, trace_id=ex.trace_id)
        structural_fp = report.descriptor_ids & {
            "looping",
            "repetitive_tool_call",
            "tool_error",
            "bad_tool_args",
            "unnecessary_tool_call",
            "mcp_auth_failure",
            "wrong_tool",
        }
        assert not structural_fp, f"{ex.trace_id}: FP {structural_fp}"


def test_write_benchmark_report(tmp_path: Path) -> None:
    engine = DescriptorEngine()
    rows = []
    for case in LAYER_A_CASES:
        report = engine.describe(
            case["events"],
            trace_id=case["id"],
            tool_schemas=case.get("tool_schemas"),
            expected_tools=case.get("expected_tools"),
            max_tool_calls=case.get("max_tool_calls"),
            timeout_ms=case.get("timeout_ms"),
        )
        rows.append(
            {
                "id": case["id"],
                "tier": case.get("tier"),
                "expected": sorted(case["expected"]),
                "got": sorted(report.descriptor_ids),
                "scores": report.scores,
                "latency_ms": report.latency_ms,
                "rationales": {d.descriptor_id: d.rationale for d in report.descriptors},
            }
        )
    out = tmp_path / "layer_a_v2_benchmark.json"
    out.write_text(json.dumps({"n": len(rows), "cases": rows}, indent=2))
    assert out.exists()


def test_describe_convenience() -> None:
    case = next(c for c in LAYER_A_CASES if c["id"] == "tool_error_simple")
    report = describe_trace(case["events"], trace_id="t")
    assert report.has("tool_error")
    assert report.detector_version.startswith("layer_a")


def test_long_agent_labels_present() -> None:
    for did in (
        "retry_storm",
        "sliding_window_loop",
        "tool_thrash",
        "assistant_echo_loop",
        "goal_abandoned",
    ):
        assert did in DESCRIPTOR_IDS
    assert any(c["id"] == "gen_retry_storm" for c in LAYER_A_CASES)
    assert any(c["id"] == "gen_sliding_window_loop" for c in LAYER_A_CASES)


def test_online_long_trace_latency() -> None:
    """Simulate a 400-event stuck agent; online path must stay cheap."""
    from tests.unit.evaluation.descriptors.cases import _llm, _tc, _tool

    events = [_llm(user="Research everything")]
    for i in range(200):
        events.append(_llm(tool_calls=[_tc("search_kb", {"q": f"topic_{i % 3}"}, f"c{i}")]))
        events.append(_tool("search_kb", content='{"hits":1}'))
    events.append(_llm(assistant="Still searching..."))

    online = DescriptorEngine(online=True).describe(events, trace_id="long_online")
    offline = DescriptorEngine(online=False).describe(events, trace_id="long_offline")

    assert online.latency_ms < 25.0, f"online {online.latency_ms}ms"
    assert online.has("looping") or online.has("sliding_window_loop") or online.has(
        "repetitive_tool_call"
    )
    assert online.scores.get("events_truncated") == 1.0
    # Offline may be slower but should still finish under a soft budget
    assert offline.latency_ms < 80.0
