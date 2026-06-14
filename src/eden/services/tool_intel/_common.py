"""Shared helpers for Cat 7 (Tool Intelligence) services.

Centralises:

* The data read path — :func:`_fetch_tool_events_for_tool`,
  :func:`_fetch_tool_events_for_trace`,
  :func:`_fetch_tool_aggregates`,
  :func:`_fetch_distinct_tools_for_org`,
  :func:`_fetch_tool_pairs_in_trace`.
* The envelope shape used for live (non-stub) responses —
  :func:`_ok_envelope`, :func:`_bad_request_envelope`,
  :func:`_not_found_envelope`. All three use ``live=True``.
* The persistence pattern used by the 2 services that write
  to the 2 Cat 7 tables (``tool_attributions``,
  ``tool_comparisons``). The migration
  (``020_intelligence_gap_tables.py``) does not declare
  unique constraints, so the delete-then-insert pattern is
  the only way to make the services re-runnable.
* :func:`_parse_window` for the time-bounded queries the
  four services run. Accepts ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"``
  and returns a Postgres interval literal; bad input returns
  ``None`` and the service turns it into a bad-request
  envelope.
* :func:`_extract_tool_name` — defensive extraction of the
  tool name from a ``telemetry_events`` row, since the tool
  name lives in different places depending on the source
  format (``attributes->>'tool_name'``, ``attributes->>'name'``,
  ``name`` column, ``payload->>'tool'``).
* :func:`_tool_is_success` — defensive success heuristic for
  tool events. ``outcome='success'`` is the strongest signal;
  ``outcome IS NULL`` AND ``attributes->>'error' IS NULL``
  is the fallback (the v1 telemetry schema often doesn't
  populate ``outcome`` for tool rows).
* :func:`_safe_float` / :func:`_safe_int` / :func:`_clamp` —
  defensive coercion helpers for the SQL aggregation output.
* :func:`_fire_tool_drift_hook` — the single closed-loop
  hook the Cat 7 surface ships. When a tool's success_rate
  drops materially (≥ 0.10 absolute drop OR ≥ 25% relative
  drop) and the call count is ≥ ``DRIFT_MIN_CALLS``, fires
  :func:`eden.llmops.promotion_hooks.get_promotion_hook`
  .on_drift_alert with ``drift_type="tool_success_drop"``
  and ``severity="high"``. Mirrors the Cat 2 RCA + Cat 8
  cost anomaly pattern.

The helpers are intentionally local to the package — Cat 7
is a self-contained unit and the package boundary is the
right place to hide the per-service glue. Mirrors the
layout of :mod:`eden.kb.retrieval_intel._common` (Cat 4),
:mod:`eden.services.cost_intel._common` (Cat 8), and
:mod:`eden.agents.agent_intel._common` (Cat 6).

See ``docs/observability-gap/07-tool-intelligence.md``.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: The set of ``event_type`` values that count as a tool call
#: in the v1 telemetry schema. Matches the format used by
#: :class:`eden.observability.telemetry_collector.TelemetryCollector`
#: (``tool.call``, ``tool.execute``) plus a couple of aliases
#: that show up in OTel / Langfuse ingestion. A row whose
#: ``event_type`` matches one of these prefixes is treated as
#: a tool call for attribution, comparison, and taxonomy
#: purposes.
TOOL_EVENT_TYPES: tuple[str, ...] = (
    "tool.call",
    "tool.execute",
    "tool.invocation",
    "tool_run",
    "tool.result",
)


#: Thresholds for the :func:`_fire_tool_drift_hook` closed-loop
#: hook. The drift fires when *both* (call-count is high
#: enough) AND (success-rate dropped by at least the
#: absolute or relative threshold). Matches the Cat 2 cluster
#: severity heuristic (signal strength × frequency).
DRIFT_MIN_CALLS: int = 10
DRIFT_ABSOLUTE_DROP: float = 0.10
DRIFT_RELATIVE_DROP: float = 0.25

#: Thresholds for the :class:`ToolComparator` winner decision.
#: The tool with the higher success rate wins unless the
#: difference is below this non-inferiority margin (in which
#: case it's a tie). Mirrors the Cat 8 cost-anomaly magnitude
#: convention (0.05 = "about the same").
COMPARATOR_MARGIN: float = 0.05

#: The maximum number of tools the :class:`ToolRegistryTaxonomy`
#: returns in one call. Caps response size for orgs with
#: thousands of distinct tools.
MAX_TOOLS_RETURNED: int = 200

#: The maximum number of tool-pairs the :class:`ToolRegistryTaxonomy`
#: returns in the ``co_occurrence`` matrix. The matrix is
#: O(N²) in the worst case; this cap keeps the response
#: bounded.
MAX_COOCCURRENCE_PAIRS: int = 500

#: The maximum number of recommendations the
#: :class:`ToolRecommender` returns. Matches the appendix
#: spec (``k: 3`` default).
MAX_RECOMMENDATIONS: int = 10

#: Minimum sample size for a tool to be eligible for
#: recommendation. Below this the success_rate is too noisy
#: to score. Mirrors the Cat 4 ``MIN_GAP_SAMPLE_SIZE`` (3)
#: — bumped to 5 here because tool success rates are
#: typically sparser than retrieval hit rates.
RECOMMENDER_MIN_CALLS: int = 5

#: Latency reference (ms) used to normalise the tool's
#: p95_latency to a 0..1 score. 5s is the appendix default.
LATENCY_REFERENCE_MS: float = 5000.0

#: Cost reference (USD per call) used to normalise the
#: tool's cost_per_call_usd to a 0..1 score. 5 cents is the
#: appendix default.
COST_REFERENCE_USD: float = 0.05


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None`` on
    bad input; the service wraps that into a
    :func:`_bad_request_envelope`.

    ``None`` or empty input defaults to ``"30 days"`` (matches
    the appendix's ``window: "30d"`` default for the
    attribution scorer).
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
    """Cat 7-prefixed trace id — distinguishes live responses
    from Cat 1/2/4/6/8/16 in the audit log."""
    return f"ti_{uuid.uuid4().hex[:12]}"


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
    window string or empty tool_id). Returns
    ``status="bad_request"`` so the front-end can render a
    4xx-class message without falling back to the stub
    envelope."""
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {"message": message},
    }


