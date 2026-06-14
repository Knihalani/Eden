"""Shared helpers for Cat 22 — APM Depth + Tracing Depth (v1.4).

Centralises:

* The OTel v1.41 → v1.36 dual-emit mapping for attributes
  (Galileo + Langfuse dashboards still use the v1.36 names).
* The per-step ``step_index`` / ``step_judges`` envelope shape
  (stored inside ``telemetry_events.attributes`` JSONB — the
  v1.4 ship uses a JSONB column instead of a new column to
  avoid a destructive migration).
* The ``live: True`` envelope shape used by every service in
  this package.

The package follows the v1.3 + v1.4 cat-ship pattern
(:mod:`eden.columnar` + :mod:`eden.predictive`): a single
``_common`` for the envelope + mapping, a small set of
service modules, and a lazy ``__init__`` that re-exports the
public surface.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ─── v1.41 → v1.36 dual-emit map ──────────────────────────────────

#: Maps the v1.41 (current) OTel GenAI attribute name to its
#: v1.36 (legacy) alias. When a v1.41 name is present, the
#: decoder also writes the v1.36 alias so dashboards that
#: reference the legacy name keep working through the spec
#: transition. The reverse direction (v1.36 → v1.41) is also
#: handled: if only the legacy name is present, the decoder
#: adds the v1.41 name with the same value.
#:
#: The full v1.41 spec is in development status (Greptime,
#: May 2026); the v0.1 ship covers the most-used attributes
#: and the ones Cat 16 + Cat 22 read from.
V141_TO_V136: dict[str, str] = {
    # Token usage
    "gen_ai.client.token.usage": "gen_ai.usage.input_tokens",  # input
    "gen_ai.client.output.token.usage": "gen_ai.usage.output_tokens",  # output
    "gen_ai.client.input.token.usage": "gen_ai.usage.input_tokens",  # input (alt)
    # Agent / tool / workflow
    "gen_ai.agent.name": "gen_ai.agent.name",  # same in both
    "gen_ai.agent.id": "gen_ai.agent.id",  # same
    "gen_ai.agent.description": "gen_ai.agent.description",  # same
    "gen_ai.tool.name": "gen_ai.tool.name",  # same
    "gen_ai.tool.call.id": "gen_ai.tool.call.id",  # same
    "gen_ai.tool.description": "gen_ai.tool.description",  # same
    "gen_ai.workflow.name": "gen_ai.workflow.name",  # same
    # Operation
    "gen_ai.operation.name": "gen_ai.operation.name",  # same
    # Model
    "gen_ai.request.model": "gen_ai.request.model",  # same
    "gen_ai.response.model": "gen_ai.response.model",  # same
    # Conversation
    "gen_ai.conversation.id": "gen_ai.conversation.id",  # same
    # System / provider
    "gen_ai.system": "gen_ai.system",  # same
    # Error
    "error.type": "error.type",  # same
    # Finish reasons
    "gen_ai.response.finish_reasons": "gen_ai.response.finish_reasons",  # same
    # MCP-specific
    "mcp.method.name": "mcp.method.name",
    "mcp.resource.uri": "mcp.resource.uri",
    "mcp.prompt.name": "mcp.prompt.name",
}

#: v1.36 → v1.41 reverse map (computed from V141_TO_V136).
V136_TO_V141: dict[str, str] = {}
for _v141, _v136 in V141_TO_V136.items():
    # Don't reverse-map where the names are identical
    if _v141 != _v136:
        V136_TO_V141.setdefault(_v136, _v141)


# ─── Per-step envelope shape ──────────────────────────────────────

#: Attribute key under which per-step judges are stored inside
#: ``telemetry_events.attributes`` JSONB. The shape is::
#:
#:     {
#:       "apm.step_index": 0,
#:       "apm.step_judges": {
#:         "hallucination": 0.85,
#:         "correctness": 0.92,
#:         "tool_selection": 0.78
#:       }
#:     }
#:
#: The Cat 2 RCA clusterer reads this to pinpoint the failing
#: step in a multi-step agent trace.
STEP_INDEX_ATTR = "apm.step_index"
STEP_JUDGES_ATTR = "apm.step_judges"


# ─── Envelope helpers ─────────────────────────────────────────────


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """The Cat 22 happy-path envelope.

    Mirrors the rest of the intelligence surface — the
    ``live: True`` flag signals the front-end to render the
    real metric (not the "stub" badge).
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "timestamp": _now_iso(),
        "data": data,
    }


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ─── Dual-emit logic ──────────────────────────────────────────────


