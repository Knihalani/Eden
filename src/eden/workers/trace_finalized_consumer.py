"""trace.finalized consumer (F20).

Reads the global ``trace.finalized`` Redis stream via a consumer group
and runs :class:`~eden.issues.auto_scanner.AutoIssueScanner` per trace.
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
                    scan_results = await self._scanner.scan(
                        org_id,
                        trace_id,
                        agent_id=data.get("agent_id") or None,
                        session_id=data.get("session_id") or None,
                        user_id=data.get("user_id") or None,
                        detection_profile=_resolve_profile(org_id),
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


def _decode(fields: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if not isinstance(fields, dict):
        return out
    for k, v in fields.items():
        key = k.decode() if isinstance(k, bytes) else str(k)
        val = v.decode() if isinstance(v, bytes) else str(v)
        out[key] = val
    return out


def _resolve_profile(org_id: str) -> str:
    """Resolve an org's detection profile (F20). v1 defaults to
    ``standard``; a per-org override table can slot in here later."""
    return "standard"


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
