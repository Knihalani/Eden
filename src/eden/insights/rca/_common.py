"""Shared helpers for Cat 2 (Root Cause Attribution & Incident Clustering) services.

Centralises:

* The trace read path — :func:`_fetch_trace_events`,
  :func:`_fetch_judge_scores`, :func:`_fetch_failed_traces_in_window`.
* The envelope shape used for live (non-stub) responses —
  :func:`_ok_envelope`, :func:`_not_found_envelope`,
  :func:`_bad_request_envelope` (with ``live=True``).
* The persistence pattern used by the 3 services that write to
  the 3 Cat 2 tables (rca_analyses, incident_clusters,
  incident_cluster_members) — the migration
  (020_intelligence_gap_tables.py) does not declare a unique
  constraint on these tables, so the only way to make the
  services re-runnable is to delete-then-insert for the
  ``(org_id, trace_id)`` tuple. The Cat 2 cluster write uses
  the same shape with explicit DELETE ordering (members first,
  then clusters) to avoid FK violations.
* The rule-based pre-filter :func:`_classify_events` shared by
  :class:`eden.insights.rca.analyzer.RootCauseAnalyzer` and
  :class:`eden.insights.incidents.clusterer.IncidentClusterer`.
  The clusterer cannot depend on the analyzer class (it would
  create a cyclic import on services that import ``analyzer``
  for a different reason), so the rule table lives here.
* :func:`_parse_window` for the time-bounded queries the
  clusterer runs.
* A small Jaccard similarity helper :func:`_jaccard_similarity`
  used to compute the secondary similarity score for the
  ``centroid_embedding`` column.

The helpers are intentionally local to the package — Cat 2 is a
self-contained unit and the package boundary is the right place
to hide the per-service glue. Mirrors the layout of
:mod:`eden.decision._common` (Cat 16).
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


#: The six failure categories the rule-based pre-filter can
#: return. Order is the rule-priority order (first match wins);
#: only the categorical label matters, not the priority.
CATEGORIES: tuple[str, ...] = (
    "retrieval",
    "tool",
    "prompt",
    "model",
    "memory",
    "user_issue",
)

#: Hardcoded stopword set for the Jaccard tokeniser. A short
#: 30-word list is enough for English error messages; we don't
#: need a full NLP pipeline to get a useful similarity score.
_JACCARD_STOPWORDS: frozenset[str] = frozenset(
    {
        "the", "a", "an", "and", "or", "of", "to", "in", "on", "for",
        "is", "are", "was", "were", "be", "been", "being",
        "this", "that", "these", "those",
        "it", "its", "with", "from", "by", "as", "at",
        "but", "not", "no",
    }
)

#: Cluster-key version embedded in the deterministic cluster_id
#: hash. Bump this string to invalidate all previously generated
#: cluster IDs (forces a fresh clustering pass).
CLUSTER_KEY_VERSION: str = "v1"

#: Cluster size thresholds for the recursive split. Any bucket
#: larger than this is split on the next field in the key tuple.
MAX_CLUSTER_SIZE: int = 10_000

#: Max recursion depth for the cluster-split fallback chain.
MAX_RECURSION_DEPTH: int = 3

#: Per-category recommended-action text used by
#: :func:`_recommendation_for_category` in the clusterer.
_CATEGORY_RECOMMENDATIONS: dict[str, str] = {
    "tool": "Review the failing tool for timeouts or rate limits.",
    "retrieval": "Check KB freshness and embedding index health.",
    "model": "Investigate the prompt+model combination; consider an A/B test.",
    "user_issue": "Add input validation or a guardrail for the flagged pattern.",
    "memory": "Check memory store connectivity and TTLs.",
    "prompt": "Revert to the last known-good prompt version.",
}


# ── Trace read paths ─────────────────────────────────────────────────


async def _fetch_trace_events(org_id: str, trace_id: str) -> list[dict[str, Any]]:
    """Read the flat event list for one ``(org, trace)`` from Postgres.

    Mirrors :func:`eden.decision._common._fetch_trace_events` —
    ordered by ``timestamp ASC`` so the reconstructed trajectory is
    in execution order. Returns an empty list if Postgres isn't
    available or the trace has no events. Callers should treat
    empty as ``not_found`` and return the ``_not_found_envelope``.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
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
        logger.debug("rca._common: fetch events failed: %s", exc)
        return []
    return [dict(r) for r in rows]


