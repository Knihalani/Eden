"""F09 — Postgres-backed browser session store (RRWeb event payloads)."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.replay.events import (
    Session,
    SessionEvent,
    SessionRecorder,
    build_timeline,
    redact_event,
)

logger = logging.getLogger(__name__)


class BrowserSessionStore:
    """Persist browser recordings keyed by trace + step (F09)."""

    def __init__(self, pg: Any | None = None) -> None:
        self._pg = pg
        self._memory_only = pg is None
        self._fallback = SessionRecorder(redact=True)

    async def _client(self) -> Any | None:
        if self._memory_only:
            return None
        if self._pg is not None:
            return self._pg
        try:
            from eden.storage.postgres import get_postgres_client

            return await get_postgres_client()
        except Exception:
            logger.debug("postgres client unavailable for replay store", exc_info=True)
            return None

    async def create_session(
        self,
        org_id: str,
        *,
        trace_id: str,
        agent_session_id: str | None = None,
        user_agent: str = "",
        viewport_w: int = 0,
        viewport_h: int = 0,
    ) -> Session:
        session_id = str(uuid.uuid4())
        now = datetime.now(UTC)
        client = await self._client()
        if client is None:
            return self._fallback.start(
                org_id=org_id,
                trace_id=trace_id,
                user_agent=user_agent,
                viewport_w=viewport_w,
                viewport_h=viewport_h,
            )
        await client.execute(
            """
            INSERT INTO browser_sessions (
                id, org_id, trace_id, agent_session_id, user_agent,
                viewport_w, viewport_h, started_at
            ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)
            """,
            session_id,
            org_id,
            trace_id,
            agent_session_id,
            user_agent,
            viewport_w,
            viewport_h,
            now,
        )
        return Session(
            id=session_id,
            org_id=org_id,
            started_at=now.isoformat(),
            trace_id=trace_id,
            user_agent=user_agent,
            viewport_w=viewport_w,
            viewport_h=viewport_h,
        )

    async def append_events(
        self,
        org_id: str,
        browser_session_id: str,
        events: list[dict[str, Any]],
    ) -> int:
        client = await self._client()
        if client is None:
            sess = self._fallback.get_session(browser_session_id)
            if sess is None or str(sess.org_id) != str(org_id):
                return 0
            count = 0
            for ev in events:
                if self._fallback.append(
                    browser_session_id,
                    str(ev.get("event_type") or ev.get("type") or "meta"),
                    dict(ev.get("payload") or ev),
                ):
                    count += 1
            return count
        owned = await client.fetchval(
            """
            SELECT 1 FROM browser_sessions
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            browser_session_id,
        )
        if not owned:
            return 0
        count = 0
        for ev in events:
            payload = dict(ev.get("payload") or ev)
            event_type = str(ev.get("event_type") or ev.get("type") or "meta")
            step_number = ev.get("step_number")
            if step_number is None and "timestamp" in ev:
                step_number = ev.get("step")
            redacted = redact_event(
                SessionEvent(
                    id="pending",
                    session_id=browser_session_id,
                    sequence=count,
                    event_type=event_type,
                    timestamp=datetime.now(UTC).isoformat(),
                    payload=payload,
                )
            )
            await client.execute(
                """
                INSERT INTO browser_session_events (
                    browser_session_id, step_number, event_type, payload, recorded_at
                ) VALUES ($1::uuid, $2, $3, $4::jsonb, NOW())
                """,
                browser_session_id,
                step_number,
                redacted.event_type,
                json.dumps(redacted.payload),
            )
            count += 1
        return count

    async def get_session(
        self, org_id: str, browser_session_id: str
    ) -> Session | None:
        client = await self._client()
        if client is None:
            sess = self._fallback.get_session(browser_session_id)
            if sess is None or str(sess.org_id) != str(org_id):
                return None
            return sess
        row = await client.fetchrow(
            """
            SELECT id, org_id, trace_id, user_agent, viewport_w, viewport_h,
                   started_at, ended_at
            FROM browser_sessions
            WHERE org_id = $1 AND id = $2::uuid
            """,
            org_id,
            browser_session_id,
        )
        if not row:
            return None
        events = await self._load_events(browser_session_id)
        started = row["started_at"]
        ended = row.get("ended_at")
        return Session(
            id=str(row["id"]),
            org_id=row["org_id"],
            started_at=started.isoformat() if hasattr(started, "isoformat") else str(started),
            ended_at=ended.isoformat() if ended and hasattr(ended, "isoformat") else (
                str(ended) if ended else None
            ),
            user_agent=row.get("user_agent") or "",
            viewport_w=int(row.get("viewport_w") or 0),
            viewport_h=int(row.get("viewport_h") or 0),
            trace_id=row.get("trace_id"),
            event_count=len(events),
        )

    async def replay_bundle_for_trace(
        self, org_id: str, trace_id: str
    ) -> dict[str, Any] | None:
        client = await self._client()
        if client is None:
            return None
        row = await client.fetchrow(
            """
            SELECT id, org_id, trace_id, user_agent, viewport_w, viewport_h,
                   started_at, ended_at
            FROM browser_sessions
            WHERE org_id = $1 AND trace_id = $2
            ORDER BY started_at DESC
            LIMIT 1
            """,
            org_id,
            trace_id,
        )
        if not row:
            return None
        session_id = str(row["id"])
        events = await self._load_events(session_id)
        timeline = build_timeline(events)
        steps: dict[int, list[dict[str, Any]]] = {}
        for ev in events:
            step = _step_for_event(ev)
            steps.setdefault(step, []).append(ev.to_dict())
        return {
            "browser_session_id": session_id,
            "trace_id": trace_id,
            "session": {
                "id": session_id,
                "org_id": org_id,
                "trace_id": row.get("trace_id"),
                "viewport_w": row.get("viewport_w"),
                "viewport_h": row.get("viewport_h"),
                "event_count": len(events),
            },
            "timeline": timeline,
            "events_by_step": {str(k): v for k, v in sorted(steps.items())},
            "events": [e.to_dict() for e in events[:500]],
        }

    async def _load_events(self, browser_session_id: str) -> list[SessionEvent]:
        client = await self._client()
        if client is None:
            return self._fallback.list_events(browser_session_id)
        rows = await client.fetch(
            """
            SELECT step_number, event_type, payload, recorded_at
            FROM browser_session_events
            WHERE browser_session_id = $1::uuid
            ORDER BY recorded_at ASC, id ASC
            LIMIT 5000
            """,
            browser_session_id,
        )
        out: list[SessionEvent] = []
        for i, row in enumerate(rows):
            payload = row["payload"]
            if isinstance(payload, str):
                payload = json.loads(payload)
            recorded = row["recorded_at"]
            out.append(
                SessionEvent(
                    id=f"bs-{i}",
                    session_id=browser_session_id,
                    sequence=i,
                    event_type=str(row["event_type"]),
                    timestamp=recorded.isoformat() if hasattr(recorded, "isoformat") else str(recorded),
                    payload=dict(payload) if isinstance(payload, dict) else {},
                )
            )
        return out


def _step_for_event(ev: SessionEvent) -> int:
    payload = ev.payload or {}
    for key in ("step_number", "step", "eden_step"):
        val = payload.get(key)
        if val is not None:
            try:
                return int(val)
            except (TypeError, ValueError):
                pass
    return max(0, ev.sequence // 10)


__all__ = ["BrowserSessionStore"]
