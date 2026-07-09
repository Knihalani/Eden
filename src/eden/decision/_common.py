"""Shared helpers for Cat 16 (Decision Intelligence) services.

Centralises:
* the trace read path (``_fetch_trace_events``, ``_load_trace_tree``)
* the envelope shape used for live (non-stub) responses
  (``_ok_envelope``, ``_not_found_envelope``)
* the persistence pattern (``_delete_then_insert``) used by the
  3 services that write to the 4 Cat 16 tables — the migration
  (020_intelligence_gap_tables.py) doesn't declare a unique
  constraint on the 4 tables, so the only way to make these
  services re-runnable is to delete-then-insert for the
  (org_id, trace_id) tuple.
* the synthetic event shape (``_build_light_event``) that the
  judges consume — mirrors the ``_LightEvent`` pattern in
  ``src/eden/api/routes/judges.py`` and
  ``src/eden/llmops/judges/redis_tailer.py``.

The helpers are intentionally local to the package — Cat 16 is a
self-contained unit and the package boundary is the right place
to hide the per-service glue.
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime
from typing import Any, cast

logger = logging.getLogger(__name__)


# ── Trace read paths ────────────────────────────────────────────────


async def _fetch_trace_events(org_id: str, trace_id: str) -> list[dict[str, Any]]:
    """Read the flat event list for one (org, trace) from Postgres.

    Mirrors ``_fetch_events_for_trace`` in
    ``src/eden/api/routes/judges.py`` — returns a list of
    ``TelemetryEvent``-shaped dicts (not the dataclass; the judges
    only need a few fields). Ordered by timestamp ASC so the
    reconstructed trajectory is in execution order.

    Returns an empty list if Postgres isn't available or the trace
    has no events. Callers should treat empty as ``not_found`` and
    return the ``_not_found_envelope``.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("decision._common: postgres import failed: %s", exc)
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
        logger.debug("decision._common: fetch events failed: %s", exc)
        return []
    return [dict(r) for r in rows]


async def _load_trace_tree(org_id: str, trace_id: str) -> dict[str, Any] | None:
    """Build the hierarchical trace tree for one (org, trace).

    Returns a normalised dict (NOT the ``TraceTree`` dataclass, to
    keep the helpers decoupled from the collector module) with:

    * ``trace_id``, ``tenant_id``, ``realm``, ``outcome``
    * ``root_spans`` (list of span dicts, each with nested
      ``children``)
    * ``span_map`` (dict ``span_id → span dict``)
    * ``total_duration_ms``, ``span_count``

    Returns ``None`` if the trace has no events. The tree view is
    useful when callers need the parent/child structure (Cat 16
    path reconstruction); flat events are enough for the
    trajectory analyzer and the scorer.
    """
    try:
        from eden.observability.telemetry_collector import get_telemetry_collector
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("decision._common: telemetry import failed: %s", exc)
        return None

    try:
        collector = await get_telemetry_collector()
    except Exception as exc:
        logger.debug("decision._common: get_telemetry_collector failed: %s", exc)
        return None
    if collector is None:
        return None

    try:
        tree = await collector.get_trace_tree(org_id, trace_id)
    except Exception as exc:
        logger.debug("decision._common: get_trace_tree failed: %s", exc)
        return None
    if tree is None:
        return None

    # The TelemetryCollector returns a TraceTree dataclass, but
    # tests may pass a plain dict (with the same keys). Handle
    # both — the field names are identical so the consumer code
    # only needs ``tree["..."]`` to work, which is what we
    # return here.
    def _get(field, default) -> None:
        if isinstance(tree, dict):
            return cast(None, tree.get(field, default))
        return cast(None, getattr(tree, field, default))

    return {
        "trace_id": _get("trace_id", trace_id),
        "tenant_id": _get("tenant_id", org_id),
        "realm": _get("realm", "production"),
        "outcome": _get("outcome", None),
        "root_spans": _get("root_spans", []),
        "span_map": _get("span_map", {}),
        "total_duration_ms": _get("total_duration_ms", 0.0),
        "span_count": _get("span_count", 0),
    }


