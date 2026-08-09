"""RTBF request lifecycle tracking (Phase K — RagaAI parity).

The existing :class:`eden.services.governance_intel.gdpr.RightToBeForgottenService`
performs the in-place redaction. What's missing is a
lifecycle row that proves GDPR Art. 17 was honoured:

  * when the request came in
  * who triggered it
  * how long the redaction took
  * how many rows were affected
  * did it fail, and why

This module is a thin wrapper that calls
``RightToBeForgottenService.process_request()`` and writes a
single row to ``rtbf_requests`` (migration 033) per call.
The wrapper is the entry point for the API layer; the
underlying service is unchanged.

Status flow
───────────
  pending  ─► in_progress  ─► completed
                            └► failed

The wrapper sets ``pending`` before the redaction starts,
flips to ``in_progress`` when the first table UPDATE fires,
flips to ``completed`` on success (or ``failed`` on error).

Failure handling
────────────────
If the redaction raises, the wrapper:

  1. Sets the row to ``failed`` with the exception text.
  2. Re-raises the exception so the API layer returns a
     proper 5xx.

The redaction is *not* rolled back (Postgres UPDATEs are
committed as they happen). The lifecycle row is the audit
trail that says "started at X, partially complete, errored
at Y, here is the exception".

Concurrency
───────────
Each call to ``track()`` writes a single lifecycle row with
a fresh UUID. Concurrent calls for the same target user are
not deduplicated — the GDPR right is per-request, and the
audit log is more useful with one row per request than with
N updates to a single row.

This module is a *sibling* to ``gdpr.py``; it does not
modify the existing service. The new lifecycle table is
the source of truth for the operator dashboard + compliance
evidence packs; the existing ``org_audit_log`` row remains
as a backup.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from eden.services.governance_intel.gdpr import (
    RightToBeForgottenService,
)

logger = logging.getLogger(__name__)


# Status enum — keep in sync with the migration CHECK constraint.
RTBF_STATUS_PENDING = "pending"
RTBF_STATUS_IN_PROGRESS = "in_progress"
RTBF_STATUS_COMPLETED = "completed"
RTBF_STATUS_FAILED = "failed"

ALL_RTBF_STATUSES = frozenset({
    RTBF_STATUS_PENDING,
    RTBF_STATUS_IN_PROGRESS,
    RTBF_STATUS_COMPLETED,
    RTBF_STATUS_FAILED,
})


class RtbfRequestTracker:
    """Write a lifecycle row to ``rtbf_requests`` per RTBF call.

    Args:
        pg: The shared :class:`PostgresClient`. If None, the
            tracker is a no-op (the redaction still happens;
            we just don't log to ``rtbf_requests``). This
            keeps the service usable in tests + early-boot
            scenarios where the DB is unreachable.
        rtbf: The underlying redaction service. Defaults to a
            new :class:`RightToBeForgottenService` instance.
    """

    def __init__(self, pg: Any, rtbf: RightToBeForgottenService | None = None) -> None:
        self._pg = pg
        self._rtbf = rtbf or RightToBeForgottenService()

    # ── Public API ────────────────────────────────────────────

    async def track(
        self,
        org_id: str,
        *,
        target_user_id: str,
        requester_user_id: str,
        reason: str | None = None,
        sla_days: int = 14,
        dry_run: bool = False,
    ) -> dict[str, Any]:
        """Run the RTBF redaction AND write a lifecycle row.

        Returns the underlying service result with the
        lifecycle row id added under ``rtbf_request_id``.
        """
        request_id = _new_uuid()

        # 1. Insert the lifecycle row in 'pending' state. We
        #    insert BEFORE running the redaction so that a
        #    crash mid-run still leaves an audit trail.
        if self._pg is not None and not dry_run:
            try:
                await self._pg.execute(
                    """
                    INSERT INTO rtbf_requests (
                        id, org_id, requester_user_id, target_user_id,
                        reason, status, started_at
                    ) VALUES ($1, $2, $3, $4, $5, $6, NULL)
                    """,
                    request_id, org_id, requester_user_id, target_user_id,
                    reason, RTBF_STATUS_PENDING,
                )
            except Exception as exc:
                # We never want a logging failure to block
                # the actual redaction. Log + continue.
                logger.warning(
                    "rtbf_tracker: failed to insert pending row for "
                    "org=%s target=%s: %s",
                    org_id, target_user_id, exc,
                )

        # 2. Run the redaction.
        result: dict[str, Any] = {}
        try:
            result = await self._rtbf.process_request(
                org_id,
                user_id=target_user_id,
                requested_by=requester_user_id,
                sla_days=sla_days,
                dry_run=dry_run,
            )
        except Exception as exc:
            # 3a. Failure path: mark the lifecycle row 'failed'
            #     and re-raise.
            if self._pg is not None and not dry_run:
                try:
                    await self._pg.execute(
                        """
                        UPDATE rtbf_requests
                        SET status = $2,
                            error = $3,
                            started_at = COALESCE(started_at, NOW()),
                            completed_at = NOW()
                        WHERE id = $1
                        """,
                        request_id, RTBF_STATUS_FAILED, str(exc),
                    )
                except Exception as log_exc:
                    logger.warning(
                        "rtbf_tracker: failed to mark request %s as "
                        "failed: %s", request_id, log_exc,
                    )
            raise

        # 3b. Success path: mark lifecycle row from the service envelope.
        envelope_status = result.get("status") if isinstance(result, dict) else None
        payload = (
            result.get("data", {})
            if isinstance(result, dict) and isinstance(result.get("data"), dict)
            else result if isinstance(result, dict) else {}
        )
        is_complete = (
            envelope_status == "ok"
            and bool(payload.get("complete"))
        )
        affected_rows = int(
            payload.get("total_rows_anonymised", 0)
            or payload.get("total_rows_matched", 0)
            or 0,
        )
        if self._pg is not None and not dry_run:
            try:
                await self._pg.execute(
                    """
                    UPDATE rtbf_requests
                    SET status = $2,
                        started_at = COALESCE(started_at, NOW()),
                        completed_at = NOW(),
                        affected_rows = $3,
                        error = $4
                    WHERE id = $1
                    """,
                    request_id,
                    RTBF_STATUS_COMPLETED if is_complete else RTBF_STATUS_FAILED,
                    affected_rows,
                    None if is_complete else str(payload.get("message") or envelope_status),
                )
            except Exception as exc:
                logger.warning(
                    "rtbf_tracker: failed to mark request %s as "
                    "completed: %s", request_id, exc,
                )

        # 4. Augment the result with our id.
        if isinstance(result, dict):
            result["rtbf_request_id"] = str(request_id)
            result["rtbf_status"] = (
                RTBF_STATUS_COMPLETED
                if is_complete and not dry_run
                else RTBF_STATUS_PENDING
                if dry_run
                else RTBF_STATUS_FAILED
            )
        return result

    # ── Read helpers (for the operator dashboard) ────────────

    async def list_for_org(
        self,
        org_id: str,
        *,
        limit: int = 50,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        """List recent RTBF requests for an org, optionally
        filtered by status. Returns dicts in insertion order
        (most recent first)."""
        if self._pg is None:
            return []
        if status is not None and status not in ALL_RTBF_STATUSES:
            raise ValueError(f"unknown status: {status!r}")
        if status is not None:
            rows = await self._pg.fetch(
                """
                SELECT id, org_id, requester_user_id, target_user_id,
                       reason, status, affected_rows, error,
                       started_at, completed_at, created_at, updated_at
                FROM rtbf_requests
                WHERE org_id = $1 AND status = $2
                ORDER BY created_at DESC
                LIMIT $3
                """,
                org_id, status, limit,
            )
        else:
            rows = await self._pg.fetch(
                """
                SELECT id, org_id, requester_user_id, target_user_id,
                       reason, status, affected_rows, error,
                       started_at, completed_at, created_at, updated_at
                FROM rtbf_requests
                WHERE org_id = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                org_id, limit,
            )
        return [_row_to_dict(r) for r in rows]

    async def list_in_flight(self, org_id: str, *, limit: int = 20) -> list[dict[str, Any]]:
        """List pending + in_progress requests (operator dashboard)."""
        if self._pg is None:
            return []
        rows = await self._pg.fetch(
            """
            SELECT id, org_id, requester_user_id, target_user_id,
                   reason, status, affected_rows, error,
                   started_at, completed_at, created_at, updated_at
            FROM rtbf_requests
            WHERE org_id = $1
              AND status IN ('pending', 'in_progress')
            ORDER BY created_at DESC
            LIMIT $2
            """,
            org_id, limit,
        )
        return [_row_to_dict(r) for r in rows]

    async def get_by_id(self, request_id: str) -> dict[str, Any] | None:
        if self._pg is None:
            return None
        row = await self._pg.fetchrow(
            """
            SELECT id, org_id, requester_user_id, target_user_id,
                   reason, status, affected_rows, error,
                   started_at, completed_at, created_at, updated_at
            FROM rtbf_requests
            WHERE id = $1
            """,
            request_id,
        )
        if row is None:
            return None
        return _row_to_dict(row)


