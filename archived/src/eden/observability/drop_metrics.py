"""Counter for events Eden discards, by pipeline stage and reason.

Eden drops telemetry in roughly eighteen places — load shed, queue overflow,
oversize payloads, failed sink writes, shutdown races — and until now every one
of them was silent. A dropped event and an event that was never sent look
identical from the outside, which means the only way to notice ingest loss was
a customer asking where their traces went.

This module is the one place that accounting lives:
``eden_events_dropped_total{stage, reason}``.

Two design constraints, both learned from the latency histogram that had to be
capped after an unauthenticated attacker could add a permanent row per request
(see ``api/middleware/latency.py``):

* **Closed vocabularies.** ``stage`` and ``reason`` are drawn from the frozen
  sets below. A caller passing anything else is folded into ``unknown`` rather
  than minting a new series, so no user-controlled string can ever reach a
  label value.
* **A hard cardinality cap** as a second line of defence, in case the
  vocabularies grow carelessly. Past the cap, counts fold into the overflow
  pair instead of allocating — the total stays truthful even when the
  breakdown stops being.

Pre-seeded pairs matter more than they look. A counter that has never been
incremented is *absent* from the exposition, and absent is indistinguishable
from "instrumentation is broken" — exactly the failure this module exists to
detect. Seeding the wired pairs at zero makes "no drops" an assertion rather
than an absence, so ``rate(eden_events_dropped_total[5m]) > 0`` alerts work
from the first scrape.
"""

from __future__ import annotations

import logging
import threading

logger = logging.getLogger(__name__)

#: Pipeline stages an event can be lost at, ordered roughly by how far the
#: event travelled before dying.
STAGES: frozenset[str] = frozenset({
    "sdk",          # client-side buffer, before the event ever left the app
    "ingest",       # HTTP boundary: load shed, oversize, malformed
    "dedup",        # idempotency / duplicate suppression
    "sample",       # sampling gate
    "enrich",       # normalization, PII masking
    "queue",        # in-process queue between ingest and the sinks
    "sink_pg",      # Postgres write
    "sink_ch",      # ClickHouse write
    "sink_search",  # Typesense index write
    "sse",          # Live Tail fan-out
    "unknown",
})

#: Why the event was dropped. Kept deliberately coarse: these are alert
#: predicates, not debug detail. Detail belongs in a log line next to the
#: increment.
REASONS: frozenset[str] = frozenset({
    "load_shed",       # deliberate: upstream pressure
    "queue_full",      # backpressure exhausted
    "oversize",        # payload above the accepted limit
    "malformed",       # failed validation/parse
    "duplicate",       # already seen; not a loss
    "sampled_out",     # deliberate: sampling policy
    "quota_exceeded",  # tenant over plan limits
    "write_error",     # sink rejected or errored
    "timeout",         # sink did not answer in time
    "shutdown",        # process exited before flush
    "unknown",
})

#: Ceiling on distinct ``(stage, reason)`` pairs held in memory. The closed
#: vocabularies bound this to len(STAGES) * len(REASONS) already; the cap is a
#: backstop against that product growing without anyone noticing.
_MAX_PAIRS = 256

#: Where counts go once the cap is hit, so the total stays correct even when
#: the breakdown cannot.
_OVERFLOW: tuple[str, str] = ("unknown", "unknown")

#: Pairs seeded at zero so the series exists before the first drop. Only pairs
#: with a real call site belong here — seeding the full cross product would
#: bury the meaningful series in ~120 permanent zeros.
_SEEDED: tuple[tuple[str, str], ...] = (
    ("ingest", "load_shed"),
    ("ingest", "oversize"),
    ("ingest", "malformed"),
    ("ingest", "quota_exceeded"),
    ("queue", "queue_full"),
    ("sink_pg", "write_error"),
    ("sink_ch", "write_error"),
    ("sink_search", "write_error"),
    ("sse", "queue_full"),
    ("sdk", "queue_full"),
    ("enrich", "shutdown"),
)

_lock = threading.Lock()
_counts: dict[tuple[str, str], float] = {}

#: Unknown stage/reason values are a programming error, so they are logged —
#: but at most once per distinct value, because the call sites are hot.
_warned: set[tuple[str, str]] = set()


def _seed() -> None:
    for pair in _SEEDED:
        _counts.setdefault(pair, 0.0)


_seed()


def _coerce(stage: str, reason: str) -> tuple[str, str]:
    """Fold anything outside the closed vocabularies into ``unknown``."""
    ok_stage = stage in STAGES
    ok_reason = reason in REASONS
    if not ok_stage or not ok_reason:
        key = (stage, reason)
        if key not in _warned:
            _warned.add(key)
            logger.warning(
                "drop_metrics: unrecognised (stage=%r, reason=%r); counting as "
                "unknown. Add it to STAGES/REASONS if it is a real category.",
                stage,
                reason,
            )
        return (stage if ok_stage else "unknown", reason if ok_reason else "unknown")
    return (stage, reason)


def record_drop(stage: str, reason: str, count: int = 1) -> None:
    """Record ``count`` events discarded at ``stage`` because of ``reason``.

    Safe to call from any thread and from the hot path: one uncontended lock
    acquire and a dict update. Never raises — an accounting failure must not
    become an ingest failure.
    """
    if count <= 0:
        return
    with _lock:
        key = _coerce(stage, reason)
        if key not in _counts and len(_counts) >= _MAX_PAIRS:
            key = _OVERFLOW
        _counts[key] = _counts.get(key, 0.0) + float(count)


def get_drop_metrics() -> dict[tuple[str, str], float]:
    """Return a snapshot of ``{(stage, reason): count}``."""
    with _lock:
        return dict(_counts)


def total_drops() -> float:
    """Total events dropped across every stage and reason."""
    with _lock:
        return sum(_counts.values())


def reset_for_tests() -> None:
    """Clear all counts and restore the seeded zeros."""
    with _lock:
        _counts.clear()
        _warned.clear()
        _seed()


__all__ = [
    "REASONS",
    "STAGES",
    "get_drop_metrics",
    "record_drop",
    "reset_for_tests",
    "total_drops",
]
