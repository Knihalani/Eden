"""N14 — production platform activation (Wave 0).

Covers G1 (lifespan wiring), G2 (Settings fields), and G10
(quality worker no longer no-ops when the settings exist).

* Settings — the ``trace_quality_*`` / ``quality_pipeline_*`` fields
  now exist and are env-driven.
* ``install_all()`` — idempotent (safe to call once per process, and a
  second call must not raise).
* ``start_worker()`` — no longer exits early on missing Settings attrs;
  when the feature is enabled it actually creates the sidecar task.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest


def test_settings_have_trace_quality_fields() -> None:
    from eden.config import get_settings

    s = get_settings()
    assert s.trace_quality_enabled is True
    assert s.trace_quality_compute_async is True
    assert s.trace_quality_worker_enabled is True
    assert s.quality_pipeline_workers == 8
    assert s.quality_pipeline_watermark_poll_ms == 1000
    assert s.quality_pipeline_batch_size == 100
    assert s.detector_keep_rate_loop == 1.0
    assert s.detector_keep_rate_error == 1.0
    # Kill-switch mirror: read-only True, mutating False.
    assert s.default_action_applied_flag["emit_drift_alert"] is True
    assert s.default_action_applied_flag["block_user"] is False


def test_app_lifespan_calls_install_all_and_workers() -> None:
    """G1 — lifespan runs install_all on every pod; workers leader-gated."""
    from pathlib import Path

    app_src = (
        Path(__file__).resolve().parents[2]
        / "src"
        / "eden"
        / "api"
        / "app.py"
    ).read_text(encoding="utf-8")
    worker_src = (
        Path(__file__).resolve().parents[2]
        / "src"
        / "eden"
        / "workers"
        / "background.py"
    ).read_text(encoding="utf-8")
    assert "install_all()" in app_src
    assert "start_background_workers" in app_src
    assert "run_background_workers" in app_src
    assert "install_all()" not in worker_src
    # The quality-pipeline worker moved behind the cross-process-locked
    # sidecar bundle (eden.workers.sidecars) so the API pod and the
    # dedicated worker pod can't both host it. background.py must still
    # reach it, and the bundle must still be what calls start_worker().
    sidecar_src = (
        Path(__file__).resolve().parents[2]
        / "src"
        / "eden"
        / "workers"
        / "sidecars.py"
    ).read_text(encoding="utf-8")
    assert "start_quality_and_closed_loop_sidecars" in worker_src
    assert "start_worker()" in sidecar_src
    assert "register_all_hooks()" in worker_src
    assert "start_judge_tailer" in worker_src
    assert "stop_judge_tailer" in worker_src
    assert "statgate_installed" in app_src
    assert "evolution_loop_running" in app_src


@pytest.mark.asyncio
async def test_start_judge_tailer_respects_disable_flag() -> None:
    from eden.llmops.judges.redis_tailer import start_judge_tailer, stop_judge_tailer

    class _S:
        judges_async_tailer_enabled = False

    result = await start_judge_tailer(_S())
    assert result is None
    await stop_judge_tailer()


def test_install_all_is_idempotent() -> None:
    from eden.observability.platform_activation import reset_for_tests
    from eden.observability.trace_quality.wiring import install_all

    reset_for_tests()
    install_all()
    install_all()

    from eden.observability.platform_activation import is_statgate_installed

    assert is_statgate_installed() is True


@pytest.mark.asyncio
async def test_start_worker_no_longer_noops_when_enabled() -> None:
    """G10 — with the Settings fields present and the feature enabled,
    ``start_worker`` proceeds past the guard and creates the sidecar
    task (previously it always exited early because the attrs were
    missing). We stub ``SidecarWorker`` so no Redis is required."""
    import asyncio

    import eden.observability.quality_pipeline.worker as worker_mod

    class _FakeWorker:
        def __init__(self, **_kw: object) -> None:
            pass

        async def run(self, stop_event: asyncio.Event) -> None:
            await stop_event.wait()

    with patch.object(worker_mod, "SidecarWorker", _FakeWorker):
        await worker_mod.start_worker()
        try:
            assert worker_mod.is_worker_running() is True
        finally:
            await worker_mod.stop_worker()
        assert worker_mod.is_worker_running() is False


@pytest.mark.asyncio
async def test_start_worker_respects_disable_flag() -> None:
    import eden.observability.quality_pipeline.worker as worker_mod

    class _S:
        trace_quality_enabled = False
        trace_quality_compute_async = True
        quality_pipeline_watermark_poll_ms = 1000
        quality_pipeline_batch_size = 100

    with patch.object(worker_mod, "get_settings", return_value=_S(), create=True):
        # Import path inside start_worker is ``from eden.config import
        # get_settings`` — patch there instead.
        with patch("eden.config.get_settings", return_value=_S()):
            await worker_mod.start_worker()
            assert worker_mod.is_worker_running() is False


def test_statgate_wraps_apply_approved_after_install_all() -> None:
    """StatGate must monkey-patch ClosedLoopExecutor.apply_approved."""
    from eden.llmops import closed_loop_executor as cle
    from eden.observability.platform_activation import reset_for_tests
    from eden.observability.trace_quality.wiring import install_all

    reset_for_tests()
    before = cle.ClosedLoopExecutor.apply_approved
    install_all()
    after = cle.ClosedLoopExecutor.apply_approved
    assert after is not before


def test_platform_activation_metrics_exported() -> None:
    from eden.observability.platform_activation import (
        get_platform_activation_metrics,
        mark_wiring_installed,
        record_hot_path_duration,
        reset_for_tests,
    )

    reset_for_tests()
    mark_wiring_installed(success=True)
    record_hot_path_duration(0.001)
    snap = get_platform_activation_metrics()
    assert snap["eden_wiring_install_success"] == 1.0
    assert snap["eden_hot_path_guardrail_duration_seconds_count"] >= 1


@pytest.mark.asyncio
async def test_guardrail_demote_hook_calls_eval_link() -> None:
    """Demote hook must disable guardrail, not record-only."""
    from unittest.mock import AsyncMock

    from eden.llmops.promotion_hooks import GuardrailHook

    demote = AsyncMock(return_value={"status": "ok", "data": {"status": "disabled"}})
    with patch(
        "eden.llmops.promotion_hooks._record_action",
        AsyncMock(return_value="aid-1"),
    ), patch(
        "eden.evaluation.eval_intel.integration.EvalToGuardrailLink.demote",
        demote,
    ):
        await GuardrailHook().on_judge_below_floor("org_t", judge_name="j1")
    demote.assert_awaited_once_with(
        "org_t", judge_name="j1", reason="judge_below_floor"
    )


def test_etec_attr_bridge_documented_in_loop_detector() -> None:
    """F20 loop detector reads etec_loop_score from span attributes."""
    from eden.issues.auto_scanner import AutoIssueScanner

    events = [
        {
            "event_type": "span.end",
            "attributes": {"etec_loop_score": "0.95"},
            "duration_ms": 10,
        }
    ]
    stumbles = AutoIssueScanner()._detect_loops(
        "org", "trace-1", None, None, None, events
    )
    assert stumbles and stumbles[0].kind == "loop"
    assert stumbles[0].detail.get("etec_loop_score") == 0.95


def test_background_worker_stop_timeout_covers_quality_drain() -> None:
    """Supervisor stop timeout must be ≥ quality worker 30s drain."""
    import inspect

    from eden.workers import background as bg

    sig = inspect.signature(bg.stop_background_workers)
    default = sig.parameters["timeout"].default
    assert float(default) >= 30.0