# ── Envelope helpers ────────────────────────────────────────────────


def _new_trace_id() -> str:
    return f"dec_{uuid.uuid4().hex[:12]}"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The live-response envelope — same shape as the stub envelope
    (so the front-end renders uniformly) but with ``status="ok"``
    and ``live=True`` to signal real data.

    The :mod:`eden.intelligence_envelope` module owns the
    ``IntelligenceStubResponse`` model; we use the same field
    names (``status``, ``feature``, ``live``, ``trace_id``,
    ``timestamp``, ``data``) without depending on the model so the
    decision package can be imported in tests that don't pull in
    the envelope's pydantic dep.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _not_found_envelope(feature: str, trace_id: str) -> dict[str, Any]:
    """Live envelope for a missing trace — distinct from
    ``not_implemented()`` because the service IS implemented, the
    trace just doesn't exist for this org.
    """
    return {
        "status": "not_found",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {"trace_id": trace_id, "reason": "no events found for this (org, trace)"},
    }


# ── Persistence ─────────────────────────────────────────────────────


async def _delete_then_insert(
    org_id: str,
    trace_id: str,
    table: str,
    columns: list[str],
    values: list[Any],
) -> None:
    """Atomic delete-then-insert for the 4 Cat 16 tables.

    None of the 4 tables have a unique constraint, so the only way
    to make the services re-runnable is to clear the (org, trace)
    rows and re-insert. The :func:`asyncio.gather`-free
    sequential pattern is intentional: the runner that the
    ``scorer`` uses also writes to ``judge_scores``, and we want
    stable ordering for debugging.

    Best-effort: any exception is logged and swallowed so the
    caller can still return the live envelope with the in-memory
    data. Persistence is a side-effect, not the contract.

    Defence-in-depth: ``table`` and ``columns`` are interpolated
    raw into SQL below. Today every caller passes hardcoded
    strings, but we still validate at the function boundary so a
    future caller can't smuggle SQL via a column list that came
    from request input.
    """
    import re as _re
    _IDENT = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")  # noqa: N806
    if not isinstance(table, str) or not _IDENT.match(table):
        raise ValueError(
            f"decision._delete_then_insert: invalid SQL identifier "
            f"table={table!r}"
        )
    for i, c in enumerate(columns):
        if not isinstance(c, str) or not _IDENT.match(c):
            raise ValueError(
                f"decision._delete_then_insert: invalid SQL identifier "
                f"column[{i}]={c!r}"
            )

    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("decision._common: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                f"DELETE FROM {table} WHERE org_id = $1 AND trace_id = $2",
                org_id,
                trace_id,
            )
            if not values:
                return
            # asyncpg needs a unique placeholder per column.
            placeholders = ", ".join(
                f"${i + 3}" for i in range(len(values))
            )
            cols_csv = ", ".join(columns)
            await conn.execute(
                f"INSERT INTO {table} (org_id, trace_id, {cols_csv}) "
                f"VALUES ($1, $2, {placeholders})",
                org_id,
                trace_id,
                *values,
            )
    except Exception as exc:
        logger.debug(
            "decision._common: delete_then_insert %s failed: %s", table, exc
        )


