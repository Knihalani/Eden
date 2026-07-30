"""Counter for ClickHouse→Postgres fallbacks in the columnar path.

Ten `except Exception` handlers across `src/eden/columnar/` drop from
ClickHouse to Postgres, and before this module none of them incremented
anything. Two of the three query-path handlers
(`aggregations.py`, `partitions.py`) did not even log. So a columnar
subsystem that was failing on *every single call* was indistinguishable
from one that was working — which is exactly what happened: the sink's
`_execute` form-encoded its SQL into the request body, ClickHouse read the
body as SQL and rejected every statement with a syntax error, and the
fallback quietly served Postgres for the entire life of the feature.

A fallback is not an error — falling back is the designed behaviour and the
data is still served correctly. What matters is the *rate*: an occasional
fallback is a healthy circuit breaker, and a 100% fallback rate means the
columnar store is decorative. Only a counter can tell those apart, which is
why this is a metric rather than a log line.

Deliberately separate from `observability.drop_metrics`: nothing is dropped
here, so `eden_events_dropped_total` would be the wrong name and the wrong
closed vocabulary.
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

# Closed vocabularies, same discipline as drop_metrics: an unbounded label
# set on a metric is a cardinality incident waiting to happen.
SURFACES: frozenset[str] = frozenset(
    {
        "query",          # ColumnarQueryEngine.execute
        "aggregations",   # rollup aggregation reads
        "partitions",     # partition ensure/probe
        "compaction",     # compaction runs
        "home_kpi",       # Home dashboard KPI tiles
        "alerts",         # dsl/alerts evaluation
        "unknown",
    }
)

REASONS: frozenset[str] = frozenset(
    {
        "unavailable",    # health probe said no / not configured
        # Structural, not transient: the logical table has no ClickHouse
        # mirror at all. Kept distinct from "unavailable" so a permanent
        # ~100% rate on this label cannot drown out a real outage.
        "no_mirror",
        "query_error",    # ClickHouse accepted the connection, rejected the query
        "empty",          # reachable and populated with nothing usable
        "timeout",
        "unknown",
    }
)

_MAX_PAIRS = 64
_OVERFLOW = ("unknown", "unknown")

_lock = threading.Lock()
_counts: dict[tuple[str, str], float] = {}
_warned: set[tuple[str, str]] = set()


def _coerce(surface: str, reason: str) -> tuple[str, str]:
    s = surface if surface in SURFACES else "unknown"
    r = reason if reason in REASONS else "unknown"
    if (s, r) != (surface, reason):
        key = (surface, reason)
        if key not in _warned:
            _warned.add(key)
            logger.warning(
                "columnar fallback metric: unknown (surface, reason) "
                "(%r, %r) folded to (%r, %r)", surface, reason, s, r,
            )
    return s, r


def record_fallback(surface: str, reason: str, count: float = 1.0) -> None:
    """Count one ClickHouse→Postgres fallback. Never raises."""
    if count <= 0:
        return
    try:
        key = _coerce(surface, reason)
        with _lock:
            if key not in _counts and len(_counts) >= _MAX_PAIRS:
                key = _OVERFLOW
            _counts[key] = _counts.get(key, 0.0) + float(count)
    except Exception:  # noqa: BLE001 — a metric must never break a fallback
        pass


def get_fallback_metrics() -> dict[tuple[str, str], float]:
    with _lock:
        return dict(_counts)


def reset_for_tests() -> None:
    with _lock:
        _counts.clear()
        _warned.clear()
