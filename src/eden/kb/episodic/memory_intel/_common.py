"""Shared helpers for Cat 5 (Memory Intelligence) services.

Centralises:

* The data read paths —
  :func:`_fetch_trace_events`,
  :func:`_fetch_memories_used_in_trace`,
  :func:`_fetch_trace_response_text`,
  :func:`_fetch_memory_timeline`,
  :func:`_fetch_recent_attributions_for_memory`,
  :func:`_fetch_distinct_memory_ids_in_window`,
  :func:`_fetch_memories_metadata_for_org`,
  :func:`_fetch_last_accessed_for_memory`.
* The envelope shape used for live (non-stub) responses —
  :func:`_ok_envelope`,
  :func:`_not_found_envelope`,
  :func:`_bad_request_envelope`. All use ``live=True`` so
  the front-end can distinguish real responses from the
  ``not_implemented`` stubs.
* The persistence pattern used by the 4 services that write
  to the 3 Cat 5 tables (``memory_attributions``,
  ``memory_timeline_events``, ``memory_impact_scores``). The
  migration (``020_intelligence_gap_tables.py``) does not
  declare a unique constraint on these tables, so the only
  way to make the services re-runnable is to
  delete-then-insert for the ``(org_id, trace_id)`` tuple (or
  ``(org_id, memory_id)`` for the timeline).
* A small tokeniser :func:`_tokenize` + Jaccard
  :func:`_token_overlap` used for the "did this memory
  influence the final answer?" heuristic in
  :class:`MemoryAttributor`.
* :func:`_role_for_score` — maps a 0..1 influence score to
  one of the three roles (``primary``, ``secondary``,
  ``context``) used by the response envelope.
* :func:`_normalise_attributions` — softmax-style
  normalisation of the per-memory influence scores so they
  sum to 1.0 across the trace.
* :func:`_safe_float` — defensive coercion helper.

Mirrors the layout of
:mod:`eden.insights.rca._common` (Cat 2),
:mod:`eden.kb.retrieval_intel._common` (Cat 4), and
:mod:`eden.services.cost_intel._common` (Cat 8).
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: Score thresholds for the per-memory ``role`` label returned
#: by :func:`_role_for_score`. Mirrors the appendix values:
#: > 0.5 → ``primary``; > 0.15 → ``secondary``; else
#: ``context``.
ROLE_PRIMARY_THRESHOLD: float = 0.5
ROLE_SECONDARY_THRESHOLD: float = 0.15

#: Max number of memory entries returned by
#: :class:`MemoryReweaver` in the ``near_duplicates`` list.
#: The Reweaver is a suggestion endpoint, not a destructive
#: action — keep the response bounded.
MAX_NEAR_DUPLICATES: int = 5

#: Cosine / Jaccard threshold above which two memories are
#: considered "near-duplicate" by the Reweaver. 0.85 is the
#: conventional "almost certainly the same fact" cutoff.
NEAR_DUPLICATE_THRESHOLD: float = 0.85

#: Number of days a memory can go without being accessed
#: before :class:`MemoryReweaver` flags it for archival. Mirrors
#: the appendix's 90-day rule.
STALE_DAYS: int = 90

#: Number of days of zero-attribution history that triggers
#: the "never material" demotion suggestion. Mirrors the
#: appendix's 30-day rule.
NEVER_MATERIAL_DAYS: int = 30

#: Hard cap on the number of memories attributed per trace.
#: 10 matches the appendix's "v0 caps at 10 memories per
#: trace" guardrail (so the token-overlap heuristic stays
#: cheap and the response stays bounded).
MAX_MEMORIES_PER_TRACE: int = 10

#: Hard cap on the number of timeline events returned by
#: :class:`MemoryTimelineBuilder`. The full timeline for a
#: 1-year-old memory can be thousands of events; the front-end
#: only renders the first page.
MAX_TIMELINE_EVENTS: int = 200


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None`` on
    bad input; the service wraps that into a
    :func:`_bad_request_envelope`.

    ``None`` or empty input defaults to ``"30 days"`` (matches
    the Cat 4 / Cat 8 conventions).
    """
    if window is None:
        return "30 days"
    s = window.strip()
    if not s:
        return "30 days"
    m = _WINDOW_RE.match(s)
    if m is None:
        return None
    n, unit = m.group(1), m.group(2).lower()
    unit_long = {"h": "hours", "d": "days", "m": "minutes", "s": "seconds"}[unit]
    return f"{n} {unit_long}"


