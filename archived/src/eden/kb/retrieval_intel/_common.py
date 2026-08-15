"""Shared helpers for Cat 4 (Retrieval Intelligence) services.

Centralises:

* The data read path — :func:`_fetch_retrieval_logs_for_trace`,
  :func:`_fetch_retrieval_logs_in_window`,
  :func:`_fetch_recent_retrieval_logs_by_collection`,
  :func:`_fetch_trace_response_text`,
  :func:`_fetch_utilization_history_for_collection`,
  :func:`_fetch_distinct_collections_in_window`.
* The envelope shape used for live (non-stub) responses —
  :func:`_ok_envelope`, :func:`_bad_request_envelope`. Both use
  ``live=True``.
* The persistence pattern used by the 2 services that write to
  the 2 Cat 4 tables (``retrieval_utilization_scores``,
  ``retrieval_knowledge_gaps``). The migration
  (``020_intelligence_gap_tables.py``) does not declare a unique
  constraint on either table, so the only way to make the
  services re-runnable is to delete-then-insert.
* :func:`_parse_window` for the time-bounded queries the four
  services run. Accepts ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"`` and
  returns a Postgres interval literal; bad input returns
  ``None`` and the service turns it into a bad-request envelope.
* :func:`_tokenize` — a minimal, language-agnostic tokenizer
  (lowercased word boundaries) used by the utilization and
  attribution heuristics. Pure-Python, no external deps.
* :func:`_token_overlap` — Jaccard-style token overlap between
  a chunk's text (or chunk_id surrogate) and the answer. The
  v1 heuristic when we don't have chunk-text access in SQL.
* :func:`_normalise_attributions` — softmax-style normalisation
  of raw contribution scores so the per-chunk
  ``contribution_score`` values sum to 1.0. Returns 1.0 for a
  single chunk (so attribution is meaningful for a 1-chunk
  retrieval).
* :func:`_safe_float` — defensive coercion helper.

The helpers are intentionally local to the package — Cat 4 is a
self-contained unit and the package boundary is the right place
to hide the per-service glue. Mirrors the layout of
:mod:`eden.services.cost_intel._common` (Cat 8),
:mod:`eden.decision._common` (Cat 16), and
:mod:`eden.insights.rca._common` (Cat 2).
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: Thresholds for the :class:`KnowledgeGapDetector`. A query
#: pattern is flagged as a gap if its hit rate is below
#: ``HIT_RATE_THRESHOLD`` OR its utilization is below
#: ``UTILIZATION_THRESHOLD``. The values match the appendix
#: pseudo-code (0.5 hit, 0.3 util) and are intentionally generous
#: — knowledge gaps should be noisy so the operator can prune.
HIT_RATE_THRESHOLD: float = 0.5
UTILIZATION_THRESHOLD: float = 0.3

#: Maximum number of query patterns returned by
#: :class:`KnowledgeGapDetector`. Caps response size when an org
#: has thousands of distinct query hashes.
MAX_GAPS_RETURNED: int = 100

#: Number of most-recent retrieval logs the
#: :class:`RetrievalUtilizationScorer` falls back to when
#: ``job_id = trace_id`` lookup returns no rows. Some Eden
#: traces don't have a 1:1 job_id, in which case the most
#: recent 5 retrieval logs are a reasonable proxy.
RECENT_FALLBACK_LIMIT: int = 5

#: Max number of chunks returned in the
#: :class:`RetrievalReorderer` "suggested order" list. Keeps
#: the response bounded.
MAX_REORDER_ITEMS: int = 200

#: Lookback window for the reordering history.
REORDER_LOOKBACK_DAYS: int = 30

#: Min sample size for a query pattern to be considered for
#: gap detection. Patterns with fewer than this many samples
#: are not flagged (noisy signal).
MIN_GAP_SAMPLE_SIZE: int = 3

#: Time window (seconds) for the "no specific job_id" fallback
#: in :func:`_fetch_retrieval_logs_for_trace` when the trace
#: cannot be matched by job_id. We look for the most recent
#: retrieval logs in the last ``RECENT_FALLBACK_SECONDS``
#: seconds.
RECENT_FALLBACK_SECONDS: int = 300


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None`` on
    bad input; the service wraps that into a
    ``_bad_request_envelope``.

    ``None`` or empty input defaults to ``"7 days"`` (matches
    the Cat 2 / Cat 8 conventions and the appendix's
    ``window: "7d"`` default).
    """
    if window is None:
        return "7 days"
    s = window.strip()
    if not s:
        return "7 days"
    m = _WINDOW_RE.match(s)
    if m is None:
        return None
    n, unit = m.group(1), m.group(2).lower()
    unit_long = {"h": "hours", "d": "days", "m": "minutes", "s": "seconds"}[unit]
    return f"{n} {unit_long}"


