"""In-process metrics for the issues layer (F28 / F20 / F29).

Simple Prometheus-compatible accumulators (no external dependency),
mirroring :mod:`eden.observability.search_service`. Rendered by
``metrics_endpoint.py`` under the ``eden_stumble_*`` / ``eden_issue_*``
/ ``auto_issue_*`` names the specs call for.
"""

from __future__ import annotations

from typing import Any

# ── Stumble write path (F28) ────────────────────────────────────────
_stumble_stats: dict[str, float] = {
    "write_duration_sum_s": 0.0,
    "write_duration_count": 0.0,
    "created_total": 0.0,
    "deduped_total": 0.0,
}

# ── Auto-issue scanner (F20) ────────────────────────────────────────
_scan_stats: dict[str, float] = {
    "scan_duration_ms_sum": 0.0,
    "scan_duration_ms_count": 0.0,
    "queue_lag_seconds_sum": 0.0,
    "queue_lag_seconds_count": 0.0,
}
_detector_hits: dict[str, float] = {}

# ── Issue list read path (F29) ──────────────────────────────────────
_issue_stats: dict[str, float] = {
    "list_duration_sum_s": 0.0,
    "list_duration_count": 0.0,
}


def record_stumble_write(duration_s: float, *, created: bool, deduped: bool) -> None:
    _stumble_stats["write_duration_sum_s"] += duration_s
    _stumble_stats["write_duration_count"] += 1.0
    if created:
        _stumble_stats["created_total"] += 1.0
    if deduped:
        _stumble_stats["deduped_total"] += 1.0


def record_scan(duration_ms: float, *, detector_hits: dict[str, int] | None = None) -> None:
    _scan_stats["scan_duration_ms_sum"] += duration_ms
    _scan_stats["scan_duration_ms_count"] += 1.0
    for detector, n in (detector_hits or {}).items():
        _detector_hits[detector] = _detector_hits.get(detector, 0.0) + float(n)


def record_queue_lag(lag_seconds: float) -> None:
    _scan_stats["queue_lag_seconds_sum"] += lag_seconds
    _scan_stats["queue_lag_seconds_count"] += 1.0


def record_issue_list(duration_s: float) -> None:
    _issue_stats["list_duration_sum_s"] += duration_s
    _issue_stats["list_duration_count"] += 1.0


def get_stumble_stats() -> dict[str, float]:
    return dict(_stumble_stats)


def get_scan_stats() -> dict[str, Any]:
    return {**_scan_stats, "detector_hits": dict(_detector_hits)}


def get_issue_stats() -> dict[str, float]:
    return dict(_issue_stats)
