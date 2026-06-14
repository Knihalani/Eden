"""Shared helpers for Cat 1 (Trace Replay & Workflow) services.

Cat 1 reads from the existing ``telemetry_events`` table (the
single source of truth for trace data) and from the four
``trace_replay_sessions`` / ``trace_workflow_graphs`` /
``conversations`` / ``conversation_messages`` tables added in
migration 020. The helpers here centralise:

* the trace read path (``fetch_events_page``,
  ``fetch_all_trace_events``)
* the envelope shape used for live (non-stub) responses
  (``ok_envelope``, ``not_found_envelope``, ``error_envelope``)
* the persistence pattern (``upsert_session``,
  ``upsert_workflow_graph``, ``insert_message``)
* a small ``_serialise_event`` helper that turns a DB row dict
  into a JSON-safe dict (Postgres JSONB fields round-trip as
  ``dict`` / ``list`` already; we just normalise ``None`` and
  drop keys the front-end doesn't need).

The helpers are intentionally local to ``eden.observability``
and decoupled from ``eden.decision._common`` so the two cats
can evolve independently. Functions use the same
"best-effort, log-and-return" defensive pattern Cat 16 uses —
Postgres may be unavailable in tests or local dev, and the
service must still produce a useful response.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Trace read paths ────────────────────────────────────────────────


#: Default page size for ``fetch_events_page``. Chosen to keep
#: the response under 1MB for typical LLM event payloads.
DEFAULT_PAGE_SIZE = 100

#: Hard cap on page size so a caller can't ask for 1M events.
MAX_PAGE_SIZE = 1000


async def fetch_events_page(
    org_id: str,
    trace_id: str,
    *,
    cursor: int = 0,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> list[dict[str, Any]]:
    """Return a single page of events for one (org, trace).

    Ordered by ``timestamp ASC, event_id ASC`` so the page is
    stable across calls. Returns an empty list when the trace
    has no events (caller treats that as ``not_found``).
    """
    page_size = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE))
    offset = max(0, int(cursor or 0))
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT event_id, trace_id, span_id, parent_span_id, event_type,
                   timestamp, name, duration_ms, outcome, error,
                   agent_id, agent_version, environment_id, realm,
                   payload, metrics, attributes, tags,
                   source_format, project_id, tenant_id
            FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY timestamp ASC, event_id ASC
            LIMIT $3 OFFSET $4
            """,
            org_id,
            trace_id,
            page_size,
            offset,
        )
    except Exception as exc:
        logger.debug("_trace_common: fetch_events_page failed: %s", exc)
        return []
    return [dict(r) for r in rows]


