"""N11 — channel naming, flags, and in-memory session buffer."""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

LIVE_CHANNEL_PREFIX = "trace:live"
LIVE_BUFFER_MAX = 500
LIVE_MAX_SESSIONS_PER_ORG = 100
LIVE_META_TTL_S = 3600
LIVE_FINALIZE_GRACE_S = 300
LIVE_RATE_LIMIT_PER_MIN = 1000


def channel_name(org_id: str, session_id: str) -> str:
    return f"{LIVE_CHANNEL_PREFIX}:{org_id}:{session_id}"


def meta_key(org_id: str, session_id: str) -> str:
    return f"{LIVE_CHANNEL_PREFIX}:meta:{org_id}:{session_id}"


def buffer_key(org_id: str, session_id: str) -> str:
    return f"{LIVE_CHANNEL_PREFIX}:buf:{org_id}:{session_id}"


def org_sessions_key(org_id: str) -> str:
    return f"{LIVE_CHANNEL_PREFIX}:org_sessions:{org_id}"


def seq_key(org_id: str, session_id: str) -> str:
    return f"{LIVE_CHANNEL_PREFIX}:seq:{org_id}:{session_id}"


def live_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "live_trace_streaming_v1", False))
    except Exception:
        return False


def live_mcp_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "live_mcp_tail_v1", False))
    except Exception:
        return False


def max_sessions_per_org() -> int:
    try:
        from eden.config import get_settings

        return int(
            getattr(
                get_settings(),
                "live_max_sessions_per_org",
                LIVE_MAX_SESSIONS_PER_ORG,
            )
        )
    except Exception:
        return LIVE_MAX_SESSIONS_PER_ORG


@dataclass
class SessionBuffer:
    """Bounded in-process buffer (fallback when Redis list unavailable)."""

    events: deque[dict[str, Any]] = field(
        default_factory=lambda: deque(maxlen=LIVE_BUFFER_MAX)
    )
    dropped: int = 0
    finalized: bool = False
    finalized_at: float | None = None
    created_at: float = field(default_factory=time.monotonic)

    def append(self, event: dict[str, Any]) -> None:
        if len(self.events) >= LIVE_BUFFER_MAX:
            self.dropped += 1
        self.events.append(event)

    def since(self, from_event_id: int) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for ev in self.events:
            eid = int(ev.get("event_id") or 0)
            if eid > from_event_id:
                out.append(ev)
        return out
