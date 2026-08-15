"""Regression guard for the un-awaited ``async def`` hook bug class.

``PromotionHook`` / ``GuardrailHook`` / ``ExperimentHook`` methods are all
``async def``. Several *synchronous* helpers across the intelligence
surface used to call them bare — the coroutine was created, never
scheduled, and immediately garbage-collected. Result: the alert never
fired in production and Python emitted::

    RuntimeWarning: coroutine 'PromotionHook.on_drift_alert' was never awaited

:func:`eden.async_tasks.fire_and_forget` centralises the correct handling.
This module unit-tests that helper and then asserts that every fixed sync
helper is warning-free *and* actually delivers the hook call.
"""

from __future__ import annotations

import asyncio
import warnings
from typing import Any

import pytest

from eden.async_tasks import fire_and_forget, reset_bounded_task_semaphores


@pytest.fixture(autouse=True)
def _clean_semaphores():
    reset_bounded_task_semaphores()
    yield
    reset_bounded_task_semaphores()


# ── fire_and_forget unit tests ───────────────────────────────────────


async def test_fire_and_forget_schedules_when_loop_running():
    ran = asyncio.Event()

    async def _work() -> None:
        ran.set()

    assert fire_and_forget(_work(), name="unit-schedules") is True
    await asyncio.wait_for(ran.wait(), timeout=1.0)


def test_fire_and_forget_closes_coroutine_with_no_loop():
    """No running loop: return False, close the coroutine, no warning."""
    started = False

    async def _work() -> None:
        nonlocal started
        started = True

    coro = _work()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        assert fire_and_forget(coro, name="unit-no-loop") is False
        del coro  # drop the last ref while the filter is still installed

    assert started is False
    assert not _never_awaited(caught)


def test_fire_and_forget_ignores_non_coroutine():
    assert fire_and_forget(None, name="unit-none") is False
    assert fire_and_forget(42, name="unit-int") is False
    assert fire_and_forget("not a coroutine", name="unit-str") is False


async def test_fire_and_forget_swallows_hook_exceptions():
    """A raising hook must not surface as an unhandled task exception."""
    entered = asyncio.Event()

    async def _boom() -> None:
        entered.set()
        raise RuntimeError("hook exploded")

    assert fire_and_forget(_boom(), name="unit-raises") is True
    await asyncio.wait_for(entered.wait(), timeout=1.0)
    await _drain()


# ── Helpers ──────────────────────────────────────────────────────────


def _never_awaited(caught: list[warnings.WarningMessage]) -> list[str]:
    """Return the ``never awaited`` RuntimeWarnings in ``caught``."""
    return [
        str(w.message)
        for w in caught
        if issubclass(w.category, RuntimeWarning)
        and "never awaited" in str(w.message)
    ]


async def _drain() -> None:
    """Let scheduled fire-and-forget tasks run to completion."""
    for _ in range(6):
        await asyncio.sleep(0)