def _not_found_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for a missing resource (e.g. unknown
    tool). Returns ``status="not_found"`` so the front-end
    can render a clean 404 message without falling back to
    the stub envelope."""
    return {
        "status": "not_found",
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
        logger.debug("tool_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("tool_intel: get_postgres_client failed: %s", exc)
        return None


def _tool_event_type_clause() -> str:
    """Build the ``event_type IN (...)`` clause for the
    :data:`TOOL_EVENT_TYPES` list. Returns a literal SQL
    fragment with the values quoted.

    The list is hard-coded in this module, so this is safe
    from injection; we still wrap the values in single
    quotes as a defensive measure.
    """
    return "event_type IN ('" + "','".join(TOOL_EVENT_TYPES) + "')"


def _extract_tool_name(row: dict[str, Any]) -> str | None:
    """Defensive extraction of the tool name from a
    ``telemetry_events`` row.

    Tries the common shapes in priority order:

    1. ``attributes->>'tool_name'`` (the most common shape;
       written by the framework / OTel decoders)
    2. ``attributes->>'name'`` (legacy shape)
    3. ``attributes->>'tool_id'`` (when the source format
       distinguishes the tool_id from the tool_name)
    4. ``payload->>'tool'`` (raw provider format)
    5. The ``name`` column (used by the OTel decoder for
       span names like ``"tool:search_kb"``)

    Returns ``None`` if no shape matches so the caller can
    skip the row.
    """
    if not isinstance(row, dict):
        try:
            row = dict(row)
        except Exception:
            return None
    attrs = row.get("attributes")
    if isinstance(attrs, dict):
        for key in ("tool_name", "name", "tool_id"):
            v = attrs.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()[:128]
    payload = row.get("payload")
    if isinstance(payload, dict):
        for key in ("tool", "tool_name", "name"):
            v = payload.get(key)
            if isinstance(v, str) and v.strip():
                return v.strip()[:128]
    name = row.get("name")
    if isinstance(name, str) and name.strip():
        s = name.strip()[:128]
        # Strip a "tool:" prefix that the OTel decoder adds
        if s.startswith("tool:"):
            return s[len("tool:"):]
        return s
    return None


def _tool_is_success(row: dict[str, Any]) -> bool:
    """Defensive success heuristic for a tool event row.

    * ``outcome='success'`` → True (strongest signal)
    * ``outcome IN ('error', 'failed')`` → False
    * ``outcome IS NULL`` AND ``attributes->>'error' IS NULL``
      AND ``attributes->>'is_error' IS NULL`` → True (the v1
      telemetry schema often doesn't populate ``outcome`` for
      tool rows)
    * ``attributes->>'error'`` is set → False
    * Otherwise → True (default to success; the
      alternative — defaulting to failure — would inflate the
      failure rate in the absence of clean signal)

    Always returns a ``bool``; never raises.
    """
    if not isinstance(row, dict):
        try:
            row = dict(row)
        except Exception:
            return True
    outcome = row.get("outcome")
    if isinstance(outcome, str):
        o = outcome.strip().lower()
        if o == "success":
            return True
        if o in ("error", "failed", "failure"):
            return False
    attrs = row.get("attributes")
    if isinstance(attrs, dict):
        for key in ("error", "is_error", "errored"):
            v = attrs.get(key)
            if v is None:
                continue
            if isinstance(v, bool) and v:
                return False
            if isinstance(v, str) and v.strip().lower() in (
                "true", "1", "yes", "y", "error", "failed"
            ):
                return False
    return True


async def _fetch_tool_events_for_tool(
    org_id: str,
    tool_name: str,
    interval_sql: str,
    *,
    agent_id: str | None = None,
    limit: int = 1000,
) -> list[dict[str, Any]]:
    """Pull tool events for a specific ``(org, tool_name)`` in
    the given window.

    The query is **defensive** about the tool-name location:
    it checks ``attributes->>'tool_name'``, ``attributes->>'name'``,
    and ``payload->>'tool'`` and returns any row where *any*
    of these matches ``tool_name``. This is robust against
    source-format variation (OpenAI, Anthropic, Helicone,
    Langfuse, OTel) where the tool name lives in different
    places.

    ``agent_id`` is an optional filter (the appendix spec
    allows it on the attribution scorer). Returns ``[]`` on
    any failure so the caller can render a "no data"
    envelope.

    Best-effort: exceptions are logged and swallowed.
    """
    client = await _get_client()
    if client is None:
        return []
    tool_name_sanitised = str(tool_name).strip()[:128]
    try:
        rows = await client.fetch(
            f"""
            SELECT trace_id, event_type, duration_ms, outcome,
                   attributes, payload, name, agent_id, created_at
              FROM telemetry_events
             WHERE org_id = $1
               AND {_tool_event_type_clause()}
               AND created_at > NOW() - $2::interval
               AND (COALESCE(NULLIF(attributes->>'tool_name', ''),
                             NULLIF(attributes->>'name', ''),
                             NULLIF(payload->>'tool', ''),
                             NULLIF(payload->>'tool_name', ''),
                             NULLIF(REPLACE(name, 'tool:', ''), ''))
                    ) = $3
               AND ($4::text IS NULL OR agent_id = $4)
             ORDER BY created_at DESC
             LIMIT $5
            """,
            org_id,
            interval_sql,
            tool_name_sanitised,
            agent_id,
            limit,
        )
    except Exception as exc:
        logger.debug("tool_intel: fetch_tool_events_for_tool failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(d)
    return out


async def _fetch_tool_events_for_trace(
    org_id: str,
    trace_id: str,
) -> list[dict[str, Any]]:
    """Pull all tool events for a single trace. Returns
    ``[]`` on any failure. Used by :class:`ToolAttributionScorer`
    when the trace_id is provided (so the per-trace
    attribution can be computed even when the window is
    empty)."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            f"""
            SELECT trace_id, event_type, duration_ms, outcome,
                   attributes, payload, name, agent_id, created_at
              FROM telemetry_events
             WHERE org_id = $1
               AND trace_id = $2
               AND {_tool_event_type_clause()}
             ORDER BY created_at ASC
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("tool_intel: fetch_tool_events_for_trace failed: %s", exc)
        return []
    return [dict(r) if not isinstance(r, dict) else r for r in rows]


