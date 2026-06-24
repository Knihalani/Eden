"""Provider routing service — D.12.6 (§2.12).

Read + write surface over the ``provider_routing_attempts``
table.

Public surface:

* :class:`ProviderRoutingService` — service class
* :func:`get_provider_routing_service` — singleton getter

The service exposes the 4-decision state machine
(success / fallback / retry / abort — per spec §B.8) and
the repeated-failure detector (per spec §E.1 row 26).

The SDK wires the 4 decisions to the customer's existing
provider-routing middleware (LiteLLM / Portkey /
OpenRouter). The service is best-effort — DB errors fall
through to ``[]`` / ``None`` so the route layer never 500s.

Ponytail:
* No circuit-breaker state machine in the service. The
  spec's §E.1 row 26 is "repeated failures" (a count
  threshold), not a state machine. The detector uses a
  simple rolling-window count; circuit-breaker logic
  belongs in the customer's routing middleware (where
  per-tenant in-process state is available) rather than
  in the Eden DB.
* Cap of 10 attempts per trace per spec R-13: enforced
  by the route layer (``max_sequence_index=10``); the
  service itself accepts any sequence_index because
  some customer middlewares (e.g. OpenRouter) can
  fan out wider.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


# 4 spec'd decisions per §B.8.
DECISIONS: tuple[str, ...] = (
    "success", "fallback", "retry", "abort",
)

# Repeated-failure detector defaults per spec §E.1 row 26.
# We track the rolling ``window_minutes`` count of
# non-success decisions (``fallback``/``abort``/``retry``)
# for the org + provider. When the count crosses
# ``REPEATED_FAILURE_THRESHOLD`` the hook fires.
DEFAULT_REPEATED_FAILURE_WINDOW_MINUTES: int = 15
DEFAULT_REPEATED_FAILURE_THRESHOLD: int = 10

# Per-trace attempt cap per R-13.
MAX_SEQUENCE_INDEX: int = 10


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("provider_routing: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("provider_routing: get_postgres_client failed: %s", exc)
        return None


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


class ProviderRoutingService:
    """Service for the provider-routing surface."""

    async def record_attempt(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str,
        attempted_provider: str,
        attempted_model: str,
        sequence_index: int,
        decision: str,
        failure_reason: str | None = None,
        latency_ms: int | None = None,
    ) -> str | None:
        """Persist one routing attempt. Idempotent on
        ``(trace_id, sequence_index)`` — a middleware retry
        of the same attempt upserts in place (R-13).
        """
        if decision not in DECISIONS:
            raise ValueError(
                f"unknown decision: {decision!r} "
                f"(expected one of {DECISIONS})"
            )
        if int(sequence_index) < 0:
            raise ValueError(
                f"sequence_index must be >= 0, got {sequence_index}"
            )
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                INSERT INTO provider_routing_attempts (
                    id, org_id, trace_id, span_id,
                    attempted_provider, attempted_model,
                    failure_reason, latency_ms,
                    decision, sequence_index
                ) VALUES (
                    gen_random_uuid(), $1, $2::uuid, $3::uuid,
                    $4, $5,
                    $6, $7,
                    $8, $9
                )
                ON CONFLICT (trace_id, sequence_index) DO UPDATE SET
                    attempted_provider = EXCLUDED.attempted_provider,
                    attempted_model    = EXCLUDED.attempted_model,
                    failure_reason     = EXCLUDED.failure_reason,
                    latency_ms         = EXCLUDED.latency_ms,
                    decision           = EXCLUDED.decision
                RETURNING id
                """,
                org_id,
                trace_id,
                span_id,
                attempted_provider,
                attempted_model,
                failure_reason,
                latency_ms,
                decision,
                int(sequence_index),
            )
            return str(row["id"]) if row else None
        except Exception as exc:
            logger.debug("provider_routing.record_attempt failed: %s", exc)
            return None

    async def get_attempts_for_trace(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return every routing attempt for a trace, in
        ``sequence_index`` order.
        """
        client = await _get_client()
        if client is None:
            return []
        try:
            if org_id:
                rows = await client.fetch(
                    """
                    SELECT id, org_id, trace_id, span_id,
                           attempted_provider, attempted_model,
                           failure_reason, latency_ms,
                           decision, sequence_index, created_at
                      FROM provider_routing_attempts
                     WHERE trace_id = $1::uuid
                       AND org_id    = $2
                     ORDER BY sequence_index ASC
                    """,
                    trace_id, org_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT id, org_id, trace_id, span_id,
                           attempted_provider, attempted_model,
                           failure_reason, latency_ms,
                           decision, sequence_index, created_at
                      FROM provider_routing_attempts
                     WHERE trace_id = $1::uuid
                     ORDER BY sequence_index ASC
                    """,
                    trace_id,
                )
        except Exception as exc:
            logger.debug("provider_routing.get_attempts_for_trace failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def list_attempts(
        self,
        org_id: str,
        *,
        attempted_provider: str | None = None,
        decision: str | None = None,
        since_minutes: int | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """List attempts for an org with optional filters.
        ``since_minutes`` filters by ``created_at >= now() - N minutes``
        (the repeated-failure detector's typical query).
        """
        if decision is not None and decision not in DECISIONS:
            raise ValueError(
                f"unknown decision: {decision!r} (expected one of {DECISIONS})"
            )
        client = await _get_client()
        if client is None:
            return []
        where = ["org_id = $1"]
        params: list[Any] = [org_id]
        if attempted_provider is not None:
            where.append(f"attempted_provider = ${len(params) + 1}")
            params.append(attempted_provider)
        if decision is not None:
            where.append(f"decision = ${len(params) + 1}")
            params.append(decision)
        if since_minutes is not None:
            where.append(
                f"created_at >= NOW() - (${len(params) + 1} || ' minutes')::interval"
            )
            params.append(int(since_minutes))
        params.append(int(limit))
        sql = (
            "SELECT id, org_id, trace_id, span_id, "
            "attempted_provider, attempted_model, failure_reason, "
            "latency_ms, decision, sequence_index, created_at "
            "FROM provider_routing_attempts "
            f"WHERE {' AND '.join(where)} "
            f"ORDER BY created_at DESC LIMIT ${len(params)}"
        )
        try:
            rows = await client.fetch(sql, *params)
        except Exception as exc:
            logger.debug("provider_routing.list_attempts failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def get_failure_rate(
        self,
        org_id: str,
        *,
        attempted_provider: str,
        window_minutes: int = DEFAULT_REPEATED_FAILURE_WINDOW_MINUTES,
    ) -> dict[str, Any]:
        """Return the per-provider failure rate for the org
        in the rolling ``window_minutes`` window. Shape::

            {
                "org_id": ...,
                "attempted_provider": ...,
                "window_minutes": ...,
                "total_attempts": ...,
                "non_success_count": ...,    # fallback+abort+retry
                "success_count": ...,
                "failure_rate": ...,         # non_success / total (0.0-1.0)
            }
        """
        client = await _get_client()
        if client is None:
            return {
                "org_id": org_id,
                "attempted_provider": attempted_provider,
                "window_minutes": int(window_minutes),
                "total_attempts": 0,
                "non_success_count": 0,
                "success_count": 0,
                "failure_rate": 0.0,
            }
        try:
            row = await client.fetchrow(
                """
                SELECT
                    COUNT(*)                                       AS total_attempts,
                    COUNT(*) FILTER (WHERE decision = 'success')   AS success_count,
                    COUNT(*) FILTER (WHERE decision <> 'success')  AS non_success_count
                  FROM provider_routing_attempts
                 WHERE org_id = $1
                   AND attempted_provider = $2
                   AND created_at >= NOW() - ($3 || ' minutes')::interval
                """,
                org_id, attempted_provider, int(window_minutes),
            )
        except Exception as exc:
            logger.debug("provider_routing.get_failure_rate failed: %s", exc)
            return {
                "org_id": org_id,
                "attempted_provider": attempted_provider,
                "window_minutes": int(window_minutes),
                "total_attempts": 0,
                "non_success_count": 0,
                "success_count": 0,
                "failure_rate": 0.0,
            }
        total = int(row["total_attempts"] or 0)
        non_success = int(row["non_success_count"] or 0)
        success = int(row["success_count"] or 0)
        rate = (non_success / total) if total > 0 else 0.0
        return {
            "org_id": org_id,
            "attempted_provider": attempted_provider,
            "window_minutes": int(window_minutes),
            "total_attempts": total,
            "non_success_count": non_success,
            "success_count": success,
            "failure_rate": rate,
        }

    async def detect_repeated_failures(
        self,
        org_id: str,
        *,
        attempted_provider: str,
        window_minutes: int = DEFAULT_REPEATED_FAILURE_WINDOW_MINUTES,
        threshold: int = DEFAULT_REPEATED_FAILURE_THRESHOLD,
        fire_hook: bool = True,
    ) -> dict[str, Any] | None:
        """Look at the rolling ``window_minutes`` count of
        non-success decisions for ``(org_id, attempted_provider)``.
        When the count is ``>= threshold``, return a summary
        (and fire the ``on_provider_routing_repeated_failures``
        hook when ``fire_hook`` is True).

        Returns ``None`` when the count is below threshold
        or the DB is unavailable. The summary shape is::

            {
                "org_id": ...,
                "attempted_provider": ...,
                "window_minutes": ...,
                "threshold": ...,
                "non_success_count": ...,
                "total_attempts": ...,
                "failure_rate": ...,
                "spike": True,
                "trace_ids": [...],   # the most recent 10 contributing traces
            }
        """
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                SELECT
                    COUNT(*)                                       AS total_attempts,
                    COUNT(*) FILTER (WHERE decision <> 'success')  AS non_success_count
                  FROM provider_routing_attempts
                 WHERE org_id = $1
                   AND attempted_provider = $2
                   AND created_at >= NOW() - ($3 || ' minutes')::interval
                """,
                org_id, attempted_provider, int(window_minutes),
            )
            if int(row["non_success_count"] or 0) < threshold:
                return None
            # Collect the most recent 10 contributing trace_ids
            # for the operator's drill-in path.
            recent = await client.fetch(
                """
                SELECT DISTINCT trace_id
                  FROM provider_routing_attempts
                 WHERE org_id = $1
                   AND attempted_provider = $2
                   AND decision <> 'success'
                   AND created_at >= NOW() - ($3 || ' minutes')::interval
                 ORDER BY trace_id DESC
                 LIMIT 10
                """,
                org_id, attempted_provider, int(window_minutes),
            )
        except Exception as exc:
            logger.debug(
                "provider_routing.detect_repeated_failures failed: %s", exc,
            )
            return None
        non_success = int(row["non_success_count"] or 0)
        total = int(row["total_attempts"] or 0)
        rate = (non_success / total) if total > 0 else 0.0
        summary = {
            "org_id": org_id,
            "attempted_provider": attempted_provider,
            "window_minutes": int(window_minutes),
            "threshold": int(threshold),
            "non_success_count": non_success,
            "total_attempts": total,
            "failure_rate": rate,
            "spike": True,
            "trace_ids": [str(r["trace_id"]) for r in recent],
        }
        if fire_hook:
            try:
                from eden.llmops.promotion_hooks import PromotionHook
                hook = PromotionHook()
                await hook.on_provider_routing_repeated_failures(
                    org_id,
                    attempted_provider=attempted_provider,
                    window_minutes=int(window_minutes),
                    threshold=int(threshold),
                    non_success_count=non_success,
                    failure_rate=rate,
                )
            except Exception as exc:
                logger.debug(
                    "provider_routing.detect_repeated_failures: hook fire failed: %s",
                    exc,
                )
        return summary


_singleton: ProviderRoutingService | None = None


def get_provider_routing_service() -> ProviderRoutingService:
    """Return the process-wide :class:`ProviderRoutingService`."""
    global _singleton
    if _singleton is None:
        _singleton = ProviderRoutingService()
    return _singleton


__all__ = [
    "DECISIONS",
    "DEFAULT_REPEATED_FAILURE_THRESHOLD",
    "DEFAULT_REPEATED_FAILURE_WINDOW_MINUTES",
    "MAX_SEQUENCE_INDEX",
    "ProviderRoutingService",
    "get_provider_routing_service",
]