async def _fetch_judge_scores(org_id: str, trace_id: str) -> list[dict[str, Any]]:
    """Read the ``judge_scores`` rows for one ``(org, trace)``.

    The rule-based pre-filter checks hallucination, reasoning
    coherence, and safety judge outputs. Returns a flat list of
    ``{judge_name, score, ...}`` dicts; empty list on failure.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    try:
        # ``judge_scores`` is keyed by ``tenant_id`` and ``trace_id``
        # (per the convention used by ``DecisionScorer``). Pull the
        # minimum columns the rules need.
        rows = await client.fetch(
            """
            SELECT judge_name, score, target_id, span_id
            FROM judge_scores
            WHERE tenant_id = $1 AND trace_id = $2
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("rca._common: fetch judge_scores failed: %s", exc)
        return []
    return [dict(r) for r in rows]


async def _fetch_failed_traces_in_window(
    org_id: str, interval_sql: str
) -> list[str]:
    """Return the distinct ``trace_id`` values that have at least
    one failed event in the last ``interval_sql`` (a Postgres
    interval literal like ``'24 hours'``).

    Used by :class:`IncidentClusterer.cluster` to pick the
    candidate set before bucketing. Returns ``[]`` on failure.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT DISTINCT trace_id
            FROM telemetry_events
            WHERE tenant_id = $1
              AND timestamp > NOW() - $2::interval
              AND (error IS NOT NULL OR outcome = 'error')
            ORDER BY trace_id
            LIMIT 500
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("rca._common: fetch failed traces failed: %s", exc)
        return []
    return [r["trace_id"] for r in rows]


async def _fetch_cluster_members(
    org_id: str, cluster_id: str
) -> list[str]:
    """Return the ``trace_id`` values that are members of the
    given cluster. Used by :func:`IncidentClusterer.summarize`."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT trace_id
            FROM incident_cluster_members
            WHERE cluster_id = $1
            """,
            cluster_id,
        )
    except Exception as exc:
        logger.debug("rca._common: fetch cluster members failed: %s", exc)
        return []
    return [r["trace_id"] for r in rows]


async def _fetch_cluster_row(
    org_id: str, cluster_id: str
) -> dict[str, Any] | None:
    """Return the ``incident_clusters`` row for ``cluster_id``,
    or ``None`` if it doesn't exist for this org."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return None

    client = await get_postgres_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT id, org_id, name, member_count, severity, summary,
                   centroid_embedding, created_at
            FROM incident_clusters
            WHERE id = $1 AND org_id = $2
            """,
            cluster_id,
            org_id,
        )
    except Exception as exc:
        logger.debug("rca._common: fetch cluster row failed: %s", exc)
        return None
    if row is None:
        return None
    return dict(row)


async def _fetch_similar_rca_analyses(
    org_id: str,
    category: str,
    error_type: str,
    exclude_trace_id: str,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Return the most recent ``rca_analyses`` rows for the
    same org whose category matches and (optionally) the same
    error type. Used by :func:`RootCauseAnalyzer.explain` to
    surface similar incidents."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    try:
        # error_type is encoded in ``signals_json`` (a JSON list of
        # human-readable strings). We LIKE-match on the error_type
        # substring within the signals_json text; this is
        # good-enough for Phase 1 and avoids a JSONB query.
        rows = await client.fetch(
            """
            SELECT trace_id, category, confidence, signals_json, explanation
            FROM rca_analyses
            WHERE org_id = $1
              AND category = $2
              AND trace_id <> $3
              AND ($4::text = '' OR signals_json LIKE '%' || $4 || '%')
            ORDER BY created_at DESC
            LIMIT $5
            """,
            org_id,
            category,
            exclude_trace_id,
            error_type or "",
            limit,
        )
    except Exception as exc:
        logger.debug("rca._common: fetch similar rca failed: %s", exc)
        return []
    return [dict(r) for r in rows]


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None`` on
    bad input; the clusterer wraps that into a
    ``_bad_request_envelope``."""
    if window is None:
        return "24 hours"
    s = window.strip()
    if not s:
        return "24 hours"
    m = _WINDOW_RE.match(s)
    if m is None:
        return None
    n, unit = m.group(1), m.group(2).lower()
    unit_long = {"h": "hours", "d": "days", "m": "minutes", "s": "seconds"}[unit]
    return f"{n} {unit_long}"


