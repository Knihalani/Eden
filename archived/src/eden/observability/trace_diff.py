"""Trace diff — align any two traces' event streams and describe what changed (Wave 9).

The portal's trace view is single-trace; debugging an agent regression
usually means eyeballing two runs side by side. This module powers
``POST /orgs/{org_id}/observability/traces/diff``: fetch both traces'
events with a **lean** projection (identity + timing + outcome + cost —
never the wide ``payload``/``attributes``/body blobs), align the two
streams in ``O(n+m)`` by ``span_id``, and emit a per-step diff plus
aggregate deltas (cost, duration, span count, failures).

Speed notes (measured in ``bench/trace_diff.py``):

* Alignment: naive pairwise join is ``O(n*m)`` (~87 ms at the 2000-event
  cap); the hashed aligner is ``O(n+m)`` (~1.2 ms) — ~75x faster.
* Fetch: the lean projection returns ~13x fewer bytes than the full
  ``_fetch_trace_events`` column set because it never selects the widest
  blob columns.

Everything here is pure read — no writes, no locks, no side effects.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from typing import Any

logger = logging.getLogger(__name__)

#: Lean column set for diff fetches. Deliberately excludes the widest
#: columns (``payload``, ``attributes``, ``tags``, ``reasoning``,
#: ``tool_calls_full``, ``tool_results``, ``request_body``,
#: ``response_body``) — the diff only reasons about span structure,
#: timing, outcome, and cost/token extracts, so pulling full bodies
#: would be 10x+ the bytes for nothing.
#:
#: Cost uses the SAME COALESCE ladder as the trace-list aggregate
#: (``metrics`` → ``payload`` → ``attributes``) so the diff's cost cards
#: never disagree with the page the user is looking at.
_DIFF_EVENTS_COLUMNS: str = (
    "event_id, trace_id, span_id, event_type, name, timestamp, "
    "duration_ms, outcome, error_type, parent_span_id, agent_id, "
    "COALESCE(NULLIF(metrics->>'cost_usd','')::float, "
    "         NULLIF(payload->>'cost_usd','')::float, "
    "         NULLIF(attributes->>'cost_usd','')::float) AS cost_usd, "
    "(NULLIF(payload->>'input_tokens','')::bigint) AS input_tokens, "
    "(NULLIF(payload->>'output_tokens','')::bigint) AS output_tokens"
)


async def fetch_diff_events(org_id: str, trace_id: str) -> list[dict[str, Any]]:
    """Fetch one trace's events with only the columns the diff needs.

    Mirrors :func:`eden.insights.rca._common._fetch_trace_events`'s
    failure contract (empty list on any error; never raises) but with a
    lean projection and ``timestamp ASC`` ordering so callers can align
    streams in execution order.
    """
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("trace_diff: postgres import/fetch failed: %s", exc)
        return []
    if client is None:
        return []
    try:
        rows = await client.fetch(
            f"""
            SELECT {_DIFF_EVENTS_COLUMNS}
            FROM telemetry_events
            WHERE tenant_id = $1 AND trace_id = $2
            ORDER BY timestamp ASC
            LIMIT 2000
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug("trace_diff: fetch failed: %s", exc)
        return []
    return [dict(r) for r in rows]


