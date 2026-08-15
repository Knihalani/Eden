"""In-process slow-query event ring buffer (F83 / K44).

Records slow SQL fingerprints observed by instrumented call sites.
Tenant-scoped listing powers ``GET /orgs/{org}/admin/slow-queries``.
No ``pg_stat_activity`` — cluster-wide stats stay off-limits to tenants.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from typing import Any

_MAX_EVENTS = 500
_DEFAULT_THRESHOLD_MS = 200.0

_lock = threading.Lock()
_events: deque[dict[str, Any]] = deque(maxlen=_MAX_EVENTS)


def reset_for_tests() -> None:
    with _lock:
        _events.clear()


def record_slow_query(
    *,
    org_id: str,
    fingerprint: str,
    duration_ms: float,
    source: str = "unknown",
    threshold_ms: float = _DEFAULT_THRESHOLD_MS,
) -> bool:
    """Record a slow query when ``duration_ms`` exceeds ``threshold_ms``.

    Returns True when an event was stored.
    """
    if not org_id or duration_ms < threshold_ms:
        return False
    event = {
        "org_id": str(org_id),
        "fingerprint": (fingerprint or "unknown")[:256],
        "duration_ms": round(float(duration_ms), 3),
        "source": (source or "unknown")[:64],
        "recorded_at": time.time(),
    }
    with _lock:
        _events.append(event)
    return True


def list_slow_queries(
    org_id: str,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Return recent slow-query events for ``org_id`` (newest first)."""
    lim = max(1, min(int(limit), 200))
    with _lock:
        rows = [e for e in _events if e.get("org_id") == str(org_id)]
    rows.reverse()
    return rows[:lim]


def slow_query_count(org_id: str) -> int:
    with _lock:
        return sum(1 for e in _events if e.get("org_id") == str(org_id))


def admin_slow_queries_payload(org_id: str, *, limit: int = 50) -> dict[str, Any]:
    """Shape returned by the admin slow-queries endpoint."""
    events = list_slow_queries(org_id, limit=limit)
    return {
        "org_id": str(org_id),
        "slow_query_count": slow_query_count(org_id),
        "available": True,
        "threshold_ms": _DEFAULT_THRESHOLD_MS,
        "events": events,
        "note": "In-process ring buffer; not a cluster pg_stat_activity dump.",
    }


__all__ = [
    "admin_slow_queries_payload",
    "list_slow_queries",
    "record_slow_query",
    "reset_for_tests",
    "slow_query_count",
]
