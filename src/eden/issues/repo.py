"""Postgres CRUD for the issues layer (F28 / F29).

Thin async wrappers over ``get_postgres_client()`` following the
codebase convention (``fetch`` / ``fetchrow`` / ``execute`` with a
defensive ``None`` guard when Postgres is unavailable). The transactional
issue upsert lives in :class:`IssuePromoter`.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from eden.issues.models import Issue, StumbleCreate

logger = logging.getLogger(__name__)


def _row_to_issue(row: dict[str, Any]) -> Issue:
    return Issue(
        id=str(row["id"]),
        org_id=row["org_id"],
        fingerprint=row["fingerprint"],
        kind=row["kind"],
        title=row["title"],
        status=row["status"],
        severity=row["severity"],
        stumble_count=row.get("stumble_count", 1),
        user_count=row.get("user_count", 1),
        repetition_count=row.get("repetition_count", 1),
        agent_id=row.get("agent_id"),
        affected_user_ids=list(row.get("affected_user_ids") or []),
        example_stumble_ids=[str(x) for x in (row.get("example_stumble_ids") or [])],
        triage_result=_maybe_json(row.get("triage_result")),
        experiment_id=(
            str(row["experiment_id"]) if row.get("experiment_id") else None
        ),
        experiment_result=_maybe_json(row.get("experiment_result")),
        regression_case_id=row.get("regression_case_id"),
        first_seen=row.get("first_seen"),
        last_seen=row.get("last_seen"),
    )


def _maybe_json(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, dict):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


class IssuesRepo:
    """CRUD for ``agent_stumbles`` and ``agent_issues``."""

    async def _client(self) -> Any | None:
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("issues.repo: get_postgres_client failed: %s", exc)
            return None

    # ── stumbles ────────────────────────────────────────────────────

    async def insert_stumble(
        self, sc: StumbleCreate, fingerprint: str
    ) -> tuple[str | None, bool]:
        """Insert (or dedup-update) a stumble.

        Returns ``(stumble_id, inserted)`` where ``inserted`` is True
        only when a brand-new row was created. On conflict
        ``(org_id, trace_id, kind, fingerprint)`` the ``detail`` is
        merged and the existing id returned (``inserted=False``).
        """
        client = await self._client()
        if client is None:
            return None, False
        sid = str(uuid.uuid4())
        try:
            row = await client.fetchrow(
                """
                INSERT INTO agent_stumbles
                    (id, org_id, trace_id, session_id, user_id, agent_id,
                     span_id, kind, fingerprint, title, detail, severity,
                     detected_by)
                VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                        $11::jsonb, $12, $13)
                ON CONFLICT (org_id, trace_id, kind, fingerprint)
                DO UPDATE SET detail = EXCLUDED.detail
                RETURNING id, (xmax = 0) AS inserted
                """,
                sid,
                sc.org_id,
                sc.trace_id,
                sc.session_id,
                sc.user_id,
                sc.agent_id,
                sc.span_id,
                sc.kind,
                fingerprint,
                sc.title,
                json.dumps(sc.detail or {}),
                sc.resolved_severity(),
                sc.detected_by,
            )
        except Exception as exc:
            logger.warning("issues.repo: insert_stumble failed: %s", exc)
            return None, False
        if row is None:
            return None, False
        return str(row["id"]), bool(row["inserted"])

    async def list_stumbles(
        self,
        org_id: str,
        *,
        fingerprint: str | None = None,
        trace_id: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        client = await self._client()
        if client is None:
            return []
        clauses = ["org_id = $1"]
        args: list[Any] = [org_id]
        if fingerprint:
            args.append(fingerprint)
            clauses.append(f"fingerprint = ${len(args)}")
        if trace_id:
            args.append(trace_id)
            clauses.append(f"trace_id = ${len(args)}")
        args.append(int(limit))
        sql = (
            "SELECT * FROM agent_stumbles WHERE "
            + " AND ".join(clauses)
            + f" ORDER BY detected_at DESC LIMIT ${len(args)}"
        )
        try:
            rows = await client.fetch(sql, *args)
        except Exception as exc:
            logger.debug("issues.repo: list_stumbles failed: %s", exc)
            return []
        return [dict(r) for r in rows]

    async def count_recent_stumbles(
        self, org_id: str, fingerprint: str, *, minutes: int = 30
    ) -> int:
        """Count stumbles for a fingerprint in the trailing window.

        Used by the verify loop (Wave 6) to confirm a fix stopped the
        bleeding (rate → 0 for N minutes).
        """
        client = await self._client()
        if client is None:
            return 0
        try:
            val = await client.fetchrow(
                "SELECT COUNT(*) AS n FROM agent_stumbles "
                "WHERE org_id = $1 AND fingerprint = $2 "
                f"AND detected_at > NOW() - INTERVAL '{int(minutes)} minutes'",
                org_id,
                fingerprint,
            )
        except Exception as exc:
            logger.debug("issues.repo: count_recent_stumbles failed: %s", exc)
            return 0
        return int(val["n"]) if val else 0

    # ── issues ──────────────────────────────────────────────────────

    async def get_issue(self, org_id: str, issue_id: str) -> Issue | None:
        client = await self._client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                "SELECT * FROM agent_issues WHERE org_id = $1 AND id = $2::uuid",
                org_id,
                issue_id,
            )
        except Exception as exc:
            logger.debug("issues.repo: get_issue failed: %s", exc)
            return None
        return _row_to_issue(dict(row)) if row else None

    async def get_issue_by_fingerprint(
        self, org_id: str, fingerprint: str
    ) -> Issue | None:
        client = await self._client()
        if client is None:
            return None
        try:
            row = await client.fetchrow(
                "SELECT * FROM agent_issues "
                "WHERE org_id = $1 AND fingerprint = $2",
                org_id,
                fingerprint,
            )
        except Exception as exc:
            logger.debug("issues.repo: get_issue_by_fingerprint failed: %s", exc)
            return None
        return _row_to_issue(dict(row)) if row else None

    async def list_issues(
        self,
        org_id: str,
        *,
        status: str | None = None,
        severity: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Issue]:
        client = await self._client()
        if client is None:
            return []
        clauses = ["org_id = $1"]
        args: list[Any] = [org_id]
        if status:
            args.append(status)
            clauses.append(f"status = ${len(args)}")
        if severity:
            args.append(severity)
            clauses.append(f"severity = ${len(args)}")
        args.append(int(limit))
        limit_pos = len(args)
        args.append(int(offset))
        offset_pos = len(args)
        sql = (
            "SELECT * FROM agent_issues WHERE "
            + " AND ".join(clauses)
            + f" ORDER BY last_seen DESC LIMIT ${limit_pos} OFFSET ${offset_pos}"
        )
        try:
            rows = await client.fetch(sql, *args)
        except Exception as exc:
            logger.debug("issues.repo: list_issues failed: %s", exc)
            return []
        return [_row_to_issue(dict(r)) for r in rows]

    async def set_status(
        self,
        org_id: str,
        issue_id: str,
        status: str,
        *,
        set_resolved_at: bool = False,
    ) -> bool:
        client = await self._client()
        if client is None:
            return False
        resolved = ", resolved_at = NOW()" if set_resolved_at else ""
        try:
            res = await client.execute(
                "UPDATE agent_issues "
                f"SET status = $3, updated_at = NOW(){resolved} "
                "WHERE org_id = $1 AND id = $2::uuid",
                org_id,
                issue_id,
                status,
            )
        except Exception as exc:
            logger.warning("issues.repo: set_status failed: %s", exc)
            return False
        return _rowcount(res) > 0

    async def set_triage_result(
        self, org_id: str, issue_id: str, triage_result: dict[str, Any]
    ) -> bool:
        client = await self._client()
        if client is None:
            return False
        try:
            res = await client.execute(
                "UPDATE agent_issues "
                "SET triage_result = $3::jsonb, updated_at = NOW() "
                "WHERE org_id = $1 AND id = $2::uuid",
                org_id,
                issue_id,
                json.dumps(triage_result),
            )
        except Exception as exc:
            logger.warning("issues.repo: set_triage_result failed: %s", exc)
            return False
        return _rowcount(res) > 0


def _rowcount(execute_result: Any) -> int:
    """Parse asyncpg's ``UPDATE <n>`` status string into an int."""
    try:
        return int(str(execute_result).split()[-1])
    except (ValueError, IndexError, AttributeError):
        return 0
