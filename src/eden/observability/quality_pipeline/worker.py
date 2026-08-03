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

Metrics, recorded unconditionally via
``eden.observability.simple_metrics`` and exposed on ``/metrics``::

    quality_pipeline_traces_total{status="ok|dlq|error"}
    quality_pipeline_step_duration_seconds{step="tas|loop|..."}
    quality_pipeline_watermark_age_seconds

These were previously best-effort ``prometheus_client`` counters, which meant
they were recorded either nowhere (the library is not a declared dependency,
so the no-op shim is what ran) or into a registry the hand-rolled ``/metrics``
endpoint never reads. The pipeline had no observable throughput either way.

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

from eden.observability.simple_metrics import Counter, Gauge, Summary
from eden.storage.empty_cooldown import aligned_deadline

logger = logging.getLogger(__name__)

# Install the cache-first HuggingFace download patch so the
# quality pipeline doesn't hit the network-probe bug when loading
# sentence-transformers / BGE / cross-encoder / MiniCheck models.
# Idempotent — safe to import multiple times.
with contextlib.suppress(Exception):  # pragma: no cover - supplementaries not on path
    from supplementaries import _hf_cache_patch  # noqa: F401  pylint: disable=unused-import


# ponytail: keep step labels here (also used as Prometheus label
# values and as the field name on the persisted report). Adding a
# new step = add a label + a compute block + a persist block.
STEP_NAMES: tuple[str, ...] = ("tas", "loop", "quality", "reasoning", "detection")


# ── Metrics ───────────────────────────────────────────────────────
#
# Formerly ``prometheus_client`` behind a no-op shim, which meant these
# numbers were either not recorded at all (library absent — it is not a
# declared dependency) or recorded into a registry that Eden's hand-rolled
# ``/metrics`` endpoint never reads. Either way the quality pipeline had no
# observable throughput.


class _Metrics:
    """Quality-pipeline worker metrics.

    Class attributes, so the families are constructed exactly once at import.
    The previous lazy singleton would re-register on any reset, and duplicate
    families produce duplicate ``# HELP`` lines — an exposition that
    ``expfmt``-based consumers reject outright.
    """

    traces_total = Counter(
        "quality_pipeline_traces_total",
        "Total traces processed by the sidecar worker",
        labelnames=("status",),
    )
    step_duration = Summary(
        "quality_pipeline_step_duration_seconds",
        "Per-step wall-clock latency",
        labelnames=("step",),
    )
    watermark_age = Gauge(
        "quality_pipeline_watermark_age_seconds",
        "Seconds since the last persisted watermark",
    )

    @classmethod
    def get(cls) -> type[_Metrics]:
        return cls


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
        # Phase 5 — gated behind ``quality_pipeline_detection_enabled``
        # (default OFF). ``_TABLES`` (below) has no "detection" entry,
        # so ``persist_reports`` has always silently discarded this
        # step's output — every trace paid ~200ms of CPU for a report
        # that was never written anywhere. Skip the compute entirely
        # until a ``trace_detection_reports`` table + persist branch
        # exist to actually use it.
        if not _detection_enabled():
            return {"status": "disabled", "reason": "quality_pipeline_detection_enabled=false"}
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
                "ids": [name for name, s in zip(_DETECTION_FIELDS, severities, strict=True) if s != "ok"][:8],
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
            evt = hook.on_drift_alert
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