def _num(value: Any, default: float = 0.0) -> float:
    """Coerce a numeric cell; missing/None becomes ``default``."""
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _int(value: Any, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _event_cost(ev: dict[str, Any]) -> float:
    """Cost for one event: dedicated column, then payload/metrics fallback."""
    cost = ev.get("cost_usd")
    if cost is not None:
        return _num(cost)
    payload = ev.get("payload") or {}
    metrics = ev.get("metrics") or {}
    for source in (metrics, payload):
        if isinstance(source, dict):
            raw = source.get("cost_usd")
            if raw is not None:
                return _num(raw)
    return 0.0


def align_events(
    a: list[dict[str, Any]],
    b: list[dict[str, Any]],
) -> list[tuple[dict[str, Any] | None, dict[str, Any] | None]]:
    """Align two ASC-ordered event lists into paired rows — O(n+m).

    Indexes B once by ``span_id``, walks A in order pairing each step to
    its match (first use wins), then appends B's unmatched steps. Rows
    with a ``None`` side are additions/removals; everything else is a
    same-span pair for per-step comparison.

    Falls back to ``(event_type, name)`` order-preserving matching when a
    span id is missing, so events without span ids still align in
    sequence.
    """
    b_by_span: dict[str, dict[str, Any]] = {}
    # No-span B events are indexed by (event_type, name) into order-
    # preserving deques so the fallback stays O(n+m) worst case (a naive
    # per-A-row scan of the B list would be O(n*m) — the exact thing the
    # hashed span-id path exists to avoid).
    b_no_span: dict[tuple[str, str], deque[dict[str, Any]]] = {}
    b_no_span_order: list[tuple[str, str]] = []
    for ev in b:
        sid = _text(ev.get("span_id"))
        if sid:
            b_by_span.setdefault(sid, ev)
        else:
            key = (_text(ev.get("event_type")), _text(ev.get("name")))
            bucket = b_no_span.get(key)
            if bucket is None:
                bucket = deque()
                b_no_span[key] = bucket
                b_no_span_order.append(key)
            bucket.append(ev)

    used: set[str] = set()
    rows: list[tuple[dict[str, Any] | None, dict[str, Any] | None]] = []
    for ev_a in a:
        sid = _text(ev_a.get("span_id"))
        matched: dict[str, Any] | None = None
        if sid and sid not in used:
            cand = b_by_span.get(sid)
            if cand is not None:
                used.add(sid)
                matched = cand
        if matched is None:
            # No-span fallback: same (event_type, name) in order.
            bucket = b_no_span.get(
                (_text(ev_a.get("event_type")), _text(ev_a.get("name")))
            )
            if bucket:
                matched = bucket.popleft()
        rows.append((ev_a, matched))

    for key in b_no_span_order:
        for ev_b in b_no_span[key]:
            rows.append((None, ev_b))
    # Unmatched span-id B rows (spans present only in B).
    for sid, ev_b in b_by_span.items():
        if sid not in used:
            rows.append((None, ev_b))
    return rows


def _step_diff(
    index: int,
    ev_a: dict[str, Any] | None,
    ev_b: dict[str, Any] | None,
) -> dict[str, Any]:
    """One aligned row: identity, per-side fields, deltas, and a kind."""
    if ev_a is None:
        kind = "only_b"
    elif ev_b is None:
        kind = "only_a"
    else:
        same_name = _text(ev_a.get("name")) == _text(ev_b.get("name"))
        same_outcome = _text(ev_a.get("outcome")) == _text(ev_b.get("outcome"))
        same_error = _text(ev_a.get("error_type")) == _text(ev_b.get("error_type"))
        kind = "same" if (same_name and same_outcome and same_error) else "changed"

    dur_a = _num(ev_a.get("duration_ms")) if ev_a else 0.0
    dur_b = _num(ev_b.get("duration_ms")) if ev_b else 0.0
    cost_a = _event_cost(ev_a) if ev_a else 0.0
    cost_b = _event_cost(ev_b) if ev_b else 0.0

    return {
        "index": index,
        "kind": kind,
        "span_id": _text((ev_a or ev_b or {}).get("span_id")),
        "name_a": _text(ev_a.get("name")) if ev_a else None,
        "name_b": _text(ev_b.get("name")) if ev_b else None,
        "event_type_a": _text(ev_a.get("event_type")) if ev_a else None,
        "event_type_b": _text(ev_b.get("event_type")) if ev_b else None,
        "outcome_a": _text(ev_a.get("outcome")) if ev_a else None,
        "outcome_b": _text(ev_b.get("outcome")) if ev_b else None,
        "error_a": _text(ev_a.get("error_type")) or None if ev_a else None,
        "error_b": _text(ev_b.get("error_type")) or None if ev_b else None,
        "duration_ms_a": dur_a,
        "duration_ms_b": dur_b,
        "duration_delta_ms": round(dur_b - dur_a, 3),
        "cost_usd_a": round(cost_a, 6),
        "cost_usd_b": round(cost_b, 6),
    }


def _trace_rollup(
    trace_id: str,
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    """Per-trace aggregates for the diff header cards."""
    cost = sum(_event_cost(ev) for ev in events)
    return {
        "trace_id": trace_id,
        "span_count": len(events),
        "duration_ms": max((_num(ev.get("duration_ms")) for ev in events), default=0.0),
        "cost_usd": round(cost, 6),
        "failures": sum(
            1
            for ev in events
            if _text(ev.get("error_type")) or _text(ev.get("outcome")) not in ("", "success")
        ),
        "input_tokens": sum(_int(ev.get("input_tokens")) for ev in events),
        "output_tokens": sum(_int(ev.get("output_tokens")) for ev in events),
    }


def diff_events(
    trace_a: str,
    trace_b: str,
    a_events: list[dict[str, Any]],
    b_events: list[dict[str, Any]],
) -> dict[str, Any]:
    """Pure diff of two event lists (also used directly by tests)."""
    started = time.perf_counter()
    pairs = align_events(a_events, b_events)
    steps = [_step_diff(i, ea, eb) for i, (ea, eb) in enumerate(pairs)]

    counts = {"same": 0, "changed": 0, "added": 0, "removed": 0}
    for row in steps:
        kind = row["kind"]
        if kind == "same":
            counts["same"] += 1
        elif kind == "changed":
            counts["changed"] += 1
        elif kind == "only_b":
            counts["added"] += 1
        else:
            counts["removed"] += 1

    rollup_a = _trace_rollup(trace_a, a_events)
    rollup_b = _trace_rollup(trace_b, b_events)

    def _agent(events: list[dict[str, Any]]) -> str | None:
        for ev in events:
            if _text(ev.get("agent_id")):
                return _text(ev.get("agent_id"))
        return None

    return {
        "trace_a": rollup_a,
        "trace_b": rollup_b,
        "totals": {
            "cost_delta_usd": round(rollup_b["cost_usd"] - rollup_a["cost_usd"], 6),
            "duration_delta_ms": round(rollup_b["duration_ms"] - rollup_a["duration_ms"], 3),
            "span_count_delta": rollup_b["span_count"] - rollup_a["span_count"],
            "failures_a": rollup_a["failures"],
            "failures_b": rollup_b["failures"],
            "token_delta": rollup_b["input_tokens"]
            + rollup_b["output_tokens"]
            - rollup_a["input_tokens"]
            - rollup_a["output_tokens"],
        },
        "shared": {
            "agent_id": _agent(a_events) or _agent(b_events),
            "matched_spans": counts["same"] + counts["changed"],
        },
        "counts": counts,
        "steps": steps,
        "took_ms": round((time.perf_counter() - started) * 1000, 3),
    }


async def diff_traces(org_id: str, trace_a: str, trace_b: str) -> dict[str, Any] | None:
    """Diff two traces for an org; ``None`` when either trace is unknown.

    Pure read: two lean ``telemetry_events`` scans, aligned in memory.
    Returns the same shape as :func:`diff_events` (minus the ``steps``
    body if the caller wants a summary) — full shape for the portal.
    """
    a_events = await fetch_diff_events(org_id, trace_a)
    if not a_events:
        return None
    b_events = await fetch_diff_events(org_id, trace_b)
    if not b_events:
        return None
    return diff_events(trace_a, trace_b, a_events, b_events)


# NOTE: both fetches cap at 2000 events (``fetch_diff_events`` LIMIT),
# aligned in ASC order — for traces longer than the cap, ``added`` /
# ``removed`` counts cover only the aligned prefix, not the tail beyond
# event 2000. Acceptable for a compare tool (the cap bounds the response
# size); callers that need the full tail should use the trace tree.
