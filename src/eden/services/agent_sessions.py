"""Agent session lifecycle (F23) — distinct from user intelligence sessions."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class AgentSession:
    id: str
    org_id: str
    agent_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    success: bool | None = None
    failure_reason: str | None = None
    trace_ids: list[str] = field(default_factory=list)
    started_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )
    ended_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "agent_id": self.agent_id,
            "user_id": self.user_id,
            "metadata": dict(self.metadata),
            "success": self.success,
            "failure_reason": self.failure_reason,
            "trace_ids": list(self.trace_ids),
            "started_at": self.started_at,
            "ended_at": self.ended_at,
        }


class AgentSessionService:
    """CRUD for ``agent_sessions`` (F23 / D12)."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg
        self._memory: dict[str, AgentSession] = {}

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def start(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        user_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        session_id: str | None = None,
    ) -> AgentSession:
        session = AgentSession(
            id=session_id or str(uuid.uuid4()),
            org_id=org_id,
            agent_id=agent_id,
            user_id=user_id,
            metadata=dict(metadata or {}),
        )
        await self._persist(session)
        return session

    async def get(self, org_id: str, session_id: str) -> AgentSession | None:
        client = await self._client()
        if client is not None:
            row = await client.fetchrow(
                """
                SELECT id, org_id, agent_id, user_id, metadata, success,
                       failure_reason, trace_ids, started_at, ended_at
                FROM agent_sessions
                WHERE org_id = $1 AND id = $2::uuid
                """,
                org_id,
                session_id,
            )
            if row:
                return _row_to_session(dict(row))
        return self._memory.get(f"{org_id}:{session_id}")

    async def list_sessions(
        self,
        org_id: str,
        *,
        agent_id: str | None = None,
        limit: int = 50,
    ) -> list[AgentSession]:
        client = await self._client()
        if client is None:
            rows = [s for s in self._memory.values() if s.org_id == org_id]
            if agent_id:
                rows = [s for s in rows if s.agent_id == agent_id]
            return sorted(rows, key=lambda s: s.started_at, reverse=True)[:limit]
        sql_rows = await client.fetch(
            """
            SELECT id, org_id, agent_id, user_id, metadata, success,
                   failure_reason, trace_ids, started_at, ended_at
            FROM agent_sessions
            WHERE org_id = $1
              AND ($2::text IS NULL OR agent_id = $2)
            ORDER BY started_at DESC
            LIMIT $3
            """,
            org_id,
            agent_id,
            limit,
        )
        return [_row_to_session(dict(r)) for r in sql_rows]

    async def attach_trace(
        self, org_id: str, session_id: str, trace_id: str
    ) -> bool:
        session = await self.get(org_id, session_id)
        if session is None:
            return False
        if trace_id not in session.trace_ids:
            session.trace_ids.append(trace_id)
        await self._persist(session)
        return True

    async def identify(
        self, org_id: str, session_id: str, user_id: str
    ) -> bool:
        session = await self.get(org_id, session_id)
        if session is None:
            return False
        session.user_id = user_id
        await self._persist(session)
        return True

    async def complete(
        self,
        org_id: str,
        session_id: str,
        *,
        success: bool,
        failure_reason: str | None = None,
    ) -> AgentSession | None:
        session = await self.get(org_id, session_id)
        if session is None:
            return None
        session.success = success
        session.failure_reason = failure_reason
        session.ended_at = datetime.now(UTC).isoformat()
        await self._persist(session)
        if not success:
            await self._emit_task_failure(org_id, session)
        return session

    async def _emit_task_failure(
        self, org_id: str, session: AgentSession
    ) -> None:
        logger.info(
            "agent_session task_failure org=%s session=%s agent=%s reason=%s",
            org_id,
            session.id,
            session.agent_id,
            session.failure_reason,
        )
        # F20 task_failure path: a session ending unsuccessfully is a
        # first-class stumble so the ``task_failure`` detector is not dead
        # for orgs that report session outcomes out-of-band (no
        # ``session_success`` attr on the trace). Best-effort; a failure
        # here never breaks session completion.
        trace_id = session.trace_ids[0] if session.trace_ids else session.id
        try:
            from eden.issues.models import StumbleCreate
            from eden.issues.stumble_writer import StumbleWriter

            await StumbleWriter().create(
                StumbleCreate(
                    org_id=org_id,
                    trace_id=trace_id,
                    kind="task_failure",
                    title="Agent session failed",
                    detail={
                        "failure_reason": session.failure_reason
                        or "session marked unsuccessful",
                        "session_id": session.id,
                        "source": "agent_session_end",
                    },
                    detected_by="agent_session",
                    agent_id=session.agent_id,
                    session_id=session.id,
                    user_id=session.user_id,
                )
            )
        except Exception as exc:  # pragma: no cover - best-effort
            logger.debug("agent_session: task_failure stumble failed: %s", exc)

    async def _persist(self, session: AgentSession) -> None:
        self._memory[f"{session.org_id}:{session.id}"] = session
        client = await self._client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO agent_sessions (
                id, org_id, agent_id, user_id, metadata, success,
                failure_reason, trace_ids, started_at, ended_at
            ) VALUES (
                $1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz
            )
            ON CONFLICT (id) DO UPDATE SET
                agent_id = EXCLUDED.agent_id,
                user_id = EXCLUDED.user_id,
                metadata = EXCLUDED.metadata,
                success = EXCLUDED.success,
                failure_reason = EXCLUDED.failure_reason,
                trace_ids = EXCLUDED.trace_ids,
                ended_at = EXCLUDED.ended_at
            """,
            session.id,
            session.org_id,
            session.agent_id,
            session.user_id,
            json.dumps(session.metadata),
            session.success,
            session.failure_reason,
            json.dumps(session.trace_ids),
            session.started_at,
            session.ended_at,
        )


def _row_to_session(row: dict[str, Any]) -> AgentSession:
    meta = row.get("metadata") or {}
    if isinstance(meta, str):
        meta = json.loads(meta)
    traces = row.get("trace_ids") or []
    if isinstance(traces, str):
        traces = json.loads(traces)
    started = row.get("started_at")
    ended = row.get("ended_at")
    return AgentSession(
        id=str(row["id"]),
        org_id=row["org_id"],
        agent_id=row.get("agent_id"),
        user_id=row.get("user_id"),
        metadata=dict(meta) if isinstance(meta, dict) else {},
        success=row.get("success"),
        failure_reason=row.get("failure_reason"),
        trace_ids=[str(t) for t in traces],
        started_at=started.isoformat() if hasattr(started, "isoformat") else str(started or ""),
        ended_at=ended.isoformat() if hasattr(ended, "isoformat") else (
            str(ended) if ended else None
        ),
    )


__all__ = ["AgentSession", "AgentSessionService"]
