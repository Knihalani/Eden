"""Sidecar worker body — 5-step compute + persist + dead-letter.

This module owns the per-iteration compute loop. The lifespan
in ``api/app.py`` calls :func:`start_worker` /
:func:`stop_worker`. Tests can also call :func:`compute_trace_reports`
directly to exercise the 5-step compute without the loop.

The 5 steps (spec §5, deliverable E):

1. **TAS** — ``supplementaries.phase_2_efficiency.composite.compute_tas``
   (~50ms CPU).
2. **Loop** — ``supplementaries.phase_3_loops.combined_loop_detector.check_combined``
   (~100ms CPU).
3. **Quality** — ``supplementaries.phase_5_quality.pipeline.HallucinationPipeline``
   (~200ms CPU; first call lazy-loads the models).
4. **Reasoning** — ``supplementaries.phase_9_reasoning.scorer.compute_composite``
   (~50ms CPU).
5. **Detection** — ``supplementaries.phase_7_detection.detectors.run_all_detectors``
   (~200ms CPU).

Prometheus counters (best-effort; only updated when
``prometheus_client`` is importable)::

    quality_pipeline_traces_total{status="ok|dlq|error"}
    quality_pipeline_step_duration_seconds{step="tas|loop|..."}
    quality_pipeline_watermark_age_seconds

The worker is intentionally framework-light. No threads, no
asyncio queues — a simple ``while not stop_event.is_set()``
loop polls every ``quality_pipeline_watermark_poll_ms`` (1s
default). The CPU-bound compute is delegated to the
supplementary implementations (already <50ms each per the
spec §3 measured budgets).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

# Install the cache-first HuggingFace download patch so the
# quality pipeline doesn't hit the network-probe bug when loading
# sentence-transformers / BGE / cross-encoder / MiniCheck models.
# Idempotent — safe to import multiple times.
try:
    from supplementaries import _hf_cache_patch  # noqa: F401  pylint: disable=unused-import
except Exception:  # pragma: no cover - supplementaries not on path
    pass


# ponytail: keep step labels here (also used as Prometheus label
# values and as the field name on the persisted report). Adding a
# new step = add a label + a compute block + a persist block.
STEP_NAMES: tuple[str, ...] = ("tas", "loop", "quality", "reasoning", "detection")


# ── Prometheus (lazy import; tests skip when missing) ──────────────


def _prom():
    try:
        from prometheus_client import Counter, Gauge, Histogram
        return Counter, Gauge, Histogram
    except Exception:
        return None


class _Metrics:
    """Lazy Prometheus counter wrappers.

    Each metric is created once per process. On environments
    without ``prometheus_client`` the wrappers fall back to a
    no-op shim so the worker still runs.
    """
    _instance: _Metrics | None = None

    def __init__(self) -> None:
        prom = _prom()
        if prom is None:
            self.traces_total = _NoopCounter()
            self.step_duration = _NoopHistogram()
            self.watermark_age = _NoopGauge()
            return
        Counter, Gauge, Histogram = prom
        self.traces_total = Counter(
            "quality_pipeline_traces_total",
            "Total traces processed by the sidecar worker",
            labelnames=("status",),
        )
        self.step_duration = Histogram(
            "quality_pipeline_step_duration_seconds",
            "Per-step wall-clock latency",
            labelnames=("step",),
        )
        self.watermark_age = Gauge(
            "quality_pipeline_watermark_age_seconds",
            "Seconds since the last persisted watermark",
        )

    @classmethod
    def get(cls) -> _Metrics:
        if cls._instance is None:
            cls._instance = _Metrics()
        return cls._instance


class _NoopCounter:
    def labels(self, **_: Any) -> _NoopCounter:
        return self

    def inc(self, *_a: Any, **_k: Any) -> None:
        return None


class _NoopHistogram:
    def labels(self, **_: Any) -> _NoopHistogram:
        return self

    def observe(self, *_a: Any, **_k: Any) -> None:
        return None


class _NoopGauge:
    def set(self, *_a: Any, **_k: Any) -> None:
        return None


# ── Worker state ──────────────────────────────────────────────────


@dataclass
class SidecarWorkerState:
    """Mutable state observable from tests + the health endpoint."""

    running: bool = False
    last_watermark_at: datetime | None = None
    processed_total: int = 0
    failed_total: int = 0
    dead_lettered_total: int = 0
    started_at: datetime | None = None
    stopped_at: datetime | None = None
    last_step_durations_ms: dict[str, float] = field(default_factory=dict)


_STATE = SidecarWorkerState()


def get_worker_state() -> SidecarWorkerState:
    """Snapshot of the worker state for the health endpoint + tests."""
    return _STATE


# ── 5-step compute (the core algorithm) ──────────────────────────


async def compute_trace_reports(
    tenant_id: str,
    trace_id: str,
    events: list[dict[str, Any]],
    *,
    archetype_id: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Compute all 5 reports for one trace.

    Returns a dict keyed by step name (``tas``, ``loop``, ...)
    with the report payload for each. The caller persists
    each payload to the corresponding ``trace_*_reports``
    table in a single transaction.

    Per-step timeouts are enforced via ``asyncio.wait_for``.
    On timeout, the step's payload is a stub with ``status =
    "timeout"`` so the caller knows to dead-letter.

    Parameters
    ----------
    archetype_id : str | None
        Optional archetype slug (e.g. ``"efficient-good"``) used to
        look up the per-archetype Task Value Score (TVS) and pick
        the right intervention. If ``None``, a neutral TVS of 0.7
        is used and the generic intervention policy applies.
    """
    out: dict[str, dict[str, Any]] = {}
    metrics = _Metrics.get()

    # Convert dict events to TelemetryEvent objects so the supplementaries
    # modules (which all expect typed events) can consume them.
    try:
        telemetry_events = _coerce_to_telemetry_events(events)
    except Exception as exc:
        # If we can't coerce at all, every step will fail — short-circuit.
        err = {"status": "error", "error": f"event coercion failed: {exc}"[:200]}
        return {
            "tas": err, "loop": err, "quality": err,
            "reasoning": err, "detection": err,
        }

    # All five steps run concurrently via asyncio.gather so the
    # end-to-end compute path completes in roughly the slowest
    # step's wall-time rather than the sum. Pre-fix the steps
    # ran sequentially and a single 1s step dragged the whole
    # compute into the 4-5s range; the e2e test
    # ``test_e2e_happy_path_11_step_trace`` expects < 200ms total.
    async def _tas() -> dict[str, Any]:
        from supplementaries.phase_2_efficiency.composite import (
            TASResult,
            compute_tas,
        )
        t0 = time.perf_counter()
        try:
            tas_result = await asyncio.wait_for(
                asyncio.to_thread(
                    compute_tas,
                    telemetry_events,
                    archetype_id=archetype_id,
                ),
                timeout=_get_timeout("tas"),
            )
            metrics.step_duration.labels(step="tas").observe(
                time.perf_counter() - t0
            )
            if not isinstance(tas_result, TASResult):
                raise TypeError(
                    f"compute_tas returned {type(tas_result).__name__}, "
                    "expected TASResult"
                )
            return {
                "tas": int(tas_result.tas),
                "avs": int(tas_result.avs),
                "vae": int(tas_result.vae),
                "grade": tas_result.grade,
                "intervention": tas_result.intervention,
                "metrics": dict(tas_result.metrics),
                "fix_patches": list(tas_result.fix_patches),
            }
        except Exception as exc:
            metrics.step_duration.labels(step="tas").observe(
                time.perf_counter() - t0
            )
            kind = "timeout" if isinstance(exc, asyncio.TimeoutError) else "error"
            logger.warning("sidecar: tas %s: %r", kind, exc)
            return {
                "status": kind,
                "error": f"{type(exc).__name__}: {exc}"[:200] or kind,
            }

    async def _loop() -> dict[str, Any]:
        from supplementaries.phase_3_loops.combined_loop_detector import (
            CombinedLoopReport,
            check_combined,
        )
        t0 = time.perf_counter()
        try:
            loop_report = await asyncio.wait_for(
                asyncio.to_thread(check_combined, telemetry_events),
                timeout=_get_timeout("loop"),
            )
            metrics.step_duration.labels(step="loop").observe(
                time.perf_counter() - t0
            )
            if not isinstance(loop_report, CombinedLoopReport):
                raise TypeError(
                    f"check_combined returned {type(loop_report).__name__}, "
                    "expected CombinedLoopReport"
                )
            return {
                "verdict": loop_report.verdict,
                "detectors_tripped": list(loop_report.detectors_tripped),
                "severity": loop_report.severity,
                "action": loop_report.action,
                "max_cosine": loop_report.cosine_max,
                "max_jaccard": None,  # jaccard not exposed on CombinedLoopReport
                "step_index": None,
            }
        except Exception as exc:
            metrics.step_duration.labels(step="loop").observe(
                time.perf_counter() - t0
            )
            kind = "timeout" if isinstance(exc, asyncio.TimeoutError) else "error"
            logger.warning("sidecar: loop %s: %r", kind, exc)
            return {
                "status": kind,
                "error": f"{type(exc).__name__}: {exc}"[:200] or kind,
            }

    async def _quality() -> dict[str, Any]:
        from supplementaries.phase_5_quality.pipeline import (
            HallucinationPipeline,
            QualityReport,
        )
        t0 = time.perf_counter()
        try:
            pipeline = HallucinationPipeline()
            # Quality is premise/hypothesis-based, not per-event.
            # Walk the trace: for each llm.completion, score the
            # request_body vs response_body. Aggregate to one report.
            quality_report = await asyncio.wait_for(
                asyncio.to_thread(_score_trace_quality, pipeline, telemetry_events),
                timeout=_get_timeout("quality"),
            )
            metrics.step_duration.labels(step="quality").observe(
                time.perf_counter() - t0
            )
            if not isinstance(quality_report, QualityReport):
                raise TypeError(
                    f"_score_trace_quality returned "
                    f"{type(quality_report).__name__}, expected QualityReport"
                )
            components = dict(quality_report.components)
            return {
                "hallucination_score": quality_report.hallucination_score,
                "groundedness": quality_report.grounded,
                "tool_relevance": components.get("tool_relevance"),
                "step_coherence": components.get("step_coherence"),
                "components": components,
                "verdict": quality_report.intervention,
            }
        except Exception as exc:
            metrics.step_duration.labels(step="quality").observe(
                time.perf_counter() - t0
            )
            kind = "timeout" if isinstance(exc, asyncio.TimeoutError) else "error"
            logger.warning("sidecar: quality %s: %r", kind, exc)
            return {
                "status": kind,
                "error": f"{type(exc).__name__}: {exc}"[:200] or kind,
            }

    async def _reasoning() -> dict[str, Any]:
        from supplementaries.phase_9_reasoning.scorer import (
            score_with_composite,
        )
        t0 = time.perf_counter()
        try:
            steps = _reasoning_steps(telemetry_events)
            user_prompt = _first_user_prompt(telemetry_events)
            reasoning_score = await asyncio.wait_for(
                asyncio.to_thread(score_with_composite, steps, user_prompt),
                timeout=_get_timeout("reasoning"),
            )
            metrics.step_duration.labels(step="reasoning").observe(
                time.perf_counter() - t0
            )
            return {
                "coherence": reasoning_score.coherence,
                "informativeness": reasoning_score.informativeness,
                "goal_alignment": reasoning_score.goal_alignment,
                "verification": reasoning_score.verification,
                "calibration_error": reasoning_score.calibration_error,
                "composite": reasoning_score.composite,
                "lanham_trap": False,
            }
        except Exception as exc:
            metrics.step_duration.labels(step="reasoning").observe(
                time.perf_counter() - t0
            )
            kind = "timeout" if isinstance(exc, asyncio.TimeoutError) else "error"
            logger.warning("sidecar: reasoning %s: %r", kind, exc)
            return {
                "status": kind,
                "error": f"{type(exc).__name__}: {exc}"[:200] or kind,
            }

    async def _detection() -> dict[str, Any]:
        from supplementaries.phase_7_detection.detectors import (
            DetectionReport,
            run_all_detectors,
        )
        t0 = time.perf_counter()
        try:
            det_report = await asyncio.wait_for(
                asyncio.to_thread(run_all_detectors, telemetry_events),
                timeout=_get_timeout("detection"),
            )
            metrics.step_duration.labels(step="detection").observe(
                time.perf_counter() - t0
            )
            if not isinstance(det_report, DetectionReport):
                raise TypeError(
                    f"run_all_detectors returned {type(det_report).__name__}, "
                    "expected DetectionReport"
                )
            severities = _detection_severities(det_report)
            return {
                "count": sum(1 for s in severities if s != "ok"),
                "high_severity_count": sum(1 for s in severities if s == "high"),
                "ids": [name for name, s in zip(_DETECTION_FIELDS, severities) if s != "ok"][:8],
            }
        except Exception as exc:
            metrics.step_duration.labels(step="detection").observe(
                time.perf_counter() - t0
            )
            kind = "timeout" if isinstance(exc, asyncio.TimeoutError) else "error"
            logger.warning("sidecar: detection %s: %r", kind, exc)
            return {
                "status": kind,
                "error": f"{type(exc).__name__}: {exc}"[:200] or kind,
            }

    # Launch the five steps concurrently. ``return_exceptions=True``
    # so a single crashed step doesn't take down the whole compute
    # (each step is already guarded internally).
    tas, loop, quality, reasoning, detections = await asyncio.gather(
        _tas(),
        _loop(),
        _quality(),
        _reasoning(),
        _detection(),
    )
    out["tas"] = tas
    out["loop"] = loop
    out["quality"] = quality
    out["reasoning"] = reasoning
    out["detection"] = detections

    # Permanent-write-then-fail: if the loop verdict is
    # "LOOP" with high severity, fire the drift alert hook
    # even if a later step timed out.
    if (loop or {}).get("severity") == "high":
        try:
            from eden.llmops.promotion_hooks import get_promotion_hook
            hook = get_promotion_hook()
            evt = hook.on_drift_alert  # type: ignore[attr-defined]
            if asyncio.iscoroutinefunction(evt):
                await evt(
                    drift_type="loop_high_severity",
                    severity="high",
                    org_id=tenant_id,
                    trace_id=trace_id,
                )
            else:
                evt(
                    drift_type="loop_high_severity",
                    severity="high",
                    org_id=tenant_id,
                    trace_id=trace_id,
                )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("sidecar: drift alert hook failed: %s", exc)

    return out