async def fetch_all_trace_events(
    org_id: str,
    trace_id: str,
    *,
    limit: int = 10000,
) -> list[dict[str, Any]]:
    """Return every event for one (org, trace) up to ``limit``.

    Used by services that need the full event list (workflow
    graph, message view's tool result pairing). Reads in a
    single query so the round-trip cost is O(1) rather than
    paging.
    """
    limit = max(1, min(int(limit or 10000), 10000))
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return []
    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT event_id, trace_id, span_id, parent_span_id, event_type,
                   timestamp, name, duration_ms, outcome, error,
                   agent_id, agent_version, environment_id, realm,
                   payload, metrics, attributes, tags,
                   source_format, project_id, tenant_id
            FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY timestamp ASC, event_id ASC
            LIMIT $3
            """,
            org_id,
            trace_id,
            limit,
        )
    except Exception as exc:
        logger.debug("_trace_common: fetch_all_trace_events failed: %s", exc)
        return []
    return [dict(r) for r in rows]


# ── Envelope helpers ────────────────────────────────────────────────


def _new_trace_id() -> str:
    return f"cat1_{uuid.uuid4().hex[:12]}"


def ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live-response envelope for Cat 1 endpoints.

    Same shape as the stub envelope (so the front-end renders
    uniformly) but with ``status="ok"`` and ``live=True`` to
    signal real data. Mirrors the
    ``_ok_envelope`` helper in
    ``src/eden/decision/_common.py`` — the fields are
    identical so the UI doesn't need per-cat branches.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def not_found_envelope(feature: str, trace_id: str) -> dict[str, Any]:
    """Live envelope for a missing trace — distinct from
    ``not_implemented()`` because the service IS implemented,
    the trace just doesn't exist for this org.
    """
    return {
        "status": "not_found",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {"trace_id": trace_id, "reason": "no events found for this (org, trace)"},
    }


def error_envelope(
    feature: str, message: str, *, code: str = "error"
) -> dict[str, Any]:
    """Live envelope for an internal error (e.g. quota
    exceeded, invalid input). The route handler can map this
    to a 4xx response based on ``code``.
    """
    return {
        "status": "error",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {"message": message, "code": code},
    }


# ── Persistence helpers ────────────────────────────────────────────


async def upsert_session(
    org_id: str,
    trace_id: str,
    *,
    cursor: int,
    state_json: str | None = None,
    user_id: str | None = None,
) -> None:
    """Upsert a row in ``trace_replay_sessions`` for one (org, trace).

    The migration declares no unique constraint on (org_id,
    trace_id), so we delete-then-insert to keep the service
    idempotent. Best-effort: a Postgres failure is logged
    and swallowed.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        await client.execute(
            "DELETE FROM trace_replay_sessions WHERE org_id = $1 AND trace_id = $2",
            org_id,
            trace_id,
        )
        await client.execute(
            """
            INSERT INTO trace_replay_sessions
                (id, org_id, trace_id, user_id, cursor, state_json,
                 created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
            """,
            str(uuid.uuid4()),
            org_id,
            trace_id,
            user_id,
            int(cursor),
            state_json,
        )
    except Exception as exc:
        logger.debug("_trace_common: upsert_session failed: %s", exc)


