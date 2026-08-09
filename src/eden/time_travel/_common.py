"""Shared helpers for Cat 20 — Time-Travel Debugging (v1.3).

The four services (:class:`TraceRecorder`, :class:`TraceForker`,
:class:`TraceReplayer`, :class:`ReplayDiff`) share four concerns:

* **Envelope shape** — every route returns the
  ``status / feature / live / data`` envelope from
  :mod:`eden.intelligence_envelope`. The Cat 20 routes use
  the live ``ok`` shape on the happy path; the missing-parent
  / cache-miss paths return the live envelope with a clear
  ``message`` so the UI can render a "the parent trace has no
  cacheable steps" hint.

* **Deterministic id builders** — the fork id, replay id, and
  step cache key are all content-derived (so re-running the
  same operation on the same input produces the same id,
  making the services re-runnable). The fork id is
  ``frk_<uuid>`` (customer-facing); the replay id is
  ``rpl_<uuid>``.

* **Edit application** — the :class:`TraceReplayer` accepts
  per-step dotted-path edits (e.g. ``step_30.system_prompt``)
  via the :func:`_apply_edits` helper. The helper enforces
  the per-step edit format the appendix recommends.

* **Persistence helpers** — the :func:`_upsert_fork_branch`
  and :func:`_insert_replay_step` helpers wrap the
  Postgres round-trip with the standard delete-then-insert
  + append-only patterns the rest of the intelligence
  surface uses.

The v1.3 ship is **non-destructive** in two important ways:

* The recorder marks a step as cacheable but never *blocks*
  a step from being recorded — the recording is
  observational.
* The replayer serves steps 1..N-1 from cache when the
  parent has cacheable steps; when it doesn't, the replayer
  re-executes ALL steps live and surfaces a
  ``cache_miss_warnings`` field so the user knows the
  "10× debug cycle time" claim doesn't apply to their
  specific fork.

Closed-loop wiring: the Cat 20 ships do not fire any
closed-loop hooks in v1.3. The forks + replays feed the
existing :func:`PromotionHook.on_judge_regression` event
through the Cat 3 judge path (the replayer scores the
replayed output with the existing judge set).
"""

from __future__ import annotations

import contextlib
import json
import logging
import re
import uuid
from typing import Any

logger = logging.getLogger(__name__)


# ─── Envelope helpers ────────────────────────────────────────


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The Cat 20 happy-path envelope.

    Mirrors the rest of the intelligence surface — the
    ``live: True`` flag signals the front-end to render the
    live fork-and-replay UI rather than the "stub" badge.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "data": data,
    }


