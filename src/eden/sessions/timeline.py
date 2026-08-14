"""Read side of the N12 session timeline: list, timeline, link-issue.

Serves the ``/orgs/{org_id}/sessions`` routes from the
``session_summaries`` rollup (one indexed read for the list; the
timeline re-reads the summary's own ``trace_ids`` through the same
per-turn aggregate the rollup used, so cards always sum to the header).

``live`` overlay: the rollup only ever sees settled turns, so stored
``outcome`` is success/fail/partial. A session whose last event is
recent is presented as ``live`` — presentation state derived from
recency, deliberately not persisted (a stored ``live`` would go stale
the moment traffic stops).

Org scoping is per-query ``WHERE org_id = $1`` throughout (RLS is
defence-in-depth only — see storage/postgres.py).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.sessions.rollup import _TURNS_SQL

logger = logging.getLogger(__name__)

#: A session whose last event is younger than this reads as ``live``.
LIVE_WINDOW_S = 300.0

_SUMMARY_COLUMNS = (
    "org_id, session_id, agent_id, user_id, trace_ids, turn_count, "
    "total_cost_usd, total_input_tokens, total_output_tokens, "
    "total_latency_ms, session_start, session_end, had_stumble, "
    "stumble_count, stumble_turn_indices, issue_count, "
    "linked_issue_id::text AS linked_issue_id, outcome, helped, updated_at"
)

# Timeline reads are paginated (unlike the rollup's full-session
# aggregate that ``_TURNS_SQL`` was written for) — ``trace_ids`` on
# ``session_summaries`` is not guaranteed chronologically ordered, so a
# naive ``trace_ids[offset:offset+limit]`` slice would silently return
# the wrong turns. LIMIT/OFFSET are pushed into the query itself,
# after ``_TURNS_SQL``'s own ``ORDER BY min(timestamp)``, so the page
# boundary is always correct regardless of ``trace_ids`` ordering.
_TURNS_SQL_PAGE = _TURNS_SQL + "\nLIMIT $3 OFFSET $4\n"

_TURN_ISSUES_SQL = """
SELECT DISTINCT s.trace_id,
       i.id::text AS issue_id,
       i.status,
       i.severity,
       i.title
FROM agent_stumbles s
JOIN agent_issues i
  ON i.org_id = s.org_id AND i.fingerprint = s.fingerprint