async def _fetch_tool_aggregates(
    org_id: str,
    tool_name: str,
    interval_sql: str,
    *,
    agent_id: str | None = None,
) -> dict[str, Any]:
    """Aggregate a single tool's events in a window. Returns
    a dict with ``{n_calls, n_success, success_rate, p50_ms,
    p95_ms, cost_usd_sum, cost_per_call_usd}``. All numeric
    fields default to 0 / None on missing data so the
    callers can render a clean "no data" envelope.

    ``agent_id`` is an optional filter (the appendix spec
    allows it on the attribution scorer).

    Best-effort: returns the zero-defaults on any failure.
    """
    events = await _fetch_tool_events_for_tool(
        org_id, tool_name, interval_sql, agent_id=agent_id
    )
    if not events:
        return {
            "n_calls": 0,
            "n_success": 0,
            "success_rate": None,
            "p50_ms": None,
            "p95_ms": None,
            "cost_usd_sum": 0.0,
            "cost_per_call_usd": None,
            "agent_ids": [],
        }
    durations: list[float] = []
    n_success = 0
    cost_sum = 0.0
    agents: set[str] = set()
    for r in events:
        if _tool_is_success(r):
            n_success += 1
        d = r.get("duration_ms")
        if isinstance(d, (int, float)) and d >= 0:
            durations.append(float(d))
        attrs = r.get("attributes") or {}
        if isinstance(attrs, dict):
            cost = attrs.get("cost_usd")
            if isinstance(cost, (int, float)):
                cost_sum += float(cost)
        ag = r.get("agent_id")
        if isinstance(ag, str) and ag.strip():
            agents.add(ag.strip())
    n = len(events)
    success_rate = n_success / n if n else None
    p50 = _percentile(durations, 0.50)
    p95 = _percentile(durations, 0.95)
    cost_per_call = (cost_sum / n) if n else None
    return {
        "n_calls": n,
        "n_success": n_success,
        "success_rate": success_rate,
        "p50_ms": p50,
        "p95_ms": p95,
        "cost_usd_sum": cost_sum,
        "cost_per_call_usd": cost_per_call,
        "agent_ids": sorted(agents)[:16],
    }


