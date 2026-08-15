"""N14 platform activation observability — health + Prometheus gauges.

Tracks StatGate wiring install state and exports the four N14 §5
metrics for the ``/metrics`` endpoint and ``/health`` probes.
"""

from __future__ import annotations

import time
from typing import Any

_wiring_installed: bool = False
_hot_path_durations_s: list[float] = []
_HOT_PATH_MAX_SAMPLES = 10_000


def mark_wiring_installed(*, success: bool = True) -> None:
    """Record that ``install_all()`` completed on this process."""
    global _wiring_installed
    _wiring_installed = bool(success)


def is_statgate_installed() -> bool:
    """Return whether Cat 17 StatGate gating was installed this process."""
    return _wiring_installed


def record_hot_path_duration(seconds: float) -> None:
    """Observe one hot-path guardrail evaluation (for p99 monitoring)."""
    if seconds < 0:
        return
    _hot_path_durations_s.append(seconds)
    if len(_hot_path_durations_s) > _HOT_PATH_MAX_SAMPLES:
        del _hot_path_durations_s[: len(_hot_path_durations_s) - _HOT_PATH_MAX_SAMPLES]


def get_platform_activation_metrics() -> dict[str, Any]:
    """Snapshot N14 gauges/histograms for ``/metrics`` rendering."""
    try:
        from eden.observability.quality_pipeline.worker import (
            get_worker_state,
            is_worker_running,
        )

        worker_running = 1.0 if is_worker_running() else 0.0
        state = get_worker_state()
        lag_s = 0.0
        if state.last_watermark_at is not None:
            lag_s = max(
                0.0,
                time.time() - state.last_watermark_at.timestamp(),
            )
    except Exception:
        worker_running = 0.0
        lag_s = 0.0

    try:
        from eden.agents.evolution.loop import is_evolution_loop_running

        evolution_running = 1.0 if is_evolution_loop_running() else 0.0
    except Exception:
        evolution_running = 0.0

    durations = list(_hot_path_durations_s)
    hot_sum = sum(durations)
    hot_count = len(durations)

    return {
        "eden_quality_worker_running": worker_running,
        "eden_wiring_install_success": 1.0 if _wiring_installed else 0.0,
        "eden_quality_worker_lag_seconds": lag_s,
        "eden_hot_path_guardrail_duration_seconds_sum": hot_sum,
        "eden_hot_path_guardrail_duration_seconds_count": hot_count,
        "eden_evolution_loop_running": evolution_running,
    }


def reset_for_tests() -> None:
    """Clear process-local activation state (unit tests only)."""
    global _wiring_installed
    _wiring_installed = False
    _hot_path_durations_s.clear()