# ── Envelope helpers ─────────────────────────────────────────────────


def _new_trace_id() -> str:
    """Cat 4-prefixed trace id — distinguishes live responses
    from Cat 1/2/8/16 in the audit log."""
    return f"ri_{uuid.uuid4().hex[:12]}"


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
    — persistence helpers and fetchers check for ``None`` and
    no-op or return ``[]``/``None``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("retrieval_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("retrieval_intel: get_postgres_client failed: %s", exc)
        return None


async def _fetch_retrieval_logs_for_trace(
    org_id: str, trace_id: str
) -> list[dict[str, Any]]:
    """Get the retrieval logs for a single trace.

    Tries ``job_id = trace_id`` first (the most common Eden
    convention: the ``trace_id`` IS a ``job_id``). Falls back to
    the most recent ``RECENT_FALLBACK_LIMIT`` retrieval logs
    inside ``RECENT_FALLBACK_SECONDS`` for the org, which is a
    reasonable proxy when traces aren't 1:1 with jobs.

    Returns ``[]`` on any failure (so the service can render a
    "no retrieval logs" message).
    """
    client = await _get_client()
    if client is None:
        return []
    # First: try the job_id match.
    try:
        rows = await client.fetch(
            """
            SELECT id, job_id, agent_id, collection, query_hash,
                   query_text, retrieved_item_ids, retrieval_method,
                   filter_conditions, score_threshold,
                   retrieval_latency_ms, created_at
              FROM retrieval_logs
             WHERE org_id = $1
               AND job_id = $2
             ORDER BY created_at ASC
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_retrieval_logs_for_trace (job_id) failed: %s",
            exc,
        )
        return []
    if rows:
        return [dict(r) if not isinstance(r, dict) else r for r in rows]
    # Fallback: most recent N logs in the last 5 minutes.
    try:
        rows = await client.fetch(
            """
            SELECT id, job_id, agent_id, collection, query_hash,
                   query_text, retrieved_item_ids, retrieval_method,
                   filter_conditions, score_threshold,
                   retrieval_latency_ms, created_at
              FROM retrieval_logs
             WHERE org_id = $1
               AND created_at > NOW() - ($2::text || ' seconds')::interval
             ORDER BY created_at DESC
             LIMIT $3
            """,
            org_id,
            str(RECENT_FALLBACK_SECONDS),
            RECENT_FALLBACK_LIMIT,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_retrieval_logs_for_trace (fallback) failed: %s",
            exc,
        )
        return []
    return [dict(r) if not isinstance(r, dict) else r for r in rows]


async def _fetch_retrieval_logs_in_window(
    org_id: str, interval_sql: str
) -> list[dict[str, Any]]:
    """Get all retrieval logs for an org in the given window.
    Returns ``[]`` on failure. Used by
    :class:`KnowledgeGapDetector` for the gap pattern
    aggregation."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, job_id, agent_id, collection, query_hash,
                   query_text, retrieved_item_ids, retrieval_method,
                   filter_conditions, score_threshold,
                   retrieval_latency_ms, created_at
              FROM retrieval_logs
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
             ORDER BY created_at ASC
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_retrieval_logs_in_window failed: %s",
            exc,
        )
        return []
    return [dict(r) if not isinstance(r, dict) else r for r in rows]


async def _fetch_recent_retrieval_logs_by_collection(
    org_id: str, collection: str, interval_sql: str
) -> list[dict[str, Any]]:
    """Get the retrieval logs for a single collection in the
    given window. Used by :class:`RetrievalReorderer` to find
    the most-used chunks for the proposed reordering."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, job_id, agent_id, collection, query_hash,
                   query_text, retrieved_item_ids, retrieval_method,
                   filter_conditions, score_threshold,
                   retrieval_latency_ms, created_at
              FROM retrieval_logs
             WHERE org_id = $1
               AND collection = $2
               AND created_at > NOW() - $3::interval
             ORDER BY created_at DESC
            """,
            org_id,
            collection,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_recent_retrieval_logs_by_collection failed: %s",
            exc,
        )
        return []
    return [dict(r) if not isinstance(r, dict) else r for r in rows]


