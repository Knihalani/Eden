"""N01 replay verification tests (``regression_replay_v1``).

The differentiator over post-hoc trace checks: the runner replays the
STORED case input (the failing checkpoint's recorded messages) against
current behavior and asserts the failure signature is absent. All
gateway / checkpoint traffic is mocked — no network.
"""

from __future__ import annotations

import pytest

import eden.improvement.replay_verify as rv
from eden.evaluation.regression_builder import RegressionCase
from eden.evaluation.regression_runner import RegressionRunner
from eden.improvement.replay_verify import extract_failure_signature

ORG = "org-1"
TRACE = "trc-1"

SIG = extract_failure_signature(
    {"kind": "tool_error", "error": "division by zero in checkout step 7"},
    {"name": "tool.checkout"},
)
assert SIG is not None

#: expected_data as written by the flywheel enrichment.
ENRICHED = {
    "failure_signature": SIG.to_json(),
    "replay": {"checkpoint_available": True, "checkpoint_trace_id": TRACE},
}


def _case(*, expected: dict, trace_id: str | None = TRACE) -> RegressionCase:
    return RegressionCase(
        id="c1",
        org_id=ORG,
        dataset_id="ds",
        source_issue_id=None,
        source_trace_id=trace_id,
        fingerprint="fp",
        auto_generated=True,
        expected_data=expected,
    )


def _failing_checkpoint():
    from eden.debugger.checkpoints import Checkpoint

    return Checkpoint(
        id="cp-1",
        trace_id=TRACE,
        step_number=0,
        input_messages=[
            {"role": "system", "content": "You are a helpful bot."},
            {"role": "user", "content": "checkout my cart"},
        ],
        tool_calls=[],
        tool_results=[],
        response={
            "content": "Error: division by zero in checkout step 7",
            "model": "test-model",
        },
    )


class _FakeStore:
    def __init__(self, by_trace):
        self.by_trace = by_trace

    async def list_for_trace(self, trace_id, org_id=None):
        return list(self.by_trace.get(trace_id, []))


def _patch_seams(monkeypatch, *, store, gateway_text="all good", cost=0.001):
    async def _fake_store():
        return store

    calls = []

    async def _fake_gateway(org_id, model, prompt):
        calls.append({"org_id": org_id, "model": model, "prompt": prompt})
        return {"text": gateway_text, "cost_usd": cost}

    monkeypatch.setattr(rv, "_get_checkpoint_store", _fake_store)
    monkeypatch.setattr(rv, "_gateway_complete", _fake_gateway)
    return calls


def _enable(monkeypatch, on: bool = True) -> None:
    from eden.config import get_settings

    monkeypatch.setattr(get_settings(), "regression_replay_v1", on)


class _FakePg:
    """asyncpg-shaped stub for the post-hoc fallback path."""

    def __init__(self, rows=None):
        self._rows = rows or []

    async def fetch(self, query, *args):
        return list(self._rows)

    async def fetchrow(self, query, *args):
        return None

    async def execute(self, query, *args):
        return "INSERT 0 1"


# ── Replay verdicts ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_fix_removed_signature_passes_with_replay_reason(
    monkeypatch,
) -> None:
    _enable(monkeypatch)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})
    calls = _patch_seams(
        monkeypatch, store=store, gateway_text="Checkout complete, no errors."
    )
    runner = RegressionRunner(memory_only=True)
    status, reason = await runner._evaluate_case(_case(expected=dict(ENRICHED)))
    assert (status, reason) == ("passed", "replay_signature_absent")
    # The replay sent the STORED input, not something synthesized.
    assert calls and "checkout my cart" in calls[0]["prompt"]


@pytest.mark.asyncio
async def test_signature_persists_fails(monkeypatch) -> None:
    _enable(monkeypatch)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})
    _patch_seams(
        monkeypatch,
        store=store,
        gateway_text="Sorry — division by zero in checkout step 9 again",
    )
    runner = RegressionRunner(memory_only=True)
    status, reason = await runner._evaluate_case(_case(expected=dict(ENRICHED)))
    assert (status, reason) == ("failed", "replay_signature_present")


@pytest.mark.asyncio
async def test_replay_verdict_beats_posthoc_telemetry_outage(
    monkeypatch,
) -> None:
    """A replay verdict stands even when telemetry is down (memory_only)."""
    _enable(monkeypatch)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})
    _patch_seams(monkeypatch, store=store, gateway_text="all clean")
    runner = RegressionRunner(memory_only=True)
    expected = {**ENRICHED, "no_stumble_kinds": ["tool_error"]}
    status, reason = await runner._evaluate_case(_case(expected=expected))
    assert (status, reason) == ("passed", "replay_signature_absent")


# ── Cost caps: abort is an error, never a pass ──────────────────


