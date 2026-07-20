"""Search service (Phase B — Laminar parity for "fast text search").

The headline Laminar feature is "fast text search across every span".
This service exposes it via :class:`SearchService`, which wraps
:meth:`TypesenseClient` with query construction + per-org isolation
guards. The trace view and the global Cmd-K palette both go through
here.

API surface (mirrors Laminar's):

  * :meth:`search` — ``GET /orgs/{org}/spans/search?q=&agent=&tool=&from=&to=``
  * :meth:`suggest` — Cmd-K autocomplete: returns top-5 spans matching
    a prefix query, includes trace_id for "jump to trace".
  * :meth:`facets` — facet counts for the current query (used to build
    the sidebar filter UI on ``/observability/search``).

Per-org isolation: every search method takes ``tenant_id`` and forces
it into the Typesense ``filter_by`` expression. Cross-tenant data is
unreachable even if the upstream query string is malicious.

Performance budget: <100ms p95 for a 1M-doc collection on default
hardware. The trace view pages are heavier (the trace graph builder
runs after the search hit), but the search itself should feel
instantaneous.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

from eden.observability.typesense_client import (
    TypesenseClient,
    get_typesense_client,
)

logger = logging.getLogger(__name__)

# ── In-process metrics (Prometheus-compatible naming) ───────────────
# Simple accumulators exposed via get_search_stats() and rendered
# by metrics_endpoint.py. No external dependency required.
_search_stats: dict[str, float] = {
    "duration_sum_s": 0.0,
    "duration_count": 0.0,
    "fallback_total": 0.0,
    "index_lag_sum_s": 0.0,
    "index_lag_count": 0.0,
}


def get_search_stats() -> dict[str, float]:
    """Return a snapshot of in-process search metrics."""
    return dict(_search_stats)


def _record_search(duration_s: float, *, fallback: bool) -> None:
    _search_stats["duration_sum_s"] += duration_s
    _search_stats["duration_count"] += 1.0
    if fallback:
        _search_stats["fallback_total"] += 1.0


def record_index_lag(lag_s: float) -> None:
    """Record how many seconds elapsed between event creation and Typesense index."""
    _search_stats["index_lag_sum_s"] += lag_s
    _search_stats["index_lag_count"] += 1.0


@dataclass
class SpanHit:
    """One search result row."""

    event_id: str
    trace_id: str
    span_id: str
    agent_id: str
    name: str
    event_type: str
    outcome: str
    input_text_excerpt: str = ""
    output_text_excerpt: str = ""
    tool_names: list[str] = field(default_factory=list)
    created_at: int = 0
    duration_ms: float = 0.0
    cost_usd: float = 0.0
    highlight: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "agent_id": self.agent_id,
            "name": self.name,
            "event_type": self.event_type,
            "outcome": self.outcome,
            "input_text_excerpt": self.input_text_excerpt,
            "output_text_excerpt": self.output_text_excerpt,
            "tool_names": list(self.tool_names),
            "created_at": self.created_at,
            "duration_ms": self.duration_ms,
            "cost_usd": self.cost_usd,
            "highlight": dict(self.highlight),
        }


@dataclass
class SearchResponse:
    """Envelope returned to the API + portal."""

    hits: list[SpanHit] = field(default_factory=list)
    total: int = 0
    facet_counts: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    took_ms: float = 0.0
    query: str = ""
    fallback: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "hits": [h.to_dict() for h in self.hits],
            "total": self.total,
            "facet_counts": self.facet_counts,
            "took_ms": round(self.took_ms, 2),
            "query": self.query,
            "fallback": self.fallback,
        }


def _excerpt(text: str, query: str, width: int = 240) -> str:
    """Return a window around the first query hit, with ellipses.

    Falls back to the head of the text when the query is missing
    or no hit is found (e.g. when searching by tool name only).
    """
    if not text:
        return ""
    if not query:
        return text[:width]
    lower = text.lower()
    q_lower = query.lower()
    idx = lower.find(q_lower)
    if idx < 0:
        return text[:width]
    half = width // 2
    start = max(0, idx - half)
    end = min(len(text), idx + len(query) + half)
    snippet = text[start:end]
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def _parse_facet_counts(facet_block: list[dict[str, Any]] | None) -> dict[str, list[dict[str, Any]]]:
    """Extract the ``facet_counts`` block from a Typesense response.

    Typesense returns one entry per faceted field, each with
    ``counts: [{value, count}, ...]``. We shape that into the
    ``{field: [{value, count}]}`` form the UI consumes.

    Accepts the already-extracted ``facet_counts`` list (i.e. the
    value of ``body["facet_counts"]``), not the full response body.
    """
    if not isinstance(facet_block, list):
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    for entry in facet_block:
        if not isinstance(entry, dict):
            continue
        field_name = entry.get("field_name")
        counts = entry.get("counts")
        if isinstance(field_name, str) and isinstance(counts, list):
            out[field_name] = [
                {"value": c.get("value"), "count": c.get("count")}
                for c in counts
                if isinstance(c, dict)
            ]
    return out


class SearchService:
    """Span full-text search backed by Typesense.

    Stateless wrapper around :class:`TypesenseClient`. The trace
    view, the global Cmd-K palette, and the ``/observability/search``
    page all call into here. The class is process-wide singleton;
    use :func:`get_search_service` to acquire it.

    All public methods are async because every call is one HTTP
    round-trip to Typesense (or one no-op when Typesense is down).
    """

    name = "search_service"

    #: Fields the ``/observability/search`` page shows as facets.
    #: Each becomes a sidebar filter checkbox group.
    DEFAULT_FACET_FIELDS: tuple[str, ...] = (
        "agent_id",
        "tool_names",
        "outcome",
        "event_type",
        "model",
    )

    def __init__(self, *, client: TypesenseClient | None = None) -> None:
        self._client = client

    @property
    def client(self) -> TypesenseClient | None:
        if self._client is not None:
            return self._client
        return get_typesense_client()

    # Default PG fallback window when callers omit time bounds
    # (prevents unbounded tenant-wide ILIKE scans).
    DEFAULT_FALLBACK_WINDOW_S: int = 7 * 24 * 3600

    # ── Postgres ILIKE fallback ────────────────────────────────────

    @classmethod
    def _bounded_time_range(
        cls,
        from_ts: int | None,
        to_ts: int | None,
    ) -> tuple[int, int]:
        """Force a closed [from_ts, to_ts] window for search fallback."""
        now = int(time.time())
        end = int(to_ts) if to_ts is not None else now
        start = (
            int(from_ts)
            if from_ts is not None
            else end - cls.DEFAULT_FALLBACK_WINDOW_S
        )
        if start > end:
            start, end = end - cls.DEFAULT_FALLBACK_WINDOW_S, end
        return start, end

    async def _pg_fallback_search(
        self,
        *,
        tenant_id: str,
        query: str = "",
        agent_id: str | None = None,
        outcome: str | None = None,
        event_type: str | None = None,
        from_ts: int | None = None,
        to_ts: int | None = None,
        per_page: int = 20,
        page: int = 1,
    ) -> SearchResponse:
        """ILIKE full-text fallback against ``telemetry_events`` in Postgres.

        Used when Typesense is unavailable. Matches the same filter
        shape as the Typesense path so callers see the same response
        structure. Returns an empty response (not an error) if the
        Postgres client is unavailable.

        Always applies tenant + time bounds (default last 7 days when
        ``from_ts``/``to_ts`` are omitted) so fallback never does an
        unbounded tenant scan.
        """
        start = time.perf_counter()
        try:
            from eden.storage.postgres import get_postgres_client
            pg = await get_postgres_client()
        except Exception as exc:
            logger.debug("PG fallback: postgres unavailable: %s", exc)
            return SearchResponse(query=query, fallback=True)
        if pg is None:
            return SearchResponse(query=query, fallback=True)

        bound_from, bound_to = self._bounded_time_range(from_ts, to_ts)

        pattern = f"%{query.strip()}%" if query.strip() else "%"
        conditions: list[str] = ["tenant_id = $1"]
        params: list[Any] = [tenant_id]
        idx = 2

        if query.strip():
            # Prefer bare-column ILIKE so mig 113 gin_trgm indexes
            # (name, agent_id) can be used. COALESCE(...) wrappers are
            # expression-index-hostile; NULL ILIKE is already false.
            conditions.append(
                f"(name ILIKE ${idx}"
                f" OR agent_id ILIKE ${idx}"
                f" OR outcome ILIKE ${idx}"
                f" OR event_type ILIKE ${idx})"
            )
            params.append(pattern)
            idx += 1
        if agent_id:
            conditions.append(f"agent_id = ${idx}")
            params.append(agent_id)
            idx += 1
        if outcome:
            conditions.append(f"outcome = ${idx}")
            params.append(outcome)
            idx += 1
        if event_type:
            conditions.append(f"event_type = ${idx}")
            params.append(event_type)
            idx += 1
        # Compare against the timestamp column directly so the
        # (tenant_id, timestamp) btree can be used — EXTRACT(EPOCH FROM
        # timestamp) is not sargable.
        conditions.append(f"timestamp >= to_timestamp(${idx})")
        params.append(float(bound_from))
        idx += 1
        conditions.append(f"timestamp <= to_timestamp(${idx})")
        params.append(float(bound_to))
        idx += 1

        limit = max(1, min(per_page, 100))
        offset = max(0, (max(1, page) - 1) * limit)
        where = " AND ".join(conditions)
        sql = f"""
            SELECT event_id, trace_id, span_id, agent_id, name,
                   event_type, outcome, duration_ms,
                   EXTRACT(EPOCH FROM timestamp)::bigint AS created_at
            FROM telemetry_events
            WHERE {where}
            ORDER BY timestamp DESC
            LIMIT {limit} OFFSET {offset}
        """

        try:
            rows = await pg.fetch(sql, *params)
        except Exception as exc:
            logger.debug("PG fallback search failed: %s", exc)
            elapsed_ms = (time.perf_counter() - start) * 1000
            return SearchResponse(query=query, took_ms=elapsed_ms, fallback=True)

        hits: list[SpanHit] = []
        for r in rows:
            hits.append(SpanHit(
                event_id=str(r["event_id"] or ""),
                trace_id=str(r["trace_id"] or ""),
                span_id=str(r["span_id"] or ""),
                agent_id=str(r["agent_id"] or ""),
                name=str(r["name"] or ""),
                event_type=str(r["event_type"] or ""),
                outcome=str(r["outcome"] or ""),
                input_text_excerpt=_excerpt(str(r["name"] or ""), query),
                created_at=int(r["created_at"] or 0),
                duration_ms=float(r["duration_ms"] or 0.0),
            ))

        elapsed_ms = (time.perf_counter() - start) * 1000
        return SearchResponse(
            hits=hits,
            total=len(hits),
            took_ms=elapsed_ms,
            query=query,
            fallback=True,
        )

    # ── Core search ───────────────────────────────────────────────

    async def search(
        self,
        *,
        tenant_id: str,
        query: str = "",
        agent_id: str | None = None,
        tool: str | None = None,
        outcome: str | None = None,
        event_type: str | None = None,
        from_ts: int | None = None,
        to_ts: int | None = None,
        per_page: int = 20,
        page: int = 1,
        facet_by: tuple[str, ...] | None = None,
    ) -> SearchResponse:
        """Run a full-text search with facet + range filters.

        All filters are AND-joined into Typesense's ``filter_by``
        expression. ``tenant_id`` is always forced into the filter
        for per-org isolation — callers cannot opt out.

        Returns a :class:`SearchResponse` with hits, total count,
        facet counts, and the wall-clock time spent in Typesense.
        An unreachable Typesense returns an empty ``SearchResponse``
        with ``took_ms=0`` so the UI can render a "search offline"
        fallback.
        """
        start = time.perf_counter()

        # Guard on feature flag — when typesense_search_v1 is off, skip
        # Typesense entirely and serve Postgres results directly.
        try:
            from eden.config import get_settings
            _flag_on = getattr(get_settings(), "typesense_search_v1", True)
        except Exception:
            _flag_on = True

        client = self.client if _flag_on else None
        if client is None:
            resp = await self._pg_fallback_search(
                tenant_id=tenant_id,
                query=query,
                agent_id=agent_id,
                outcome=outcome,
                event_type=event_type,
                from_ts=from_ts,
                to_ts=to_ts,
                per_page=per_page,
                page=page,
            )
            _record_search((time.perf_counter() - start), fallback=True)
            return resp

        # Ensure schema exists before first search (best-effort,
        # also called by index_span — idempotent).
        if not client._schema_ready:
            await client.ensure_collection()

        # Build the filter expression. Typesense wants
        # ``field:=value`` for exact match, ``field:>value`` for >.
        # Empty ``query`` is allowed: returns all docs matching the
        # filter, useful for "show me all failed spans in the last
        # hour" without a text query.
        filters: list[str] = [f"tenant_id:={tenant_id}"]
        if agent_id:
            filters.append(f"agent_id:={agent_id}")
        if tool:
            # tool_names is a string[] field; ``:=`` does an OR match
            # inside the array.
            filters.append(f"tool_names:={tool}")
        if outcome:
            filters.append(f"outcome:={outcome}")
        if event_type:
            filters.append(f"event_type:={event_type}")
        if from_ts is not None:
            filters.append(f"created_at:>={int(from_ts)}")
        if to_ts is not None:
            filters.append(f"created_at:<={int(to_ts)}")

        facets = ",".join(facet_by) if facet_by else ",".join(self.DEFAULT_FACET_FIELDS)
        params: dict[str, Any] = {
            "q": query or "*",
            "query_by": "input_text,output_text,tool_names,name,agent_id",
            "filter_by": " && ".join(filters),
            "sort_by": "created_at:desc",
            "per_page": max(1, min(per_page, 100)),
            "page": max(1, page),
            "facet_by": facets,
            "max_facet_values": 25,
            "highlight_full_fields": "input_text,output_text",
            "highlight_affix_num_tokens": 4,
            "snippet_threshold": 30,
        }

        # Use the client's underlying HTTP request — go through the
        # public ``_request`` method since that's already async and
        # handles the circuit breaker.
        status, body = await client._request(
            "GET",
            f"/collections/{client._collection}/documents/search",
            params=params,
        )
        elapsed_ms = (time.perf_counter() - start) * 1000

        if status != 200 or not isinstance(body, dict):
            logger.debug(f"SearchService.search: typesense returned {status}; using PG fallback")
            fb = await self._pg_fallback_search(
                tenant_id=tenant_id,
                query=query,
                agent_id=agent_id,
                outcome=outcome,
                event_type=event_type,
                from_ts=from_ts,
                to_ts=to_ts,
                per_page=per_page,
                page=page,
            )
            _record_search((time.perf_counter() - start), fallback=True)
            return fb

        hits_raw = body.get("hits") or []
        hits: list[SpanHit] = []
        for h in hits_raw:
            if not isinstance(h, dict):
                continue
            doc = h.get("document") or {}
            hl = h.get("highlight") or {}
            snippet = h.get("snippet") or {}
            # Snippet is preferred over plain excerpt when present —
            # Typesense wraps matched terms in ``<mark>`` tags.
            in_snip = snippet.get("input_text") if isinstance(snippet, dict) else ""
            out_snip = snippet.get("output_text") if isinstance(snippet, dict) else ""
            hits.append(SpanHit(
                event_id=str(doc.get("id", "")).split(":", 1)[-1],
                trace_id=str(doc.get("trace_id", "")),
                span_id=str(doc.get("span_id", "")),
                agent_id=str(doc.get("agent_id", "")),
                name=str(doc.get("name", "")),
                event_type=str(doc.get("event_type", "")),
                outcome=str(doc.get("outcome", "")),
                input_text_excerpt=in_snip or _excerpt(str(doc.get("input_text", "")), query),
                output_text_excerpt=out_snip or _excerpt(str(doc.get("output_text", "")), query),
                tool_names=list(doc.get("tool_names") or []),
                created_at=int(doc.get("created_at", 0) or 0),
                duration_ms=float(doc.get("duration_ms", 0) or 0),
                cost_usd=float(doc.get("cost_usd", 0) or 0),
                highlight={
                    k: str(v) for k, v in hl.items() if isinstance(v, str)
                },
            ))

        _record_search((time.perf_counter() - start), fallback=False)
        return SearchResponse(
            hits=hits,
            total=int(body.get("found", 0) or 0),
            facet_counts=_parse_facet_counts(body.get("facet_counts")),
            took_ms=elapsed_ms,
            query=query,
        )

    # ── Cmd-K autocomplete ────────────────────────────────────────

    async def suggest(
        self,
        *,
        tenant_id: str,
        query: str,
        limit: int = 5,
    ) -> list[SpanHit]:
        """Top-N quick suggestions for the Cmd-K palette.

        Smaller page size + no facets + no highlights to stay snappy.
        Results are sorted by recency so the most recent matching
        trace rises to the top of the dropdown.
        """
        if not query:
            return []
        # Bypass the default facet set explicitly — ``facet_by=None``
        # would otherwise fall back to DEFAULT_FACET_FIELDS.
        resp = await self.search(
            tenant_id=tenant_id,
            query=query,
            per_page=limit,
            page=1,
            facet_by=("agent_id",),  # tiny facet for sidebar, skip the rest
        )
        return resp.hits

    # ── Facets only ───────────────────────────────────────────────

    async def facets(
        self,
        *,
        tenant_id: str,
        query: str = "",
        facet_by: tuple[str, ...] | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """Return facet counts for a query without the hit list.

        Used by the search page's sidebar to render the filter
        checkboxes (e.g. "agent_id: alice (12), bob (3)").
        """
        resp = await self.search(
            tenant_id=tenant_id,
            query=query,
            per_page=1,
            page=1,
            facet_by=facet_by,
        )
        return resp.facet_counts


# ── Singleton accessor ──────────────────────────────────────────────

_search_service: SearchService | None = None


def get_search_service() -> SearchService:
    """Return the process-wide SearchService (lazy)."""
    global _search_service
    if _search_service is None:
        _search_service = SearchService()
    return _search_service