async def _fetch_distinct_tools_for_org(
    org_id: str,
    interval_sql: str,
    *,
    limit: int = MAX_TOOLS_RETURNED,
) -> list[dict[str, Any]]:
    """List the distinct tools the org has called in the
    given window, with per-tool aggregates. Returns a list
    of dicts of the form ``{tool_name, version, n_calls,
    n_success, success_rate, p50_ms, p95_ms,
    cost_per_call_usd, last_seen_at}``.

    The query is per-tool so the comparator + recommender +
    taxonomy can all use the same read path. The loop
    issues one aggregate query per distinct tool; for an
    org with thousands of tools this is N queries, but the
    SQL is O(rows in window) per query so the total is
    bounded. A future iteration can switch to a single
    GROUP BY query for a ~10× speedup.

    Best-effort: returns ``[]`` on any failure."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            f"""
            SELECT DISTINCT
                COALESCE(NULLIF(attributes->>'tool_name', ''),
                         NULLIF(attributes->>'name', ''),
                         NULLIF(payload->>'tool', ''),
                         NULLIF(payload->>'tool_name', ''),
                         REPLACE(name, 'tool:', '')) AS tool_name,
                COALESCE(NULLIF(attributes->>'tool_version', ''),
                         NULLIF(payload->>'tool_version', ''),
                         'unknown') AS tool_version
              FROM telemetry_events
             WHERE org_id = $1
               AND {_tool_event_type_clause()}
               AND created_at > NOW() - $2::interval
             LIMIT $3
            """,
            org_id,
            interval_sql,
            limit * 4,  # over-fetch to account for the
                        # DISTINCT/COALESCE pattern
        )
    except Exception as exc:
        logger.debug("tool_intel: fetch_distinct_tools_for_org failed: %s", exc)
        return []
    distinct: dict[str, str] = {}
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        tn = d.get("tool_name")
        if not isinstance(tn, str) or not tn.strip():
            continue
        tn = tn.strip()[:128]
        if tn in distinct:
            continue
        tv = d.get("tool_version")
        distinct[tn] = (str(tv).strip()[:32] if tv else "unknown")
    out: list[dict[str, Any]] = []
    for tool_name, tool_version in distinct.items():
        agg = await _fetch_tool_aggregates(org_id, tool_name, interval_sql)
        if agg["n_calls"] <= 0:
            continue
        out.append(
            {
                "tool_name": tool_name,
                "tool_version": tool_version,
                "n_calls": agg["n_calls"],
                "n_success": agg["n_success"],
                "success_rate": agg["success_rate"],
                "p50_ms": agg["p50_ms"],
                "p95_ms": agg["p95_ms"],
                "cost_per_call_usd": agg["cost_per_call_usd"],
            }
        )
        if len(out) >= limit:
            break
    # Sort by n_calls desc — the operator's
    # "biggest-bang-for-buck" view.
    out.sort(key=lambda t: -int(t.get("n_calls") or 0))
    return out


async def _fetch_tool_pairs_in_trace(
    org_id: str,
    interval_sql: str,
    *,
    limit_traces: int = 5000,
) -> dict[tuple[str, str], int]:
    """For each trace in the window, collect the set of
    distinct tool names that fired, then emit every
    unordered pair (sorted ascending) into a co-occurrence
    counter.

    Returns a dict ``{(tool_a, tool_b): trace_count}`` where
    ``tool_a < tool_b`` (lexicographic, for determinism).
    Traces that call only one tool contribute nothing.

    This is the input to the :class:`ToolRegistryTaxonomy`
    co-occurrence matrix. Best-effort: returns ``{}`` on
    any failure.
    """
    client = await _get_client()
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            f"""
            SELECT trace_id,
                   COALESCE(NULLIF(attributes->>'tool_name', ''),
                            NULLIF(attributes->>'name', ''),
                            NULLIF(payload->>'tool', ''),
                            NULLIF(payload->>'tool_name', ''),
                            REPLACE(name, 'tool:', '')) AS tool_name
              FROM telemetry_events
             WHERE org_id = $1
               AND {_tool_event_type_clause()}
               AND created_at > NOW() - $2::interval
             ORDER BY trace_id, created_at ASC
             LIMIT $3
            """,
            org_id,
            interval_sql,
            limit_traces * 4,
        )
    except Exception as exc:
        logger.debug("tool_intel: fetch_tool_pairs_in_trace failed: %s", exc)
        return {}
    by_trace: dict[str, set[str]] = {}
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        tid = d.get("trace_id")
        tn = d.get("tool_name")
        if not isinstance(tid, str) or not tid.strip():
            continue
        if not isinstance(tn, str) or not tn.strip():
            continue
        by_trace.setdefault(tid, set()).add(tn.strip()[:128])
    pairs: dict[tuple[str, str], int] = {}
    for tools in by_trace.values():
        names = sorted(tools)
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                pairs[(names[i], names[j])] = (
                    int(pairs.get((names[i], names[j]), 0)) + 1
                )
    return pairs


async def _fetch_tool_success_rate_in_window(
    org_id: str,
    tool_name: str,
    interval_sql: str,
) -> tuple[int, float]:
    """Lightweight: returns ``(n_calls, success_rate)`` for a
    tool in the *current* window (``[NOW() - interval,
    NOW()]``). Used by the drift-hook helper.
    Best-effort: returns ``(0, 0.0)`` on any failure.
    """
    agg = await _fetch_tool_aggregates(org_id, tool_name, interval_sql)
    return (
        int(agg.get("n_calls") or 0),
        float(agg.get("success_rate") or 0.0),
    )


async def _fetch_tool_success_rate_in_prev_window(
    org_id: str,
    tool_name: str,
    interval_sql: str,
) -> tuple[int, float]:
    """Lightweight: returns ``(n_calls, success_rate)`` for a
    tool in the *previous* same-length window (``[NOW() - 2
    × interval, NOW() - interval]``).

    Used by :class:`ToolAttributionScorer` to compare the
    current window's success rate against the previous
    window's. Implementation: a single SQL query that
    filters ``created_at > NOW() - 2*interval AND created_at
    <= NOW() - interval``. The interval is doubled in
    Python and passed as a string so the query stays
    parameterised.

    Best-effort: returns ``(0, 0.0)`` on any failure (and
    on degenerate inputs like ``"0 days"``).
    """
    parts = interval_sql.split()
    if len(parts) != 2:
        return (0, 0.0)
    try:
        n = int(parts[0])
    except ValueError:
        return (0, 0.0)
    if n <= 0:
        return (0, 0.0)
    doubled = f"{n * 2} {parts[1]}"
    client = await _get_client()
    if client is None:
        return (0, 0.0)
    tool_name_sanitised = str(tool_name).strip()[:128]
    try:
        rows = await client.fetch(
            f"""
            SELECT
              COUNT(*)::int                                                       AS n_calls,
              SUM(CASE WHEN outcome = 'success'
                        OR (outcome IS NULL
                            AND (attributes->>'error' IS NULL
                                 AND attributes->>'is_error' IS NULL))
                       THEN 1 ELSE 0 END)::float8 / NULLIF(COUNT(*), 0)::float8 AS success_rate
              FROM telemetry_events
             WHERE org_id = $1
               AND {_tool_event_type_clause()}
               AND created_at > NOW() - $2::interval
               AND created_at <= NOW() - $3::interval
               AND (COALESCE(NULLIF(attributes->>'tool_name', ''),
                             NULLIF(attributes->>'name', ''),
                             NULLIF(payload->>'tool', ''),
                             NULLIF(payload->>'tool_name', ''),
                             NULLIF(REPLACE(name, 'tool:', ''), ''))
                    ) = $4
            """,
            org_id,
            doubled,
            interval_sql,
            tool_name_sanitised,
        )
    except Exception as exc:
        logger.debug(
            "tool_intel: fetch_tool_success_rate_in_prev_window failed: %s", exc
        )
        return (0, 0.0)
    if not rows:
        return (0, 0.0)
    r = dict(rows[0]) if not isinstance(rows[0], dict) else rows[0]
    return (
        int(r.get("n_calls") or 0),
        float(r.get("success_rate") or 0.0),
    )


# ── Numeric helpers ──────────────────────────────────────────────────


def _percentile(values: list[float], pct: float) -> float | None:
    """Pure-Python percentile (no numpy). Returns ``None``
    for an empty list. Uses the nearest-rank method
    (``ceil(pct * n) - 1`` as the 0-indexed rank), which is
    what ``percentile_cont`` approximates for integer
    samples. Deterministic."""
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    if n == 1:
        return float(s[0])
    k = max(0, min(n - 1, int(round(pct * (n - 1)))))
    return float(s[k])


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic in the 4 services."""
    if isinstance(value, bool):
        # ``True``/``False`` would coerce to 1/0 — guard against it.
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0


