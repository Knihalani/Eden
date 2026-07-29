"""F03 — Persist debugger checkpoints from LLM telemetry events.

Best-effort hook: never raises into the ingest hot path. Writes
``debugger.checkpoint`` rows via :class:`CheckpointStore` (audit trail)
**and** upserts a content-addressed row into ``debugger_llm_cache`` via
:class:`PrefixCacheService` (Wave-7 F01 prefix-cache reuse).

Feature flag: ``debugger_checkpoint_ingest_v1`` (default ``True``).
When the flag is off, the hook is a no-op.

Metrics emitted (Prometheus, fail-silent when library absent):
  * ``eden_checkpoint_ingest_total``   — counter, labels: status=(ok|skip|error)
  * ``eden_checkpoint_ingest_errors``  — counter (subset of above, status=error)
  * ``eden_checkpoint_ingest_duration_seconds`` — histogram of wall-clock time
"""

from __future__ import annotations

import logging
import time
from typing import Any

from eden.observability.simple_metrics import Counter, Summary
from eden.observability.bounded_expiry_cache import (
    BoundedExpiryCache,
    resolve_max_entries,
)

logger = logging.getLogger(__name__)

try:
    from eden.config import get_settings  # noqa: F401 — module-level for test patching
except Exception:  # noqa: BLE001
    get_settings = None  # type: ignore[assignment]

_LLM_EVENT_TYPES = frozenset({
    "llm.completion",
    "llm_completion",
    "llm_completion_stream",
    "openai.chat_completion",
    "anthropic.message",
    "bedrock.invoke_model",
    "gemini.generate_content",
    "otel.llm_completion",
    "helicone.request",
    "langfuse.observation",
})


# ── Metrics ───────────────────────────────────────────────────────
#
# These used to be ``prometheus_client`` objects behind a no-op shim. Both
# paths were dark: the library is not a declared dependency, so the shim was
# usually what ran, and where the library *was* present the counters landed in
# its default registry, which Eden's hand-rolled ``/metrics`` never reads.
# ``simple_metrics`` records unconditionally and is exposed by the endpoint.


class _Metrics:
    """Checkpoint-ingest metrics.

    Defined as class attributes so the families are constructed exactly once,
    at import. Re-constructing them would register duplicates and put two
    ``# HELP`` lines for one family into the exposition, which is precisely
    the corruption this wave exists to remove.
    """

    total = Counter(
        "eden_checkpoint_ingest_total",
        "Total checkpoint ingest attempts",
        labelnames=("status",),
    )
    errors = Counter(
        "eden_checkpoint_ingest_errors",
        "Total checkpoint ingest errors",
    )
    duration = Summary(
        "eden_checkpoint_ingest_duration_seconds",
        "Wall-clock time for checkpoint ingest (hook only)",
    )

    @classmethod
    def get(cls) -> type[_Metrics]:
        return cls


# ── Helpers ───────────────────────────────────────────────────────


def is_llm_event(event_type: str | None) -> bool:
    if not event_type:
        return False
    et = event_type.lower()
    if et in _LLM_EVENT_TYPES:
        return True
    if "llm" in et and ("completion" in et or "chat" in et or "message" in et):
        return True
    return False