WHERE s.org_id = $1 AND s.trace_id = ANY($2::text[])
"""

_TURN_STUMBLES_SQL = """
SELECT trace_id, array_agg(DISTINCT kind) AS kinds
FROM agent_stumbles
WHERE org_id = $1 AND trace_id = ANY($2::text[])
GROUP BY trace_id
"""


class SessionNotFoundError(LookupError):
    """No ``session_summaries`` row for (org_id, session_id)."""


class IssueNotFoundError(LookupError):
    """Issue id missing, malformed, or owned by another org."""


async def _default_client() -> Any:
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    if client is None:
        raise ConnectionError("sessions: postgres unavailable")
    return client


def _iso(value: Any) -> str | None:
    return value.isoformat() if isinstance(value, datetime) else None


def _effective_outcome(stored: str | None, session_end: Any) -> str:
    if isinstance(session_end, datetime):
        end = session_end if session_end.tzinfo else session_end.replace(tzinfo=UTC)
        if (datetime.now(UTC) - end).total_seconds() < LIVE_WINDOW_S:
            return "live"
    return stored or "live"


def _summary_dict(row: Any) -> dict[str, Any]:
    return {
        "session_id": row["session_id"],
        "agent_id": row["agent_id"],
        "user_id": row["user_id"],
        "trace_ids": list(row["trace_ids"] or []),
        "turn_count": int(row["turn_count"] or 0),
        "total_cost_usd": float(row["total_cost_usd"] or 0.0),
        "total_input_tokens": int(row["total_input_tokens"] or 0),
        "total_output_tokens": int(row["total_output_tokens"] or 0),
        "total_latency_ms": (
            float(row["total_latency_ms"])
            if row["total_latency_ms"] is not None
            else None
        ),
        "session_start": _iso(row["session_start"]),
        "session_end": _iso(row["session_end"]),
        "had_stumble": bool(row["had_stumble"]),
        "stumble_count": int(row["stumble_count"] or 0),
        "stumble_turn_indices": list(row["stumble_turn_indices"] or []),
        "issue_count": int(row["issue_count"] or 0),
        "linked_issue_id": row["linked_issue_id"],
        "outcome": _effective_outcome(row["outcome"], row["session_end"]),
        "helped": str(row["helped"] or "unknown") if "helped" in row.keys() else "unknown",
        "updated_at": _iso(row["updated_at"]),
    }


async def list_sessions(
    org_id: str,
    *,
    agent_id: str | None = None,
    since: datetime | None = None,
    had_stumble: bool | None = None,
    min_cost: float | None = None,
    limit: int = 50,
    offset: int = 0,
    client: Any | None = None,
) -> dict[str, Any]:
    """Filtered, recency-ordered session page: ``{sessions, total, limit, offset}``."""
    client = client or await _default_client()
    clauses = ["org_id = $1"]
    args: list[Any] = [org_id]
    if agent_id:
        args.append(agent_id)
        clauses.append(f"agent_id = ${len(args)}")
    if since is not None:
        args.append(since)
        clauses.append(f"session_end >= ${len(args)}")
    if had_stumble is not None:
        args.append(had_stumble)
        clauses.append(f"had_stumble = ${len(args)}")
    if min_cost is not None:
        args.append(float(min_cost))
        clauses.append(f"total_cost_usd >= ${len(args)}")
    where = " AND ".join(clauses)
    rows = await client.fetch(
        f"SELECT {_SUMMARY_COLUMNS} FROM session_summaries WHERE {where} "
        f"ORDER BY session_start DESC LIMIT ${len(args) + 1} OFFSET ${len(args) + 2}",
        *args,
        limit,
        offset,
    )
    # Same count-skip as observability.list_traces: a short page is the
    # last page, so the count is already known.
    if len(rows) < limit:
        total = offset + len(rows)
    else:
        total = int(
            await client.fetchval(
                f"SELECT count(*) FROM session_summaries WHERE {where}", *args
            )
            or 0
        )
    return {
        "sessions": [_summary_dict(r) for r in rows],
        "total": int(total),
        "limit": limit,
        "offset": offset,
    }


async def get_session_timeline(
    org_id: str,
    session_id: str,
    *,
    limit: int = 50,
    offset: int = 0,
    client: Any | None = None,
) -> dict[str, Any]:
    """Session header + one page of ordered turn cards.

    Raises :class:`SessionNotFoundError` when the session has no summary
    row (never indexed, or a session-less trace). ``limit``/``offset``
    page the turn rows themselves (via ``_TURNS_SQL_PAGE``'s own
    ``ORDER BY min(timestamp) ... LIMIT ... OFFSET``) rather than
    slicing ``summary["trace_ids"]``, which is not reliably
    chronologically ordered. The stumble/issue sub-queries are scoped
    to only the trace ids on the current page, so they no longer scan
    the whole session on every fetch.
    """
    client = client or await _default_client()
    row = await client.fetchrow(
        f"SELECT {_SUMMARY_COLUMNS} FROM session_summaries "
        "WHERE org_id = $1 AND session_id = $2",
        org_id,
        session_id,
    )
    if row is None:
        raise SessionNotFoundError(session_id)
    summary = _summary_dict(row)

    trace_ids = summary["trace_ids"]
    turns: list[dict[str, Any]] = []
    if trace_ids:
        turn_rows = await client.fetch(
            _TURNS_SQL_PAGE, org_id, trace_ids, limit, offset
        )
        page_trace_ids = [r["trace_id"] for r in turn_rows]
        stumbles: dict[str, list[str]] = {}
        issues: dict[str, list[dict[str, Any]]] = {}
        if page_trace_ids:
            stumbles = {
                r["trace_id"]: list(r["kinds"] or [])
                for r in await client.fetch(
                    _TURN_STUMBLES_SQL, org_id, page_trace_ids
                )
            }
            for r in await client.fetch(
                _TURN_ISSUES_SQL, org_id, page_trace_ids
            ):
                issues.setdefault(r["trace_id"], []).append(
                    {
                        "issue_id": r["issue_id"],
                        "status": r["status"],
                        "severity": r["severity"],
                        "title": r["title"],
                    }
                )
        for index, r in enumerate(turn_rows, start=offset + 1):
            tid = r["trace_id"]
            turns.append(
                {
                    "index": index,
                    "trace_id": tid,
                    "started_at": _iso(r["started_at"]),
                    "ended_at": _iso(r["last_event_at"]),
                    "duration_ms": (
                        float(r["duration_ms"])
                        if r["duration_ms"] is not None
                        else None
                    ),
                    "cost_usd": (
                        float(r["cost_usd"]) if r["cost_usd"] is not None else None
                    ),
                    "input_tokens": int(r["input_tokens"] or 0),
                    "output_tokens": int(r["output_tokens"] or 0),
                    "outcome": r["outcome"],
                    "error_type": r["error_type"],
                    "had_stumble": tid in stumbles,
                    "stumble_kinds": sorted(stumbles.get(tid, [])),
                    "issues": issues.get(tid, []),
                    # First named event of the trace — the closest thing
                    # to a per-trace summary line the read model stores.
                    "summary": r["first_name"],
                }
            )
    return {
        "org_id": org_id,
        "session_id": session_id,
        "summary": summary,
        "turn_count": summary["turn_count"],
        "turns": turns,
        "limit": limit,
        "offset": offset,
    }


async def link_issue(
    org_id: str,
    session_id: str,
    issue_id: str,
    *,
    client: Any | None = None,
) -> dict[str, Any]:
    """Attach an org-owned F29 issue to a session.

    Raises :class:`IssueNotFoundError` for a malformed id or an issue
    the org does not own (same 404 for both — no cross-org existence
    oracle), :class:`SessionNotFoundError` for an unknown session.
    """
    client = client or await _default_client()
    try:
        uuid.UUID(str(issue_id))
    except ValueError:
        # Malformed id — same error as not-found (no format oracle), and
        # validated here so a DB DataError never has to be swallowed
        # (which would also have eaten transient connection failures).
        raise IssueNotFoundError(issue_id) from None
    issue_row = await client.fetchrow(
        "SELECT id::text AS id FROM agent_issues "
        "WHERE org_id = $1 AND id = $2::uuid",
        org_id,
        issue_id,
    )
    if issue_row is None:
        raise IssueNotFoundError(issue_id)
    status = await client.execute(
        "UPDATE session_summaries "
        "SET linked_issue_id = $3::uuid, updated_at = NOW() "
        "WHERE org_id = $1 AND session_id = $2",
        org_id,
        session_id,
        issue_id,
    )
    if not str(status).strip().endswith(" 1"):
        raise SessionNotFoundError(session_id)
    return {
        "session_id": session_id,
        "linked_issue_id": issue_row["id"],
    }