class _Recorder:
    """Async no-op hook that records every call it receives."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Any, ...], dict[str, Any]]] = []

    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)

        async def _call(*args: Any, **kwargs: Any) -> None:
            self.calls.append((name, args, kwargs))

        return _call


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    """Swap every hook accessor for a recording async stub.

    The fixed helpers import their accessor *inside* the function body,
    so patching the module attribute is enough.
    """
    rec = _Recorder()
    import eden.llmops.promotion_hooks as ph

    for accessor in (
        "get_promotion_hook",
        "get_guardrail_hook",
        "get_experiment_hook",
        "get_metric_studio_hook",
        "get_columnar_hook",
        "get_dsl_hook",
    ):
        monkeypatch.setattr(ph, accessor, lambda _rec=rec: _rec, raising=False)
    return rec


# ── The fixed sync helpers must not leak un-awaited coroutines ───────
#
# Each entry is (label, callable). The callable takes no arguments and
# invokes one previously-broken sync helper with inputs that pass its
# early-return guard, so the hook call is genuinely reached.


def _call_experiments_winner() -> None:
    from eden.experiments._common import _fire_winner_hook

    _fire_winner_hook(
        org_id="org-1", experiment_id_str="exp-1", winner_variant="b"
    )


def _call_experiments_dont_ship() -> None:
    from eden.experiments._common import _fire_dont_ship_hook

    _fire_dont_ship_hook(
        org_id="org-1", experiment_id_str="exp-1", judge="j", delta=-0.4
    )


def _call_experiments_simulation_drift() -> None:
    from eden.experiments._common import _fire_simulation_drift_hook

    _fire_simulation_drift_hook(
        org_id="org-1", scenario_id_str="scenario-1", severity="high"
    )


def _call_eval_intel_threshold_breach() -> None:
    from eden.evaluation.eval_intel._common import (
        _fire_eval_to_guardrail_promotion,
    )

    _fire_eval_to_guardrail_promotion("org-1", judge_name="j", threshold=0.7)


def _call_decision_below_floor() -> None:
    from eden.decision.decision_scorer import DecisionScorer

    scorer = DecisionScorer.__new__(DecisionScorer)
    scorer._fire_low_score_hooks("org-1", ["action_completion"])


def _call_decision_regression() -> None:
    from eden.decision.decision_scorer import DecisionScorer

    scorer = DecisionScorer.__new__(DecisionScorer)
    scorer._fire_regression_hook("org-1", "trace-1", 0.2, ["j"])


def _call_outcomes_low_roi() -> None:
    from eden.analytics.outcomes.tracker import _fire_low_roi_alert

    _fire_low_roi_alert("org-1", [{"department": "eng", "net_roi": 0.3}])


def _call_cost_intel_anomaly() -> None:
    from eden.services.cost_intel._common import _fire_cost_anomaly_alert

    _fire_cost_anomaly_alert("org-1", [{"severity": "high", "z": 5.1}])


def _call_user_intel_low_satisfaction() -> None:
    from eden.services.user_intel._common import _fire_low_satisfaction_alert

    _fire_low_satisfaction_alert("org-1", "trace-1", 0.1)


def _call_predictive_drift() -> None:
    from eden.predictive._common import _fire_drift_alert

    _fire_drift_alert("org-1", "output_drift", "high", {"psi": 0.9})


SYNC_HOOK_HELPERS = [
    ("experiments.on_winner", _call_experiments_winner),
    ("experiments.on_judge_regression", _call_experiments_dont_ship),
    ("experiments.on_drift_alert", _call_experiments_simulation_drift),
    ("eval_intel.on_judge_threshold_breach", _call_eval_intel_threshold_breach),
    ("decision.on_judge_below_floor", _call_decision_below_floor),
    ("decision.on_judge_regression", _call_decision_regression),
    ("outcomes.on_drift_alert", _call_outcomes_low_roi),
    ("cost_intel.on_drift_alert", _call_cost_intel_anomaly),
    ("user_intel.on_drift_alert", _call_user_intel_low_satisfaction),
    ("predictive.on_drift_alert", _call_predictive_drift),
]


@pytest.mark.parametrize(
    "label,invoke", SYNC_HOOK_HELPERS, ids=[lbl for lbl, _ in SYNC_HOOK_HELPERS]
)
async def test_sync_helper_does_not_leak_unawaited_coroutine(
    label: str, invoke, recorder: _Recorder
):
    """Runs inside an event loop, so fire_and_forget schedules the hook."""
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        invoke()
        await _drain()

    leaked = _never_awaited(caught)
    assert not leaked, f"{label} leaked un-awaited coroutine(s): {leaked}"
    assert recorder.calls, f"{label} never reached the hook"


@pytest.mark.parametrize(
    "label,invoke", SYNC_HOOK_HELPERS, ids=[lbl for lbl, _ in SYNC_HOOK_HELPERS]
)
def test_sync_helper_is_safe_without_event_loop(
    label: str, invoke, recorder: _Recorder
):
    """Same helpers called from a plain sync context (CLI / worker boot).

    No loop is running, so the coroutine must be closed rather than
    dropped — still no ``never awaited`` warning, and no exception.
    """
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        invoke()

    leaked = _never_awaited(caught)
    assert not leaked, f"{label} leaked un-awaited coroutine(s): {leaked}"


# ── The async hook helpers must actually await their hook ────────────


async def test_columnar_compaction_drift_hook_awaits(recorder: _Recorder):
    from eden.columnar._common import _fire_compaction_drift_hook

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await _fire_compaction_drift_hook(
            "org-1", partition_id="p-1", reason="skew", severity="high"
        )

    assert not _never_awaited(caught)
    assert [c[0] for c in recorder.calls] == ["on_compaction_drift"]


async def test_dsl_alert_lint_warning_hook_awaits(recorder: _Recorder):
    from eden.dsl._common import _fire_dsl_alert_lint_warning_hook

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        await _fire_dsl_alert_lint_warning_hook(
            "org-1", alert_id="a-1", warnings=[{"code": "W001"}]
        )

    assert not _never_awaited(caught)
    assert [c[0] for c in recorder.calls] == ["on_alert_lint_warning"]
