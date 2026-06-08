"""Pipeline-level metrics (counters for timeouts, retries, errors).

§11.5 — ``pipeline_timeouts_total{node}`` is the headline metric
that the §9.5.1 alerts engine watches (>5% triggers page). Implemented
as an in-memory counter; the alerts engine reads via
``get_pipeline_metrics_snapshot()`` every minute.

Mirrors the §11.1 LatencyHistogram pattern: process-wide singleton,
thread-safe, JSON-serializable snapshot.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from threading import Lock
from typing import Optional

logger = logging.getLogger(__name__)


class PipelineMetrics:
    """Thread-safe counter for pipeline-node events."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._timeouts: dict[str, int] = defaultdict(int)
        self._errors: dict[str, int] = defaultdict(int)
        self._retries: dict[str, int] = defaultdict(int)
        self._completions: dict[str, int] = defaultdict(int)

    def record_timeout(self, node: str) -> None:
        with self._lock:
            self._timeouts[node] += 1

    def record_error(self, node: str) -> None:
        with self._lock:
            self._errors[node] += 1

    def record_retry(self, node: str) -> None:
        with self._lock:
            self._retries[node] += 1

    def record_completion(self, node: str) -> None:
        with self._lock:
            self._completions[node] += 1

    def snapshot(self) -> dict:
        with self._lock:
            timeouts = dict(self._timeouts)
            errors = dict(self._errors)
            retries = dict(self._retries)
            completions = dict(self._completions)

        # Compute per-node timeout rate.
        rates: dict[str, float] = {}
        for node, n_timeouts in timeouts.items():
            n_complete = completions.get(node, 0) + n_timeouts
            if n_complete > 0:
                rates[node] = round(n_timeouts / n_complete, 4)
        return {
            "timeouts": timeouts,
            "errors": errors,
            "retries": retries,
            "completions": completions,
            "timeout_rates": rates,
        }


_metrics = PipelineMetrics()


def get_pipeline_metrics() -> PipelineMetrics:
    """Return the process-wide metrics singleton."""
    return _metrics


def get_pipeline_metrics_snapshot() -> dict:
    return _metrics.snapshot()


def reset_pipeline_metrics() -> None:
    """Reset the in-memory counters. Tests only."""
    global _metrics
    _metrics = PipelineMetrics()