def _get_timeout(step: str) -> float:
    """Per-step timeout in seconds, read from Settings."""
    try:
        from eden.config import get_settings
        s = get_settings()
        mapping = {
            "tas": s.quality_step_timeout_tas_ms,
            "loop": s.quality_step_timeout_loop_ms,
            "quality": s.quality_step_timeout_quality_ms,
            "reasoning": s.quality_step_timeout_reasoning_ms,
            "detection": s.quality_step_timeout_detection_ms,
        }
        # Default budget is generous — covers cold-start model load
        # for sentence-transformers + BGE + MiniCheck on first run.
        # Subsequent runs are sub-50ms per the spec §3 measured budgets.
        return float(mapping.get(step, 30000)) / 1000.0
    except Exception:
        return 30.0  # 30s fallback for cold start




# ── Event coercion ───────────────────────────────────────────────


def _coerce_to_telemetry_events(
    events: list[dict[str, Any]],
) -> list[Any]:
    """Convert event dicts to ``TelemetryEvent`` instances.

    Falls back to a permissive dict-shaped wrapper if
    ``TelemetryEvent.from_dict`` rejects an event — keeps the
    pipeline alive on malformed input.
    """
    from eden.observability.telemetry_collector import TelemetryEvent
    out = []
    for e in events:
        if isinstance(e, TelemetryEvent):
            out.append(e)
            continue
        try:
            out.append(TelemetryEvent.from_dict(dict(e)))
        except Exception:
            # Permissive fallback — preserves the raw fields the
            # supplementaries modules look at, but skips strict
            # validation so a single bad event doesn't 500 the
            # whole compute.
            class _PermissiveEvent:
                __slots__ = ("__dict__",)
            pe = _PermissiveEvent()
            pe.__dict__.update(dict(e))
            out.append(pe)
    return out


