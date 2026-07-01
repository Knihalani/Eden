"""Tests for Phase 4 TrajectoryGuardrail — 8 hot-path checks + 4 async advisory.

Tests verify:
1. Each individual check returns the right action
2. Action precedence reduces to the most-restrictive action
3. The orchestrator runs all checks and combines correctly
4. End-to-end on synthetic dataset
5. Hot-path latency <5ms p99
"""
from __future__ import annotations

import time

import pytest

from eden.observability.telemetry_collector import TelemetryEvent
from supplementaries.phase_4_guardrails.trajectory import (
    ACTION_RANK,
    AsyncAdvisoryState,
    CostState,
    GuardrailState,
    GuardrailVerdict,
    LatencyState,
    TokenState,
    _most_restrictive,
    advisory_output_length,
    advisory_user_prompt_dedup,
    check_confidence,
    check_cost,
    check_finish_reason,
    check_latency,
    check_loop,
    check_retry_storm,
    check_schema,
    check_tokens,
    check_tool_dedup,
    evaluate_step,
)
from tests.fixtures.traces import load_synthetic_dataset


@pytest.fixture(scope="module")
def dataset() -> list:
    """Load the synthetic dataset (local fixture for this test file)."""
    return load_synthetic_dataset()


# ── Helpers ─────────────────────────────────────────────────────


def _make_event(
    event_type: str = "tool.call", **kwargs
) -> TelemetryEvent:
    return TelemetryEvent(
        event_id=kwargs.get("event_id", "evt_test_0000"),
        tenant_id="org_test",
        project_id="proj_test",
        trace_id="trace_test",
        realm="production",
        event_type=event_type,
        timestamp=kwargs.get("timestamp", "2026-06-28T12:00:00+00:00"),
        agent_id="agent_test",
        agent_version="test-v1",
        environment_id="env_test",
        parent_span_id=None,
        span_id=kwargs.get("span_id", "spn_test_0000"),
        name=kwargs.get("name", "test"),
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
        logprobs=kwargs.get("logprobs"),
        finish_reason=kwargs.get("finish_reason"),
    )


# ── Action precedence tests ────────────────────────────────────


def test_action_precedence_block_wins():
    actions = {"cost": "allow", "loop": "block", "latency": "warn"}
    assert _most_restrictive(actions.values()) == "block"


def test_action_precedence_escalate_beats_warn():
    actions = {"cost": "warn", "loop": "escalate", "latency": "allow"}
    assert _most_restrictive(actions.values()) == "escalate"


def test_action_precedence_allow_is_lowest():
    actions = {"cost": "allow", "loop": "warn", "latency": "allow"}
    assert _most_restrictive(actions.values()) == "warn"


# ── CostGuard ───────────────────────────────────────────────────


def test_cost_under_budget():
    e = _make_event("tool.call", metrics={"cost_usd": 0.01})
    state = CostState()
    assert check_cost(e, state, 0.01) == "allow"


def test_cost_over_per_step_budget():
    e = _make_event("tool.call", metrics={"cost_usd": 1.00})
    state = CostState(per_step_budget_usd=0.50)
    assert check_cost(e, state, 0.0) == "block"


def test_cost_over_trace_budget():
    e = _make_event("tool.call", metrics={"cost_usd": 0.10})
    state = CostState(per_trace_budget_usd=1.00)
    assert check_cost(e, state, 0.95) == "block"


def test_cost_z_score_high():
    """Cost > mean + 3σ → warn."""
    e = _make_event("tool.call", metrics={"cost_usd": 0.10})
    state = CostState(mean_cost_7d=0.01, std_cost_7d=0.005)
    # z = (0.10 - 0.01) / 0.005 = 18 → way above 3
    assert check_cost(e, state, 0.0) == "warn"


# ── TokenGuard ──────────────────────────────────────────────────


def test_tokens_within_budget():
    e = _make_event("llm.completion", metrics={"prompt_tokens": 100, "completion_tokens": 50})
    assert check_tokens(e, TokenState(), (100, 50)) == "allow"


def test_tokens_over_step_budget():
    e = _make_event("llm.completion", metrics={"prompt_tokens": 10000, "completion_tokens": 50})
    assert check_tokens(e, TokenState(), (0, 0)) == "block"


# ── LoopGuard ───────────────────────────────────────────────────