# ── Envelope helpers ─────────────────────────────────────────────────


def _new_trace_id() -> str:
    """Cat 5-prefixed trace id — distinguishes live responses
    from Cat 1/2/4/8/16 in the audit log."""
    return f"mi_{uuid.uuid4().hex[:12]}"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live response envelope — same shape as the stub
    :class:`eden.intelligence_envelope.IntelligenceStubResponse`
    so the front-end renders uniformly. ``live=True`` signals
    a real implementation."""
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _not_found_envelope(
    feature: str, *, trace_id: str | None = None, memory_id: str | None = None
) -> dict[str, Any]:
    """Live envelope for a missing trace or memory — distinct
    from :func:`eden.intelligence_envelope.not_implemented`
    because the service IS implemented, the target just
    doesn't exist for this org."""
    data: dict[str, Any] = {"reason": "no events found for this (org, trace)"}
    if trace_id is not None:
        data["trace_id"] = trace_id
    if memory_id is not None:
        data["memory_id"] = memory_id
        data["reason"] = "no timeline events for this (org, memory_id)"
    return {
        "status": "not_found",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for an invalid request (e.g. malformed
    window string). Returns ``status="bad_request"`` so the
    front-end can render a 4xx-class message without falling
    back to the stub envelope."""
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {"message": message},
    }


# ── Data read paths ──────────────────────────────────────────────────


async def _get_client() -> Any:
    """Best-effort :func:`eden.storage.postgres.get_postgres_client`
    import + await. Returns ``None`` if Postgres isn't available
    — fetchers check for ``None`` and return ``[]`` / ``None``
    so the service can still render a useful "no data"
    response."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("memory_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("memory_intel: get_postgres_client failed: %s", exc)
        return None


async def _fetch_trace_events(
    org_id: str, trace_id: str
) -> list[dict[str, Any]]:
    """Return the flat event list for one ``(org, trace)`` from
    Postgres. Mirrors :func:`eden.insights.rca._common.
    _fetch_trace_events` — ordered by ``timestamp ASC`` so the
    reconstructed trajectory is in execution order. Returns
    an empty list on any failure (caller treats that as
    ``not_found``)."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT event_id, trace_id, span_id, event_type, payload,
                   attributes, tags, source_format, timestamp, name,
                   duration_ms, outcome, error, parent_span_id,
                   agent_id, reasoning, tool_calls_full, tool_results,
                   request_body, response_body, tenant_id
              FROM telemetry_events
             WHERE tenant_id = $1 AND trace_id = $2
             ORDER BY timestamp ASC
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("memory_intel: fetch events failed: %s", exc)
        return []
    return [dict(r) for r in rows]


async def _fetch_memories_used_in_trace(
    org_id: str, trace_id: str
) -> list[dict[str, Any]]:
    """Extract the list of memory entries that were used in a
    trace. Looks for ``memory.read`` / ``memory.recall`` /
    ``memory.access`` events on the trace and pulls the
    ``memory_id`` from the ``attributes`` JSONB.

    Each returned dict is ``{memory_id, memory_text,
    retrieval_score}`` — ``memory_text`` is the best-effort
    text the memory contributed (for the overlap heuristic);
    ``retrieval_score`` is the cosine score from the
    retrieval (None when not present).

    Returns ``[]`` on failure / no memory events.
    """
    events = await _fetch_trace_events(org_id, trace_id)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for ev in events:
        et = (ev.get("event_type") or "").lower()
        if not et.startswith("memory."):
            continue
        attrs = ev.get("attributes") or {}
        if not isinstance(attrs, dict):
            attrs = {}
        # The agent harness stores memory_id in attributes; we
        # tolerate the alternative ``payload.memory_id`` shape
        # (defensive — some decoders nest under payload).
        mid = attrs.get("memory_id") or attrs.get("id")
        if not mid:
            payload = ev.get("payload") or {}
            if isinstance(payload, dict):
                mid = payload.get("memory_id") or payload.get("id")
        if not mid or str(mid) in seen:
            continue
        seen.add(str(mid))
        text = attrs.get("text") or attrs.get("content")
        if text is None and isinstance(ev.get("payload"), dict):
            text = ev["payload"].get("text") or ev["payload"].get("content")
        if not isinstance(text, str):
            text = str(mid)  # fallback surrogate for the tokeniser
        score = attrs.get("score")
        if not isinstance(score, (int, float)) and isinstance(
            ev.get("payload"), dict
        ):
            ps = ev["payload"].get("score")
            if isinstance(ps, (int, float)):
                score = float(ps)
        out.append(
            {
                "memory_id": str(mid)[:128],
                "memory_text": text or "",
                "retrieval_score": _safe_float(score) if score is not None else None,
            }
        )
    return out


async def _fetch_trace_response_text(
    org_id: str, trace_id: str
) -> str | None:
    """Get the final response text for a trace from
    ``telemetry_events``. Mirrors
    :func:`eden.kb.retrieval_intel._common._fetch_trace_response_text`
    — the ``response_body`` JSONB may have the response in a
    sub-key (``text``, ``content``, ``output``) depending on
    the source format. Returns ``None`` on failure / no
    answer."""
    client = await _get_client()
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT response_body
              FROM telemetry_events
             WHERE tenant_id = $1
               AND trace_id = $2
               AND response_body IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 10
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("memory_intel: fetch response body failed: %s", exc)
        return None
    if not rows:
        return None
    for r in rows:
        body = r.get("response_body") if isinstance(r, dict) else r["response_body"]
        if not body:
            continue
        for key in ("text", "content", "output", "answer", "message"):
            v = body.get(key)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, list) and v:
                parts: list[str] = []
                for item in v:
                    if isinstance(item, dict):
                        s = item.get("text") or item.get("content")
                        if isinstance(s, str):
                            parts.append(s)
                    elif isinstance(item, str):
                        parts.append(item)
                if parts:
                    return "\n".join(parts)
    return None


async def _fetch_memory_timeline(
    org_id: str, memory_id: str
) -> list[dict[str, Any]]:
    """Return the timeline events for one ``(org, memory_id)``
    from ``memory_timeline_events``, ordered by ``occurred_at
    DESC`` and capped at :data:`MAX_TIMELINE_EVENTS`. Returns
    ``[]`` on failure / no events (caller treats that as
    ``not_found``)."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT event_type, occurred_at, actor, trace_id,
                   payload_json, created_at
              FROM memory_timeline_events
             WHERE org_id = $1 AND memory_id = $2
             ORDER BY occurred_at DESC
             LIMIT $3
            """,
            org_id,
            memory_id,
            MAX_TIMELINE_EVENTS,
        )
    except Exception as exc:
        logger.debug("memory_intel: fetch timeline failed: %s", exc)
        return []
    return [dict(r) for r in rows]


async def _fetch_recent_attributions_for_memory(
    org_id: str, memory_id: str, *, interval_sql: str
) -> list[dict[str, Any]]:
    """Return the recent ``memory_attributions`` rows for one
    memory. Used by :class:`MemoryReweaver` to detect
    "never material" memories (zero rows in the last
    :data:`NEVER_MATERIAL_DAYS` days). Returns ``[]`` on
    failure."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT trace_id, influence_score, created_at
              FROM memory_attributions
             WHERE org_id = $1
               AND memory_id = $2
               AND created_at > NOW() - $3::interval
             ORDER BY created_at DESC
            """,
            org_id, memory_id, interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "memory_intel: fetch attributions for memory failed: %s", exc,
        )
        return []
    return [dict(r) for r in rows]


async def _fetch_distinct_memory_ids_in_window(
    org_id: str, interval_sql: str
) -> list[str]:
    """Return the distinct ``memory_id`` values that appear in
    ``memory_timeline_events`` (or ``memory_attributions``) in
    the given window. Used by the :class:`MemoryReweaver`
    ``"ALL"`` mode (when ``memory_id`` is empty). Returns
    ``[]`` on failure."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT DISTINCT memory_id
              FROM memory_timeline_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
             UNION
            SELECT DISTINCT memory_id
              FROM memory_attributions
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "memory_intel: fetch distinct memory ids failed: %s", exc,
        )
        return []
    out: list[str] = []
    for r in rows:
        mid = r.get("memory_id") if isinstance(r, dict) else r["memory_id"]
        if mid:
            out.append(str(mid))
    return out