async def _insert_rows(
    org_id: str,
    table: str,
    rows: list[tuple[Any, ...]],
    columns: list[str],
) -> None:
    """Bulk insert rows for one org. Used by services that write
    one row per step (e.g. ``decision_paths``,
    ``decision_alternatives``).

    Best-effort like :func:`_delete_then_insert`.

    Defence-in-depth: ``table``/``columns`` are interpolated raw
    into SQL below. Today every caller passes hardcoded strings,
    but we still validate at the function boundary so a future
    caller can't smuggle SQL via a column list that came from
    request input.
    """
    import re as _re
    _IDENT = _re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")  # noqa: N806
    if not isinstance(table, str) or not _IDENT.match(table):
        raise ValueError(
            f"decision._insert_rows: invalid SQL identifier "
            f"table={table!r}"
        )
    for i, c in enumerate(columns):
        if not isinstance(c, str) or not _IDENT.match(c):
            raise ValueError(
                f"decision._insert_rows: invalid SQL identifier "
                f"column[{i}]={c!r}"
            )

    if not rows:
        return
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("decision._common: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            cols_csv = ", ".join(["org_id", *columns])
            placeholders_template = ", ".join(
                f"${i + 2}" for i in range(len(columns))
            )
            await conn.executemany(
                f"INSERT INTO {table} (id, org_id, {cols_csv}) "
                f"VALUES (gen_random_uuid(), $1, {placeholders_template})",
                [(org_id, *row) for row in rows],
            )
    except Exception as exc:
        logger.debug(
            "decision._common: insert_rows %s failed: %s", table, exc
        )


# ── Light event for the judges ──────────────────────────────────────


class _LightEvent:
    """Minimal slot-based object the judges consume.

    Mirrors the ``_LightEvent`` shape in
    ``src/eden/api/routes/judges.py:158`` and
    ``src/eden/llmops/judges/redis_tailer.py:203``. Only the slots
    the 3 Galileo judges read are populated; other fields stay
    ``None``.

    The :class:`Judge.matches` method does ``event.event_type``
    and ``event.payload`` — those plus ``event.tenant_id`` (for
    judge_scores persistence) are all we need.
    """

    __slots__ = (
        "event_id",
        "trace_id",
        "span_id",
        "event_type",
        "payload",
        "attributes",
        "tags",
        "source_format",
        "tenant_id",
    )


def _build_light_event(row: dict[str, Any], *, tenant_id: str) -> _LightEvent:
    """Build a :class:`_LightEvent` from one ``telemetry_events`` row."""
    ev = _LightEvent()
    for slot in _LightEvent.__slots__:
        if slot == "tenant_id":
            setattr(ev, slot, tenant_id)
        else:
            setattr(ev, slot, row.get(slot))
    return ev


# ── Event classification helpers ────────────────────────────────────


# Event types that represent an LLM call (or close enough that a
# Galileo judge could score the action / reasoning / tool pick).
# The judge ``matches()`` does its own per-judge filtering on top
# of this list, so being a bit broad is fine.
LLM_LIKE_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "openai.chat",
        "openai.completion",
        "anthropic.message",
        "anthropic.completion",
        "bedrock.invoke",
        "gemini.generate",
        "otel.chat",
        "otel.text_completion",
        "langfuse.generation",
        "helicone.llm_call",
        "llm_completion",
        "llm_completion_stream",
        "agent.step",
        "agent.decision",
    }
)

# Event types that represent a tool/function call. The trajectory
# analyzer uses these to count tool calls; the path reconstructor
# uses them as "steps" alongside LLM events.
TOOL_LIKE_EVENT_TYPES: frozenset[str] = frozenset(
    {
        "tool.call",
        "tool_call",
        "tool.result",
        "tool_result",
        "function.call",
    }
)


def _is_llm_event(event: dict[str, Any]) -> bool:
    event_type = (event.get("event_type") or "").lower()
    if not event_type:
        return False
    return any(event_type.startswith(prefix) for prefix in LLM_LIKE_EVENT_TYPES) or \
        event_type in LLM_LIKE_EVENT_TYPES


def _is_tool_event(event: dict[str, Any]) -> bool:
    event_type = (event.get("event_type") or "").lower()
    if not event_type:
        return False
    return event_type in TOOL_LIKE_EVENT_TYPES or event_type.startswith("tool.")


def _step_index(idx: int) -> int:
    """0-based step number. Trivial today, but having one helper
    means the numbering convention lives in one place if it ever
    needs to change (e.g. to 1-based for the front-end)."""
    return idx


def _json_dumps(obj: Any) -> str:
    """JSON serialiser with a stable, Postgres-friendly default."""
    return json.dumps(obj, default=str, ensure_ascii=False)


