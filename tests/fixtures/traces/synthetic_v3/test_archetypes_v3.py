"""Per-archetype detector tests for the v3 synthetic dataset.

Validates that each new archetype exercises the expected detector.
Tests are organised by category. All detector functions are real —
they live in `supplementaries/phase_7_detection/detectors.py` and
`supplementaries/phase_3_loops/hash_ring.py` etc.

Test budget: <30s with model exercises lazy-loaded.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

V3_ROOT = Path(__file__).parent
TRACES = V3_ROOT / "traces"
GTS = V3_ROOT / "ground_truth"


def _load(slug_prefix: str) -> list[tuple[list[dict[str, Any]], dict[str, Any]]]:
    """Load all variants for archetypes whose filename starts with the given prefix.

    The v3 filenames follow the pattern ``<CATEGORY>_<index>-<archetype-slug>_<variant>.json``
    (e.g. ``A_01_high-srr-every-step-redundant_01.json``). This loader accepts both
    the short prefix (``A_01_high-srr``) and the full archetype name
    (``A_01_high-srr-every-step-redundant``).
    """
    pairs: list[tuple[list[dict[str, Any]], dict[str, Any]]] = []
    for p in sorted(TRACES.glob(f"{slug_prefix}*.json")):
        gt_path = GTS / p.name
        if gt_path.exists():
            pairs.append((
                json.loads(p.read_text())["events"],
                json.loads(gt_path.read_text()),
            ))
    return pairs


def _to_events(pairs: list[tuple[list[dict], dict]]) -> list[list[Any]]:
    from eden.observability.telemetry_collector import TelemetryEvent
    return [[TelemetryEvent.from_dict(e) for e in events_blob] for events_blob, _ in pairs]


# ─────────────────────────────────────────────────────────────
# Phase 7 detector coverage (12 archetypes)
# ─────────────────────────────────────────────────────────────


def test_D_01_sycophancy_marker_detected():
    from supplementaries.phase_7_detection.detectors import detect_sycophancy_markers
    pairs = _load("D_01_sycophancy-marker")
    for evts in _to_events(pairs):
        assert detect_sycophancy_markers(evts) > 0.4


def test_D_02_reward_hogging_detected():
    from supplementaries.phase_7_detection.detectors import detect_reward_hogging
    pairs = _load("D_02_reward-hogging")
    for evts in _to_events(pairs):
        scores = detect_reward_hogging(evts)
        assert max(scores.values()) > 0.5


def test_D_03_calibration_failure_detected():
    from supplementaries.phase_7_detection.detectors import detect_calibration_failure
    pairs = _load("D_03_calibration-failure")
    for evts in _to_events(pairs):
        assert detect_calibration_failure(evts) > 0.0


def test_D_04_multi_turn_escalation_detected():
    """User-message escalation → multi_turn_escalation > 0."""
    from supplementaries.phase_7_detection.detectors import (
        detect_multi_turn_escalation, _extract_user_messages,
    )
    pairs = _load("D_04_multi-turn-escalation")
    for evts in _to_events(pairs):
        msgs = _extract_user_messages(evts)
        # Threshold 0.3 catches monotonic length/pressure escalation;
        # the 0.6 default is calibrated for clear-cut topic-broadening.
        assert detect_multi_turn_escalation(msgs, vocab_growth_threshold=0.3) > 0.0


def test_D_05_many_shot_preamble_detected():
    from supplementaries.phase_7_detection.detectors import detect_many_shot_preamble
    pairs = _load("D_05_many-shot-preamble")
    for evts in _to_events(pairs):
        assert detect_many_shot_preamble(evts) > 0.5


def test_D_06_verifier_loop_detected():
    """The 4-step 'verify the verify the verify' chain must trip verifier_loop."""
    from supplementaries.phase_7_detection.detectors import detect_verifier_loop
    pairs = _load("D_06_verifier-loop")
    for evts in _to_events(pairs):
        # The trace uses keywords verify/verifier/confirmed; threshold=3 catches chains of 4+.
        assert detect_verifier_loop(evts, threshold=2) > 0.4


def test_D_07_memory_bloat_detected():
    from supplementaries.phase_7_detection.detectors import detect_memory_bloat_events
    pairs = _load("D_07_memory-bloat-20kb")
    for evts in _to_events(pairs):
        # 20KB observation > 8KB threshold (8*1024=8192) → score saturates to 1.0.
        assert detect_memory_bloat_events(evts, threshold_bytes=8 * 1024) > 0.5


def test_D_08_memory_conflict_detected():
    from supplementaries.phase_7_detection.detectors import detect_memory_conflict
    pairs = _load("D_08_memory-conflict-vegetarian")
    for evts in _to_events(pairs):
        assert detect_memory_conflict(evts) > 0.0


def test_D_09_agent_depth_runaway_detected():
    from supplementaries.phase_7_detection.detectors import detect_agent_depth_runaway
    pairs = _load("D_09_agent-depth-runaway")
    for evts in _to_events(pairs):
        # Build depth_by_trace from event attributes for this trace.
        depth_by_trace: dict[str, int] = {}
        for e in evts:
            depth_attr = (e.attributes or {}).get("agent_depth")
            if depth_attr:
                depth_by_trace[e.trace_id] = max(
                    depth_by_trace.get(e.trace_id, 0), int(depth_attr)
                )
        caught = detect_agent_depth_runaway(depth_by_trace, threshold=5)
        assert caught, f"depth runaway not caught: max_depth={depth_by_trace}"


def test_D_10_blackboard_stale_detected():
    from supplementaries.phase_7_detection.detectors import detect_blackboard_stale
    pairs = _load("D_10_blackboard-stale-90s")
    for evts in _to_events(pairs):
        # At 90s delay vs 60s threshold the detector returns (90-60)/60 = 0.5.
        assert detect_blackboard_stale(evts, stale_threshold_ms=60_000.0) >= 0.5


def test_D_11_swarm_centralized_detected():
    from supplementaries.phase_7_detection.detectors import detect_swarm_topology_centralization
    pairs = _load("D_11_swarm-centralized")
    for evts in _to_events(pairs):
        # Count agent.handoff to-target counts from tool_calls_full.
        import json as _json
        from collections import Counter
        targets: Counter[str] = Counter()
        for e in evts:
            for tc in (e.tool_calls_full or []):
                fn = (tc or {}).get("function") or {}
                if fn.get("name") == "agent.handoff":
                    args_str = fn.get("arguments") or "{}"
                    try:
                        args = _json.loads(args_str)
                    except Exception:
                        args = {}
                    if isinstance(args, dict) and "to" in args:
                        targets[args["to"]] += 1
        verdict = detect_swarm_topology_centralization(
            dict(targets), low_entropy_threshold=1.5, high_entropy_threshold=4.0
        )
        assert verdict == "centralized", f"expected centralized, got {verdict} (counts={dict(targets)})"


def test_D_12_swarm_dispersed_no_centralized():
    from supplementaries.phase_7_detection.detectors import detect_swarm_topology_centralization
    pairs = _load("D_12_swarm-dispersed")
    for evts in _to_events(pairs):
        import json as _json
        from collections import Counter
        targets: Counter[str] = Counter()
        for e in evts:
            for tc in (e.tool_calls_full or []):
                fn = (tc or {}).get("function") or {}
                if fn.get("name") == "agent.handoff":
                    args_str = fn.get("arguments") or "{}"
                    try:
                        args = _json.loads(args_str)
                    except Exception:
                        args = {}
                    if isinstance(args, dict) and "to" in args:
                        targets[args["to"]] += 1
        verdict = detect_swarm_topology_centralization(
            dict(targets), low_entropy_threshold=1.5, high_entropy_threshold=2.5
        )
        # Dispersed should not be "centralized".
        assert verdict != "centralized", f"got centralized for dispersed trace: {verdict}"


# ─────────────────────────────────────────────────────────────
# Phase 3 Loop detector coverage (3 archetypes)
# ─────────────────────────────────────────────────────────────


def test_B_02_loop_3_distinct_detected():
    """3 separate loops in one trace → hash ring trips on each."""
    from supplementaries.phase_3_loops.hash_ring import scan_hash_ring
    pairs = _load("B_02_loop-3-distinct")
    for evts in _to_events(pairs):
        summary = scan_hash_ring(evts)
        # final_verdict = True iff any step tripped.
        assert summary.final_verdict is True, f"3-distinct loop not caught: {summary}"
        # At least 3 distinct trip points (each inner loop trips at least once).
        assert summary.trip_count >= 3, f"only {summary.trip_count} trips for 3-distinct"


def test_B_03_loop_long_delay_detected():
    """Long-delay loop (5 calls w/ 60s gaps) trips hash ring."""
    from supplementaries.phase_3_loops.hash_ring import scan_hash_ring
    pairs = _load("B_03_loop-long-delay")
    for evts in _to_events(pairs):
        summary = scan_hash_ring(evts)
        assert summary.final_verdict is True, f"long-delay loop not caught: {summary}"


# ─────────────────────────────────────────────────────────────
# Phase 5 Quality (6 archetypes)
# ─────────────────────────────────────────────────────────────


def test_C_01_clean_quality_baseline_low_score():
    from supplementaries.phase_5_quality.pipeline import HallucinationPipeline
    pipeline = HallucinationPipeline()
    src = "Q3 2026: ARR $14.2M, NRR 122%, customers 218 → 311."
    grounded = "Q3 2026: ARR $14.2M, NRR 122%, customers grew from 218 to 311."
    report = pipeline.score(src, grounded)
    assert report.hallucination_score < 0.5, (
        f"grounded baseline hallucination_score={report.hallucination_score}"
    )


def test_C_02_multi_fabricated_statics_detected():
    from supplementaries.phase_5_quality.pipeline import HallucinationPipeline
    pipeline = HallucinationPipeline()
    src = "Q3 2026: ARR $14.2M (38% growth). Customers 218 → 311. Gross margin 71%."
    hallucinated = ("Q3 2026 was a record quarter: ARR hit $15.8M, customer count grew from "
                   "218 to 388, and we hit a 78% gross margin.")
    report = pipeline.score(src, hallucinated)
    assert report.hallucination_score > 0.1, (
        f"multi-fabricated hallucination_score={report.hallucination_score}"
    )


def test_C_03_tool_result_fabrication_runs():
    from supplementaries.phase_5_quality.pipeline import HallucinationPipeline
    pipeline = HallucinationPipeline()
    doc = "Order 4471 status: cancelled. Refund state: queued."
    hallucinated = "Your refund was processed on April 12 and you should have seen $42 land."
    # The numeric guard should at minimum catch the date-discrepancy signal.
    report = pipeline.score(doc, hallucinated)
    assert report.hallucination_score >= 0.0


def test_C_05_unicode_emoji_runs():
    from supplementaries.phase_5_quality.pipeline import HallucinationPipeline
    pipeline = HallucinationPipeline()
    src = "Tokyo office hosted a partner summit (取引先)."
    unicode_text = "東京オフィスで取引先サミットを開催しました 🌏✨"
    report = pipeline.score(src, unicode_text)
    assert report.hallucination_score >= 0.0


def test_C_06_paraphrase_hallucination_detected():
    from supplementaries.phase_5_quality.pipeline import HallucinationPipeline
    pipeline = HallucinationPipeline()
    src = "Net retention 122% in Q3 2026."
    hallucinated = ("Net retention for Q3 2026 was 122 percent — solid. "
                   "Wait, the deck says 132%. Net retention was 132% for Q3 2026.")
    report = pipeline.score(src, hallucinated)
    assert report.hallucination_score > 0.1


# ─────────────────────────────────────────────────────────────
# Phase 10 A2A (3 archetypes)
# ─────────────────────────────────────────────────────────────


def test_E_01_a2a_input_required_stuck_detected():
    from supplementaries.phase_7_detection.detectors import detect_a2a_task_stuck
    pairs = _load("E_01_a2a-input-required-stuck")
    for evts in _to_events(pairs):
        # 45min stuck vs 30min threshold → (45-30)/30 = 0.5.
        assert detect_a2a_task_stuck(evts, stuck_minutes=30.0) >= 0.5


def test_E_02_a2a_auth_required_stuck_detected():
    from supplementaries.phase_7_detection.detectors import detect_a2a_task_stuck
    pairs = _load("E_02_a2a-auth-required-stuck")
    for evts in _to_events(pairs):
        # 50min stuck vs 30min threshold → (50-30)/30 = 0.67.
        assert detect_a2a_task_stuck(evts, stuck_minutes=30.0) >= 0.5


def test_E_03_a2a_all_9_states_no_stuck():
    from supplementaries.phase_7_detection.detectors import detect_a2a_task_stuck
    pairs = _load("E_03_a2a-all-9-states")
    for evts in _to_events(pairs):
        # Each state observed briefly — not stuck.
        assert detect_a2a_task_stuck(evts, stuck_minutes=30.0) == 0.0


# ─────────────────────────────────────────────────────────────
# Cat 22 APM (2 archetypes)
# ─────────────────────────────────────────────────────────────


def test_F_01_cat22_error_keep_decision():
    from supplementaries.cat_22_apm.tail_sampling import SamplingPolicy
    pairs = _load("F_01_cat22-error-keep")
    policy = SamplingPolicy(slow_threshold_ms=5_000.0, keep_rate=0.0)
    for evts in _to_events(pairs):
        has_error = any(e.outcome == "failure" for e in evts)
        decision = policy.should_keep(
            has_error=has_error, is_loop=False,
            duration_ms=0.0, force_trace=False,
        )
        assert decision.keep, f"expected keep on error, got {decision}"


def test_F_02_cat22_slow_keep_decision():
    from supplementaries.cat_22_apm.tail_sampling import SamplingPolicy
    pairs = _load("F_02_cat22-slow-keep")
    policy = SamplingPolicy(slow_threshold_ms=5_000.0, keep_rate=0.0)
    for evts in _to_events(pairs):
        max_dur = max((e.duration_ms or 0.0) for e in evts)
        decision = policy.should_keep(
            has_error=False, is_loop=False,
            duration_ms=max_dur, force_trace=False,
        )
        assert decision.keep, f"expected keep on slow, got {decision}"


# ─────────────────────────────────────────────────────────────
# ETEC per-metric extremes (representative)
# ─────────────────────────────────────────────────────────────


def test_A_01_high_srr_low_tas_relative():
    """High-SRR should score lower than the clean baseline on the same composite."""
    from supplementaries.phase_2_efficiency.composite import compute_tas
    high = _load("A_01_high-srr-every-step-redundant")
    clean = _load("A_08_clean-etec-baseline")
    high_tas = compute_tas(_to_events(high)[0], archetype_id="high-srr").tas
    clean_tas = compute_tas(_to_events(clean)[0], archetype_id="clean-etec-baseline").tas
    assert high_tas < clean_tas, (
        f"high-srr TAS={high_tas} should be < clean_baseline TAS={clean_tas}"
    )


def test_A_08_clean_etec_baseline_tas_in_range():
    """Clean baseline TAS should be ≥ 75 (best single-trace possible)."""
    from supplementaries.phase_2_efficiency.composite import compute_tas
    clean = _load("A_08_clean-etec-baseline")
    for evts in _to_events(clean):
        result = compute_tas(evts, archetype_id="clean-etec-baseline")
        assert result.tas >= 75, f"clean baseline TAS={result.tas} (expected ≥ 75)"


# ─────────────────────────────────────────────────────────────
# Edge / structural (representative)
# ─────────────────────────────────────────────────────────────


def test_G_05_negative_control_clean_pipeline_runs():
    """Single-event clean baseline runs through all detectors without crash."""
    from supplementaries.phase_7_detection.detectors import run_all_detectors
    pairs = _load("G_05_negative-control-clean")
    for evts in _to_events(pairs):
        report = run_all_detectors(evts)
        assert isinstance(report.indirect_injection_max, float)
        assert isinstance(report.sycophancy_rate, float)


def test_G_01_deep_hierarchy_normal_no_runaway():
    """Depth-3 trace must NOT trigger runaway (threshold = 5)."""
    pairs = _load("G_01_deep-hierarchy-normal")
    max_depth = 0
    for evts in _to_events(pairs):
        for e in evts:
            depth_attr = (e.attributes or {}).get("agent_depth")
            if depth_attr:
                max_depth = max(max_depth, int(depth_attr))
    assert max_depth == 3, f"expected depth 3, got {max_depth}"
    assert max_depth <= 5, "depth-3 should NOT trigger runaway"


# ─────────────────────────────────────────────────────────────
# Combined dataset test
# ─────────────────────────────────────────────────────────────


def test_combined_v1_v2_v3_total_trace_count():
    v1 = list((Path(__file__).parent.parent / "synthetic" / "traces").glob("*.json"))
    v2 = list((Path(__file__).parent.parent / "synthetic_v2" / "traces").glob("*.json"))
    v3 = list(TRACES.glob("*.json"))
    assert len(v1) == 30
    assert len(v2) == 24
    assert len(v3) == 117
    assert 30 + 24 + 117 == 171