@pytest.mark.asyncio
async def test_suite_budget_exhausted_is_error(monkeypatch) -> None:
    _enable(monkeypatch)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})
    calls = _patch_seams(monkeypatch, store=store, gateway_text="all clean")
    runner = RegressionRunner(memory_only=True)
    from eden.config import get_settings

    max_steps = int(get_settings().replay_max_llm_steps)
    status, reason = await runner._evaluate_case(
        _case(expected=dict(ENRICHED)),
        replay_budget={"llm_steps": max_steps, "cost_usd": 0.0},
    )
    assert (status, reason) == ("error", "cost_cap")
    assert not calls  # capped BEFORE any live step


@pytest.mark.asyncio
async def test_llm_budget_exhausted_is_error(monkeypatch) -> None:
    _enable(monkeypatch)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})
    _patch_seams(monkeypatch, store=store, gateway_text="all clean")
    import eden.improvement.sweep_budget as sb

    monkeypatch.setattr(sb, "try_consume_llm_call", lambda: False)
    runner = RegressionRunner(memory_only=True)
    status, reason = await runner._evaluate_case(
        _case(expected=dict(ENRICHED)), replay_budget={"llm_steps": 0, "cost_usd": 0.0}
    )
    assert (status, reason) == ("error", "cost_cap")


@pytest.mark.asyncio
async def test_replay_cost_accrues_into_suite_budget(monkeypatch) -> None:
    _enable(monkeypatch)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})
    _patch_seams(monkeypatch, store=store, gateway_text="all clean", cost=0.01)
    runner = RegressionRunner(memory_only=True)
    budget = {"llm_steps": 0, "cost_usd": 0.0}
    await runner._evaluate_case(
        _case(expected=dict(ENRICHED)), replay_budget=budget
    )
    assert budget["llm_steps"] == 1
    assert budget["cost_usd"] == pytest.approx(0.01)


# ── Infrastructure failure: error, never a silent pass ──────────


@pytest.mark.asyncio
async def test_gateway_failure_is_error(monkeypatch) -> None:
    _enable(monkeypatch)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})

    async def _fake_store():
        return store

    async def _boom(org_id, model, prompt):
        raise RuntimeError("gateway down")

    monkeypatch.setattr(rv, "_get_checkpoint_store", _fake_store)
    monkeypatch.setattr(rv, "_gateway_complete", _boom)
    runner = RegressionRunner(memory_only=True)
    status, reason = await runner._evaluate_case(_case(expected=dict(ENRICHED)))
    assert (status, reason) == ("error", "replay_failed")


# ── Fallback + skip taxonomy ────────────────────────────────────


@pytest.mark.asyncio
async def test_no_checkpoint_and_no_constraints_skips(monkeypatch) -> None:
    _enable(monkeypatch)
    expected = {
        "failure_signature": SIG.to_json(),
        "replay": {"checkpoint_available": False, "checkpoint_trace_id": None},
    }
    runner = RegressionRunner(memory_only=True)
    status, reason = await runner._evaluate_case(_case(expected=expected))
    assert (status, reason) == ("skipped", "no_checkpoint")


@pytest.mark.asyncio
async def test_checkpoints_vanished_falls_back_to_posthoc(monkeypatch) -> None:
    """Marked available but store has none → post-hoc still verifies."""
    _enable(monkeypatch)
    store = _FakeStore({})  # no checkpoints for the trace anymore
    _patch_seams(monkeypatch, store=store)
    pg = _FakePg(rows=[{"kind": "timeout"}])  # clean of "tool_error"
    runner = RegressionRunner(pg=pg)
    expected = {**ENRICHED, "no_stumble_kinds": ["tool_error"]}
    status, reason = await runner._evaluate_case(_case(expected=expected))
    # Post-hoc pass keeps its own reason — proof quality stays labeled.
    assert (status, reason) == ("passed", "ok")


# ── Flag off: today's behavior, byte-for-byte ───────────────────


@pytest.mark.asyncio
async def test_flag_off_enriched_case_without_constraints_skips(
    monkeypatch,
) -> None:
    _enable(monkeypatch, on=False)
    runner = RegressionRunner(memory_only=True)
    status, reason = await runner._evaluate_case(_case(expected=dict(ENRICHED)))
    assert (status, reason) == ("skipped", "no_constraints")


@pytest.mark.asyncio
async def test_flag_off_never_touches_replay_seams(monkeypatch) -> None:
    _enable(monkeypatch, on=False)
    store = _FakeStore({TRACE: [_failing_checkpoint()]})
    calls = _patch_seams(monkeypatch, store=store, gateway_text="all clean")
    pg = _FakePg(rows=[{"kind": "loop"}])
    runner = RegressionRunner(pg=pg)
    expected = {**ENRICHED, "no_stumble_kinds": ["loop"]}
    status, reason = await runner._evaluate_case(_case(expected=expected))
    assert status == "failed"  # post-hoc found the stumble, as today
    assert reason.startswith("stumble kinds present")
    assert not calls  # no gateway traffic with the flag off