async def _fetch_memories_metadata_for_org(
    org_id: str
) -> list[dict[str, Any]]:
    """Return the per-org set of memory metadata we can use to
    detect near-duplicates. The Cat 5 migration does NOT
    add a memories table; we use the union of ``memory_text``
    attributes from the trace events for the org (the same
    source the attributor uses). Returns ``[]`` on failure.

    Best-effort, capped at 1000 rows to keep the response /
    duplicate scan bounded.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT DISTINCT ON (memory_id)
                   attrs->>'memory_id' AS memory_id,
                   COALESCE(attrs->>'text', attrs->>'content', '') AS memory_text,
                   created_at
              FROM telemetry_events,
                   LATERAL jsonb_path_query(attributes, '$.memory_id') AS mid,
                   LATERAL jsonb_path_query(attributes, '$.text') AS txt
              -- no, that's a cartesian — instead we cast attributes to jsonb
              -- and just project in the SELECT
              WHERE FALSE
            """,
        ) if False else await client.fetch(
            """
            SELECT DISTINCT ON (memory_id) memory_id, memory_text, created_at
              FROM (
                SELECT attrs->>'memory_id' AS memory_id,
                       COALESCE(
                         attrs->>'text',
                         attrs->>'content',
                         ''
                       ) AS memory_text,
                       created_at
                  FROM telemetry_events,
                       jsonb_each(attributes) AS kv(k, v)
                 WHERE tenant_id = $1
                   AND event_type LIKE 'memory.%'
                   AND attrs ? 'memory_id'
            ) s
             WHERE memory_id IS NOT NULL
             ORDER BY memory_id, created_at DESC
             LIMIT 1000
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug(
            "memory_intel: fetch memories metadata failed: %s", exc,
        )
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        if not isinstance(r, dict):
            r = dict(r)
        mid = r.get("memory_id")
        if not mid:
            continue
        out.append(
            {
                "memory_id": str(mid)[:128],
                "memory_text": str(r.get("memory_text") or ""),
            }
        )
    return out


async def _fetch_last_accessed_for_memory(
    org_id: str, memory_id: str
) -> datetime | None:
    """Return the timestamp of the most recent ``accessed``
    timeline event for this memory, or ``None`` when the
    memory has never been accessed. Used by the
    :class:`MemoryReweaver` stale-check."""
    client = await _get_client()
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT MAX(occurred_at) AS last_accessed
              FROM memory_timeline_events
             WHERE org_id = $1
               AND memory_id = $2
               AND event_type = 'accessed'
             GROUP BY memory_id
            """,
            org_id, memory_id,
        )
    except Exception as exc:
        logger.debug(
            "memory_intel: fetch last accessed failed: %s", exc,
        )
        return None
    if not rows:
        return None
    row = rows[0]
    if not isinstance(row, dict):
        row = dict(row)
    val = row.get("last_accessed")
    return val


