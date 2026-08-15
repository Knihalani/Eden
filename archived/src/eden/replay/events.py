"""Session recording events (Phase O — Browser session recording).

Laminar's differentiator: the user can replay the exact
browser session that produced a failed agent run. The
recording is a stream of events (DOM mutations, user
inputs, navigations) that can be replayed deterministically
in a sandbox.

This module is the **backend** side: the event model,
the storage shape, the redaction contract, and the replay
timeline helper. The actual browser-side recorder
(``rrweb`` or equivalent) is Phase O.5.

Event model
───────────
Each recorded event is one of:
  * ``dom_mutation`` — a DOM change (add / remove / modify
    element). Carries the serialized mutation.
  * ``user_input`` — a keyboard / mouse / form event.
  * ``navigation`` — a URL change (pushState, location).
  * ``console`` — a ``console.log`` / ``console.error`` (for
    debugging the recorded session).
  * ``meta`` — a session-level marker (start, end, viewport
    size).

All events are JSON-serialisable and content-addressed
(SHA-256 of the canonical form). Storage is in the
``session_events`` table; the per-event columns are JSONB
for forward-compatibility.

Privacy
──────
Browser recordings contain PII. The recorder applies
``MultiLangPIIMasker`` (Phase K) before sending events to
the server. The server side applies a second pass. The
default redaction removes emails / SSNs / credit cards /
IP addresses; org-configurable via the existing
``org_pii_policies`` table.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

logger = logging.getLogger(__name__)


# ─- Event types ─────────────────────────────────────────────


class SessionEventType(StrEnum):
    """The 5 event types the recorder emits."""

    DOM_MUTATION = "dom_mutation"
    USER_INPUT = "user_input"
    NAVIGATION = "navigation"
    CONSOLE = "console"
    META = "meta"


# ─- Event dataclass ────────────────────────────────────────


@dataclass
class SessionEvent:
    """One recorded event from a browser session.

    The event is identified by a content-addressed hash of
    its canonical JSON form. The same logical event
    recorded twice (e.g. via replay) gets the same id.
    """

    id: str
    session_id: str
    sequence: int           # 0-indexed position in the session
    event_type: str         # SessionEventType value
    timestamp: str
    payload: dict[str, Any]
    # Optional: the trace_id this session is associated
    # with. The session may be the user-side mirror of an
    # agent run.
    trace_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "session_id": self.session_id,
            "sequence": self.sequence,
            "event_type": self.event_type,
            "timestamp": self.timestamp,
            "payload": dict(self.payload),
            "trace_id": self.trace_id,
        }


# ─- Session dataclass ───────────────────────────────────────


@dataclass
class Session:
    """One recorded browser session.

    Sessions are identified by a UUID; the recorder's
    event stream is append-only. The session is associated
    with an org (multi-tenancy) and optionally with a
    trace (the agent run that the user was running).
    """

    id: str
    org_id: str
    started_at: str
    ended_at: str | None = None
    # Optional: the user agent (for replay context).
    user_agent: str = ""
    # Optional: the viewport size at start.
    viewport_w: int = 0
    viewport_h: int = 0
    # Optional: the trace this session is associated with.
    trace_id: str | None = None
    # Counters (computed at replay time).
    event_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "org_id": self.org_id,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "user_agent": self.user_agent,
            "viewport_w": self.viewport_w,
            "viewport_h": self.viewport_h,
            "trace_id": self.trace_id,
            "event_count": self.event_count,
        }


# ─- Redaction ──────────────────────────────────────────────


# Patterns the recorder MUST redact from any string-valued
# field. These are intentionally simple — the production
# recorder (Phase O.5) wires the full
# :class:`MultiLangPIIMasker`.
_REDACT_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "[REDACTED:email]"),
    (r"\b\d{3}-\d{2}-\d{4}\b", "[REDACTED:ssn]"),
    (r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", "[REDACTED:phone]"),
    (r"\b\d{16}\b", "[REDACTED:cc]"),
    (r"\b(?:sk|pk|api[_-]?key)[_-]?[A-Za-z0-9]{20,}\b", "[REDACTED:apikey]"),
)


def redact_event(event: SessionEvent) -> SessionEvent:
    """Apply basic PII redaction to an event.

    For v1 this is a regex-based scrubber. Phase O.5 wires
    the full :class:`MultiLangPIIMasker` (which catches
    EU VAT, Chinese ID, etc.).
    """
    redacted_payload = _redact_value(event.payload)
    return SessionEvent(
        id=event.id,
        session_id=event.session_id,
        sequence=event.sequence,
        event_type=event.event_type,
        timestamp=event.timestamp,
        payload=redacted_payload,
        trace_id=event.trace_id,
    )


def _redact_value(value: Any) -> Any:
    """Recursively redact a payload value."""
    if isinstance(value, str):
        out = value
        for pat, repl in _REDACT_PATTERNS:
            out = re.sub(pat, repl, out)
        return out
    if isinstance(value, dict):
        return {k: _redact_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    return value


# ─- Event ID generation ─────────────────────────────────────


def _canonical_json(payload: dict[str, Any]) -> str:
    """Render ``payload`` as a canonical JSON string for
    content-addressing. Sorted keys, no whitespace."""
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def event_id(
    session_id: str,
    sequence: int,
    event_type: str,
    payload: dict[str, Any],
) -> str:
    """Compute a content-addressed event id.

    Two events with the same (session, sequence, type,
    payload) hash to the same id — this is the foundation
    of idempotent re-runs.
    """
    import hashlib
    blob = f"{session_id}|{sequence}|{event_type}|{_canonical_json(payload)}"
    return "evt-" + hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


# ─- Session service ────────────────────────────────────────


class SessionRecorder:
    """Append-only in-memory session recorder.

    Production wires this to a Postgres-backed
    :class:`SessionStore` (Phase O.5). The in-memory
    surface is for unit tests + the small batch of use
    cases that don't need durability.
    """

    def __init__(self, redact: bool = True) -> None:
        self._sessions: dict[str, Session] = {}
        self._events: dict[str, list[SessionEvent]] = {}
        self._redact = redact

    def start(
        self,
        *,
        org_id: str,
        user_agent: str = "",
        viewport_w: int = 0,
        viewport_h: int = 0,
        trace_id: str | None = None,
    ) -> Session:
        import uuid as _uuid
        sid = "sess-" + _uuid.uuid4().hex[:16]
        now = datetime.now(UTC).isoformat()
        s = Session(
            id=sid, org_id=org_id, started_at=now,
            user_agent=user_agent,
            viewport_w=viewport_w, viewport_h=viewport_h,
            trace_id=trace_id,
        )
        self._sessions[sid] = s
        self._events[sid] = []
        return s

    def end(self, session_id: str) -> Session | None:
        s = self._sessions.get(session_id)
        if s is None:
            return None
        s.ended_at = datetime.now(UTC).isoformat()
        s.event_count = len(self._events.get(session_id, []))
        return s

    def append(
        self,
        session_id: str,
        event_type: str,
        payload: dict[str, Any],
    ) -> SessionEvent | None:
        """Append one event to a session."""
        s = self._sessions.get(session_id)
        if s is None:
            return None
        if s.ended_at is not None:
            return None  # session is closed
        seq = len(self._events[session_id])
        ev = SessionEvent(
            id=event_id(session_id, seq, event_type, payload),
            session_id=session_id,
            sequence=seq,
            event_type=event_type,
            timestamp=datetime.now(UTC).isoformat(),
            payload=payload,
        )
        if self._redact:
            ev = redact_event(ev)
        self._events[session_id].append(ev)
        return ev

    def list_events(self, session_id: str) -> list[SessionEvent]:
        return list(self._events.get(session_id, []))

    def get_session(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)


# ─- Replay timeline ────────────────────────────────────────


def build_timeline(events: list[SessionEvent]) -> list[dict[str, Any]]:
    """Build a renderable timeline from a session's events.

    Returns a list of "buckets" (one per event type) with
    counts. The frontend uses this to render the replay
    scrubber (a coloured bar with a "DOM mutations" segment,
    a "user inputs" segment, etc.).
    """
    counts: dict[str, int] = {}
    for ev in events:
        counts[ev.event_type] = counts.get(ev.event_type, 0) + 1
    return [
        {"event_type": t, "count": c}
        for t, c in sorted(counts.items(), key=lambda x: -x[1])
    ]


__all__ = [
    "SessionEventType",
    "SessionEvent",
    "Session",
    "SessionRecorder",
    "redact_event",
    "event_id",
    "build_timeline",
]
