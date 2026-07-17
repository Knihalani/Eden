"""F74 — debugger session continuity (multi-run compare)."""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class DebugSessionRun:
    id: str
    session_id: str
    org_id: str
    source_trace_id: str
    result_trace_id: str | None
    from_step: int
    rerun_mode: str
    diff_summary: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "org_id": self.org_id,
            "source_trace_id": self.source_trace_id,
            "result_trace_id": self.result_trace_id,
            "from_step": self.from_step,
            "rerun_mode": self.rerun_mode,
            "diff_summary": list(self.diff_summary),
            "created_at": self.created_at,
        }


@dataclass
class DebugSession:
    id: str
    org_id: str
    title: str
    source_trace_id: str | None = None
    notes: str = ""
    runs: list[DebugSessionRun] = field(default_factory=list)
    created_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "title": self.title,
            "source_trace_id": self.source_trace_id,
            "notes": self.notes,
            "run_count": len(self.runs),
            "runs": [r.to_dict() for r in self.runs],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class DebugSessionService:
    """Persisted multi-run debugger sessions (F74 / U13)."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg
        self._memory: dict[str, DebugSession] = {}

    async def _client(self) -> Any | None:
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            return None

    async def create(
        self,
        org_id: str,
        *,
        title: str = "Debug session",
        source_trace_id: str | None = None,
        notes: str = "",
    ) -> DebugSession:
        session = DebugSession(
            id=str(uuid.uuid4()),
            org_id=org_id,
            title=title,
            source_trace_id=source_trace_id,
            notes=notes,
        )
        await self._persist_session(session)
        self._memory[f"{org_id}:{session.id}"] = session
        return session

    async def list_sessions(
        self, org_id: str, *, limit: int = 50
    ) -> list[DebugSession]:
        client = await self._client()
        if client is None:
            rows = [s for s in self._memory.values() if s.org_id == org_id]
            return sorted(rows, key=lambda s: s.updated_at, reverse=True)[:limit]
        sql_rows = await client.fetch(
            """
            SELECT id, org_id, title, source_trace_id, notes, created_at, updated_at
            FROM debug_sessions
            WHERE org_id = $1
            ORDER BY updated_at DESC
            LIMIT $2
            """,
            org_id,
            limit,
        )
        out: list[DebugSession] = []
        for row in sql_rows:
            session = _row_to_session(dict(row))
            session.runs = await self._load_runs(org_id, session.id)
            out.append(session)
        return out

    async def get(self, org_id: str, session_id: str) -> DebugSession | None:
        client = await self._client()
        if client is not None:
            row = await client.fetchrow(
                """
                SELECT id, org_id, title, source_trace_id, notes, created_at, updated_at
                FROM debug_sessions
                WHERE org_id = $1 AND id = $2::uuid
                """,
                org_id,
                session_id,
            )
            if row:
                session = _row_to_session(dict(row))
                session.runs = await self._load_runs(org_id, session.id)
                return session
        return self._memory.get(f"{org_id}:{session_id}")

    async def add_run(
        self,
        org_id: str,
        session_id: str,
        *,
        source_trace_id: str,
        from_step: int,
        rerun_mode: str,
        result_trace_id: str | None = None,
        diff_summary: list[dict[str, Any]] | None = None,
    ) -> DebugSessionRun | None:
        session = await self.get(org_id, session_id)
        if session is None:
            return None
        run = DebugSessionRun(
            id=str(uuid.uuid4()),
            session_id=session_id,
            org_id=org_id,
            source_trace_id=source_trace_id,
            result_trace_id=result_trace_id,
            from_step=from_step,
            rerun_mode=rerun_mode,
            diff_summary=list(diff_summary or []),
        )
        session.runs.append(run)
        session.updated_at = datetime.now(UTC).isoformat()
        await self._persist_run(run)
        await self._touch_session(session)
        self._memory[f"{org_id}:{session_id}"] = session
        return run

    async def compare_runs(
        self,
        org_id: str,
        session_id: str,
        *,
        run_a_id: str,
        run_b_id: str,
    ) -> dict[str, Any] | None:
        session = await self.get(org_id, session_id)
        if session is None:
            return None
        by_id = {r.id: r for r in session.runs}
        a = by_id.get(run_a_id)
        b = by_id.get(run_b_id)
        if a is None or b is None:
            return None
        diff_steps_a = {d.get("step_number") for d in a.diff_summary}
        diff_steps_b = {d.get("step_number") for d in b.diff_summary}
        shared = diff_steps_a & diff_steps_b
        only_a = diff_steps_a - diff_steps_b
        only_b = diff_steps_b - diff_steps_a
        return {
            "session_id": session_id,
            "run_a": a.to_dict(),
            "run_b": b.to_dict(),
            "comparison": {
                "shared_diff_steps": sorted(shared),
                "only_in_a": sorted(only_a),
                "only_in_b": sorted(only_b),
                "mode_changed": a.rerun_mode != b.rerun_mode,
                "from_step_delta": b.from_step - a.from_step,
            },
        }

    async def _load_runs(self, org_id: str, session_id: str) -> list[DebugSessionRun]:
        client = await self._client()
        if client is None:
            session = self._memory.get(f"{org_id}:{session_id}")
            return list(session.runs) if session else []
        rows = await client.fetch(
            """
            SELECT id, session_id, org_id, source_trace_id, result_trace_id,
                   from_step, rerun_mode, diff_summary, created_at
            FROM debug_session_runs
            WHERE org_id = $1 AND session_id = $2::uuid
            ORDER BY created_at ASC
            """,
            org_id,
            session_id,
        )
        return [_row_to_run(dict(r)) for r in rows]

    async def _persist_session(self, session: DebugSession) -> None:
        client = await self._client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO debug_sessions (
                id, org_id, title, source_trace_id, notes, created_at, updated_at
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)
            ON CONFLICT (id) DO UPDATE SET
                title = EXCLUDED.title,
                notes = EXCLUDED.notes,
                updated_at = EXCLUDED.updated_at
            """,
            session.id,
            session.org_id,
            session.title,
            session.source_trace_id,
            session.notes,
            session.created_at,
            session.updated_at,
        )

    async def _touch_session(self, session: DebugSession) -> None:
        client = await self._client()
        if client is None:
            return
        await client.execute(
            """
            UPDATE debug_sessions SET updated_at = NOW()
            WHERE id = $1::uuid AND org_id = $2
            """,
            session.id,
            session.org_id,
        )

    async def _persist_run(self, run: DebugSessionRun) -> None:
        client = await self._client()
        if client is None:
            return
        await client.execute(
            """
            INSERT INTO debug_session_runs (
                id, session_id, org_id, source_trace_id, result_trace_id,
                from_step, rerun_mode, diff_summary, created_at
            ) VALUES (
                $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz
            )
            """,
            run.id,
            run.session_id,
            run.org_id,
            run.source_trace_id,
            run.result_trace_id,
            run.from_step,
            run.rerun_mode,
            json.dumps(run.diff_summary),
            run.created_at,
        )