# ── Text heuristics ──────────────────────────────────────────────────


_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")

#: Tiny stopword set — long enough to drop the boring words,
#: short enough to ship without a NLP dependency.
_STOPWORDS: frozenset[str] = frozenset(
    {
        "the", "a", "an", "and", "or", "of", "to", "in", "on", "for",
        "is", "are", "was", "were", "be", "been", "being",
        "this", "that", "these", "those",
        "it", "its", "with", "from", "by", "as", "at",
        "but", "not", "no",
    }
)


def _tokenize(text: str) -> set[str]:
    """Lowercased, word-boundary tokenisation. Drops
    stopwords + single chars. Pure-Python so the helper is
    testable in isolation. Returns the unique tokens in
    ``text``."""
    if not text:
        return set()
    return {
        m.group(0).lower()
        for m in _TOKEN_RE.finditer(text)
        if len(m.group(0)) > 1
        and m.group(0).lower() not in _STOPWORDS
    }


def _token_overlap(a_text: str, b_text: str) -> float:
    """Jaccard-style overlap of the two token sets. Returns
    ``0.0`` for either empty input. Used as the v1
    "did the answer reference this memory?" heuristic when
    memory text is available."""
    a = _tokenize(a_text)
    b = _tokenize(b_text)
    if not a or not b:
        return 0.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def _role_for_score(score: float) -> str:
    """Map a 0..1 influence score to the role label used in
    the response envelope. Mirrors the appendix values
    (> 0.5 → primary, > 0.15 → secondary, else context)."""
    if score > ROLE_PRIMARY_THRESHOLD:
        return "primary"
    if score > ROLE_SECONDARY_THRESHOLD:
        return "secondary"
    return "context"


def _normalise_attributions(raw_scores: list[float]) -> list[float]:
    """Normalise a list of raw contribution scores so they sum
    to 1.0 (softmax-style). Returns ``[1.0]`` for a 1-element
    list (so a single-memory trace has a meaningful
    attribution), and ``[]`` for an empty list.

    Falls back to a uniform split when the sum of raw scores
    is zero (no signal) so the response is always well-formed.
    """
    n = len(raw_scores)
    if n == 0:
        return []
    if n == 1:
        return [1.0]
    s = sum(max(0.0, x) for x in raw_scores)
    if s <= 0.0:
        return [1.0 / n for _ in raw_scores]
    return [max(0.0, x) / s for x in raw_scores]