def _truncate_or_empty(s: str | None, limit: int) -> str:
    """Truncate a string to ``limit`` chars and append an ellipsis.
    Returns ``""`` for ``None`` or empty/whitespace input. Used by
    Cat 16 services to keep response envelopes and DB rows small."""
    if not s or not isinstance(s, str):
        return ""
    stripped = s.strip()
    if not stripped:
        return ""
    if len(stripped) <= limit:
        return stripped
    return stripped[: max(0, limit - 1)] + "…"


# ── Field extractors shared by every Cat 16 service ────────────────
# These pull the same "what the agent thought / did" data from the
# telemetry row, just from slightly different shapes. Centralising
# them keeps the four consumer services consistent — when one
# service extracts reasoning from ``payload.reasoning`` and another
# extracts it from ``payload.thought``, the front-end sees a
# predictable shape.


def _extract_reasoning(event: dict[str, Any]) -> str:
    """Best-effort reasoning text from one event.

    Looks at, in order: ``payload.reasoning`` (string), the
    top-level ``reasoning`` column (which may be a dict or a
    string), ``payload.thought``, ``attributes["reasoning"]``.
    """
    payload = event.get("payload") or {}
    if isinstance(payload, dict):
        r = payload.get("reasoning") or payload.get("thought")
        if isinstance(r, str) and r.strip():
            return r
    reasoning_col = event.get("reasoning")
    if isinstance(reasoning_col, str) and reasoning_col.strip():
        return reasoning_col
    if isinstance(reasoning_col, dict):
        # Common shape: ``{"text": "..."}`` or ``{"chain_of_thought": "..."}``
        text = (
            reasoning_col.get("text")
            or reasoning_col.get("chain_of_thought")
            or reasoning_col.get("thought")
        )
        if isinstance(text, str) and text.strip():
            return text
    attrs = event.get("attributes") or {}
    if isinstance(attrs, dict):
        r = attrs.get("reasoning") or attrs.get("thought")
        if isinstance(r, str) and r.strip():
            return r
    return ""


def _extract_chosen_action(event: dict[str, Any]) -> str:
    """The action the agent took at this step.

    Tool call: the tool name (from ``payload.tool_call.name`` or
    ``payload.action`` or ``payload.tool_name``). LLM call: a
    short preview of the assistant text from ``response_body`` or
    ``payload.assistant_text``.
    """
    payload = event.get("payload") or {}
    if isinstance(payload, dict):
        # Tool call shapes
        tool_call = payload.get("tool_call")
        if isinstance(tool_call, dict):
            name = tool_call.get("name") or tool_call.get("tool")
            if name:
                return str(name)
        if isinstance(tool_call, str) and tool_call.strip():
            return tool_call
        for key in ("action", "tool_name", "chosen_action"):
            v = payload.get(key)
            if isinstance(v, str) and v.strip():
                return v
    # Tool calls full (array of {name, args})
    tool_calls_full = event.get("tool_calls_full") or []
    if tool_calls_full and isinstance(tool_calls_full, list):
        first = tool_calls_full[0]
        if isinstance(first, dict):
            name = first.get("name") or first.get("tool")
            if name:
                return str(name)
    # LLM assistant text preview
    response_body = event.get("response_body") or {}
    if isinstance(response_body, dict):
        # OpenAI shape: choices[0].message.content
        choices = response_body.get("choices")
        if isinstance(choices, list) and choices:
            first = choices[0]
            if isinstance(first, dict):
                msg = first.get("message") or {}
                content = msg.get("content") if isinstance(msg, dict) else None
                if isinstance(content, str) and content.strip():
                    return content
                text = first.get("text")
                if isinstance(text, str) and text.strip():
                    return text
    return ""


def _classify_event(event: dict[str, Any]) -> str:
    """One of: ``"llm_call"``, ``"tool_call"``, ``"tool_result"``,
    ``"other"``. Used to bucket events into decision steps."""
    event_type = (event.get("event_type") or "").lower()
    if _is_tool_event(event):
        if "result" in event_type:
            return "tool_result"
        return "tool_call"
    if _is_llm_event(event):
        return "llm_call"
    return "other"