def _row_to_session(row: dict[str, Any]) -> DebugSession:
    created = row.get("created_at")
    updated = row.get("updated_at")
    return DebugSession(
        id=str(row["id"]),
        org_id=row["org_id"],
        title=str(row.get("title") or "Debug session"),
        source_trace_id=row.get("source_trace_id"),
        notes=str(row.get("notes") or ""),
        created_at=created.isoformat() if hasattr(created, "isoformat") else str(created or ""),
        updated_at=updated.isoformat() if hasattr(updated, "isoformat") else str(updated or ""),
    )


def _row_to_run(row: dict[str, Any]) -> DebugSessionRun:
    diff = row.get("diff_summary") or []
    if isinstance(diff, str):
        diff = json.loads(diff)
    created = row.get("created_at")
    return DebugSessionRun(
        id=str(row["id"]),
        session_id=str(row["session_id"]),
        org_id=row["org_id"],
        source_trace_id=row["source_trace_id"],
        result_trace_id=row.get("result_trace_id"),
        from_step=int(row.get("from_step") or 0),
        rerun_mode=str(row.get("rerun_mode") or "hermetic"),
        diff_summary=list(diff) if isinstance(diff, list) else [],
        created_at=created.isoformat() if hasattr(created, "isoformat") else str(created or ""),
    )


__all__ = [
    "DebugSession",
    "DebugSessionRun",
    "DebugSessionService",
]