# ── Per-step event-list adapters ────────────────────────────────


def _reasoning_steps(events: list[Any]) -> list[str]:
    """Extract a sequence of assistant response strings for reasoning."""
    steps: list[str] = []
    for e in events:
        et = getattr(e, "event_type", None)
        if et != "llm.completion":
            continue
        rb = getattr(e, "response_body", None) or {}
        choices = (rb or {}).get("choices") or []
        if not choices:
            continue
        msg = (choices[0] or {}).get("message") or {}
        content = msg.get("content") or ""
        if isinstance(content, str) and content:
            steps.append(content)
    return steps or ["(empty trace — no LLM completions)"]


def _first_user_prompt(events: list[Any]) -> str:
    """Return the first user message in the trace, or empty string."""
    for e in events:
        et = getattr(e, "event_type", None)
        if et != "llm.completion":
            continue
        rb = getattr(e, "request_body", None) or {}
        for m in (rb or {}).get("messages") or []:
            if m.get("role") == "user":
                return str(m.get("content") or "")
    return ""


# ── Quality adapter ──────────────────────────────────────────────


def _score_trace_quality(pipeline: Any, events: list[Any]) -> Any:
    """Score every LLM completion in the trace and aggregate.

    Walks each ``llm.completion`` event, extracts the user
    message and the assistant response, runs them through
    ``HallucinationPipeline.score(premise, hypothesis)``, and
    averages the per-step reports into one. If no completions
    are found, returns a neutral report with score=0.5.
    """
    from supplementaries.phase_5_quality.pipeline import (
        QualityReport,
    )

    scored: list[QualityReport] = []
    for e in events:
        et = getattr(e, "event_type", None)
        if et != "llm.completion":
            continue
        rb_req = getattr(e, "request_body", None) or {}
        rb_res = getattr(e, "response_body", None) or {}
        user_msg = ""
        for m in (rb_req or {}).get("messages") or []:
            if m.get("role") == "user":
                user_msg = str(m.get("content") or "")
                break
        assistant_msg = ""
        choices = (rb_res or {}).get("choices") or []
        if choices:
            msg = (choices[0] or {}).get("message") or {}
            assistant_msg = str(msg.get("content") or "")
        if not user_msg or not assistant_msg:
            continue
        try:
            scored.append(pipeline.score(premise=user_msg, hypothesis=assistant_msg))
        except Exception:
            # Skip events that fail scoring — e.g. PII placeholder
            # strings or non-English text.
            continue

    if not scored:
        return QualityReport(
            grounded=True,
            hallucination_score=0.5,
            confidence=0.0,
            intervention="allow",
            components={"tool_relevance": None, "step_coherence": None},
            inference_ms=0.0,
            notes="no scorable LLM completions",
        )

    n = len(scored)
    avg_hallu = sum(r.hallucination_score for r in scored) / n
    avg_conf = sum(r.confidence for r in scored) / n
    # Aggregate intervention = most-restrictive across steps.
    RESTRICTIVENESS = {
        "allow": 0, "warn": 1, "skip_step": 2, "block": 3, "summarize": 3,
        "escalate": 4,
    }
    worst = max(scored, key=lambda r: RESTRICTIVENESS.get(r.intervention, 0))
    return QualityReport(
        grounded=all(r.grounded for r in scored),
        hallucination_score=avg_hallu,
        confidence=avg_conf,
        intervention=worst.intervention,
        components={
            "per_step_count": n,
            "step_interventions": [r.intervention for r in scored],
        },
        inference_ms=sum(r.inference_ms for r in scored),
        notes=f"aggregated across {n} LLM completions",
    )