# ── Helpers ───────────────────────────────────────────────────────


def _new_uuid() -> str:
    import uuid
    return str(uuid.uuid4())


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Coerce a DB row to a JSON-serialisable dict."""
    def _iso(v: Any) -> str | None:
        if v is None:
            return None
        if isinstance(v, datetime):
            if v.tzinfo is None:
                v = v.replace(tzinfo=UTC)
            return v.isoformat()
        return str(v)
    return {
        "id": str(row["id"]),
        "org_id": str(row["org_id"]),
        "requester_user_id": str(row["requester_user_id"]),
        "target_user_id": str(row["target_user_id"]),
        "reason": row.get("reason"),
        "status": str(row["status"]),
        "affected_rows": row.get("affected_rows"),
        "error": row.get("error"),
        "started_at": _iso(row.get("started_at")),
        "completed_at": _iso(row.get("completed_at")),
        "created_at": _iso(row.get("created_at")),
        "updated_at": _iso(row.get("updated_at")),
    }


__all__ = [
    "RtbfRequestTracker",
    "RTBF_STATUS_PENDING",
    "RTBF_STATUS_IN_PROGRESS",
    "RTBF_STATUS_COMPLETED",
    "RTBF_STATUS_FAILED",
    "ALL_RTBF_STATUSES",
]