# ── Envelope helpers ─────────────────────────────────────────────────


def _new_trace_id() -> str:
    return f"rca_{uuid.uuid4().hex[:12]}"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live response envelope — same shape as the Cat 16 envelope
    (and the stub :class:`eden.intelligence_envelope.IntelligenceStubResponse`)
    so the front-end renders uniformly. ``live=True`` signals a
    real implementation."""
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _not_found_envelope(
    feature: str, *, trace_id: str | None = None, cluster_id: str | None = None
) -> dict[str, Any]:
    """Live envelope for a missing trace or cluster — distinct
    from :func:`eden.intelligence_envelope.not_implemented`
    because the service IS implemented, the target just doesn't
    exist for this org."""
    data: dict[str, Any] = {"reason": "no events found for this (org, trace)"}
    if trace_id is not None:
        data["trace_id"] = trace_id
    if cluster_id is not None:
        data["cluster_id"] = cluster_id
        data["reason"] = "no cluster found for this (org, cluster_id)"
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


# ── Persistence ──────────────────────────────────────────────────────


async def _delete_then_insert_rca(
    org_id: str,
    trace_id: str,
    *,
    category: str,
    confidence: float,
    signals_json: str,
    explanation: str,
) -> None:
    """Write the per-trace row to ``rca_analyses``.

    Mirrors the Cat 16 ``_delete_then_insert`` pattern: none of
    the Cat 2 tables have a unique constraint, so the only way
    to make the service re-runnable is to clear the ``(org,
    trace)`` rows and re-insert. Best-effort: any exception is
    logged and swallowed so the caller can still return the
    live envelope with the in-memory data.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM rca_analyses WHERE org_id = $1 AND trace_id = $2",
                org_id,
                trace_id,
            )
            await conn.execute(
                """
                    INSERT INTO rca_analyses
                        (id, org_id, trace_id, category, confidence,
                         signals_json, explanation)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
                    """,
                org_id, trace_id, category, confidence,
                signals_json, explanation,
            )
    except Exception as exc:
        logger.debug("rca._common: rca_analyses write failed: %s", exc)


async def _delete_then_insert_incidents(
    org_id: str,
    clusters: list[dict[str, Any]],
    members: list[dict[str, Any]],
) -> None:
    """Replace all ``incident_clusters`` and
    ``incident_cluster_members`` rows for ``org_id``.

    ``members`` is a list of ``{cluster_id, trace_id, similarity}``
    dicts. ``clusters`` is a list of
    ``{id, name, centroid_embedding, member_count, severity,
    summary}`` dicts (the ``id`` is the deterministic ``clu_...``
    string). Both lists may be empty (in which case we still
    clear the old rows).

    Explicit DELETE order: members first, then clusters, to avoid
    FK violations.
    """
    if not clusters and not members:
        return
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            # DELETE members first, then clusters. Using a
            # single DELETE for members joined to clusters is
            # the safest pattern (no FK surprise if a future
            # migration adds one).
            await conn.execute(
                """
                    DELETE FROM incident_cluster_members
                    WHERE cluster_id IN (
                        SELECT id FROM incident_clusters WHERE org_id = $1
                    )
                    """,
                org_id,
            )
            await conn.execute(
                "DELETE FROM incident_clusters WHERE org_id = $1",
                org_id,
            )
            # executemany fans out into a single asyncpg pipeline call
            # instead of one INSERT per cluster / per member — pre-fix
            # this was O(N) round-trips inside the write transaction.
            if clusters:
                await conn.executemany(
                    """
                        INSERT INTO incident_clusters
                            (id, org_id, name, centroid_embedding,
                             member_count, severity, summary)
                        VALUES ($1, $2, $3, $4, $5, $6, $7)
                        """,
                    [
                        (
                            c["id"], org_id, c["name"],
                            c.get("centroid_embedding"),
                            c["member_count"], c["severity"],
                            c.get("summary"),
                        )
                        for c in clusters
                    ],
                )
            if members:
                await conn.executemany(
                    """
                        INSERT INTO incident_cluster_members
                            (cluster_id, trace_id, similarity)
                        VALUES ($1, $2, $3)
                        """,
                    [
                        (m["cluster_id"], m["trace_id"], m["similarity"])
                        for m in members
                    ],
                )
    except Exception as exc:
        logger.debug("rca._common: incidents write failed: %s", exc)