def test_loop_clean_trace():
    """A short, non-looping trace with diverse tools → allow."""
    events = [
        _make_event(
            "tool.call",
            name="crm.order_lookup",
            request_body={"tool": "crm.order_lookup", "arguments": {"id": "4471"}},
            span_id="spn_a",
        ),
        _make_event(
            "tool.call",
            name="payments.refund_status",
            request_body={"tool": "payments.refund_status", "arguments": {"id": "4471"}},
            span_id="spn_b",
        ),
        _make_event(
            "tool.call",
            name="kb.search",
            request_body={"tool": "kb.search", "arguments": {"q": "refund"}},
            span_id="spn_c",
        ),
    ]
    assert check_loop(events) == "allow"


# ── ToolDedup ───────────────────────────────────────────────────


def test_tool_dedup_no_repeat():
    from collections import deque
    e = _make_event("tool.call", request_body={"tool": "x", "arguments": {"a": 1}})
    history = deque(maxlen=10)
    assert check_tool_dedup(e, history) == "allow"


def test_tool_dedup_consecutive_same():
    from collections import deque
    history = deque(maxlen=10)
    for _ in range(3):
        e = _make_event(
            "tool.call",
            request_body={"tool": "crm.lookup", "arguments": {"id": "4471"}},
        )
        check_tool_dedup(e, history)
    # 4th identical call → coalesce
    e = _make_event(
        "tool.call",
        request_body={"tool": "crm.lookup", "arguments": {"id": "4471"}},
    )
    assert check_tool_dedup(e, history) == "coalesce"


def test_tool_dedup_different_args_no_coalesce():
    from collections import deque
    history = deque(maxlen=10)
    for i in range(3):
        e = _make_event(
            "tool.call",
            request_body={"tool": "crm.lookup", "arguments": {"id": f"447{i}"}},
        )
        check_tool_dedup(e, history)
    assert check_tool_dedup(e, history) == "allow"


# ── RetryStormGuard ────────────────────────────────────────────


def test_retry_storm_no_failures():
    from collections import deque
    e = _make_event("tool.call", outcome="success")
    history = deque(maxlen=10)
    assert check_retry_storm(e, history) == "allow"


def test_retry_storm_consecutive_failures():
    from collections import deque
    history = deque(maxlen=10)
    for _ in range(4):
        e = _make_event("tool.call", outcome="failure")
        result = check_retry_storm(e, history)
    assert result == "block"


# ── SchemaValidator ────────────────────────────────────────────


def test_schema_all_required_present():
    e = _make_event("tool.call", request_body={"tool": "x", "arguments": {"a": 1, "b": 2}})
    assert check_schema(e, {"a"}) == "allow"


def test_schema_missing_required():
    e = _make_event("tool.call", request_body={"tool": "x", "arguments": {"a": 1}})
    assert check_schema(e, {"a", "b"}) == "rewrite"


# ── LatencyGuard ───────────────────────────────────────────────


def test_latency_normal():
    e = _make_event("tool.call", duration_ms=1500.0)
    state = LatencyState(mean_latency_7d_ms=1500.0, std_latency_7d_ms=500.0)
    assert check_latency(e, state) == "allow"


def test_latency_extreme_outlier():
    e = _make_event("tool.call", duration_ms=60_000.0)
    state = LatencyState(per_step_max_ms=30_000.0)
    assert check_latency(e, state) == "block"


def test_latency_moderate_outlier_warn():
    """Latency z = 3.4 → warn (not block, not escalate)."""
    e = _make_event("tool.call", duration_ms=3200.0)
    state = LatencyState(mean_latency_7d_ms=1500.0, std_latency_7d_ms=500.0)
    # z = (3200 - 1500) / 500 = 3.4 → warn
    assert check_latency(e, state) == "warn"


def test_latency_z5_escalate():
    """Latency z = 5 → escalate (boundary)."""
    e = _make_event("tool.call", duration_ms=4000.0)
    state = LatencyState(mean_latency_7d_ms=1500.0, std_latency_7d_ms=500.0)
    # z = (4000 - 1500) / 500 = 5 → escalate (z > 4 but not > 5)
    assert check_latency(e, state) == "escalate"


def test_latency_mild_outlier():
    e = _make_event("tool.call", duration_ms=3200.0)
    state = LatencyState(mean_latency_7d_ms=1500.0, std_latency_7d_ms=500.0)
    # z = (3200 - 1500) / 500 = 3.4 → warn
    assert check_latency(e, state) == "warn"


# ── FinishReasonMonitor ────────────────────────────────────────


def test_finish_reason_stop():
    e = _make_event("llm.completion", finish_reason="stop")
    assert check_finish_reason(e) == "allow"