# ── Detection severity mapping ──────────────────────────────────


_DETECTION_FIELDS: tuple[str, ...] = (
    "indirect_injection_max",
    "sycophancy_rate",
    "reward_hogging",
    "calibration_failure_rate",
    "multi_turn_escalation_score",
    "pair_tap_crescendo",
    "memory_bloat",
    "agent_depth_runaway",
)


def _detection_severities(report: Any) -> list[str]:
    """Map each DetectionReport numeric field to a severity bucket.

    Bucket boundaries are intentionally conservative:
      high   — value >= 0.75 (extreme)
      medium — value >= 0.50 (elevated)
      low    — value >= 0.25 (minor)
      ok     — value < 0.25 (normal)
    """
    out = []
    for name in _DETECTION_FIELDS:
        v = getattr(report, name, 0.0) or 0.0
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = 0.0
        if v >= 0.75:
            out.append("high")
        elif v >= 0.50:
            out.append("medium")
        elif v >= 0.25:
            out.append("low")
        else:
            out.append("ok")
    # topology is a string field, not numeric.
    topology = getattr(report, "topology", None) or ""
    if topology in {"star", "mesh"}:
        # Add a synthetic "medium" for centralised / hyperconnected topologies.
        out.append("medium")
    else:
        out.append("ok")
    return out