def extract_llm_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize common LLM payload shapes into checkpoint fields."""
    p = payload or {}
    messages = (
        p.get("input_messages")
        or p.get("messages")
        or (p.get("request") or {}).get("messages")
        or []
    )
    if not isinstance(messages, list):
        messages = []
    tool_calls = p.get("tool_calls") or []
    if not isinstance(tool_calls, list):
        tool_calls = []
    tool_results = p.get("tool_results") or []
    if not isinstance(tool_results, list):
        tool_results = []
    response = p.get("response") or p.get("output") or {}
    if not isinstance(response, dict):
        response = {"content": response}
    step = p.get("step_number")
    try:
        step_number = int(step) if step is not None else None
    except (TypeError, ValueError):
        step_number = None
    return {
        "input_messages": messages,
        "tool_calls": tool_calls,
        "tool_results": tool_results,
        "response": response,
        "step_number": step_number,
        "started_at": str(p.get("started_at") or ""),
        "ended_at": str(p.get("ended_at") or ""),
        "duration_ms": float(p.get("duration_ms") or 0.0),
        "model": str(p.get("model") or p.get("model_id") or ""),
    }


# Sparse EXPIRE on step counters — INCR every miss, EXPIRE ~once/hour.
#
# Bounded: the gateway assigns a fresh trace_id per request, so this key
# space is unbounded and an unevicted dict here leaked one entry per
# request for the lifetime of the process. See
# eden.observability.bounded_expiry_cache.
_STEP_EXPIRE_TTL_S = 86400
_STEP_EXPIRE_REFRESH_S = 3600.0
_step_expire_at = BoundedExpiryCache(resolve_max_entries())


async def _resolve_step_number(
    trace_id: str,
    payload_step: int | None,
    sequence: Any,
    redis: Any,
) -> int:
    """Return the step number for this event.

    Priority:
    1. SDK-provided ``step_number`` from the payload.
    2. Redis INCR ``trace:{trace_id}:llm_step`` (TTL 24h) for
       auto-incrementing ordinals when the SDK omits the step.
    3. Fallback to ``sequence`` attribute or 0.

    EXPIRE is refreshed sparsely (not every INCR) to cut Upstash cmds
    on high-volume LLM traces that omit ``step_number``.
    """
    if payload_step is not None:
        return payload_step

    if redis is not None:
        try:
            key = f"trace:{trace_id}:llm_step"
            now = time.monotonic()
            need_expire = _step_expire_at.is_due(key, now)
            if need_expire:
                pipe = redis.pipeline(transaction=False)
                pipe.incr(key)
                pipe.expire(key, _STEP_EXPIRE_TTL_S)
                step, _ = await pipe.execute()
                _step_expire_at.set(
                    key, now + _STEP_EXPIRE_REFRESH_S, now=now
                )
            else:
                step = await redis.incr(key)
            return int(step) - 1  # zero-based to match SDK convention
        except Exception as exc:  # noqa: BLE001
            logger.debug("checkpoint_hook: redis INCR failed: %s", exc)

    try:
        return int(sequence) if sequence is not None else 0
    except (TypeError, ValueError):
        return 0


async def maybe_persist_checkpoint(
    event: Any,
    *,
    pg: Any | None = None,
    redis: Any | None = None,
) -> bool:
    """If ``event`` is an LLM completion, persist a debugger checkpoint.

    Writes two records (both fail-open, never raise):
      1. ``CheckpointStore.save`` → ``telemetry_events`` audit row.
      2. ``PrefixCacheService.upsert`` → ``debugger_llm_cache`` cache row.

    Returns True when at least the CheckpointStore write succeeded.
    """
    metrics = _Metrics.get()
    t0 = time.monotonic()
    try:
        # ── Feature flag ──────────────────────────────────────────
        try:
            _gs = get_settings  # use module-level ref so tests can patch it
            if _gs is not None and not _gs().debugger_checkpoint_ingest_v1:
                metrics.total.labels(status="skip").inc()
                return False
        except Exception:
            pass  # proceed if config is unavailable (test environments)

        event_type = getattr(event, "event_type", None) or ""
        if not is_llm_event(str(event_type)):
            metrics.total.labels(status="skip").inc()
            return False
        trace_id = getattr(event, "trace_id", None) or ""
        if not trace_id:
            metrics.total.labels(status="skip").inc()
            return False
        tenant_id = getattr(event, "tenant_id", None) or "default"
        payload = getattr(event, "payload", None) or {}
        if not isinstance(payload, dict):
            payload = {}
        fields = extract_llm_payload(payload)

        # ── Step number resolution ────────────────────────────────
        redis_client = redis
        if redis_client is None:
            try:
                from eden.storage.redis import get_redis_client
                redis_client = await get_redis_client()
            except Exception:
                pass

        step_number = await _resolve_step_number(
            trace_id=str(trace_id),
            payload_step=fields["step_number"],
            sequence=getattr(event, "sequence", None),
            redis=redis_client,
        )

        if pg is None:
            from eden.storage.postgres import get_postgres_client
            pg = await get_postgres_client()

        # ── 1. Audit: CheckpointStore ─────────────────────────────
        import uuid

        from eden.debugger.checkpoints import Checkpoint, CheckpointStore

        store = CheckpointStore(pg)
        cp = Checkpoint(
            id=str(uuid.uuid4()),
            trace_id=str(trace_id),
            step_number=int(step_number),
            input_messages=list(fields["input_messages"]),
            tool_calls=list(fields["tool_calls"]),
            tool_results=list(fields["tool_results"]),
            response=dict(fields["response"]),
            started_at=fields["started_at"],
            ended_at=fields["ended_at"],
            duration_ms=float(fields["duration_ms"]),
            source="live",
        )
        await store.save(cp, org_id=str(tenant_id))

        # ── 2. Prefix cache: PrefixCacheService ───────────────────
        try:
            from eden.debugger.cache import PrefixCacheService, llm_input_hash

            ih = llm_input_hash(list(fields["input_messages"]))
            cache_svc = PrefixCacheService(pg)
            await cache_svc.upsert(
                org_id=str(tenant_id),
                trace_id=str(trace_id),
                step_number=int(step_number),
                input_hash=ih,
                response=dict(fields["response"]),
                model=fields["model"] or None,
            )
        except Exception as cache_exc:  # noqa: BLE001
            logger.debug("checkpoint_hook: cache upsert skipped: %s", cache_exc)

        metrics.total.labels(status="ok").inc()
        return True

    except Exception as exc:  # noqa: BLE001 — never break ingest
        logger.debug("checkpoint_hook: skip persist: %s", exc)
        metrics.total.labels(status="error").inc()
        metrics.errors.inc()
        return False
    finally:
        metrics.duration.observe(time.monotonic() - t0)