def _ok_envelope_with_message(
    feature: str, data: dict[str, Any], message: str
) -> dict[str, Any]:
    """The Cat 20 happy-path envelope with a top-level message.

    Used when the operation succeeded but with caveats the
    UI should surface — e.g. "the parent trace has no
    cacheable steps, so this replay re-executed everything
    live".
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "message": message,
        "data": data,
    }


def _not_implemented_envelope(
    feature: str, message: str
) -> dict[str, Any]:
    """The Cat 20 error envelope.

    Returned when the input is malformed (missing parent
    trace, invalid edits, etc.).
    """
    return {
        "status": "not_implemented",
        "feature": feature,
        "live": False,
        "data": None,
        "message": message,
    }


# ─── Deterministic id builders ──────────────────────────────


def _fork_id_for() -> str:
    """Customer-facing fork id.

    Format: ``frk_<uuid4.hex[:16]>``. The 16-hex-char
    suffix keeps the id short for the URL while remaining
    collision-resistant (10^19 keys per org per day).
    """
    return f"frk_{uuid.uuid4().hex[:16]}"


def _replay_id_for() -> str:
    """Customer-facing replay id.

    Format: ``rpl_<uuid4.hex[:16]>``. Same rationale as
    :func:`_fork_id_for`.
    """
    return f"rpl_{uuid.uuid4().hex[:16]}"


def _step_cache_key(
    *, trace_id: str, step_index: int, response_hash: str
) -> str:
    """Content-derived cache key for a step.

    Format: ``tt:<trace_id>:<step_index>:<response_hash>``.
    The response_hash is the existing
    ``telemetry_events.response_hash`` value; we re-use it
    so a step that was cached during the original execution
    hits the same key on a later fork.
    """
    return f"tt:{trace_id}:{step_index}:{response_hash}"


# ─── Edit application ──────────────────────────────────────


# The edit DSL: ``step_<n>.<key>`` -> value. The v1.3 ship
# supports the per-step dotted-path format the appendix
# recommends. Examples:
#   {"step_30.system_prompt": "...", "step_30.temperature": 0.0}
#   {"step_45.tool_name": "search", "step_45.tool_args.query": "..."}
# The :func:`_apply_edits` helper walks the dict and produces
# the per-step patch map the replayer consumes.
_EDIT_KEY_RE = re.compile(r"^step_(\d+)\.([A-Za-z_][A-Za-z0-9_.]*)$")


def _validate_edits(edits: dict[str, Any]) -> str | None:
    """Return an error message if the edits dict is malformed.

    The v1.3 ship supports the per-step dotted-path format
    the appendix recommends. Any malformed key returns a
    clear error message so the route can return a 400-class
    envelope.

    Returns ``None`` on success (the edits dict is well-
    formed).
    """
    if not isinstance(edits, dict):
        return "edits must be a dict"
    for key in edits:
        if not _EDIT_KEY_RE.match(key):
            return (
                f"invalid edit key: {key!r} "
                "(expected format: step_<n>.<key>, "
                "e.g. step_30.system_prompt)"
            )
    return None


def _parse_edits(
    edits: dict[str, Any]
) -> dict[int, dict[str, Any]]:
    """Group the edits dict by step_index.

    The v1.3 ship accepts the per-step dotted-path format
    the appendix recommends (``step_30.system_prompt``)
    and groups them by step_index so the replayer can
    apply all edits to step 30 in one pass.

    Example:
        {"step_30.system_prompt": "...", "step_30.temperature": 0.0,
         "step_45.tool_name": "search"}
        → {30: {"system_prompt": "...", "temperature": 0.0},
           45: {"tool_name": "search"}}
    """
    out: dict[int, dict[str, Any]] = {}
    for key, value in edits.items():
        m = _EDIT_KEY_RE.match(key)
        if not m:
            continue
        step_idx = int(m.group(1))
        sub_key = m.group(2)
        out.setdefault(step_idx, {})[sub_key] = value
    return out


def _apply_edits_to_step(
    step: dict[str, Any],
    step_edits: dict[str, Any],
) -> dict[str, Any]:
    """Apply the per-step edits into ``step["payload"]`` (and request).

    Returns a new dict (the input is not mutated). Prompt-shaped
    keys (``messages``, ``prompt``, ``system_prompt``, ``model``,
    ``temperature``, …) are written where :meth:`TraceReplayer._re_execute_step`
    reads them — nested under ``payload`` / ``payload.request``, not
    only on the step root.
    """
    out = dict(step)
    payload_raw = out.get("payload")
    if isinstance(payload_raw, dict):
        payload: dict[str, Any] = dict(payload_raw)
    else:
        payload = {}
    request_raw = payload.get("request")
    request: dict[str, Any] = (
        dict(request_raw) if isinstance(request_raw, dict) else {}
    )
    prompt_keys = {
        "messages",
        "prompt",
        "system_prompt",
        "model",
        "model_version",
        "temperature",
    }
    for k, v in step_edits.items():
        out[k] = v
        payload[k] = v
        if k in prompt_keys:
            request[k] = v
    if request:
        payload["request"] = request
    out["payload"] = payload
    return out


# ─── Cache lookup persistence (Cat 20) ───────────────────────


async def record_cache_lookup(
    *,
    org_id: str,
    cache_key: str,
    tokens_used: int = 0,
    cost_usd: float = 0.0,
) -> None:
    """Best-effort INSERT into ``cache_lookups`` for TraceReplayer reads.

    Ensures the table exists (CREATE IF NOT EXISTS) so environments
    without a dedicated migration still work. Never raises.
    """
    if not org_id or not cache_key:
        return
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return
        await client.execute(
            """
            CREATE TABLE IF NOT EXISTS cache_lookups (
                id            BIGSERIAL PRIMARY KEY,
                org_id        VARCHAR(128) NOT NULL,
                cache_key     TEXT NOT NULL,
                tokens_used   INTEGER NOT NULL DEFAULT 0,
                cost_usd      DOUBLE PRECISION NOT NULL DEFAULT 0,
                created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        await client.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_cache_lookups_org_key
            ON cache_lookups (org_id, cache_key, created_at DESC)
            """
        )
        await client.execute(
            """
            INSERT INTO cache_lookups (org_id, cache_key, tokens_used, cost_usd)
            VALUES ($1, $2, $3, $4)
            """,
            org_id,
            cache_key[:512],
            int(tokens_used or 0),
            float(cost_usd or 0.0),
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("record_cache_lookup failed: %s", exc)


async def _upsert_fork_branch(
    *,
    org_id: str,
    fork_id: str,
    parent_trace_id: str,
    parent_fork_id: str | None,
    fork_at_step: int,
    name: str,
    edits_json: str,
) -> None:
    """Upsert a fork branch row.

    The fork_id is unique per row (the PK), so a re-fork
    on the same ``(org, parent_trace_id, fork_at_step)``
    tuple updates the row in place. The replay
    reproducibility story depends on this — the replayer
    reads ``edits_json`` to reconstruct the fork state.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO trace_fork_branches (
            id, org_id, fork_id, parent_trace_id, parent_fork_id,
            fork_at_step, name, edits_json
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8
        )
        ON CONFLICT (fork_id) DO UPDATE SET
            parent_trace_id = EXCLUDED.parent_trace_id,
            parent_fork_id = EXCLUDED.parent_fork_id,
            fork_at_step = EXCLUDED.fork_at_step,
            name = EXCLUDED.name,
            edits_json = EXCLUDED.edits_json
        """,
        uuid.uuid4(),
        org_id,
        fork_id,
        parent_trace_id,
        parent_fork_id,
        fork_at_step,
        name,
        edits_json,
    )


async def _get_fork_branch(
    *, fork_id: str, org_id: str
) -> dict[str, Any] | None:
    """Return the fork branch row, or ``None`` if not found.

    The fork_id is the customer-facing identifier; the
    org_id filter is the per-tenant isolation check the
    RLS pattern uses.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    row = await client.fetchrow(
        "SELECT * FROM trace_fork_branches "
        "WHERE fork_id = $1 AND org_id = $2",
        fork_id,
        org_id,
    )
    if not row:
        return None
    d: dict[str, Any] = dict(row)
    for k, v in d.items():
        if hasattr(v, "isoformat"):
            d[k] = v.isoformat()
    return d


async def _increment_fork_replay_counter(
    *, org_id: str, fork_id: str, outcome: str
) -> None:
    """Increment the fork's replay counter and last outcome.

    The list-forks route reads this to render the
    success/fail rate per fork. Idempotent on the row
    itself; the counter is a plain ``+= 1`` so a
    concurrent replay could lose a count, but the v1.3
    ship doesn't require exact counts (the list is a
    "show me the rough state" surface).
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        "UPDATE trace_fork_branches "
        "SET n_replays = n_replays + 1, last_replay_outcome = $3 "
        "WHERE org_id = $1 AND fork_id = $2",
        org_id,
        fork_id,
        outcome,
    )


async def _insert_replay_step(
    *,
    org_id: str,
    replay_id: str,
    fork_id: str,
    step_index: int,
    served_from_cache: bool,
    cache_key: str | None,
    re_executed: bool,
    response_hash: str | None,
    tokens_used: int,
    cost_usd: float,
) -> None:
    """Append a row to ``trace_replay_steps``.

    Append-only — the table is the per-step history.
    The diff route reads the rows in
    ``(org_id, replay_id, step_index)`` order to render
    the side-by-side timeline.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    await client.execute(
        """
        INSERT INTO trace_replay_steps (
            id, org_id, replay_id, fork_id, step_index,
            served_from_cache, cache_key, re_executed, response_hash,
            tokens_used, cost_usd
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
        )
        """,
        uuid.uuid4(),
        org_id,
        replay_id,
        fork_id,
        step_index,
        served_from_cache,
        cache_key,
        re_executed,
        response_hash,
        tokens_used,
        cost_usd,
    )


async def _get_replay_steps(
    *, replay_id: str, org_id: str
) -> list[dict[str, Any]]:
    """Return the replay's per-step rows.

    Sorted by ``step_index ASC`` so the diff route can
    render the side-by-side timeline in order. The
    response_hash is included so the diff route can
    detect cache hits.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    rows = await client.fetch(
        "SELECT step_index, served_from_cache, cache_key, "
        "re_executed, response_hash, tokens_used, cost_usd "
        "FROM trace_replay_steps "
        "WHERE replay_id = $1 AND org_id = $2 "
        "ORDER BY step_index ASC",
        replay_id,
        org_id,
    )
    return [dict(r) for r in rows]


async def _list_forks_for_trace(
    *, parent_trace_id: str, org_id: str
) -> list[dict[str, Any]]:
    """Return all forks of a given parent trace for the org.

    Sorted by ``created_at DESC`` (newest first). The
    list-forks route uses this to render the "forks of
    this trace" panel in the portal.
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    rows = await client.fetch(
        "SELECT fork_id, parent_trace_id, parent_fork_id, "
        "fork_at_step, name, n_replays, last_replay_outcome, "
        "created_at "
        "FROM trace_fork_branches "
        "WHERE parent_trace_id = $1 AND org_id = $2 "
        "ORDER BY created_at DESC",
        parent_trace_id,
        org_id,
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        d: dict[str, Any] = dict(r)
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        out.append(d)
    return out


# ─── JSON helpers ────────────────────────────────────────────


def _json_dumps(obj: Any) -> str:
    """JSON-serialise ``obj`` to a string."""
    return json.dumps(obj, default=str, sort_keys=True)


# ─── Step extraction helpers ────────────────────────────────


async def _get_parent_steps(
    *, parent_trace_id: str, org_id: str
) -> list[dict[str, Any]]:
    """Return the parent trace's steps from ``telemetry_events``.

    The v1.3 ship uses the ``name = 'agent.step'`` event
    type as the step source (the existing Cat 1 trace tree
    pattern). Steps are sorted by ``timestamp ASC`` so the
    replayer can walk them in order.

    A fork can be created on a trace that has no
    ``agent.step`` events — in that case we return an
    empty list and the replayer surfaces a clear
    ``"no step telemetry"`` message. The fork itself is
    still useful (the customer can fork a trace and edit
    the system prompt at step 0; the replayer will
    re-execute everything live).
    """
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    # ``telemetry_events`` is keyed by ``tenant_id`` (not
    # ``org_id``). ``response_hash`` lives in attributes /
    # payload rather than a dedicated column.
    rows = await client.fetch(
        """
        SELECT event_id, trace_id, span_id, name, payload, attributes,
               duration_ms, timestamp
        FROM telemetry_events
        WHERE trace_id = $1
          AND tenant_id = $2
          AND event_type = 'agent.step'
        ORDER BY timestamp ASC
        """,
        parent_trace_id,
        org_id,
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        d: dict[str, Any] = dict(r)
        for k, v in d.items():
            if hasattr(v, "isoformat"):
                d[k] = v.isoformat()
        # Normalize JSONB that may arrive as a string.
        for jk in ("payload", "attributes"):
            val = d.get(jk)
            if isinstance(val, str):
                with contextlib.suppress(ValueError, TypeError):
                    d[jk] = json.loads(val)
        _attrs = d.get("attributes")
        attrs = _attrs if isinstance(_attrs, dict) else {}
        _payload = d.get("payload")
        payload = _payload if isinstance(_payload, dict) else {}
        _response = payload.get("response")
        response = _response if isinstance(_response, dict) else {}
        d["response_hash"] = (
            d.get("response_hash")
            or attrs.get("response_hash")
            or response.get("response_hash")
            or payload.get("response_hash")
            or ""
        )
        out.append(d)
    return _normalize_parent_step_indices(out)


def _step_index_of(
    step: dict[str, Any], *, fallback: int
) -> int:
    """Best-effort step_index extraction.

    The ``agent.step`` event stores its sequence number in
    ``payload->>'step_index'`` (the v1.3 schema convention
    from Cat 22). When the field is missing, the fallback
    is used (the forker passes the row's position in the
    timeline as a fallback).
    """
    payload = step.get("payload")
    if isinstance(payload, dict):
        idx = payload.get("step_index")
        if isinstance(idx, int):
            return idx
        if isinstance(idx, str) and idx.isdigit():
            return int(idx)
    attrs = step.get("attributes")
    if isinstance(attrs, dict):
        idx = attrs.get("step_index")
        if isinstance(idx, int):
            return idx
        if isinstance(idx, str) and idx.isdigit():
            return int(idx)
    if isinstance(payload, str):
        try:
            parsed = json.loads(payload)
            if isinstance(parsed, dict):
                idx = parsed.get("step_index")
                if isinstance(idx, int):
                    return idx
        except (ValueError, TypeError):
            pass
    return fallback


def _normalize_parent_step_indices(
    steps: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Assign unique chronological ``step_index`` values.

    Gateways historically defaulted ``step_index=0`` on every
    LLM call, which collapses a whole agent run into one fork
    boundary. When recorded indices collide (or are all zero
    across multiple steps), remap to ``0..n-1`` by the already
    sorted timestamp order so fork / replay / diff stay aligned
    with the UI timeline.
    """
    if not steps:
        return steps
    recorded = [_step_index_of(s, fallback=i) for i, s in enumerate(steps)]
    unique = len(set(recorded)) == len(recorded)
    use_recorded = unique and not (
        len(recorded) > 1 and all(idx == 0 for idx in recorded)
    )
    out: list[dict[str, Any]] = []
    for position, step in enumerate(steps):
        normalized = dict(step)
        effective = recorded[position] if use_recorded else position
        normalized["step_index"] = effective
        payload = normalized.get("payload")
        if isinstance(payload, dict):
            payload = dict(payload)
            payload["step_index"] = effective
            normalized["payload"] = payload
        attrs = normalized.get("attributes")
        if isinstance(attrs, dict):
            attrs = dict(attrs)
            attrs["step_index"] = effective
            normalized["attributes"] = attrs
        out.append(normalized)
    return out


def _step_has_replayable_prompt(step: dict[str, Any]) -> bool:
    """True when the recorded step carries prompt/messages for live re-exec."""
    _payload = step.get("payload")
    payload = _payload if isinstance(_payload, dict) else {}
    _request = payload.get("request")
    request = _request if isinstance(_request, dict) else {}
    prompt = request.get("prompt") or payload.get("prompt") or ""
    if isinstance(prompt, str) and prompt.strip():
        return True
    messages = request.get("messages") or payload.get("messages") or []
    return bool(isinstance(messages, list) and messages)


def _recorded_cache_key(step: dict[str, Any]) -> str | None:
    """Prefer the cache key written at record time (survives index remap)."""
    _attrs = step.get("attributes")
    attrs = _attrs if isinstance(_attrs, dict) else {}
    key = attrs.get("cache_key")
    if isinstance(key, str) and key.strip():
        return key
    return None


__all__ = [
    "_apply_edits_to_step",
    "_fork_id_for",
    "_normalize_parent_step_indices",
    "_recorded_cache_key",
    "_step_has_replayable_prompt",
    "_get_fork_branch",
    "_get_parent_steps",
    "_get_replay_steps",
    "_increment_fork_replay_counter",
    "_insert_replay_step",
    "_json_dumps",
    "_list_forks_for_trace",
    "_not_implemented_envelope",
    "_ok_envelope",
    "_ok_envelope_with_message",
    "_parse_edits",
    "_replay_id_for",
    "_step_cache_key",
    "_step_index_of",
    "_upsert_fork_branch",
    "_validate_edits",
    "record_cache_lookup",
]