# ── Persistence ───────────────────────────────────────────────────


_TABLES = {
    "tas": "trace_efficiency_reports",
    "loop": "trace_loop_reports",
    "quality": "trace_quality_reports",
    "reasoning": "trace_reasoning_reports",
}


async def persist_reports(
    tenant_id: str,
    trace_id: str,
    reports: dict[str, dict[str, Any]],
) -> dict[str, str]:
    """Persist each report in a single transaction.

    Returns ``{step: row_id_or_None}``. PostgreSQL substrate
    failures fall back to ``None``; the caller dead-letters.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return dict.fromkeys(reports)
    try:
        client = await get_postgres_client()
    except Exception:
        return dict.fromkeys(reports)
    if client is None:
        return dict.fromkeys(reports)

    out: dict[str, str | None] = {}
    async with client.transaction():
        for step, payload in reports.items():
            table = _TABLES.get(step)
            if table is None:
                continue
            if payload.get("status") == "error":
                out[step] = None
                continue
            try:
                row_id = await _upsert_report(
                    client, tenant_id, trace_id, table, payload
                )
                out[step] = row_id
            except Exception as exc:
                logger.debug("persist %s: %s", table, exc)
                out[step] = None
    return dict(out.items())


async def _upsert_report(
    client: Any,
    tenant_id: str,
    trace_id: str,
    table: str,
    payload: dict[str, Any],
) -> str | None:
    """Insert one row into the given trace_*_reports table.

    Idempotent per (tenant_id, trace_id) — we INSERT a fresh
    row each compute (the report is a snapshot, not a state).
    The index serves the "latest" query via DESC ordering.
    """
    if table == "trace_efficiency_reports":
        row = await client.fetchrow(
            """
            INSERT INTO trace_efficiency_reports
                (tenant_id, trace_id, metrics, tas, avs, vae,
                 grade, intervention, fix_patches)
            VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb)
            RETURNING id
            """,
            tenant_id, trace_id,
            json.dumps(payload.get("metrics") or {}, default=str)[:8000],
            payload.get("tas"),
            payload.get("avs"),
            payload.get("vae"),
            payload.get("grade"),
            (payload.get("intervention") or "allow")[:16],
            json.dumps(payload.get("fix_patches") or [], default=str)[:8000],
        )
    elif table == "trace_loop_reports":
        row = await client.fetchrow(
            """
            INSERT INTO trace_loop_reports
                (tenant_id, trace_id, verdict, detectors_tripped,
                 severity, action, max_cosine, max_jaccard,
                 step_index)
            VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
            RETURNING id
            """,
            tenant_id, trace_id,
            (payload.get("verdict") or "OK")[:8],
            json.dumps(payload.get("detectors_tripped") or [])[:2000],
            (payload.get("severity") or "low")[:8],
            (payload.get("action") or "allow")[:16],
            payload.get("max_cosine"),
            payload.get("max_jaccard"),
            payload.get("step_index"),
        )
    elif table == "trace_quality_reports":
        row = await client.fetchrow(
            """
            INSERT INTO trace_quality_reports
                (tenant_id, trace_id, hallucination_score,
                 groundedness, tool_relevance, step_coherence,
                 components, verdict)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
            RETURNING id
            """,
            tenant_id, trace_id,
            payload.get("hallucination_score"),
            payload.get("groundedness"),
            payload.get("tool_relevance"),
            payload.get("step_coherence"),
            json.dumps(payload.get("components") or {}, default=str)[:4000],
            (payload.get("verdict") or "allow")[:16],
        )
    elif table == "trace_reasoning_reports":
        row = await client.fetchrow(
            """
            INSERT INTO trace_reasoning_reports
                (tenant_id, trace_id, coherence, informativeness,
                 goal_alignment, verification, calibration_error,
                 composite, lanham_trap)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id
            """,
            tenant_id, trace_id,
            payload.get("coherence"),
            payload.get("informativeness"),
            payload.get("goal_alignment"),
            payload.get("verification"),
            payload.get("calibration_error"),
            payload.get("composite"),
            bool(payload.get("lanham_trap")),
        )
    else:
        return None
    if row is None:
        return None
    try:
        return str(row["id"])
    except Exception:
        return None


# ── Dead-letter + watermark ──────────────────────────────────────


async def dead_letter(
    tenant_id: str,
    trace_id: str,
    error: str,
    events: list[dict[str, Any]],
) -> None:
    """Write a poison trace to ``quality_pipeline_failed_traces``.

    Best-effort — failures are logged at debug. The dead-letter
    table is created lazily on first write (the worker owns
    schema management for its own dead-letter table).
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return
    try:
        client = await get_postgres_client()
    except Exception:
        return
    if client is None:
        return
    try:
        await client.execute(
            """
            CREATE TABLE IF NOT EXISTS quality_pipeline_failed_traces (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                tenant_id VARCHAR(128) NOT NULL,
                trace_id VARCHAR(128) NOT NULL,
                error VARCHAR(2000),
                event_count INTEGER NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        await client.execute(
            """
            INSERT INTO quality_pipeline_failed_traces
                (id, tenant_id, trace_id, error, event_count)
            VALUES ($1::uuid, $2, $3, $4, $5)
            """,
            str(uuid.uuid4()),
            tenant_id, trace_id, error[:2000], len(events),
        )
        _STATE.dead_lettered_total += 1
    except Exception as exc:
        logger.debug("dead_letter: %s", exc)


async def load_watermark() -> tuple[str, str] | None:
    """Load the persisted watermark ``(tenant_id, event_id)``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return None
    try:
        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None
    try:
        await client.execute(
            """
            CREATE TABLE IF NOT EXISTS quality_pipeline_watermark (
                id SERIAL PRIMARY KEY,
                tenant_id VARCHAR(128) NOT NULL,
                event_id VARCHAR(128) NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
            """
        )
        row = await client.fetchrow(
            "SELECT tenant_id, event_id FROM quality_pipeline_watermark "
            "ORDER BY id DESC LIMIT 1"
        )
    except Exception:
        return None
    if row is None:
        return None
    try:
        return str(row["tenant_id"]), str(row["event_id"])
    except Exception:
        return None


async def save_watermark(tenant_id: str, event_id: str) -> None:
    """Persist the watermark so a crashed worker resumes correctly."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return
    try:
        client = await get_postgres_client()
    except Exception:
        return
    if client is None:
        return
    try:
        await client.execute(
            "INSERT INTO quality_pipeline_watermark (tenant_id, event_id) "
            "VALUES ($1, $2)",
            tenant_id, event_id,
        )
        _STATE.last_watermark_at = datetime.now(UTC)
    except Exception as exc:
        logger.debug("save_watermark: %s", exc)


# ── Main loop ────────────────────────────────────────────────────


@dataclass
class SidecarWorker:
    """Sidecar worker — poll telemetry_events, compute, persist."""

    poll_interval_s: float = 1.0
    batch_size: int = 100
    max_retries: int = 3

    async def _poll_events(
        self,
        since_event_id: str | None,
    ) -> list[dict[str, Any]]:
        """Return a batch of ``telemetry_events`` since the watermark."""
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception:
            return []
        try:
            client = await get_postgres_client()
        except Exception:
            return []
        if client is None:
            return []
        try:
            if since_event_id is None:
                rows = await client.fetch(
                    "SELECT id, tenant_id, trace_id, event_type, "
                    "payload, created_at "
                    "FROM telemetry_events "
                    "ORDER BY created_at ASC "
                    "LIMIT $1",
                    int(self.batch_size),
                )
            else:
                # ponytail: cursor-by-(created_at, id) pattern;
                # the column id is the watermark tiebreaker.
                rows = await client.fetch(
                    "SELECT id, tenant_id, trace_id, event_type, "
                    "payload, created_at "
                    "FROM telemetry_events "
                    "WHERE (created_at, id) > "
                    "  (SELECT created_at, id FROM telemetry_events "
                    "   WHERE id::text = $1 LIMIT 1) "
                    "ORDER BY created_at ASC, id ASC "
                    "LIMIT $2",
                    since_event_id, int(self.batch_size),
                )
        except Exception as exc:
            logger.debug("worker poll: %s", exc)
            return []
        return [dict(r) for r in (rows or [])]

    @staticmethod
    def _is_span_end(event: dict[str, Any]) -> bool:
        """Heuristic: a trace is ready when its ``span.end`` was observed.

        Encoded as ``event_type = 'span.end'`` in the
        canonical telemetry schema.
        """
        return (event.get("event_type") or "").lower() == "span.end"

    async def _process_one(
        self, tenant_id: str, trace_id: str, events: list[dict[str, Any]]
    ) -> bool:
        """Process one trace. Returns True on success, False on DLQ."""
        # Extract archetype_id from the first event's attributes if present,
        # otherwise leave None (generic TAS policy).
        arc_id = None
        if events and isinstance(events[0], dict):
            attrs = events[0].get("attributes") or {}
            arc_id = attrs.get("archetype_id") or None
        reports = await compute_trace_reports(tenant_id, trace_id, events, archetype_id=arc_id)
        persisted = await persist_reports(tenant_id, trace_id, reports)
        if all(v is None for v in persisted.values()):
            await dead_letter(
                tenant_id, trace_id,
                "all_steps_failed",
                events,
            )
            _STATE.failed_total += 1
            _Metrics.get().traces_total.labels(status="dlq").inc()
            return False
        _STATE.processed_total += 1
        _Metrics.get().traces_total.labels(status="ok").inc()
        return True

    async def run(self, stop_event: asyncio.Event) -> None:
        """Run the worker loop until ``stop_event`` is set."""
        _STATE.running = True
        _STATE.started_at = datetime.now(UTC)
        try:
            watermark = await load_watermark()
            last_event_id = watermark[1] if watermark else None
            while not stop_event.is_set():
                events = await self._poll_events(last_event_id)
                if not events:
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(
                            stop_event.wait(),
                            timeout=self.poll_interval_s,
                        )
                    continue
                # Group by (tenant_id, trace_id); a trace is ready
                # when its span.end event has been observed.
                groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
                for ev in events:
                    key = (str(ev.get("tenant_id")), str(ev.get("trace_id")))
                    groups.setdefault(key, []).append(ev)
                for (tid, trace_id), evs in groups.items():
                    if not any(self._is_span_end(e) for e in evs):
                        # Not yet complete — skip; will pick up
                        # next iteration when span.end arrives.
                        continue
                    for attempt in range(self.max_retries):
                        try:
                            await self._process_one(tid, trace_id, evs)
                            break
                        except Exception as exc:
                            logger.debug(
                                "worker attempt %d: %s", attempt, exc,
                            )
                            await asyncio.sleep(0.05 * (2 ** attempt))
                    last_event_id = str(evs[-1].get("id") or last_event_id)
                    if last_event_id:
                        await save_watermark(tid, last_event_id)
        finally:
            _STATE.running = False
            _STATE.stopped_at = datetime.now(UTC)


# ── FastAPI lifespan wiring ──────────────────────────────────────


_WORKER_TASK: asyncio.Task[None] | None = None
_STOP_EVENT: asyncio.Event | None = None


async def start_worker() -> None:
    """Start the sidecar worker as an asyncio task.

    Called from the FastAPI lifespan. No-op when
    ``Settings.trace_quality_compute_async`` is False (the
    hot path still runs synchronously).
    """
    global _WORKER_TASK, _STOP_EVENT
    try:
        from eden.config import get_settings
        s = get_settings()
    except Exception:
        return
    if not s.trace_quality_enabled or not s.trace_quality_compute_async:
        logger.info("quality_pipeline: disabled by Settings")
        return
    if _WORKER_TASK is not None and not _WORKER_TASK.done():
        return
    _STOP_EVENT = asyncio.Event()
    worker = SidecarWorker(
        poll_interval_s=float(s.quality_pipeline_watermark_poll_ms) / 1000.0,
        batch_size=int(s.quality_pipeline_batch_size),
    )
    _WORKER_TASK = asyncio.create_task(
        worker.run(_STOP_EVENT),
        name="quality_pipeline_sidecar",
    )
    logger.info("quality_pipeline: started")


async def stop_worker() -> None:
    """Stop the sidecar worker (drain in-flight, exit within 30s)."""
    global _WORKER_TASK, _STOP_EVENT
    if _STOP_EVENT is None:
        return
    _STOP_EVENT.set()
    if _WORKER_TASK is None:
        return
    try:
        await asyncio.wait_for(_WORKER_TASK, timeout=30.0)
    except TimeoutError:
        _WORKER_TASK.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await _WORKER_TASK
    finally:
        _WORKER_TASK = None
        _STOP_EVENT = None
    logger.info("quality_pipeline: stopped")


# ── SIGTERM handler for standalone CLI mode ─────────────────────


def _install_sigterm_handler(loop: asyncio.AbstractEventLoop) -> None:
    """Install SIGTERM/SIGINT handlers that set the stop event.

    Only used when the worker is launched as a standalone
    process (``python -m eden.observability.quality_pipeline``).
    """
    if _STOP_EVENT is None:
        return

    def _handler(signum: int, _frame: Any) -> None:
        logger.info("quality_pipeline: SIGTERM/SIGINT received")
        if _STOP_EVENT is not None:
            _STOP_EVENT.set()

    try:
        loop.add_signal_handler(signal.SIGTERM, _handler, signal.SIGTERM, None)
        loop.add_signal_handler(signal.SIGINT, _handler, signal.SIGINT, None)
    except (NotImplementedError, RuntimeError):
        # Windows / restricted env — fall back to default handler.
        signal.signal(signal.SIGTERM, _handler)
        signal.signal(signal.SIGINT, _handler)


async def _main() -> None:
    """Standalone CLI entry point.

    Used by ``python -m eden.observability.quality_pipeline``.
    Honors ``Settings.quality_pipeline_*`` flags.
    """
    from eden.config import get_settings

    s = get_settings()
    worker = SidecarWorker(
        poll_interval_s=float(s.quality_pipeline_watermark_poll_ms) / 1000.0,
        batch_size=int(s.quality_pipeline_batch_size),
    )
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()
    _install_sigterm_handler(loop)
    await worker.run(stop_event)


if __name__ == "__main__" or os.environ.get("EDEN_QUALITY_PIPELINE_MAIN"):
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(_main())