def _safe_float_or_none(value: Any) -> float | None:
    """Coerce ``value`` to ``float``; return ``None`` for
    anything that isn't a number. Used by the services that
    distinguish "no data" from "0.0"."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _safe_int(value: Any, default: int = 0) -> int:
    """Coerce ``value`` to ``int``; return ``default`` for
    anything that isn't a number."""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return int(value)
    return default


def _clamp(value: float, lo: float, hi: float) -> float:
    """Bound ``value`` to ``[lo, hi]``. Used to keep the
    success_rate / contribution_score in a sane range when
    the source data is misbehaving."""
    return max(lo, min(hi, value))


def _round6(value: float | None) -> float | None:
    """Round to 6 decimal places for stable JSON output.
    ``None`` passes through (used by the services that
    distinguish "no data" from "0.0")."""
    if value is None:
        return None
    return round(float(value), 6)


# ── Persistence ──────────────────────────────────────────────────────


async def _delete_then_insert_attribution(
    org_id: str,
    trace_id: str | None,
    tool_id: str,
    rows: list[dict[str, Any]],
) -> None:
    """Replace the ``tool_attributions`` rows for this
    ``(org_id, trace_id, tool_id)`` tuple. ``rows`` is a
    list of ``{trace_id, tool_id, impact_score}`` dicts; each
    becomes one row. The service is re-runnable because we
    clear the prior tuple first.

    The migration has no unique constraint, so the
    clear-then-insert pattern is the only way to make the
    service re-runnable. Best-effort: any exception is
    logged and swallowed so the caller can still return the
    live envelope with the in-memory data.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("tool_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            if trace_id is not None:
                await conn.execute(
                    """
                        DELETE FROM tool_attributions
                         WHERE org_id = $1
                           AND trace_id = $2
                           AND tool_id = $3
                        """,
                    org_id, trace_id, tool_id,
                )
            else:
                await conn.execute(
                    """
                        DELETE FROM tool_attributions
                         WHERE org_id = $1
                           AND tool_id = $2
                        """,
                    org_id, tool_id,
                )
            for r in rows:
                tid = str(r.get("trace_id", ""))[:128]
                tname = str(r.get("tool_id", tool_id))[:128]
                impact = r.get("impact_score")
                await conn.execute(
                    """
                        INSERT INTO tool_attributions
                            (id, org_id, trace_id, tool_id, impact_score)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4)
                        """,
                    org_id, tid, tname, impact,
                )
    except Exception as exc:
        logger.debug("tool_intel: attribution write failed: %s", exc)


async def _delete_then_insert_comparison(
    org_id: str,
    tool_a: str,
    tool_b: str,
    window: str,
    payload: dict[str, Any],
) -> None:
    """Write a single ``tool_comparisons`` row for the
    ``(org_id, tool_a, tool_b, window)`` tuple. The
    ``metrics_json`` column is the JSON-serialised ``payload``
    dict.

    Re-runnable via DELETE+INSERT (the table has no unique
    constraint). Best-effort like
    :func:`_delete_then_insert_attribution`.
    """
    import json
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("tool_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        # ``tool_a`` and ``tool_b`` are unordered in the
        # table — normalise so the same pair always lands on
        # the same row regardless of which the caller
        # listed first.
        ta, tb = sorted([str(tool_a)[:128], str(tool_b)[:128]])
        winner_raw = payload.get("winner")
        winner_norm: str | None
        if winner_raw in (ta, tb, tool_a, tool_b):
            # Map back to the alphabetical form.
            if winner_raw == tool_a or winner_raw == ta and ta == tool_a:
                winner_norm = ta
            elif winner_raw == tool_b or winner_raw == tb and tb == tool_b:
                winner_norm = tb
            else:
                winner_norm = str(winner_raw)[:16]
        else:
            winner_norm = (
                str(winner_raw)[:16] if winner_raw is not None else None
            )
        metrics_json = json.dumps(payload, default=str)
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM tool_comparisons
                     WHERE org_id = $1
                       AND tool_a = $2
                       AND tool_b = $3
                       AND window = $4
                    """,
                org_id, ta, tb, window,
            )
            await conn.execute(
                """
                    INSERT INTO tool_comparisons
                        (id, org_id, tool_a, tool_b, window,
                         winner, metrics_json)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4,
                            $5, $6)
                    """,
                org_id, ta, tb, window, winner_norm, metrics_json,
            )
    except Exception as exc:
        logger.debug("tool_intel: comparison write failed: %s", exc)