async def upsert_workflow_graph(
    org_id: str,
    trace_id: str,
    *,
    graph_json: str,
    layout_version: str = "v1",
) -> None:
    """Upsert a row in ``trace_workflow_graphs`` for one (org, trace)."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        await client.execute(
            "DELETE FROM trace_workflow_graphs WHERE org_id = $1 AND trace_id = $2",
            org_id,
            trace_id,
        )
        await client.execute(
            """
            INSERT INTO trace_workflow_graphs
                (id, org_id, trace_id, graph_json, layout_version, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            """,
            str(uuid.uuid4()),
            org_id,
            trace_id,
            graph_json,
            layout_version,
        )
    except Exception as exc:
        logger.debug("_trace_common: upsert_workflow_graph failed: %s", exc)


async def fetch_conversation_messages(
    org_id: str,
    *,
    conversation_id: str,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """Return messages of one conversation in chronological order."""
    limit = max(1, min(int(limit or 100), 1000))
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return []
    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, conversation_id, role, content, created_at
            FROM conversation_messages
            WHERE org_id = $1 AND conversation_id = $2
            ORDER BY created_at ASC, id ASC
            LIMIT $3
            """,
            org_id,
            conversation_id,
            limit,
        )
    except Exception as exc:
        logger.debug("_trace_common: fetch_conversation_messages failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        # Normalise datetime → isoformat string for JSON.
        if d.get("created_at") is not None and not isinstance(d["created_at"], str):
            d["created_at"] = d["created_at"].isoformat()
        out.append(d)
    return out


async def fetch_conversation_for_session(
    org_id: str,
    *,
    session_id: str,
) -> dict[str, Any] | None:
    """Return the most recent conversation row for one (org, session_id)."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, user_id, session_id, title,
                   created_at, updated_at
            FROM conversations
            WHERE org_id = $1 AND session_id = $2
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            org_id,
            session_id,
        )
    except Exception as exc:
        logger.debug(
            "_trace_common: fetch_conversation_for_session failed: %s", exc
        )
        return None
    if row is None:
        return None
    d = dict(row)
    for k in ("created_at", "updated_at"):
        if d.get(k) is not None and not isinstance(d[k], str):
            d[k] = d[k].isoformat()
    return d


async def fetch_sessions(
    org_id: str,
    trace_id: str,
) -> list[dict[str, Any]]:
    """Return all ``trace_replay_sessions`` rows for one (org, trace),
    most-recently-updated first. Used by ``list_checkpoints``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return []
    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, org_id, trace_id, user_id, cursor, state_json,
                   created_at, updated_at
            FROM trace_replay_sessions
            WHERE org_id = $1 AND trace_id = $2
            ORDER BY updated_at DESC, created_at DESC
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("_trace_common: fetch_sessions failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        for k in ("created_at", "updated_at"):
            if d.get(k) is not None and not isinstance(d[k], str):
                d[k] = d[k].isoformat()
        out.append(d)
    return out


async def fetch_session_at_cursor(
    org_id: str,
    trace_id: str,
    *,
    cursor: int,
) -> dict[str, Any] | None:
    """Return the most-recent session for one (org, trace) whose
    ``cursor <= cursor``. Used by ``rewind_to_step``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, trace_id, user_id, cursor, state_json,
                   created_at, updated_at
            FROM trace_replay_sessions
            WHERE org_id = $1 AND trace_id = $2 AND cursor <= $3
            ORDER BY cursor DESC
            LIMIT 1
            """,
            org_id,
            trace_id,
            int(cursor),
        )
    except Exception as exc:
        logger.debug(
            "_trace_common: fetch_session_at_cursor failed: %s", exc
        )
        return None
    if row is None:
        return None
    d = dict(row)
    for k in ("created_at", "updated_at"):
        if d.get(k) is not None and not isinstance(d[k], str):
            d[k] = d[k].isoformat()
    return d


async def insert_conversation_message(
    org_id: str,
    *,
    conversation_id: str,
    role: str,
    content: str,
) -> str | None:
    """Insert one row into ``conversation_messages`` and return its id.

    Returns ``None`` if Postgres isn't available or the insert
    fails. Best-effort — the caller treats ``None`` as a
    service-unavailable signal.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    msg_id = str(uuid.uuid4())
    try:
        await client.execute(
            """
            INSERT INTO conversation_messages
                (id, org_id, conversation_id, role, content, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            """,
            msg_id,
            org_id,
            conversation_id,
            role,
            content,
        )
    except Exception as exc:
        logger.debug(
            "_trace_common: insert_conversation_message failed: %s", exc
        )
        return None
    return msg_id


async def upsert_conversation(
    org_id: str,
    *,
    session_id: str,
    title: str | None = None,
    user_id: str | None = None,
) -> str | None:
    """Insert a new conversation row (or reuse the most recent
    one for the session) and return its id."""
    existing = await fetch_conversation_for_session(
        org_id, session_id=session_id
    )
    if existing is not None:
        # Bump updated_at.
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception as exc:  # pragma: no cover
            logger.debug(
                "_trace_common: postgres import failed: %s", exc
            )
            return existing.get("id")
        client = await get_postgres_client()
        if client is None:
            return existing.get("id")
        try:
            await client.execute(
                "UPDATE conversations SET updated_at = NOW() "
                "WHERE id = $1::uuid",
                existing["id"],
            )
        except Exception as exc:
            logger.debug(
                "_trace_common: bump conversation updated_at failed: %s",
                exc,
            )
        return existing.get("id")

    new_id = str(uuid.uuid4())
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return None
    client = await get_postgres_client()
    if client is None:
        return None
    try:
        await client.execute(
            """
            INSERT INTO conversations
                (id, org_id, user_id, session_id, title,
                 created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            """,
            new_id,
            org_id,
            user_id,
            session_id,
            title,
        )
    except Exception as exc:
        logger.debug("_trace_common: upsert_conversation failed: %s", exc)
        return None
    return new_id


# ── Event serialisation ────────────────────────────────────────────


# JSONB columns that may contain datetimes / custom types
# (asyncpg returns them as Python objects). We coerce to safe
# primitives so the response is JSON-serialisable.
def _serialise_value(v: Any) -> Any:
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, dict):
        return {k: _serialise_value(val) for k, val in v.items()}
    if isinstance(v, (list, tuple)):
        return [_serialise_value(x) for x in v]
    return str(v)


def serialise_event(row: dict[str, Any]) -> dict[str, Any]:
    """Turn a ``telemetry_events`` DB row into a JSON-safe dict.

    Drops ``tenant_id`` (the caller already has it) and
    ``project_id`` (not surfaced in the replay view), and
    coerces datetimes + nested dicts via :func:`_serialise_value`.
    """
    out: dict[str, Any] = {}
    for k, v in row.items():
        if k in ("tenant_id", "project_id"):
            continue
        out[k] = _serialise_value(v)
    return out


# ── Tag-merge helper for CustomPropertiesService ──────────────────


async def fetch_trace_tags(
    org_id: str,
    trace_id: str,
) -> dict[str, str]:
    """Return the merged tag map for one (org, trace).

    Reads the first event for the trace and flattens its
    ``tags`` JSONB column from ``[{key, value}, ...]`` (or
    ``{key: value}``) to a single ``dict[str, str]``.

    If the column is missing or malformed, returns an empty
    dict — the caller treats that as "no tags yet".
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return {}
    client = await get_postgres_client()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            """
            SELECT tags FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY timestamp ASC
            LIMIT 1
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("_trace_common: fetch_trace_tags failed: %s", exc)
        return {}
    if row is None:
        return {}
    tags = row.get("tags")
    return _flatten_tags(tags)


async def merge_trace_tags(
    org_id: str,
    trace_id: str,
    new_tags: dict[str, str],
) -> bool:
    """Merge ``new_tags`` into the ``tags`` column on every
    event for one (org, trace). Returns ``True`` on success.

    The tags column shape is normalised to
    ``{key: value}`` — we don't keep the existing
    ``[{key, value}, ...]`` shape because the front-end
    treats it as a flat dict.
    """
    existing = await fetch_trace_tags(org_id, trace_id)
    merged = {**existing, **new_tags}
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("_trace_common: postgres import failed: %s", exc)
        return False
    client = await get_postgres_client()
    if client is None:
        return False
    try:
        await client.execute(
            """
            UPDATE telemetry_events
            SET tags = $3::jsonb
            WHERE tenant_id = $1 AND trace_id = $2
            """,
            org_id,
            trace_id,
            json.dumps(merged, ensure_ascii=False),
        )
    except Exception as exc:
        logger.debug("_trace_common: merge_trace_tags failed: %s", exc)
        return False
    return True


def _flatten_tags(raw: Any) -> dict[str, str]:
    """Normalise a JSONB ``tags`` column to ``dict[str, str]``.

    Accepts ``{key: value}`` (preferred) or
    ``[{key, value}, ...]`` (legacy / Helicone-style). Unknown
    shapes yield an empty dict.
    """
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return {str(k): str(v) for k, v in raw.items()}
    if isinstance(raw, list):
        out: dict[str, str] = {}
        for item in raw:
            if isinstance(item, dict):
                k = item.get("key") or item.get("name") or item.get("k")
                v = item.get("value") or item.get("v") or item.get("val")
                if k is not None and v is not None:
                    out[str(k)] = str(v)
            elif isinstance(item, str):
                # Tag with no value — index it as itself.
                out[item] = ""
        return out
    return {}


# ── JSON helper ─────────────────────────────────────────────────────


def json_dumps(obj: Any) -> str:
    """JSON serialiser with a stable, Postgres-friendly default."""
    return json.dumps(obj, default=str, ensure_ascii=False)
