"""trace.finalized consumer (F20).

Reads the global ``trace.finalized`` Redis stream via a consumer group
and runs detection tiers per trace:

1. **Layer A** — deterministic descriptors, float scores, limited stumbles.
2. **T1 annotator** — semantic ``eval:llm:*`` search tags (no Issues).
3. **AutoIssueScanner** (F20) — remaining stumble detectors.
4. **Signal investigator** (F06/F35) — only when Layer A has no primary hit.

Follows the module-level start/stop lifecycle used by the quality
pipeline sidecar so it plugs into the API lifespan.

Concurrency: up to ``_MAX_CONCURRENT_SCANS`` scans in flight (a semaphore
bounds fan-out). Messages are XACK'd only after success **or** after the
message is durably dead-lettered (poison / retries exhausted) — if the DLQ
``xadd`` itself fails (e.g. a transient Redis blip), the original message is
left unacked so it stays in the PEL and is retried via XAUTOCLAIM, bounded
by ``_MAX_DLQ_WRITE_ATTEMPTS`` so a sustained Redis outage cannot loop
forever. Transient scan failures retry in-process so the PEL is never left
unacked forever for that reason (the reader only claims ``>`` new ids plus
idle pending via XAUTOCLAIM).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import socket
from typing import Any

from eden.observability.trace_finalized import (
    TRACE_FINALIZED_DLQ_STREAM,
    TRACE_FINALIZED_STREAM,
)

logger = logging.getLogger(__name__)

_GROUP = "eden-auto-scan"
_CONSUMER = f"auto-scan-{socket.gethostname()}"
_MAX_CONCURRENT_SCANS = 5
_BATCH = 32
# In-process retries before poison/DLQ. Keeps the PEL clean (no bare
# XACK-skip that would permanently drop a transient blip, and no
# unacked stuck entries that ``>`` alone would never reclaim).
_MAX_HANDLE_ATTEMPTS = 3
_RETRY_BASE_DELAY_S = 0.25
# Idle pending reclaim window — crash mid-handle leaves entries in the
# PEL; reclaim after this idle so another consumer finishes them.
_PENDING_IDLE_MS = 60_000
_DLQ_MAXLEN = 10_000
# Bounds how many times we'll leave a to-be-dead-lettered message unacked
# after a failed DLQ xadd before giving up and ACKing anyway. Without this,
# a sustained total-Redis-outage would let the DLQ write keep failing
# forever, and the message would loop through XAUTOCLAIM indefinitely once
# Redis recovers (each recovery attempt re-fails until this cap trips).
_MAX_DLQ_WRITE_ATTEMPTS = 5

_TASK: asyncio.Task | None = None
_STOP: asyncio.Event | None = None

# Process-local counters (tests + ops).
_STATS: dict[str, int] = {
    "handled_ok": 0,
    "poison_total": 0,
    "dlq_total": 0,
    "retry_total": 0,
    "dlq_write_failed_total": 0,
    "dlq_write_dropped_total": 0,
}


def _block_ms() -> int:
    from eden.storage.redis import redis_stream_block_ms

    return redis_stream_block_ms()


def _autoclaim_interval_s() -> float:
    from eden.storage.redis import redis_stream_autoclaim_interval_s

    return float(redis_stream_autoclaim_interval_s())


class PoisonMessageError(ValueError):
    """Malformed or permanently unprocessable ``trace.finalized`` payload."""


class TraceFinalizedConsumer:
    def __init__(self) -> None:
        from eden.issues.auto_scanner import AutoIssueScanner

        self._scanner = AutoIssueScanner()
        self._sem = asyncio.Semaphore(_MAX_CONCURRENT_SCANS)
        self._last_autoclaim_mono: float = 0.0
        # message_id -> consecutive failed DLQ-write attempts. Bounds the
        # unacked-retry loop when the DLQ xadd itself keeps failing.
        self._dlq_write_failures: dict[str, int] = {}

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
        from eden.storage.redis import get_redis_stream_client

        redis = await get_redis_stream_client()
        if redis is None:
            logger.info("trace_finalized consumer: no Redis; disabled")
            return
        await self._ensure_group(redis)
        block_ms = _block_ms()
        logger.info(
            "trace_finalized consumer: started (group=%s, block_ms=%s)",
            _GROUP,
            block_ms,
        )
        while not stop.is_set():
            entries = await self._read_batch(redis)
            if not entries:
                continue
            await asyncio.gather(
                *(self._handle(redis, mid, fields) for mid, fields in entries),
                return_exceptions=True,
            )
        logger.info("trace_finalized consumer: stopped")

    async def _read_batch(self, redis: Any) -> list[tuple[Any, Any]]:
        """Claim idle pending periodically, then read new messages.

        Crash mid-handle leaves entries in the PEL. Reading only ``>``
        would never finish them; XAUTOCLAIM reclaims idle ones — but
        running it every idle cycle doubles Upstash command volume.
        """
        import time as _time

        out: list[tuple[Any, Any]] = []
        now = _time.monotonic()
        if now - self._last_autoclaim_mono >= _autoclaim_interval_s():
            self._last_autoclaim_mono = now
            try:
                claimed = await redis.xautoclaim(
                    TRACE_FINALIZED_STREAM,
                    _GROUP,
                    _CONSUMER,
                    min_idle_time=_PENDING_IDLE_MS,
                    start_id="0-0",
                    count=_BATCH,
                )
                # redis-py: (next_id, [(id, fields), ...], deleted_ids?)
                if isinstance(claimed, (list, tuple)) and len(claimed) >= 2:
                    messages = claimed[1] or []
                    for item in messages:
                        if isinstance(item, (list, tuple)) and len(item) >= 2:
                            out.append((item[0], item[1]))
            except Exception as exc:
                # Older Redis / Upstash without XAUTOCLAIM — fall through.
                logger.debug("trace_finalized: xautoclaim: %s", exc)

        remaining = max(0, _BATCH - len(out))
        if remaining == 0:
            return out
        block_ms = _block_ms() if not out else 1
        try:
            resp = await redis.xreadgroup(
                _GROUP,
                _CONSUMER,
                {TRACE_FINALIZED_STREAM: ">"},
                count=remaining,
                block=block_ms,
            )
        except Exception as exc:
            logger.debug("trace_finalized: xreadgroup failed: %s", exc)
            if not out:
                await asyncio.sleep(1.0)
            return out
        if not resp:
            return out
        for _stream, entries in resp:
            for mid, fields in entries:
                out.append((mid, fields))
        return out

    async def _handle(self, redis: Any, message_id: Any, fields: Any) -> None:
        async with self._sem:
            dlq_reason: str | None = None
            try:
                data = _decode(fields)
                org_id = (data.get("org_id") or "").strip()
                trace_id = (data.get("trace_id") or "").strip()
                if not org_id or not trace_id:
                    raise PoisonMessageError(
                        f"missing org_id/trace_id (org={org_id!r} trace={trace_id!r})"
                    )

                last_exc: BaseException | None = None
                for attempt in range(1, _MAX_HANDLE_ATTEMPTS + 1):
                    try:
                        await self._process_trace(
                            message_id, data, org_id, trace_id, attempt=attempt
                        )
                        _STATS["handled_ok"] += 1
                        last_exc = None
                        break
                    except PoisonMessageError:
                        raise
                    except Exception as exc:
                        last_exc = exc
                        if not _is_transient(exc) or attempt >= _MAX_HANDLE_ATTEMPTS:
                            break
                        _STATS["retry_total"] += 1
                        logger.warning(
                            "trace_finalized: transient fail attempt=%d/%d "
                            "org=%s trace=%s: %s",
                            attempt,
                            _MAX_HANDLE_ATTEMPTS,
                            org_id,
                            trace_id,
                            exc,
                        )
                        await asyncio.sleep(_RETRY_BASE_DELAY_S * attempt)

                if last_exc is not None:
                    dlq_reason = f"scan_failed:{type(last_exc).__name__}:{last_exc}"
                    logger.warning(
                        "trace_finalized: giving up org=%s trace=%s: %s",
                        org_id,
                        trace_id,
                        last_exc,
                    )
            except PoisonMessageError as exc:
                dlq_reason = f"poison:{exc}"
                _STATS["poison_total"] += 1
                logger.warning("trace_finalized: poison message %s: %s", message_id, exc)
            except Exception as exc:
                dlq_reason = f"unexpected:{type(exc).__name__}:{exc}"
                logger.warning("trace_finalized: scan failed: %s", exc)

            if dlq_reason is not None:
                mid_key = (
                    message_id.decode()
                    if isinstance(message_id, bytes)
                    else str(message_id)
                )
                dlq_ok = await _dead_letter(redis, message_id, fields, dlq_reason)
                if dlq_ok:
                    self._dlq_write_failures.pop(mid_key, None)
                else:
                    _STATS["dlq_write_failed_total"] += 1
                    attempts = self._dlq_write_failures.get(mid_key, 0) + 1
                    self._dlq_write_failures[mid_key] = attempts
                    if attempts < _MAX_DLQ_WRITE_ATTEMPTS:
                        logger.warning(
                            "trace_finalized: dlq write failed (attempt %d/%d) "
                            "for %s; leaving message unacked for XAUTOCLAIM "
                            "retry: %s",
                            attempts,
                            _MAX_DLQ_WRITE_ATTEMPTS,
                            mid_key,
                            dlq_reason,
                        )
                        # Leave unacked: stays in the PEL so XAUTOCLAIM
                        # reclaims it and we retry the DLQ write later,
                        # instead of silently discarding a never-recorded
                        # message.
                        return
                    logger.error(
                        "trace_finalized: dlq write failed %d times for %s; "
                        "giving up and ACKing to avoid an infinite reprocessing "
                        "loop (message dropped, not recorded in DLQ): %s",
                        attempts,
                        mid_key,
                        dlq_reason,
                    )
                    _STATS["dlq_write_dropped_total"] += 1
                    self._dlq_write_failures.pop(mid_key, None)
            with contextlib.suppress(Exception):
                await redis.xack(TRACE_FINALIZED_STREAM, _GROUP, message_id)

    async def _process_trace(
        self,
        message_id: Any,
        data: dict[str, str],
        org_id: str,
        trace_id: str,
        *,
        attempt: int = 1,
    ) -> None:
        """Run the full detection pipeline for one finalized trace.

        Downstream writers (stumbles, tags) are idempotent so a retry after
        a partial write is safe. Layer A judge_scores skip already-written
        axes to avoid duplicate partial rows.
        """
        _record_queue_lag(message_id)
        layer_a_report = await self._run_layer_a(
            org_id,
            trace_id,
            agent_id=data.get("agent_id") or None,
            session_id=data.get("session_id") or None,
            user_id=data.get("user_id") or None,
        )
        await self._run_annotator(org_id, trace_id, layer_a_report, attempt=attempt)
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
            logger.debug("trace_finalized: statgate_p0_rail: %s", rail_exc)
        if not _layer_a_primary_hit(layer_a_report):
            # F34: classifiers before F06 investigator.
            skip_inv = await _run_signal_classifiers(org_id, trace_id)
            if not skip_inv:
                await _run_signal_investigator(org_id, trace_id)
        await self._maybe_prod_eval(
            org_id,
            trace_id,
            agent_id=data.get("agent_id") or None,
        )
        # N12 — session timeline rollup, after the detectors so the
        # stumbles this trace produced are counted on its turn.
        await self._run_session_rollup(org_id, trace_id, data)

    async def _run_layer_a(
        self,
        org_id: str,
        trace_id: str,
        *,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
    ) -> Any | None:
        """Run Layer A descriptors, persist scores/tags, promote stumbles."""
        try:
            from eden.evaluation.descriptors import DescriptorEngine
            from eden.evaluation.descriptors.persist import (
                persist_descriptor_tags,
                persist_layer_a_judge_scores,
            )
            from eden.evaluation.descriptors.taxonomy import LAYER_A_PRIMARY
            from eden.insights.rca._common import _fetch_trace_events
            from eden.issues.models import StumbleCreate
            from eden.issues.stumble_writer import StumbleWriter

            events = await _fetch_trace_events(org_id, trace_id)
            if not events:
                return None
            report = DescriptorEngine(online=True).describe(events, trace_id=trace_id)
            # Always persist scores (clean traces still get ~1.0 floats).
            await persist_descriptor_tags(org_id, trace_id, report)
            try:
                await persist_layer_a_judge_scores(org_id, trace_id, report)
            except Exception as score_exc:
                # Transient score failures should bubble for handle-retry so
                # we do not ACK a half-written Layer A score set.
                if _is_transient(score_exc):
                    raise
                logger.debug("layer_a judge_scores: %s", score_exc)
            if report.descriptors:
                logger.info(
                    "layer_a: trace=%s descriptors=%s latency_ms=%.2f",
                    trace_id,
                    sorted(report.descriptor_ids),
                    report.latency_ms,
                )
                _layer_a_stumble_kinds = {
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
                    kind = _layer_a_stumble_kinds.get(desc.descriptor_id)
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
                        if _is_transient(stumble_exc):
                            raise
                        logger.debug(
                            "layer_a stumble write failed: %s", stumble_exc
                        )
            # Attach events for annotator (avoid a second fetch).
            report._events = events  # type: ignore[attr-defined]
            report._primary_hit = bool(  # type: ignore[attr-defined]
                report.descriptor_ids & LAYER_A_PRIMARY
            )
            return report
        except Exception as exc:
            if _is_transient(exc):
                raise
            logger.debug("trace_finalized: layer_a skipped: %s", exc)
            return None

    async def _run_annotator(
        self,
        org_id: str,
        trace_id: str,
        layer_a_report: Any | None,
        *,
        attempt: int = 1,
    ) -> None:
        """T1 semantic tags after Layer A — observability only.

        COST: annotation is best-effort and costs one LLM call. It runs on
        the FIRST attempt only — re-running it on the retry ladder would
        multiply annotator spend by ``_MAX_HANDLE_ATTEMPTS`` every time an
        unrelated downstream step blipped. For the same reason a failure
        here is never re-raised: a transient LLM error must not drive a
        retry of the whole (already-paid-for) pipeline.
        """
        if attempt > 1:
            logger.debug(
                "trace_finalized: annotator skipped on retry attempt=%d trace=%s",
                attempt,
                trace_id,
            )
            return
        try:
            from eden.evaluation.annotator import annotate_and_persist
            from eden.insights.rca._common import _fetch_trace_events

            events = getattr(layer_a_report, "_events", None) if layer_a_report else None
            if not events:
                events = await _fetch_trace_events(org_id, trace_id)
            layer_ids = (
                set(getattr(layer_a_report, "descriptor_ids", ()) or ())
                if layer_a_report
                else set()
            )
            result = await annotate_and_persist(
                org_id,
                trace_id,
                events or [],
                layer_a_ids=layer_ids,
            )
            if result.tags:
                logger.info(
                    "annotator: trace=%s tags=%s model=%s cost=%.6f",
                    trace_id,
                    result.tags,
                    result.model,
                    result.cost_usd,
                )
        except Exception as exc:
            # Deliberately swallowed, including transients — see docstring.
            logger.debug("trace_finalized: annotator skipped: %s", exc)

    async def _run_session_rollup(
        self, org_id: str, trace_id: str, data: dict[str, str]
    ) -> None:
        """N12 — upsert the trace's session summary row.

        Same failure contract as ``_run_layer_a``: transient storage
        errors bubble so the handle-retry ladder re-runs the pipeline
        (the rollup is a recompute-upsert, so a retry after a partial
        write converges rather than double-counts); anything else is
        logged and dropped — a rollup bug must not dead-letter the
        detection pipeline.
        """
        try:
            from eden.sessions.rollup import SessionRollupIndexer

            await SessionRollupIndexer().index_trace(
                org_id,
                trace_id,
                session_id=data.get("session_id") or None,
                agent_id=data.get("agent_id") or None,
                user_id=data.get("user_id") or None,
            )
        except Exception as exc:
            if _is_transient(exc):
                raise
            logger.debug("trace_finalized: session rollup skipped: %s", exc)

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
            # Prod eval is optional; never poison the main scan path.
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
    """Normalize Redis stream field payloads (dict or list-of-pairs)."""
    out: dict[str, str] = {}
    pairs: list[tuple[Any, Any]] = []
    if isinstance(fields, dict):
        pairs = list(fields.items())
    elif isinstance(fields, (list, tuple)):
        for pair in fields:
            if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                pairs.append((pair[0], pair[1]))
    else:
        return out
    for k, v in pairs:
        key = k.decode() if isinstance(k, bytes) else str(k)
        val = v.decode() if isinstance(v, bytes) else str(v)
        out[key] = val
    return out


def _is_transient(exc: BaseException) -> bool:
    """True when the failure is worth an in-process retry."""
    if isinstance(exc, PoisonMessageError):
        return False
    if isinstance(
        exc,
        (ConnectionError, TimeoutError, OSError, asyncio.TimeoutError, BrokenPipeError),
    ):
        return True
    name = type(exc).__name__.lower()
    if any(tok in name for tok in ("timeout", "connection", "unavailable", "busy")):
        return True
    msg = str(exc).lower()
    return any(
        tok in msg
        for tok in (
            "connection",
            "timeout",
            "temporarily",
            "reset by peer",
            "broken pipe",
            "server closed",
            "too many connections",
        )
    )


async def _dead_letter(
    redis: Any,
    message_id: Any,
    fields: Any,
    reason: str,
) -> bool:
    """Park a poison / exhausted message on the DLQ stream.

    Returns ``True`` only once the ``xadd`` is confirmed to have gone
    through, so the caller may safely XACK the original message. Returns
    ``False`` on failure instead of swallowing it — the caller must keep
    the message unacked (so it stays in the PEL for a later XAUTOCLAIM
    retry) rather than ACKing a message that was never actually recorded
    on the DLQ stream.
    """
    mid = message_id.decode() if isinstance(message_id, bytes) else str(message_id)
    payload = _decode(fields)
    try:
        await redis.xadd(
            TRACE_FINALIZED_DLQ_STREAM,
            {
                "source_id": mid,
                "reason": reason[:500],
                "org_id": payload.get("org_id", ""),
                "trace_id": payload.get("trace_id", ""),
                "agent_id": payload.get("agent_id", ""),
                "session_id": payload.get("session_id", ""),
                "user_id": payload.get("user_id", ""),
            },
            maxlen=_DLQ_MAXLEN,
            approximate=True,
        )
    except Exception as exc:
        logger.warning("trace_finalized: dlq write failed for %s: %s", mid, exc)
        return False
    _STATS["dlq_total"] += 1
    return True


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


async def _run_signal_classifiers(org_id: str, trace_id: str) -> bool:
    """F34 — run classifiers before investigator; True = skip F06."""
    try:
        from eden.signals.classifier_worker import (
            run_classifiers_before_investigator,
        )

        result = await run_classifiers_before_investigator(org_id, trace_id)
        if result.get("skip_investigator"):
            logger.info(
                "f34: skip investigator org=%s trace=%s savings=%.4f",
                org_id,
                trace_id,
                float(result.get("savings_usd") or 0),
            )
            return True
    except Exception as exc:
        logger.debug("trace_finalized: classifiers failed: %s", exc)
    return False


async def _run_signal_investigator(org_id: str, trace_id: str) -> None:
    """F06 — per-trace signal investigator (best-effort)."""
    try:
        from eden.config import get_settings

        if not getattr(get_settings(), "per_trace_signals_v1", True):
            return
    except Exception:
        pass
    try:
        from eden.llmops.cost_ledger import CostEvent, record_cost_event
        from eden.signals.investigator import investigate_trace

        await investigate_trace(org_id, trace_id)
        # Meter that the investigator path ran, for the FinOps
        # comparison against classifier savings — but at cost_usd=0.0,
        # because this path spends nothing.
        #
        # It used to book a hardcoded $0.03. There is no model behind it:
        # the per-signal LLM investigator was removed and
        # signals/investigator.py is heuristics only (its `_one_completion`
        # raises). So every investigated trace wrote $0.03 of spend that
        # never happened into the same ledger the per-org budgets read.
        #
        # That is worse than a wrong dashboard now that the budget gates
        # actually function: at 1,000 traces/day this alone fabricates
        # $30/day and would trip the $25/day maintenance cap, blocking
        # real work on the strength of imaginary spend.
        #
        # The estimate is kept in metadata so the "what would the
        # investigator have cost" comparison in classifier_worker still
        # has its number, without it being money.
        await record_cost_event(
            CostEvent(
                org_id=org_id,
                feature="signal_investigator",
                model="f06_statgate",
                cost_usd=0.0,
                trace_id=trace_id,
                metadata={
                    "path": "investigator",
                    "notional_cost_usd": 0.03,
                    "note": "heuristics only; no model call",
                },
            )
        )
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


def get_consumer_stats() -> dict[str, int]:
    """Return a copy of process-local handle / DLQ counters."""
    return dict(_STATS)


def reset_consumer_stats() -> None:
    """Test helper — zero process-local counters."""
    for k in _STATS:
        _STATS[k] = 0
