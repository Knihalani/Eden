"""Trace-quality sidecar worker (spec §5, deliverable E).

The sidecar worker streams rows from ``telemetry_events``
since the last persisted watermark, buffers until a trace has
its ``span.end`` observed, then runs the 5-step compute
(TAS / loop / quality / reasoning / detection) and persists
one row per report to ``trace_efficiency_reports``,
``trace_loop_reports``, ``trace_quality_reports``,
``trace_reasoning_reports``. Per-step timeouts come from
``Settings.quality_step_timeout_*_ms``.

Resilience:

* **Offset poll** — ``quality_pipeline_watermark`` row
  persists the last processed ``(tenant_id, event_id)``.
* **Dead-letter** — ``quality_pipeline_failed_traces`` table
  receives permanent failures (poison traces that time out
  every step).
* **Prometheus** — ``quality_pipeline_traces_total{status}``,
  ``quality_pipeline_step_duration_seconds{step}``,
  ``quality_pipeline_watermark_age_seconds``.
* **SIGTERM drain** — graceful shutdown completes the in-flight
  batch + flushes the watermark, then exits 0 within 30s.
* **Retry with exponential backoff** — transient DB failures
  retry up to 3× (50ms / 200ms / 800ms).
* **Permanent-write-then-fail** — high-severity detector fires
  are persisted to ``trace_loop_reports`` even if downstream
  compute fails.

The worker can run as either:

* an in-process loop started from the FastAPI lifespan
  (``start_worker`` / ``stop_worker`` in ``worker.py``), or
* a standalone CLI process (``python -m eden.observability.quality_pipeline``)
  that uses the same loop body.
"""

from .worker import (
    SidecarWorker,
    SidecarWorkerState,
    compute_trace_reports,
    start_worker,
    stop_worker,
    get_worker_state,
)

__all__ = [
    "SidecarWorker",
    "SidecarWorkerState",
    "compute_trace_reports",
    "start_worker",
    "stop_worker",
    "get_worker_state",
]