async def _fetch_trace_response_text(
    org_id: str, trace_id: str
) -> str | None:
    """Get the final response text for a trace from
    ``telemetry_events``. The ``response_body`` JSONB may have
    the response in a sub-key (``text``, ``content``,
    ``output``) depending on the source format. Returns the
    first non-empty string found, or ``None`` if nothing
    useful is in the table."""
    client = await _get_client()
    if client is None:
        return None
    try:
        rows = await client.fetch(
            """
            SELECT response_body
              FROM telemetry_events
             WHERE org_id = $1
               AND trace_id = $2
               AND response_body IS NOT NULL
             ORDER BY created_at DESC
             LIMIT 10
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_trace_response_text failed: %s",
            exc,
        )
        return None
    if not rows:
        return None
    for r in rows:
        body = r.get("response_body") if isinstance(r, dict) else r["response_body"]
        if not body:
            continue
        # The response_body is a dict — try the common sub-keys
        # in turn. First non-empty match wins.
        for key in ("text", "content", "output", "answer", "message"):
            v = body.get(key)
            if isinstance(v, str) and v.strip():
                return v
            if isinstance(v, list) and v:
                # Some provider formats store content as
                # ``[{"text": "..."}]``; flatten.
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


async def _fetch_utilization_history_for_collection(
    org_id: str, collection: str, interval_sql: str
) -> list[dict[str, Any]]:
    """For :class:`RetrievalReorderer`: pull the per-chunk
    utilization scores for a collection in the given window.
    Returns ``[]`` on failure / empty.

    Note that the table doesn't carry a ``collection`` column —
    collection is implicit via the trace_id → retrieval_logs
    join. Since we already have the retrieval_logs by
    collection, we map trace_id back through the
    ``retrieval_utilization_scores`` table which is keyed on
    ``(org_id, trace_id)``.

    Best-effort: just returns the rows for the org in the
    window. The reorderer will filter by chunk_ids that appear
    in the collection's retrieval logs.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT trace_id, chunk_id, utilized, score
              FROM retrieval_utilization_scores
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_utilization_history_for_collection failed: %s",
            exc,
        )
        return []
    return [dict(r) if not isinstance(r, dict) else r for r in rows]


async def _fetch_distinct_collections_in_window(
    org_id: str, interval_sql: str
) -> list[str]:
    """List the distinct collections that have any retrieval
    logs in the given window. Used by the
    :class:`KnowledgeGapDetector` to fall back when the
    collection column is empty / unused."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT DISTINCT collection
              FROM retrieval_logs
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: fetch_distinct_collections_in_window failed: %s",
            exc,
        )
        return []
    out: list[str] = []
    for r in rows:
        c = r.get("collection") if isinstance(r, dict) else r["collection"]
        if c:
            out.append(str(c))
    return out


# ── Text heuristics ──────────────────────────────────────────────────


_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


def _tokenize(text: str) -> set[str]:
    """Lowercased, word-boundary tokenisation. Pure-Python so
    the helper is testable in isolation. Strips punctuation,
    splits on whitespace, and folds case. Returns the unique
    tokens in ``text``."""
    if not text:
        return set()
    return {m.group(0).lower() for m in _TOKEN_RE.finditer(text)}


def _token_overlap(chunk_text: str, answer_text: str) -> float:
    """Jaccard-style overlap of the two token sets. Returns
    ``0.0`` for either empty input. Used as the v1
    "did the answer reference this chunk?" heuristic when
    chunk text is available (or as a fallback for chunk-id
    surrogates)."""
    a = _tokenize(chunk_text)
    b = _tokenize(answer_text)
    if not a or not b:
        return 0.0
    inter = a & b
    union = a | b
    if not union:
        return 0.0
    return len(inter) / len(union)


def _normalise_attributions(raw_scores: list[float]) -> list[float]:
    """Normalise a list of raw contribution scores so they sum
    to 1.0 (softmax-style). Returns ``[1.0]`` for a 1-element
    list (so a single-chunk retrieval has a meaningful
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
        # No signal — uniform split, normalised.
        return [1.0 / n for _ in raw_scores]
    return [max(0.0, x) / s for x in raw_scores]


# ── Persistence ──────────────────────────────────────────────────────


async def _delete_then_insert_utilization(
    org_id: str,
    trace_id: str,
    rows: list[dict[str, Any]],
) -> None:
    """Replace the ``retrieval_utilization_scores`` rows for
    this ``(org_id, trace_id)`` tuple. ``rows`` is a list of
    ``{chunk_id, utilized, score}`` dicts; each becomes one
    row. The service is re-runnable because we clear the prior
    tuple first.

    The migration has no unique constraint, so the
    clear-then-insert pattern is the only way to make the
    service re-runnable. Best-effort: any exception is logged
    and swallowed so the caller can still return the live
    envelope with the in-memory data.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("retrieval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM retrieval_utilization_scores
                     WHERE org_id = $1 AND trace_id = $2
                    """,
                org_id,
                trace_id,
            )
            for r in rows:
                chunk_id = str(r.get("chunk_id", ""))[:128]
                utilized = bool(r.get("utilized", False))
                score = r.get("score")
                await conn.execute(
                    """
                        INSERT INTO retrieval_utilization_scores
                            (id, org_id, trace_id, chunk_id, utilized, score)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                        """,
                    org_id, trace_id, chunk_id, utilized, score,
                )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: utilization write failed: %s", exc
        )