def test_finish_reason_length_truncates():
    e = _make_event("llm.completion", finish_reason="length")
    assert check_finish_reason(e) == "truncate"


def test_finish_reason_content_filter_escalates():
    e = _make_event("llm.completion", finish_reason="content_filter")
    assert check_finish_reason(e) == "escalate"


def test_finish_reason_unknown_is_allow():
    e = _make_event("llm.completion", finish_reason="weird_thing")
    assert check_finish_reason(e) == "allow"


# ── ConfidenceGuard ────────────────────────────────────────────


def test_confidence_high():
    e = _make_event(
        "llm.completion",
        logprobs={"content": [[{"token": "yes", "logprob": -0.1}]]},
    )
    assert check_confidence(e) == "allow"


def test_confidence_low_rewrites():
    e = _make_event(
        "llm.completion",
        logprobs={"content": [[{"token": "maybe", "logprob": -5.0}]]},
    )
    assert check_confidence(e) == "rewrite"


# ── Async advisory ─────────────────────────────────────────────


def test_advisory_output_length_normal():
    state = AsyncAdvisoryState()
    for _ in range(15):
        e = _make_event("llm.completion", metrics={"completion_tokens": 100})
        advisory_output_length(e, state)
    e = _make_event("llm.completion", metrics={"completion_tokens": 100})
    assert advisory_output_length(e, state) == "allow"


def test_advisory_user_prompt_dedup():
    state = AsyncAdvisoryState()
    e1 = _make_event(
        "llm.completion",
        request_body={"messages": [{"role": "user", "content": "What's the weather?"}]},
    )
    assert advisory_user_prompt_dedup(e1, state) == "allow"
    e2 = _make_event(
        "llm.completion",
        request_body={"messages": [{"role": "user", "content": "What's the weather?"}]},
    )
    assert advisory_user_prompt_dedup(e2, state) == "cache"


# ── Orchestrator end-to-end ─────────────────────────────────────


def test_evaluate_step_runs_all_checks():
    e = _make_event(
        "tool.call",
        duration_ms=1500.0,
        metrics={"cost_usd": 0.01, "prompt_tokens": 100, "completion_tokens": 50},
        request_body={"tool": "x", "arguments": {"a": 1}},
        outcome="success",
        finish_reason="stop",
    )
    state = GuardrailState()
    verdict = evaluate_step(e, [e], state)
    assert isinstance(verdict, GuardrailVerdict)
    assert len(verdict.actions_by_check) >= 8
    assert verdict.step_action in {
        "allow", "warn", "block", "escalate", "truncate", "rewrite",
        "coalesce", "summarize", "replan", "cache", "skip_step", "redact",
    }


def test_evaluate_step_latency_under_5ms():
    """Hot-path p99 <5ms per spec."""
    e = _make_event(
        "tool.call",
        duration_ms=100.0,
        metrics={"cost_usd": 0.01},
        request_body={"tool": "x", "arguments": {"a": 1}},
    )
    state = GuardrailState()
    # Warm up + measure.
    for _ in range(20):
        evaluate_step(e, [e], state)
    times = []
    for _ in range(100):
        t0 = time.perf_counter()
        evaluate_step(e, [e], state)
        times.append((time.perf_counter() - t0) * 1000.0)
    times.sort()
    p99 = times[int(0.99 * len(times))]
    # 5ms budget per spec; proxy + checks easily fits.
    assert p99 < 5.0, f"hot-path p99 = {p99:.2f}ms exceeds 5ms budget"


def test_evaluate_step_on_synthetic(dataset):
    """The orchestrator runs cleanly on every synthetic trace."""
    valid_actions = {
        "allow", "warn", "block", "escalate", "truncate", "rewrite",
        "coalesce", "summarize", "replan", "cache", "skip_step", "redact",
    }
    for ex in dataset:
        state = GuardrailState()
        # Walk events in timestamp order, building trace-so-far as we go.
        sorted_events = sorted(ex.events, key=lambda e: e.timestamp)
        trace_so_far: list = []
        for event in sorted_events:
            verdict = evaluate_step(event, trace_so_far, state)
            assert verdict.step_action in valid_actions, (
                f"{ex.trace_id}: unexpected action {verdict.step_action}"
            )
            trace_so_far.append(event)


def test_action_rank_includes_all_spec_actions():
    """All spec-defined actions must be in ACTION_RANK."""
    for action in {
        "allow", "warn", "redact", "block", "escalate", "skip_step",
        "summarize", "coalesce", "rewrite", "truncate", "replan", "cache",
    }:
        assert action in ACTION_RANK