def _detection_enabled() -> bool:
    """Feature flag for the Detection step (default OFF — see ``_detection``)."""
    try:
        from eden.config import get_settings
        return bool(get_settings().quality_pipeline_detection_enabled)
    except Exception:
        return False


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
    restrictiveness = {
        "allow": 0, "warn": 1, "skip_step": 2, "block": 3, "summarize": 3,
        "escalate": 4,
    }
    worst = max(scored, key=lambda r: restrictiveness.get(r.intervention, 0))
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
        logger.warning(
            "persist_reports: cannot persist reports for trace %s — "
            "postgres import unavailable; partial loss cannot be retried",
            trace_id,
        )
        return dict.fromkeys(reports)
    try:
        client = await get_postgres_client()
    except Exception:
        logger.warning(
            "persist_reports: cannot persist reports for trace %s — "
            "postgres client raise; partial loss cannot be retried",
            trace_id,
        )
        return dict.fromkeys(reports)
    if client is None:
        logger.warning(
            "persist_reports: cannot persist reports for trace %s — "
            "postgres client absent; partial loss cannot be retried",
            trace_id,
        )
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
                logger.warning(
                    "persist_reports: step %s write failed for trace %s: %s — "
                    "partial loss cannot be retried (watermark still advances)",
                    step,
                    trace_id,
                    exc,
                )
                try:
                    from eden.observability.drop_metrics import record_drop

                    record_drop("sink_pg", "write_error")
                except Exception:
                    pass
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
        if row and (payload.get("verdict") or "") != "OK":
            try:
                from eden.nudges.author import ArtifactAuthor
                from eden.preview.gates import artifacts_enabled

                if await artifacts_enabled(str(tenant_id)):
                    detectors = payload.get("detectors_tripped") or []
                    kind = detectors[0] if detectors else "loop"
                    await ArtifactAuthor().from_loop_report(
                        str(tenant_id),
                        agent_id=str(payload.get("agent_id") or "default"),
                        report={
                            "kind": kind,
                            "trace_id": trace_id,
                            "tool_name": payload.get("tool_name"),
                        },
                    )
            except Exception as exc:
                logger.debug("loop→artifact draft failed: %s", exc)
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
) -> bool:
    """Write a poison trace to ``quality_pipeline_failed_traces``.

    Returns ``True`` only when a row was actually written. Failures
    (including an absent Postgres client) are logged at ERROR and
    counted via ``record_drop`` so callers do not report
    ``status="dlq"`` for a trace that never landed.
    """
    def _announce_loss(why: str) -> None:
        logger.error(
            "dead-letter write FAILED for trace %s (tenant %s): %s — "
            "trace is recoverable only by rewinding the watermark",
            trace_id,
            tenant_id,
            why,
        )
        try:
            from eden.observability.drop_metrics import record_drop

            record_drop("sink_pg", "write_error")
        except Exception:
            pass

    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:
        _announce_loss(f"postgres import failed: {exc}")
        return False
    try:
        client = await get_postgres_client()
    except Exception as exc:
        _announce_loss(f"postgres client raise: {exc}")
        return False
    if client is None:
        _announce_loss("postgres client absent")
        return False
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
        return True
    except Exception as exc:
        _announce_loss(str(exc))
        return False


# The watermark is a *cursor*, so exactly one row is meaningful. It used
# to be append-only (one INSERT per batch) against a table read with
# ``ORDER BY id DESC LIMIT 1``, so the table grew without bound and every
# read had to sort a pile of dead rows. It is now a single upserted row
# pinned at this id.
_WATERMARK_ROW_ID = 1

# ``CREATE TABLE IF NOT EXISTS`` used to run on *every* ``load_watermark``
# call. The DDL is idempotent but not free — it takes a lock and keeps
# Postgres awake, which is exactly what the Neon scale-to-zero work is
# trying to avoid. Once per process is sufficient.
_watermark_table_ready = False
_watermark_legacy_pruned = False