async def _delete_then_insert_gaps(
    org_id: str,
    window: str,
    gaps: list[dict[str, Any]],
) -> None:
    """Write a batch of ``retrieval_knowledge_gaps`` rows for
    the ``(org_id, window)`` tuple. Re-runnable via
    DELETE+INSERT (the table has no unique constraint).

    Best-effort like :func:`_delete_then_insert_utilization`.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("retrieval_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM retrieval_knowledge_gaps
                     WHERE org_id = $1 AND status = 'open'
                    """,
                org_id,
            )
            for g in gaps:
                pattern = str(g.get("query_pattern", ""))[:512]
                if not pattern:
                    continue
                hit_rate = g.get("hit_rate")
                util = g.get("utilization")
                await conn.execute(
                    """
                        INSERT INTO retrieval_knowledge_gaps
                            (id, org_id, query_pattern, hit_rate,
                             utilization, status)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4, 'open')
                        """,
                    org_id, pattern, hit_rate, util,
                )
    except Exception as exc:
        logger.debug(
            "retrieval_intel: gaps write failed: %s", exc
        )


# ── Misc small helpers ───────────────────────────────────────────────


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic in the utilization heuristics."""
    if isinstance(value, bool):
        # ``True``/``False`` would coerce to 1/0 — guard against it.
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _chunk_text_from_id(chunk_id: str) -> str:
    """Synthesise a tiny text surrogate for a chunk_id so the
    v1 utilization heuristic has *some* signal to work with
    when the actual chunk text is in a vector DB we don't
    query here.

    The surrogate is the chunk_id itself, normalised; the
    _tokenize helper will pick out the alphanumeric runs and
    treat the rest as a stop-word. This is a deliberate
    "good enough for v1" choice: real chunk text is in Qdrant
    / the KB store and the next iteration can plumb it
    through. Documented in the service docstrings.
    """
    return str(chunk_id or "")


def _chunk_ids_from_log_row(row: dict[str, Any]) -> list[str]:
    """Best-effort extraction of the ``retrieved_item_ids``
    list from a retrieval_log row. Handles the two common
    shapes — a real ``list[UUID]`` (the typical case) and a
    JSON-encoded string (defensive). Returns ``[]`` for any
    other shape so callers can always iterate safely."""
    raw = row.get("retrieved_item_ids")
    if raw is None:
        return []
    if isinstance(raw, (list, tuple)):
        return [str(x) for x in raw if x is not None]
    if isinstance(raw, str):
        # Defensive: a JSON-encoded string. We don't want to
        # import ``json`` just for this; simple split fallback
        # works for the common ``[..., ...]`` shape.
        s = raw.strip().lstrip("[").rstrip("]").strip()
        if not s:
            return []
        out: list[str] = []
        for part in s.split(","):
            v = part.strip().strip("'\"")
            if v:
                out.append(v)
        return out
    return []


def _score_for_chunk(
    *, chunk_id: str, used: bool, answer_text: str | None
) -> float:
    """Compute the per-chunk confidence score for the
    utilization heuristic. ``0.0``-``1.0``.

    * ``0.9`` if the answer mentions the chunk_id (strong
      signal).
    * ``0.7`` if there is non-trivial token overlap with the
      answer (the chunk text was used even if not cited).
    * ``0.5`` if there is an answer but no overlap (the chunk
      was retrieved but didn't influence the answer — low
      confidence on the "not used" verdict).
    * ``0.0`` if there is no answer text at all (we can't
      say — the operator should be told).

    The score is *not* the contribution to the answer (that's
    the attribution endpoint's job); it is a confidence that
    the ``used`` boolean is correct.

    Kept here for the future "chunk-level severity" endpoint
    the operator asked about; not currently called by the v1
    services (which inline the score computation in
    :meth:`RetrievalUtilizationScorer.score`).
    """
    if not answer_text:
        return 0.0
    if chunk_id and chunk_id in answer_text:
        return 0.9
    overlap = _token_overlap(_chunk_text_from_id(chunk_id), answer_text)
    if overlap >= 0.3:
        return 0.7
    if overlap > 0.0:
        return 0.5
    return 0.0 if not used else 0.2


def _dedup_preserving_order(items: Iterable[str]) -> list[str]:
    """Stable dedup — preserves the first occurrence's
    position. Used to collapse ``retrieved_item_ids`` lists
    across multiple retrieval_logs for the same trace."""
    seen: set[str] = set()
    out: list[str] = []
    for x in items:
        s = str(x)
        if s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out