async def _update_cluster_summary(
    org_id: str, cluster_id: str, summary: str
) -> None:
    """Write back a one-paragraph summary to
    ``incident_clusters.summary``. Best-effort."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                UPDATE incident_clusters
                SET summary = $1
                WHERE id = $2 AND org_id = $3
                """,
                summary, cluster_id, org_id,
            )
    except Exception as exc:
        logger.debug("rca._common: cluster summary update failed: %s", exc)


async def _ensure_incident_resolve_columns(conn: Any) -> None:
    """Idempotent ADD COLUMN for resolve status fields.

    Soft-launch: avoid a blocking migration for a single status
    mutation. Postgres ``IF NOT EXISTS`` keeps this safe to call
    on every resolve.
    """
    await conn.execute(
        """
        ALTER TABLE incident_clusters
            ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'open'
        """
    )
    await conn.execute(
        """
        ALTER TABLE incident_clusters
            ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ
        """
    )
    await conn.execute(
        """
        ALTER TABLE incident_clusters
            ADD COLUMN IF NOT EXISTS resolution_note TEXT
        """
    )


async def _resolve_incident_cluster(
    org_id: str,
    cluster_id: str,
    *,
    note: str = "",
) -> dict[str, Any] | None:
    """Mark an incident cluster as resolved.

    Returns ``{cluster_id, status, resolved_at}`` on success, or
    ``None`` when the cluster is missing / postgres unavailable.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return None

    client = await get_postgres_client()
    if client is None:
        return None
    try:
        async with client.acquire() as conn:
            await _ensure_incident_resolve_columns(conn)
            row = await conn.fetchrow(
                """
                UPDATE incident_clusters
                SET status = 'resolved',
                    resolved_at = NOW(),
                    resolution_note = $3
                WHERE id = $1 AND org_id = $2
                RETURNING id, status, resolved_at, resolution_note
                """,
                cluster_id,
                org_id,
                note or "",
            )
    except Exception as exc:
        logger.debug("rca._common: resolve incident failed: %s", exc)
        return None
    if row is None:
        return None
    resolved_at = row["resolved_at"]
    return {
        "cluster_id": str(row["id"]),
        "status": row["status"],
        "resolved_at": (
            resolved_at.isoformat()
            if hasattr(resolved_at, "isoformat")
            else resolved_at
        ),
        "resolution_note": row["resolution_note"] or "",
    }


async def _fetch_incident_clusters(
    org_id: str, *, limit: int, severity: str | None
) -> list[dict[str, Any]]:
    """Read a list of clusters for the org, ordered by
    ``member_count DESC, created_at DESC``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("rca._common: postgres import failed: %s", exc)
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT id, name, member_count, severity, summary, created_at
            FROM incident_clusters
            WHERE org_id = $1
              AND ($2::text IS NULL OR severity = $2)
            ORDER BY member_count DESC, created_at DESC
            LIMIT $3
            """,
            org_id, severity, limit,
        )
    except Exception as exc:
        logger.debug("rca._common: incident_clusters list failed: %s", exc)
        return []
    return [dict(r) for r in rows]


# ── Jaccard similarity (for the secondary cluster similarity) ──────


def _tokenize(text: str) -> set[str]:
    """Lowercase, split on non-word, drop stopwords + single chars."""
    if not text:
        return set()
    tokens = re.findall(r"[a-z0-9_]+", text.lower())
    return {t for t in tokens if t and t not in _JACCARD_STOPWORDS and len(t) > 1}


def _jaccard_similarity(a: set[str], b: set[str]) -> float:
    """Standard Jaccard: ``|a ∩ b| / |a ∪ b|``. Returns 0.0 if
    both sets are empty (no evidence either way)."""
    if not a and not b:
        return 0.0
    union = a | b
    if not union:
        return 0.0
    return len(a & b) / len(union)


def _jaccard_mean(sets: list[set[str]]) -> float:
    """Mean pairwise Jaccard across a list of token sets. Returns
    0.0 for a single set or an empty list."""
    if len(sets) < 2:
        return 0.0
    pairs = 0
    total = 0.0
    for i in range(len(sets)):
        for j in range(i + 1, len(sets)):
            total += _jaccard_similarity(sets[i], sets[j])
            pairs += 1
    return total / pairs if pairs else 0.0


# ── Rule-based pre-filter (shared by analyzer + clusterer) ─────────


def _has_tool_error(events: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    """Rule 1: any ``tool.*`` event with ``error`` set or
    ``outcome="error"``."""
    signals: list[str] = []
    for ev in events:
        et = (ev.get("event_type") or "").lower()
        if not et.startswith("tool."):
            continue
        err = ev.get("error")
        if err or (ev.get("outcome") == "error"):
            # Try to surface the tool name and error type
            name = et.removeprefix("tool.")
            err_type = (err or {}).get("type") if isinstance(err, dict) else None
            signals.append(
                f"tool '{name}' failed"
                + (f" with {err_type}" if err_type else "")
            )
    return (len(signals) > 0, signals)


def _has_empty_retrieval(events: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    """Rule 2: any retrieval event with empty/low-score results."""
    signals: list[str] = []
    for ev in events:
        et = (ev.get("event_type") or "").lower()
        if et not in ("retrieval.call", "retrieval.search", "kb.retrieval"):
            continue
        payload = ev.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        items = payload.get("retrieved_items")
        if isinstance(items, list) and len(items) == 0:
            signals.append(f"{et} returned 0 items")
            continue
        score = payload.get("score")
        if isinstance(score, (int, float)) and score < 0.4:
            signals.append(f"{et} returned low-score items (avg {score:.2f})")
    return (len(signals) > 0, signals)


def _has_low_judge(
    judge_scores: list[dict[str, Any]],
) -> tuple[bool, list[str]]:
    """Rule 3: hallucination < 0.5 OR reasoning_coherence < 0.4."""
    signals: list[str] = []
    for row in judge_scores:
        name = row.get("judge_name")
        score = row.get("score")
        if not isinstance(score, (int, float)):
            continue
        if name == "hallucination" and score < 0.5:
            signals.append(f"judge 'hallucination' scored {score:.2f}")
        elif name == "reasoning_coherence" and score < 0.4:
            signals.append(f"judge 'reasoning_coherence' scored {score:.2f}")
    return (len(signals) > 0, signals)


def _has_safety_flag(
    events: list[dict[str, Any]], judge_scores: list[dict[str, Any]]
) -> tuple[bool, list[str]]:
    """Rule 4: safety judge flagged, OR user input matches a
    PII / prompt-injection pattern."""
    signals: list[str] = []
    for row in judge_scores:
        if row.get("judge_name") != "safety":
            continue
        score = row.get("score")
        verdict = row.get("verdict") if isinstance(row, dict) else None
        if isinstance(score, (int, float)) and score < 0.3:
            signals.append(f"judge 'safety' scored {score:.2f}")
        if isinstance(verdict, str) and verdict.lower() in ("block", "deny"):
            signals.append(f"judge 'safety' verdict={verdict}")
    # Crude prompt-injection / PII sniff on the first user-input
    # event we can find.
    for ev in events:
        attrs = ev.get("attributes") or {}
        if not isinstance(attrs, dict):
            continue
        user_msg = attrs.get("user_message") or attrs.get("user_input") or ""
        if not isinstance(user_msg, str):
            continue
        low = user_msg.lower()
        if any(
            needle in low
            for needle in (
                "ignore previous instructions",
                "disregard all prior",
                "you are now",
                "system:",
                "ssn ",
                "credit card number",
            )
        ):
            signals.append("user input matched a PII / prompt-injection pattern")
            break
    return (len(signals) > 0, signals)


def _has_memory_error(events: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    """Rule 5: any ``memory.*`` event with outcome ≠ success."""
    signals: list[str] = []
    for ev in events:
        et = (ev.get("event_type") or "").lower()
        if not et.startswith("memory."):
            continue
        if ev.get("outcome") and ev.get("outcome") != "success":
            op = et.removeprefix("memory.")
            err = ev.get("error")
            err_type = (err or {}).get("type") if isinstance(err, dict) else None
            signals.append(
                f"memory op '{op}' failed"
                + (f" with {err_type}" if err_type else "")
            )
    return (len(signals) > 0, signals)


def _has_prompt_error(events: list[dict[str, Any]]) -> tuple[bool, list[str]]:
    """Rule 6: any ``prompt.*`` event with ``error`` set."""
    signals: list[str] = []
    for ev in events:
        et = (ev.get("event_type") or "").lower()
        if not et.startswith("prompt."):
            continue
        if ev.get("error"):
            name = et.removeprefix("prompt.")
            err = ev.get("error")
            err_type = (err or {}).get("type") if isinstance(err, dict) else None
            signals.append(
                f"prompt '{name}' failed"
                + (f" with {err_type}" if err_type else "")
            )
    return (len(signals) > 0, signals)


def _trace_is_failure(events: list[dict[str, Any]]) -> bool:
    """A trace is a failure if any event has ``outcome="error"`` or
    an ``error`` column set. Used as the fallback gate for rule 7."""
    for ev in events:
        if ev.get("outcome") == "error":
            return True
        if ev.get("error"):
            return True
    return False


def _pick_top_signals(raw_signals: list[str], k: int = 3) -> list[str]:
    """Pick the top-k most specific signals. We use a simple
    heuristic: prefer signals that mention a specific entity
    (tool name, KB call, judge name) over generic phrases. The
    fall-back is the order produced by the rule."""
    if len(raw_signals) <= k:
        return raw_signals[:k]
    # Score each signal: longer + contains a quote is more specific
    def specificity(s: str) -> int:
        return len(s) + (10 if "'" in s else 0)
    return sorted(raw_signals, key=specificity, reverse=True)[:k]


def _make_explanation(category: str, signals: list[str]) -> str:
    """Templated 1-sentence explanation keyed by category. The
    templates use the top signal as the specific evidence."""
    top = signals[0] if signals else "no specific evidence"
    templates = {
        "tool": f"{top.capitalize()}.",
        "retrieval": f"{top.capitalize()}.",
        "model": f"{top.capitalize()} — model output is the suspect.",
        "user_issue": f"{top.capitalize()}.",
        "memory": f"{top.capitalize()}.",
        "prompt": f"{top.capitalize()}.",
    }
    return templates.get(category, f"{top.capitalize()}.")


def _classify_events(
    events: list[dict[str, Any]],
    judge_scores: list[dict[str, Any]],
) -> tuple[str, float, list[str]]:
    """Apply the 6-rule table in priority order and return
    ``(category, confidence, signals)``.

    Used by both :class:`RootCauseAnalyzer.categorize` (which
    persists the result) and :class:`IncidentClusterer.cluster`
    (which only needs the tuple for bucketing). Putting the
    rule table here keeps the two services in lockstep — when a
    rule changes, both consumers see the new behaviour.

    Rules 1-6 each have a base confidence; the caller applies
    additive adjustments (e.g. multi-signal, single-event,
    no-judges). Rule 7 (the fallback) fires only when no rule
    matched AND the trace is itself a failure. A successful
    trace that fires no rule returns ``("model", 0.55, [...])``
    is NOT what we want — instead we return the lowest-priority
    bucket so the caller can decide.
    """
    # Rule 1
    matched, sigs = _has_tool_error(events)
    if matched:
        return ("tool", 0.92, sigs)
    # Rule 2
    matched, sigs = _has_empty_retrieval(events)
    if matched:
        return ("retrieval", 0.88, sigs)
    # Rule 3
    matched, sigs = _has_low_judge(judge_scores)
    if matched:
        return ("model", 0.85, sigs)
    # Rule 4
    matched, sigs = _has_safety_flag(events, judge_scores)
    if matched:
        return ("user_issue", 0.80, sigs)
    # Rule 5
    matched, sigs = _has_memory_error(events)
    if matched:
        return ("memory", 0.82, sigs)
    # Rule 6
    matched, sigs = _has_prompt_error(events)
    if matched:
        return ("prompt", 0.78, sigs)
    # Rule 7 — only when the trace is a failure
    if _trace_is_failure(events):
        return (
            "model",
            0.55,
            ["trace failed but no specific signal matched; defaulting to model"],
        )
    # No failure + no rule fired: the trace is a success, so
    # categorisation is meaningless. Return a low-confidence
    # "model" so the caller doesn't have to special-case the
    # shape. The analyze route will still write the row so the
    # front-end can render "no failure detected".
    return (
        "model",
        0.40,
        ["no failure detected — trace succeeded"],
    )


# ── Cluster key helpers ──────────────────────────────────────────────


def _make_cluster_id(org_id: str, key: tuple[Any, ...]) -> str:
    """Deterministic ``clu_<16hex>`` id from a key tuple.

    Re-running :func:`IncidentClusterer.cluster` on the same
    inputs produces the same ``cluster_id`` — this is the
    acceptance criterion that makes the cluster operation
    idempotent.
    """
    import hashlib
    raw = "|".join([CLUSTER_KEY_VERSION, org_id, *(str(x) for x in key)])
    return "clu_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _severity_for_count(member_count: int) -> str:
    """Map a member count to a severity bucket."""
    if member_count >= 100:
        return "critical"
    if member_count >= 30:
        return "high"
    if member_count >= 10:
        return "medium"
    return "low"


def _first_failed_event(events: list[dict[str, Any]]) -> dict[str, Any]:
    """Return the first event that is a failure (error or
    outcome='error'). Falls back to the first event, then to
    an empty dict."""
    for ev in events:
        if ev.get("error") or ev.get("outcome") == "error":
            return ev
    return events[0] if events else {}


def _error_type_from_event(ev: dict[str, Any]) -> str:
    """Best-effort error type extraction from one event."""
    err = ev.get("error")
    if isinstance(err, dict):
        et = err.get("type")
        if isinstance(et, str) and et.strip():
            return et
    if ev.get("outcome") == "error":
        return "error"
    return "unknown"


def _agent_id_from_event(ev: dict[str, Any]) -> str:
    aid = ev.get("agent_id")
    if isinstance(aid, str) and aid.strip():
        return aid
    return "unknown"


def _recommendation_for_category(category: str) -> str:
    return _CATEGORY_RECOMMENDATIONS.get(
        category, "Investigate manually; no category-specific guidance yet."
    )


# ── Misc small helpers ──────────────────────────────────────────────


def _truncate(s: str | None, n: int) -> str:
    if not s or not isinstance(s, str):
        return ""
    s = s.strip()
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)] + "…"


def _json_dumps(obj: Any) -> str:
    return json.dumps(obj, default=str, ensure_ascii=False)