async def _ensure_watermark_table(client: Any) -> None:
    """Create the watermark table at most once per process."""
    global _watermark_table_ready
    if _watermark_table_ready:
        return
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
    _watermark_table_ready = True


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
        await _ensure_watermark_table(client)
        # Order by ``updated_at`` rather than ``id`` so a deployment that
        # still has legacy append-mode rows (ids far above
        # ``_WATERMARK_ROW_ID``) resolves to the most recent write rather
        # than to the highest surviving serial.
        row = await client.fetchrow(
            "SELECT tenant_id, event_id FROM quality_pipeline_watermark "
            "ORDER BY updated_at DESC, id DESC LIMIT 1"
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
    """Persist the watermark so a crashed worker resumes correctly.

    Upserts a single row instead of appending one per batch.
    """
    global _watermark_legacy_pruned
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
        await _ensure_watermark_table(client)
        await client.execute(
            "INSERT INTO quality_pipeline_watermark "
            "(id, tenant_id, event_id, updated_at) "
            "VALUES ($1, $2, $3, now()) "
            "ON CONFLICT (id) DO UPDATE SET "
            "tenant_id = EXCLUDED.tenant_id, "
            "event_id = EXCLUDED.event_id, "
            "updated_at = now()",
            _WATERMARK_ROW_ID, tenant_id, event_id,
        )
        _STATE.last_watermark_at = datetime.now(UTC)
        if not _watermark_legacy_pruned:
            # One-time cleanup of rows left by the old append-only writer.
            # Runs *after* the upsert above so the cursor is already safe.
            _watermark_legacy_pruned = True
            try:
                await client.execute(
                    "DELETE FROM quality_pipeline_watermark WHERE id <> $1",
                    _WATERMARK_ROW_ID,
                )
            except Exception as exc:
                logger.debug("watermark legacy prune: %s", exc)
    except Exception as exc:
        logger.debug("save_watermark: %s", exc)


def _reset_watermark_caches_for_tests() -> None:
    """Test-only: clear the once-per-process DDL/prune latches."""
    global _watermark_table_ready, _watermark_legacy_pruned
    _watermark_table_ready = False
    _watermark_legacy_pruned = False


# ── Main loop ────────────────────────────────────────────────────


@dataclass
class SidecarWorker:
    """Sidecar worker — poll telemetry_events, compute, persist."""

    poll_interval_s: float = 1.0
    batch_size: int = 100
    max_retries: int = 3
    concurrency: int = 8

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
                    "SELECT event_id, tenant_id, trace_id, event_type, "
                    "payload, created_at "
                    "FROM telemetry_events "
                    "ORDER BY created_at ASC, event_id ASC "
                    "LIMIT $1",
                    int(self.batch_size),
                )
            else:
                # Cursor-by-(created_at, event_id). ``event_id`` is the
                # table's own key (migration 009 declares it PRIMARY KEY,
                # and 034 re-declares the PK as (event_id, timestamp));
                # ``telemetry_events`` has no ``id`` column at all. This
                # query previously selected/filtered on ``id``, which made
                # every poll raise UndefinedColumn. The exception is
                # swallowed below and reported as an empty batch, so the
                # whole quality pipeline silently no-op'd.
                rows = await client.fetch(
                    "SELECT event_id, tenant_id, trace_id, event_type, "
                    "payload, created_at "
                    "FROM telemetry_events "
                    "WHERE (created_at, event_id) > "
                    "  (SELECT created_at, event_id FROM telemetry_events "
                    "   WHERE event_id = $1 LIMIT 1) "
                    "ORDER BY created_at ASC, event_id ASC "
                    "LIMIT $2",
                    since_event_id, int(self.batch_size),
                )
        except Exception as exc:
            # Deliberately louder than debug: a failing poll is
            # indistinguishable from an empty queue to the caller, so a
            # schema drift here silently disables the entire pipeline
            # (which is exactly what happened with the ``id`` column).
            logger.warning(
                "quality_pipeline poll failed (treated as empty batch — "
                "pipeline is not making progress): %s", exc,
            )
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
            landed = await dead_letter(
                tenant_id, trace_id,
                "all_steps_failed",
                events,
            )
            _STATE.failed_total += 1
            if landed:
                _Metrics.get().traces_total.labels(status="dlq").inc()
            else:
                _Metrics.get().traces_total.labels(status="error").inc()
            return False
        _STATE.processed_total += 1
        _Metrics.get().traces_total.labels(status="ok").inc()
        return True

    async def run(self, stop_event: asyncio.Event) -> None:
        """Run the worker loop until ``stop_event`` is set."""
        _STATE.running = True
        _STATE.started_at = datetime.now(UTC)
        # Empty-poll backoff: start at configured interval, grow toward
        # ``quality_pipeline_empty_backoff_max_s`` (default 360s) so an
        # idle fleet can clear Neon's ~300s suspend window.
        empty_backoff_s = float(self.poll_interval_s)
        try:
            from eden.config import get_settings

            empty_backoff_max_s = float(
                getattr(
                    get_settings(),
                    "quality_pipeline_empty_backoff_max_s",
                    360.0,
                )
                or 360.0
            )
        except Exception:
            empty_backoff_max_s = 360.0
        empty_backoff_max_s = max(empty_backoff_max_s, float(self.poll_interval_s))
        try:
            watermark = await load_watermark()
            last_event_id = watermark[1] if watermark else None
            # One semaphore for the worker's lifetime. Rebuilding it per
            # batch let each batch start a fresh set of permits, so the
            # cap never applied across overlapping work. The floor is 1,
            # not 8: ``concurrency`` is the operator's knob for throttling
            # fan-out against Neon, and a floor of 8 silently ignored every
            # value below it.
            sem = asyncio.Semaphore(max(1, int(self.concurrency)))
            while not stop_event.is_set():
                events = await self._poll_events(last_event_id)
                if not events:
                    # Once the backoff saturates, snap the wake-up onto the
                    # fleet-wide idle grid. Sleeping a fixed ceiling from
                    # wherever this sidecar happened to land leaves it out of
                    # phase with the other idle pollers, and staggered polls
                    # fragment the DB-quiet window below Neon's suspend
                    # timeout even when every individual interval clears it.
                    if empty_backoff_s >= empty_backoff_max_s:
                        sleep_s = max(
                            0.0,
                            aligned_deadline(empty_backoff_max_s) - time.monotonic(),
                        )
                    else:
                        sleep_s = empty_backoff_s
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(
                            stop_event.wait(),
                            timeout=sleep_s,
                        )
                    empty_backoff_s = min(
                        empty_backoff_max_s,
                        max(self.poll_interval_s, empty_backoff_s * 1.5),
                    )
                    continue
                # NB: the backoff is reset below only when the cursor
                # actually advances, not merely because the poll returned
                # rows. A batch of traces that are all still missing their
                # span.end returns the same rows forever; resetting here
                # pinned the worker at ``poll_interval_s`` (1s) against
                # Neon indefinitely, so the database could never suspend.
                # Group by (tenant_id, trace_id); a trace is ready
                # when its span.end event has been observed.
                groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
                for ev in events:
                    key = (str(ev.get("tenant_id")), str(ev.get("trace_id")))
                    groups.setdefault(key, []).append(ev)
                ready: list[tuple[str, str, list[dict[str, Any]]]] = []
                for (tid, trace_id), evs in groups.items():
                    if not any(self._is_span_end(e) for e in evs):
                        # Not yet complete — skip; will pick up
                        # next iteration when span.end arrives.
                        continue
                    ready.append((tid, trace_id, evs))

                async def _process_ready(
                    tid: str,
                    trace_id: str,
                    evs: list[dict[str, Any]],
                ) -> str | None:
                    async with sem:
                        last_exc: Exception | None = None
                        for attempt in range(self.max_retries):
                            try:
                                await self._process_one(tid, trace_id, evs)
                                last_exc = None
                                break
                            except Exception as exc:
                                last_exc = exc
                                logger.debug(
                                    "worker attempt %d: %s", attempt, exc,
                                )
                                await asyncio.sleep(0.05 * (2 ** attempt))
                        if last_exc is not None:
                            # Every attempt raised. Advancing the watermark
                            # here would drop the trace silently and it would
                            # never be retried, so route it to the dead-letter
                            # table on the same path ``_process_one`` uses for
                            # an all-steps-failed trace. Best-effort, like
                            # ``dead_letter`` itself: this runs inside the
                            # gather below, and the Postgres failure that
                            # exhausted the retries is exactly the one that
                            # would make this write raise too.
                            logger.warning(
                                "quality pipeline: trace %s/%s failed all %d "
                                "attempts, dead-lettering: %s",
                                tid, trace_id, self.max_retries, last_exc,
                            )
                            try:
                                landed = await dead_letter(
                                    tid, trace_id,
                                    f"exhausted_retries: {last_exc}",
                                    evs,
                                )
                                _STATE.failed_total += 1
                                if landed:
                                    _Metrics.get().traces_total.labels(
                                        status="dlq"
                                    ).inc()
                                else:
                                    _Metrics.get().traces_total.labels(
                                        status="error"
                                    ).inc()
                            except Exception as dlq_exc:
                                logger.error(
                                    "quality pipeline: dead-letter failed for "
                                    "%s/%s: %s", tid, trace_id, dlq_exc,
                                )
                    return str(evs[-1].get("event_id") or "") or None

                # ``return_exceptions=True``: this gather has no supervisor
                # above it (the sidecar is a bare create_task), so a single
                # escaping exception ends the worker for the process lifetime.
                await asyncio.gather(
                    *(_process_ready(tid, tid_trace, evs) for tid, tid_trace, evs in ready),
                    return_exceptions=True,
                )

                # Advance the cursor to just before the first event of the
                # earliest trace we skipped as incomplete.
                #
                # ``_poll_events`` is a strictly forward cursor ordered by
                # (created_at, event_id). The previous code advanced to the
                # last *ready* group's final event, which in a batch that
                # mixes ready and incomplete traces jumps over the spans of
                # the incomplete ones — when their span.end arrived in a
                # later batch they were scored against a partial span set,
                # silently. Stopping at the first incomplete event means
                # those spans are re-read next poll, which is what the
                # "will pick up next iteration" comment above promised.
                ready_keys = {(t, tr) for t, tr, _ in ready}
                incomplete_keys = set(groups) - ready_keys
                safe_cursor: str | None = None
                cursor_tenant = ""
                for ev in events:
                    key = (str(ev.get("tenant_id")), str(ev.get("trace_id")))
                    if key in incomplete_keys:
                        break
                    ev_id = str(ev.get("event_id") or "")
                    if ev_id:
                        safe_cursor = ev_id
                        cursor_tenant = str(ev.get("tenant_id"))
                if safe_cursor and safe_cursor != last_event_id:
                    # One write per batch. The watermark is a single global
                    # row, so the previous per-group loop issued N upserts
                    # and kept only the last — N-1 wasted round-trips against
                    # a database billed for staying awake.
                    await save_watermark(cursor_tenant, safe_cursor)
                    last_event_id = safe_cursor
                    empty_backoff_s = float(self.poll_interval_s)
                else:
                    # Rows came back but none were actionable. Back off on
                    # the same curve as an empty poll.
                    empty_backoff_s = min(
                        empty_backoff_max_s,
                        max(self.poll_interval_s, empty_backoff_s * 1.5),
                    )
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(
                            stop_event.wait(), timeout=empty_backoff_s
                        )
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
    if (
        not s.trace_quality_enabled
        or not s.trace_quality_compute_async
        or not getattr(s, "trace_quality_worker_enabled", True)
    ):
        logger.info("quality_pipeline: disabled by Settings")
        return
    if _WORKER_TASK is not None and not _WORKER_TASK.done():
        return
    _STOP_EVENT = asyncio.Event()
    workers = max(8, int(getattr(s, "quality_pipeline_workers", 8) or 8))
    worker = SidecarWorker(
        poll_interval_s=float(s.quality_pipeline_watermark_poll_ms) / 1000.0,
        batch_size=int(s.quality_pipeline_batch_size),
        concurrency=workers,
    )
    _WORKER_TASK = asyncio.create_task(
        worker.run(_STOP_EVENT),
        name="quality_pipeline_sidecar",
    )
    logger.info("quality_pipeline: started")


def is_worker_running() -> bool:
    """Return True when the sidecar worker task is alive.

    N14 — surfaced on ``/health`` so operators can confirm the
    quality-pipeline was actually started (not silently no-oped by
    a missing Settings field or a disabled flag).
    """
    return _WORKER_TASK is not None and not _WORKER_TASK.done()


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
