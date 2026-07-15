"""trace.finalized consumer (F20).

Reads the global ``trace.finalized`` Redis stream via a consumer group
and runs detection tiers per trace:

1. **Layer A** — deterministic descriptor tags + tool-error/loop stumbles.
2. **AutoIssueScanner** (F20) — remaining stumble detectors.
3. **Signal investigator** (F06/F35) — only when Layer A has no primary hit.

Follows the module-level start/stop lifecycle used by the quality
pipeline sidecar so it plugs into the API lifespan.

Concurrency: up to ``_MAX_CONCURRENT_SCANS`` scans in flight (a semaphore
bounds fan-out); messages are XACK'd only after the scan completes so a
crash re-delivers unprocessed traces.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
from typing import Any

from eden.observability.trace_finalized import TRACE_FINALIZED_STREAM

logger = logging.getLogger(__name__)

_GROUP = "eden-auto-scan"
_CONSUMER = f"auto-scan-{socket.gethostname()}"
_MAX_CONCURRENT_SCANS = 5
_BATCH = 32
_BLOCK_MS = 2_000

_TASK: asyncio.Task | None = None
_STOP: asyncio.Event | None = None


class TraceFinalizedConsumer:
    def __init__(self) -> None:
        from eden.issues.auto_scanner import AutoIssueScanner

        self._scanner = AutoIssueScanner()
        self._sem = asyncio.Semaphore(_MAX_CONCURRENT_SCANS)

    async def _ensure_group(self, redis: Any) -> None:
        try:
            await redis.xgroup_create(
                TRACE_FINALIZED_STREAM, _GROUP, id="0", mkstream=True
            )
        except Exception as exc:
            # BUSYGROUP → group already exists; anything else is logged.
            if "BUSYGROUP" not in str(exc):
                logger.debug("trace_finalized: xgroup_create: %s", exc)

    async def run(self, stop: asyncio.Event) -> None:
        from eden.storage.redis import get_redis_client

        redis = await get_redis_client()
        if redis is None:
            logger.info("trace_finalized consumer: no Redis; disabled")
            return
        await self._ensure_group(redis)
        logger.info("trace_finalized consumer: started (group=%s)", _GROUP)
        while not stop.is_set():
            try:
                resp = await redis.xreadgroup(
                    _GROUP,
                    _CONSUMER,
                    {TRACE_FINALIZED_STREAM: ">"},
                    count=_BATCH,
                    block=_BLOCK_MS,
                )
            except Exception as exc:
                logger.debug("trace_finalized: xreadgroup failed: %s", exc)
                await asyncio.sleep(1.0)
                continue
            if not resp:
                continue
            for _stream, entries in resp:
                await asyncio.gather(
                    *(self._handle(redis, mid, fields) for mid, fields in entries),
                    return_exceptions=True,
                )
        logger.info("trace_finalized consumer: stopped")

    async def _handle(self, redis: Any, message_id: Any, fields: Any) -> None:
        async with self._sem:
            try:
                data = _decode(fields)
                org_id = data.get("org_id")
                trace_id = data.get("trace_id")
                if org_id and trace_id:
                    _record_queue_lag(message_id)
                    layer_a_report = await self._run_layer_a(
                        org_id,
                        trace_id,
                        agent_id=data.get("agent_id") or None,
                        session_id=data.get("session_id") or None,
                        user_id=data.get("user_id") or None,
                    )
                    scan_results = await self._scanner.scan(
                        org_id,
                        trace_id,
                        agent_id=data.get("agent_id") or None,
                        session_id=data.get("session_id") or None,
                        user_id=data.get("user_id") or None,
                        detection_profile=await _resolve_profile(org_id),
                    )
                    # D1 — StatGate P0 rail before orchestrator LLM triage.
                    try:
                        from eden.issues.statgate_p0_rail import (
                            apply_statgate_p0_rail,
                            collect_issue_ids_from_scan,
                        )

                        issue_ids = collect_issue_ids_from_scan(scan_results)
                        if issue_ids:
                            await apply_statgate_p0_rail(org_id, issue_ids)
                    except Exception as rail_exc:
                        logger.debug(
                            "trace_finalized: statgate_p0_rail: %s", rail_exc
                        )
                    if not _layer_a_primary_hit(layer_a_report):
                        await _run_signal_investigator(org_id, trace_id)
                    await self._maybe_prod_eval(
                        org_id,
                        trace_id,
                        agent_id=data.get("agent_id") or None,
                    )
            except Exception as exc:
                logger.warning("trace_finalized: scan failed: %s", exc)
            finally:
                with contextlib.suppress(Exception):
                    await redis.xack(TRACE_FINALIZED_STREAM, _GROUP, message_id)

    async def _run_layer_a(
        self,
        org_id: str,
        trace_id: str,
        *,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
    ) -> Any | None:
        """Run Layer A descriptors, persist tags, promote stumbles."""
        try:
            from eden.evaluation.descriptors import DescriptorEngine
            from eden.evaluation.descriptors.persist import persist_descriptor_tags
            from eden.evaluation.descriptors.taxonomy import LAYER_A_PRIMARY
            from eden.insights.rca._common import _fetch_trace_events
            from eden.issues.models import StumbleCreate
            from eden.issues.stumble_writer import StumbleWriter

            events = await _fetch_trace_events(org_id, trace_id)
            if not events:
                return None
            report = DescriptorEngine(online=True).describe(events, trace_id=trace_id)
            if report.descriptors:
                await persist_descriptor_tags(org_id, trace_id, report)
                logger.info(
                    "layer_a: trace=%s descriptors=%s latency_ms=%.2f",
                    trace_id,
                    sorted(report.descriptor_ids),
                    report.latency_ms,
                )
                _LAYER_A_STUMBLE_KINDS = {
                    "tool_error": "tool_error",
                    "looping": "loop",
                    "confusion_loop": "loop",
                    "retry_storm": "loop",
                    "sliding_window_loop": "loop",
                    "tool_thrash": "loop",
                    "assistant_echo_loop": "loop",
                    "no_progress": "loop",
                }
                writer = StumbleWriter()
                for desc in report.descriptors:
                    kind = _LAYER_A_STUMBLE_KINDS.get(desc.descriptor_id)
                    if not kind:
                        continue
                    try:
                        await writer.create(
                            StumbleCreate(
                                org_id=org_id,
                                trace_id=trace_id,
                                agent_id=agent_id,
                                session_id=session_id,
                                user_id=user_id,
                                kind=kind,
                                title=desc.display_name,
                                detail={
                                    "detector": "layer_a",
                                    "descriptor_id": desc.descriptor_id,
                                    "rationale": desc.rationale,
                                    "evidence": desc.evidence,
                                },
                                detected_by="layer_a",
                            )
                        )
                    except Exception as stumble_exc:
                        logger.debug(
                            "layer_a stumble write failed: %s", stumble_exc
                        )
            report._primary_hit = bool(  # type: ignore[attr-defined]
                report.descriptor_ids & LAYER_A_PRIMARY
            )
            return report
        except Exception as exc:
            logger.debug("trace_finalized: layer_a skipped: %s", exc)
            return None

    async def _maybe_prod_eval(
        self, org_id: str, trace_id: str, *, agent_id: str | None
    ) -> None:
        try:
            from eden.evaluation.production.sampler import ProductionEvalSampler

            sampler = ProductionEvalSampler()
            await sampler.maybe_score_trace(
                org_id, trace_id, agent_id=agent_id, is_stumble=False
            )
        except Exception as exc:
            logger.debug("trace_finalized: prod_eval skipped: %s", exc)

def _layer_a_primary_hit(report: Any | None) -> bool:
    """True when Layer A matched a primary descriptor (skip F06)."""
    if report is None:
        return False
    if getattr(report, "_primary_hit", False):
        return True
    try:
        from eden.evaluation.descriptors.taxonomy import LAYER_A_PRIMARY

        return bool(report.descriptor_ids & LAYER_A_PRIMARY)
    except Exception:
        return False


def _decode(fields: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if not isinstance(fields, dict):
        return out
    for k, v in fields.items():
        key = k.decode() if isinstance(k, bytes) else str(k)
        val = v.decode() if isinstance(v, bytes) else str(v)
        out[key] = val
    return out


async def _resolve_profile(org_id: str) -> str:
    """Resolve an org's detection profile (F20) from per-org settings
    (``organizations.settings->'detection'``). Falls back to
    ``standard`` if settings are unavailable."""
    try:
        from eden.issues.detection_settings import resolve_profile

        return await resolve_profile(org_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("trace_finalized: resolve_profile failed: %s", exc)
        return "standard"


def _record_queue_lag(message_id: Any) -> None:
    """Record the lag between the trace.finalized emit and consume.

    Redis stream ids are ``<ms-epoch>-<seq>``; the millisecond prefix is
    the enqueue time, so ``now - prefix`` is the queue lag."""
    try:
        import time

        raw = message_id.decode() if isinstance(message_id, bytes) else str(message_id)
        enqueued_ms = int(raw.split("-", 1)[0])
        lag_s = max(0.0, (time.time() * 1000.0 - enqueued_ms) / 1000.0)
        from eden.issues.metrics import record_queue_lag

        record_queue_lag(lag_s)
    except Exception:  # pragma: no cover - best-effort metric
        pass


async def _run_signal_investigator(org_id: str, trace_id: str) -> None:
    """F06 — per-trace signal investigator (best-effort)."""
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "per_trace_signals_v1", True):
            return
    except Exception:
        pass
    try:
        from eden.signals.investigator import investigate_trace

        await investigate_trace(org_id, trace_id)
    except Exception as exc:
        logger.debug("trace_finalized: signal investigator failed: %s", exc)


async def start_consumer() -> None:
    global _TASK, _STOP
    try:
        from eden.config import get_settings

        settings = get_settings()
    except Exception:
        return
    if not getattr(settings, "auto_issue_detection_v1", True):
        logger.info("trace_finalized consumer: disabled by Settings")
        return
    if _TASK is not None and not _TASK.done():
        return
    _STOP = asyncio.Event()
    consumer = TraceFinalizedConsumer()
    _TASK = asyncio.create_task(
        consumer.run(_STOP), name="trace_finalized_consumer"
    )


async def stop_consumer() -> None:
    global _TASK, _STOP
    if _STOP is None:
        return
    _STOP.set()
    if _TASK is not None:
        try:
            await asyncio.wait_for(_TASK, timeout=15.0)
        except TimeoutError:
            _TASK.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await _TASK
    _TASK = None
    _STOP = None


def is_consumer_running() -> bool:
    return _TASK is not None and not _TASK.done()