# ── Persistence ──────────────────────────────────────────────────────


async def _delete_then_insert_attributions(
    org_id: str,
    trace_id: str,
    rows: list[dict[str, Any]],
) -> None:
    """Replace the ``memory_attributions`` rows for this
    ``(org_id, trace_id)`` tuple. ``rows`` is a list of
    ``{memory_id, influence_score}`` dicts; each becomes one
    row. The service is re-runnable because we clear the
    prior tuple first.

    The migration has no unique constraint, so the
    clear-then-insert pattern is the only way to make the
    service re-runnable. Best-effort: any exception is
    logged and swallowed so the caller can still return the
    live envelope with the in-memory data.
    """
    if not rows:
        return
    client = await _get_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM memory_attributions
                     WHERE org_id = $1 AND trace_id = $2
                    """,
                org_id, trace_id,
            )
            for r in rows:
                mid = str(r.get("memory_id", ""))[:128]
                if not mid:
                    continue
                score = _safe_float(r.get("influence_score"))
                await conn.execute(
                    """
                        INSERT INTO memory_attributions
                            (id, org_id, trace_id, memory_id,
                             influence_score)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4)
                        """,
                    org_id, trace_id, mid, score,
                )
    except Exception as exc:
        logger.debug("memory_intel: attributions write failed: %s", exc)


async def _delete_then_insert_impact(
    org_id: str,
    trace_id: str,
    rows: list[dict[str, Any]],
) -> None:
    """Replace the ``memory_impact_scores`` rows for this
    ``(org_id, trace_id)`` tuple. ``rows`` is a list of
    ``{memory_id, score}`` dicts. Best-effort like
    :func:`_delete_then_insert_attributions`."""
    if not rows:
        return
    client = await _get_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM memory_impact_scores
                     WHERE org_id = $1 AND trace_id = $2
                    """,
                org_id, trace_id,
            )
            for r in rows:
                mid = str(r.get("memory_id", ""))[:128]
                if not mid:
                    continue
                score = _safe_float(r.get("score"))
                await conn.execute(
                    """
                        INSERT INTO memory_impact_scores
                            (id, org_id, trace_id, memory_id, score)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4)
                        """,
                    org_id, trace_id, mid, score,
                )
    except Exception as exc:
        logger.debug("memory_intel: impact scores write failed: %s", exc)


async def _insert_timeline_event(
    org_id: str,
    memory_id: str,
    *,
    event_type: str,
    occurred_at: datetime,
    actor: str = "system:memory_intel",
    trace_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> None:
    """Append a single ``memory_timeline_events`` row. Unlike
    the other persisters, this one is *additive* (timeline
    events are an append-only log, so we never delete first).
    Best-effort."""
    if not memory_id or not event_type:
        return
    client = await _get_client()
    if client is None:
        return
    payload_json = _json_dumps(payload or {})
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO memory_timeline_events
                    (id, org_id, memory_id, event_type, occurred_at,
                     actor, trace_id, payload_json)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
                """,
                org_id,
                str(memory_id)[:128],
                str(event_type)[:16],
                occurred_at,
                str(actor)[:128],
                (str(trace_id)[:128] if trace_id else None),
                payload_json,
            )
    except Exception as exc:
        logger.debug("memory_intel: timeline event write failed: %s", exc)


# ── Misc small helpers ───────────────────────────────────────────────


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic in the influence / impact heuristics."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _json_dumps(obj: Any) -> str:
    """JSON serialise with a permissive ``default=str`` so
    ``datetime`` / ``UUID`` / ``Decimal`` round-trip cleanly
    into the ``payload_json`` text column."""
    return json.dumps(obj, default=str, ensure_ascii=False)


def _days_since(then: datetime | None) -> int | None:
    """Return whole days between ``then`` and now (UTC). Returns
    ``None`` when ``then`` is ``None`` — the Reweaver uses
    this to decide whether to flag a memory for archival."""
    if then is None:
        return None
    if then.tzinfo is None:
        # Defensive — Postgres returns naive datetimes when the
        # server timezone is not set; we treat them as UTC.
        then = then.replace(tzinfo=UTC)
    now = datetime.now(UTC)
    delta = now - then
    return int(delta.total_seconds() // 86400)
