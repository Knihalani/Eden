"""N14 — production platform activation (Wave 0).

Covers G1 (lifespan wiring), G2 (Settings fields), and G10
(quality worker no longer no-ops when the settings exist).

* Settings — the ``trace_quality_*`` / ``stat_gate_*`` /
  ``quality_pipeline_*`` / ``enhancements_*`` fields now exist and are
  env-driven.
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
    assert s.stat_gate_min_n == 30
    assert isinstance(s.stat_gate_min_effect, float)
    assert s.quality_pipeline_workers == 2
    assert s.quality_pipeline_watermark_poll_ms == 1000
    assert s.quality_pipeline_batch_size == 100
    assert s.detector_keep_rate_loop == 1.0
    assert s.detector_keep_rate_error == 1.0
    assert s.enhancements_per_component_max == 5
    # Kill-switch mirror: read-only True, mutating False.
    assert s.default_action_applied_flag["emit_drift_alert"] is True
    assert s.default_action_applied_flag["block_user"] is False


def test_install_all_is_idempotent() -> None:
    from eden.observability.trace_quality.wiring import install_all

    # Two calls in the same process must not raise (mirrors
    # tests/api/test_hot_path_p99_regression.py:154).
    install_all()
    install_all()


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
