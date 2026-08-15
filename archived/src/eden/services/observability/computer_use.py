"""Computer Use service — D.12.3 (§8.3).

Read + write surface over the ``computer_use_steps`` table +
the ``computer_use_screenshots_tombstoned`` tombstone table.

Public surface:

* :class:`ComputerUseService` — service class
* :func:`get_computer_use_service` — singleton getter (mirrors
  the rest of the cat surface)

Ponytail: best-effort — DB errors fall through to ``[]`` /
``None`` so the route layer never 500s.

The screenshot tombstone is the RTBF cross-store path: when
a customer asks for data deletion, the screenshot URIs go
into ``computer_use_screenshots_tombstoned`` so the S3 worker
can purge the actual objects.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


async def _get_client():
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("cu: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("cu: get_postgres_client failed: %s", exc)
        return None


def _row(r: Any) -> dict[str, Any]:
    d = dict(r)
    for k, v in list(d.items()):
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


# 6 action types per spec §B.6
ACTION_TYPES: tuple[str, ...] = (
    "click", "type", "scroll", "drag", "key", "wait",
)


class ComputerUseService:
    """Service for the Computer Use surface."""

    async def record_step(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str,
        step_index: int,
        action_type: str,
        action_payload: dict[str, Any] | None = None,
        screenshot_before: str | None = None,
        screenshot_after: str | None = None,
        target_app: str | None = None,
        target_coords: dict[str, Any] | None = None,
        success: bool | None = None,
        error: str | None = None,
        duration_ms: int | None = None,
        blocked: bool = False,
    ) -> str | None:
        """Persist a single Computer Use step. Idempotent on
        (span_id, step_index) — re-recording the same step
        upserts (so a retry that started failed but eventually
        succeeded can update the row).
        """
        if action_type not in ACTION_TYPES:
            raise ValueError(
                f"unknown action_type: {action_type!r} "
                f"(expected one of {ACTION_TYPES})"
            )
        client = await _get_client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                """
                INSERT INTO computer_use_steps (
                    id, org_id, trace_id, span_id, step_index,
                    action_type, action_payload,
                    screenshot_before, screenshot_after,
                    target_app, target_coords,
                    success, error, duration_ms, blocked
                ) VALUES (
                    gen_random_uuid(), $1, $2::uuid, $3::uuid, $4,
                    $5, $6::jsonb,
                    $7, $8,
                    $9, $10::jsonb,
                    $11, $12, $13, $14
                )
                ON CONFLICT (span_id, step_index) DO UPDATE SET
                    action_payload     = EXCLUDED.action_payload,
                    screenshot_before  = COALESCE(EXCLUDED.screenshot_before, computer_use_steps.screenshot_before),
                    screenshot_after   = COALESCE(EXCLUDED.screenshot_after, computer_use_steps.screenshot_after),
                    target_app         = COALESCE(EXCLUDED.target_app, computer_use_steps.target_app),
                    target_coords      = COALESCE(EXCLUDED.target_coords, computer_use_steps.target_coords),
                    success            = COALESCE(EXCLUDED.success, computer_use_steps.success),
                    error              = COALESCE(EXCLUDED.error, computer_use_steps.error),
                    duration_ms        = COALESCE(EXCLUDED.duration_ms, computer_use_steps.duration_ms),
                    blocked            = EXCLUDED.blocked OR computer_use_steps.blocked
                RETURNING id
                """,
                org_id,
                trace_id,
                span_id,
                int(step_index),
                action_type,
                json.dumps(action_payload or {}),
                screenshot_before,
                screenshot_after,
                target_app,
                json.dumps(target_coords) if target_coords is not None else None,
                success,
                error,
                duration_ms,
                blocked,
            )
            # If the step is blocked, fire the §E.1 row 23 hook.
            if blocked:
                try:
                    from eden.llmops.promotion_hooks import PromotionHook
                    hook = PromotionHook()
                    await hook.on_computer_use_blocked(
                        org_id,
                        trace_id=trace_id,
                        span_id=span_id,
                        step_index=step_index,
                        action_type=action_type,
                        error=error,
                    )
                except Exception as exc:
                    logger.debug("cu.record_step: hook fire failed: %s", exc)
            return str(row["id"]) if row else None
        except Exception as exc:
            logger.debug("cu.record_step failed: %s", exc)
            return None

    async def get_steps_for_trace(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return every Computer Use step for a trace, in
        ``step_index`` order.
        """
        client = await _get_client()
        if client is None:
            return []
        try:
            if org_id:
                rows = await client.fetch(
                    """
                    SELECT id, org_id, trace_id, span_id, step_index,
                           action_type, action_payload,
                           screenshot_before, screenshot_after,
                           target_app, target_coords,
                           success, error, duration_ms, blocked, created_at
                      FROM computer_use_steps
                     WHERE trace_id = $1::uuid
                       AND org_id    = $2
                     ORDER BY span_id, step_index
                    """,
                    trace_id, org_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT id, org_id, trace_id, span_id, step_index,
                           action_type, action_payload,
                           screenshot_before, screenshot_after,
                           target_app, target_coords,
                           success, error, duration_ms, blocked, created_at
                      FROM computer_use_steps
                     WHERE trace_id = $1::uuid
                     ORDER BY span_id, step_index
                    """,
                    trace_id,
                )
        except Exception as exc:
            logger.debug("cu.get_steps_for_trace failed: %s", exc)
            return []
        return [_row(r) for r in rows]

    async def mark_screenshot_tombstoned(
        self,
        org_id: str,
        *,
        s3_uri: str,
        trace_id: str,
        tombstoned_by: str | None = None,
        reason: str | None = None,
    ) -> bool:
        """Mark a screenshot URI for RTBF purge. Idempotent on
        ``s3_uri`` PK.
        """
        client = await _get_client()
        if client is None:
            return False
        try:
            await client.execute(
                """
                INSERT INTO computer_use_screenshots_tombstoned (
                    s3_uri, org_id, trace_id, tombstoned_by, reason
                ) VALUES ($1, $2, $3::uuid, $4, $5)
                ON CONFLICT (s3_uri) DO NOTHING
                """,
                s3_uri, org_id, trace_id, tombstoned_by, reason,
            )
            return True
        except Exception as exc:
            logger.debug("cu.mark_screenshot_tombstoned failed: %s", exc)
            return False

    async def list_tombstoned_for_trace(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """List every tombstoned screenshot for a trace."""
        client = await _get_client()
        if client is None:
            return []
        try:
            if org_id:
                rows = await client.fetch(
                    """
                    SELECT s3_uri, org_id, trace_id, tombstoned_at,
                           tombstoned_by, reason
                      FROM computer_use_screenshots_tombstoned
                     WHERE trace_id = $1::uuid
                       AND org_id = $2
                     ORDER BY tombstoned_at DESC
                    """,
                    trace_id,
                    org_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT s3_uri, org_id, trace_id, tombstoned_at,
                           tombstoned_by, reason
                      FROM computer_use_screenshots_tombstoned
                     WHERE trace_id = $1::uuid
                     ORDER BY tombstoned_at DESC
                    """,
                    trace_id,
                )
        except Exception as exc:
            logger.debug("cu.list_tombstoned_for_trace failed: %s", exc)
            return []
        return [_row(r) for r in rows]


_singleton: ComputerUseService | None = None


def get_computer_use_service() -> ComputerUseService:
    """Return the process-wide :class:`ComputerUseService`."""
    global _singleton
    if _singleton is None:
        _singleton = ComputerUseService()
    return _singleton


__all__ = [
    "ACTION_TYPES",
    "ComputerUseService",
    "get_computer_use_service",
]