def dual_emit_attributes(
    attrs: dict[str, Any],
    *,
    spec: str = "v141",
) -> dict[str, Any]:
    """Return a copy of ``attrs`` with v1.36/v1.41 dual-emit aliases.

    The v1.4 ship accepts spans in either spec. The decoder
    writes the v1.41 names *and* the v1.36 aliases so
    dashboards don't break.

    Args:
        attrs: The raw attribute dict from the OTLP span.
        spec: ``"v141"`` (default — emit v1.41 names and add
            v1.36 aliases) or ``"v136"`` (emit v1.36 names and
            add v1.41 aliases). Either way both names are
            present after the call.

    Returns:
        A new dict with both v1.36 and v1.41 names. Does not
        mutate ``attrs``.
    """
    if not isinstance(attrs, dict) or not attrs:
        return dict(attrs or {})
    out: dict[str, Any] = dict(attrs)
    if spec == "v141":
        for v141_name, v136_name in V141_TO_V136.items():
            if v141_name in out and v136_name != v141_name and v136_name not in out:
                out[v136_name] = out[v141_name]
    elif spec == "v136":
        for v136_name, v141_name in V136_TO_V141.items():
            if v136_name in out and v141_name != v136_name and v141_name not in out:
                out[v141_name] = out[v136_name]
    return out


def enrich_step_attributes(
    attrs: dict[str, Any],
    *,
    step_index: int,
    step_judges: dict[str, float] | None = None,
) -> dict[str, Any]:
    """Stamp ``step_index`` + ``step_judges`` into a span's attributes.

    The Cat 3 judge_runner calls this when it scores a
    specific step (the trace's step_index is in the OTel
    attribute or in the call site's local context). The
    stamped attributes are persisted to
    ``telemetry_events.attributes`` JSONB so the Cat 2 RCA
    clusterer + the new Cat 22 step-depth metrics can
    consume them.

    Returns a new dict (does not mutate ``attrs``).
    """
    out: dict[str, Any] = dict(attrs or {})
    try:
        out[STEP_INDEX_ATTR] = int(step_index)
    except (TypeError, ValueError):
        out[STEP_INDEX_ATTR] = 0
    if step_judges:
        clean: dict[str, float] = {}
        for k, v in step_judges.items():
            if not isinstance(k, str) or not k:
                continue
            try:
                clean[k] = float(v)
            except (TypeError, ValueError):
                continue
        out[STEP_JUDGES_ATTR] = clean
    return out


def extract_step_judges(attrs: dict[str, Any] | None) -> dict[str, float]:
    """Read the per-step judges stamped by :func:`enrich_step_attributes`.

    Returns an empty dict if the span doesn't have step
    judges. The values are floats.
    """
    if not isinstance(attrs, dict):
        return {}
    raw = attrs.get(STEP_JUDGES_ATTR)
    if not isinstance(raw, dict):
        return {}
    return {str(k): float(v) for k, v in raw.items() if v is not None}


def extract_step_index(attrs: dict[str, Any] | None) -> int | None:
    """Read the per-step index stamped by :func:`enrich_step_attributes`."""
    if not isinstance(attrs, dict):
        return None
    val = attrs.get(STEP_INDEX_ATTR)
    if val is None:
        return None
    try:
        return int(val)
    except (TypeError, ValueError):
        return None