# ── Closed-loop hook firing ──────────────────────────────────────────


def _fire_tool_drift_hook(
    org_id: str,
    *,
    tool_name: str,
    n_calls: int,
    success_rate_now: float | None,
    success_rate_prev: float | None,
) -> None:
    """Fire :func:`PromotionHook.on_drift_alert` for a
    material drop in a tool's success rate.

    Mirrors the pattern at
    :mod:`eden.agents.agent_intel._common` and
    :mod:`eden.services.cost_intel._common`. The hook is a
    no-op logger in stub mode; a real implementation would
    let the canary auto-rollback on a high-severity drift
    alert.

    The drift fires when *all* of:

    * ``n_calls >= DRIFT_MIN_CALLS`` (avoids noise on tiny
      samples; matches the Cat 6 ``DRIFT_MIN_BASELINE_CALLS``)
    * ``success_rate_now`` is not None
    * The absolute drop is ``>= DRIFT_ABSOLUTE_DROP`` (0.10)
      OR the relative drop is ``>= DRIFT_RELATIVE_DROP``
      (25%) — relative requires ``success_rate_prev > 0`` to
      avoid divide-by-zero.

    Drift type is ``"tool_success_drop"`` so the front-end /
    audit log can grep for it. Severity is ``"high"`` for
    ``absolute_drop >= 0.20`` (a major regression) and
    ``"medium"`` otherwise. Mirrors the Cat 2 clusterer
    ``critical|high|medium`` ladder.

    Wrapped in try/except — the hook is best-effort and
    must never break the response.
    """
    if success_rate_now is None:
        return
    if n_calls < DRIFT_MIN_CALLS:
        return
    abs_drop = (success_rate_prev or 0.0) - success_rate_now
    rel_drop = (
        abs_drop / success_rate_prev if success_rate_prev and success_rate_prev > 0
        else 0.0
    )
    if abs_drop < DRIFT_ABSOLUTE_DROP and rel_drop < DRIFT_RELATIVE_DROP:
        return
    severity = "high" if abs_drop >= 0.20 else "medium"
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("tool_intel: hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug("tool_intel: get_promotion_hook failed: %s", exc)
        return
    try:
        hook.on_drift_alert(
            org_id,
            drift_type=f"tool_success_drop:{tool_name}",
            severity=severity,
        )
    except Exception as exc:
        logger.debug("tool_intel: on_drift_alert failed: %s", exc)
