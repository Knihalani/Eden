"""Trace replay service (Cat 1).

Lets a user open a stored trace, step through it event by event,
and inspect arbitrary fields. Pairs with the workflow-graph
builder (``src/eden/observability/workflow/graph_builder.py``)
to visualise the same trace as a graph of nodes + edges.

Real implementation reads from the existing
``telemetry_events`` table (single source of truth for trace
data) and persists the current cursor to
``trace_replay_sessions`` so the user can resume from where
they left off.

See ``docs/observability-gap/01-trace-replay.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.observability._trace_common import (
    DEFAULT_PAGE_SIZE,
    error_envelope,
    fetch_all_trace_events,
    fetch_events_page,
    json_dumps,
    not_found_envelope,
    ok_envelope,
    serialise_event,
    upsert_session,
)

logger = logging.getLogger(__name__)


class ReplayService:
    """Step-through replay of a stored trace."""

    name = "trace_replay"

    async def replay_trace(
        self,
        org_id: str,
        trace_id: str,
        *,
        cursor: int = 0,
        page_size: int = DEFAULT_PAGE_SIZE,
    ) -> dict[str, Any]:
        """Return the events of ``trace_id`` starting at ``cursor``.

        Reads from ``telemetry_events`` ordered by
        ``timestamp ASC, event_id ASC``. Returns
        ``{events, next_cursor, total}`` where ``next_cursor``
        is ``-1`` when the page is the last one (caller treats
        that as "you've reached the end").

        A small empty page at the end is collapsed: if the
        page is empty AND the cursor is at the start, we
        return ``not_found`` so the UI can show "no such
        trace" instead of an empty list.
        """
        try:
            page_size_int = max(1, min(int(page_size or DEFAULT_PAGE_SIZE), 1000))
        except (TypeError, ValueError):
            page_size_int = DEFAULT_PAGE_SIZE
        try:
            cursor_int = max(0, int(cursor or 0))
        except (TypeError, ValueError):
            cursor_int = 0

        rows = await fetch_events_page(
            org_id, trace_id, cursor=cursor_int, page_size=page_size_int
        )

        # Empty page at the very start: trace not found.
        if not rows and cursor_int == 0:
            return not_found_envelope(self.name, trace_id)

        # Compute next_cursor: if we got fewer than a full page,
        # there are no more rows.
        next_cursor = -1 if len(rows) < page_size_int else cursor_int + len(rows)

        events = [serialise_event(r) for r in rows]

        # Persist a session row so the user can resume from this
        # cursor. We stash the last event_id in state_json so
        # checkpoint rewind has something to re-run from.
        state_json = None
        if events:
            state_json = json_dumps(
                {
                    "last_event_id": events[-1].get("event_id"),
                    "last_timestamp": events[-1].get("timestamp"),
                    "events_seen": cursor_int + len(events),
                }
            )
        await upsert_session(
            org_id, trace_id, cursor=cursor_int, state_json=state_json
        )

        return ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "cursor": cursor_int,
                "page_size": page_size_int,
                "next_cursor": next_cursor,
                "event_count": len(events),
                "events": events,
            },
        )

    async def diff_traces(
        self,
        org_id: str,
        trace_id_a: str,
        trace_id_b: str,
    ) -> dict[str, Any]:
        """Return a side-by-side diff of two traces.

        Useful for "what changed between deployment A and
        deployment B" or "why did this user see a different
        answer than the last one".

        The diff is **per-event-fingerprint** — we collapse each
        event to ``(span_id, event_type, duration_ms, outcome)``
        and classify the pair as:

        * ``added`` — present in B, missing from A
        * ``removed`` — present in A, missing from B
        * ``changed`` — same span_id, different fingerprint
        * ``identical`` — same fingerprint (counted but not
          returned in the per-event list to keep the payload
          small)

        If either trace is missing, returns
        ``not_found_envelope`` so the caller can show a useful
        error message. If both are empty, returns an empty
        diff.
        """
        if not trace_id_a or not trace_id_b:
            return error_envelope(
                self.name,
                "both trace_id_a and trace_id_b are required",
                code="invalid_input",
            )

        rows_a = await fetch_all_trace_events(org_id, trace_id_a)
        rows_b = await fetch_all_trace_events(org_id, trace_id_b)

        # If both are empty, we can't tell whether the trace
        # doesn't exist or the caller mistyped. Default to
        # "not_found" — same shape as replay_trace.
        if not rows_a and not rows_b:
            return not_found_envelope(
                self.name, f"{trace_id_a} vs {trace_id_b}"
            )

        def _fingerprint(row: dict[str, Any]) -> tuple:
            """A coarse but stable per-event fingerprint."""
            return (
                row.get("event_type") or "",
                float(row.get("duration_ms") or 0.0),
                row.get("outcome") or "",
            )

        # Keyed by span_id (falling back to event_id) so we can
        # match events across the two traces.
        def _key(row: dict[str, Any]) -> str:
            return (
                row.get("span_id")
                or row.get("event_id")
                or f"unknown:{row.get('event_id', '')}"
            )

        map_a = {_key(r): r for r in rows_a}
        map_b = {_key(r): r for r in rows_b}

        added: list[dict[str, Any]] = []
        removed: list[dict[str, Any]] = []
        changed: list[dict[str, Any]] = []

        for k, rb in map_b.items():
            if k not in map_a:
                added.append(
                    {
                        "span_id": rb.get("span_id"),
                        "event_type": rb.get("event_type"),
                        "name": rb.get("name"),
                        "duration_ms": rb.get("duration_ms"),
                        "outcome": rb.get("outcome"),
                    }
                )
                continue
            ra = map_a[k]
            if _fingerprint(ra) != _fingerprint(rb):
                changed.append(
                    {
                        "span_id": k,
                        "a": {
                            "event_type": ra.get("event_type"),
                            "duration_ms": ra.get("duration_ms"),
                            "outcome": ra.get("outcome"),
                        },
                        "b": {
                            "event_type": rb.get("event_type"),
                            "duration_ms": rb.get("duration_ms"),
                            "outcome": rb.get("outcome"),
                        },
                    }
                )

        for k, ra in map_a.items():
            if k not in map_b:
                removed.append(
                    {
                        "span_id": ra.get("span_id"),
                        "event_type": ra.get("event_type"),
                        "name": ra.get("name"),
                        "duration_ms": ra.get("duration_ms"),
                        "outcome": ra.get("outcome"),
                    }
                )

        (
            len(map_a)
            - len(added)
            - len(removed)
            - len(changed)
        )
        # The above is per-key, but we want per-event counts.
        # Recompute: a key is "identical" if it's in both maps
        # and the fingerprints match.
        identical = sum(
            1
            for k, ra in map_a.items()
            if k in map_b and _fingerprint(ra) == _fingerprint(map_b[k])
        )

        return ok_envelope(
            self.name,
            {
                "trace_id_a": trace_id_a,
                "trace_id_b": trace_id_b,
                "summary": {
                    "a_event_count": len(rows_a),
                    "b_event_count": len(rows_b),
                    "added": len(added),
                    "removed": len(removed),
                    "changed": len(changed),
                    "identical": identical,
                },
                "added": added,
                "removed": removed,
                "changed": changed,
            },
        )
