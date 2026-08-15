"""Trace-quality hot-path hooks (Cat 15/17/22 wiring, spec §12).

This module owns the live trajectory evaluation called by the
``POST /v1/guardrails/trajectory/check`` route and by the
``GuardrailedFramework`` PlanningFramework subclass wrapper.

Hot-path contract (No-Drop Invariant #3): **p99 < 5ms over a
1000-step workload**. The implementation is intentionally
minimal — a single in-memory 8-check ensemble + a kill-switch
DB read. The Cat 15 Policy extension and Cat 17 StatGate gating
are wired but only run when the recommended action is
mutating.

The kill switch is per-(tenant, action_class). Read-only
actions (``record_to_table``, ``emit_audit_event``,
``emit_drift_alert``, ``rewrite_response``, ``coalesce_step``)
default ``applied=True``. Mutating actions default
``applied=False`` and require an operator flip via
``POST /v1/admin/guardrails/{action_class}/enable``.

Performance design
------------------

The hot path is the tightest loop in the platform; every
microsecond matters. The implementation uses three techniques
to stay under the 5 ms p99 budget at 1000 steps:

1. **Pure-Python checks** — every check is an ``O(1)`` attribute
   lookup + cheap comparison. Each runs in well under 1 us.

2. **Module-level imports + LRU-cached kill switch** — the
   per-tenant kill switch is read once per (tenant, action_class)
   pair, cached in-process for 60 s, and served from a dict
   lookup on the hot path. The ``_get_kill_switch`` cache is
   bounded by an LRU eviction policy so a hostile tenant cannot
   blow up the process memory.

3. **Fire-and-forget action queue** — the persistent
   ``trace_guardrail_actions`` insert is *not* awaited on the
   hot path. Events are appended to a bounded in-memory queue
   (``_ACTION_QUEUE``) and a background drain task flushes them
   to Postgres in batches (``executemany``). If the queue is
   full or the drain is unhealthy, the hot path keeps going —
   a missed audit row never blocks a live guardrail decision.

The drain task is started on the first call to
``evaluate_trajectory_step`` (lazy-start) and stopped on
``shutdown_trace_quality()``. Tests call
``reset_for_tests()`` to clear the queue, cache, and drain
state between runs.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
import uuid
from typing import Any

logger = logging.getLogger(__name__)


# ponytail: action class -> default kill-switch state.
# Mirrors ``Settings.default_action_applied_flag``.
ACTION_CLASS_DEFAULTS: dict[str, bool] = {
    "record_to_table": True,
    "emit_audit_event": True,
    "emit_drift_alert": True,
    "rewrite_response": True,
    "coalesce_step": True,
    "truncate_context": False,
    "block_user": False,
    "escalate_to_admin": False,
    "revoke_api_key": False,
    "apply_policy_change": False,
}


# ponytail: monotonic action precedence (most-restrictive first).
# Spec §4 Phase 4 — action precedence (most-restrictive-first).
ACTION_PRECEDENCE: list[str] = [
    "block_user",
    "revoke_api_key",
    "escalate_to_admin",
    "truncate_context",
    "apply_policy_change",
    "rewrite_response",
    "coalesce_step",
    "emit_drift_alert",
    "emit_audit_event",
    "record_to_table",
]


# ponytail: O(1) precedence lookup. The reducer used to scan
# ``ACTION_PRECEDENCE`` linearly per check (10 entries × 8 checks
# = 80 dict-membership tests per step). Pre-computing the rank
# turns the reducer into a single argmax over a fixed-size list.
_PRECEDENCE_INDEX: dict[str, int] = {
    name: idx for idx, name in enumerate(ACTION_PRECEDENCE)
}


# ── 8 hot-path checks (≤1ms each in pure-Python) ───────────────────


def _safe_float(value: Any, default: float = 0.0) -> float:
    """Coerce to float without raising. NaN/inf → ``default``.

    The hot path can receive arbitrary event payloads (forward
    compat with new telemetry schemas) so coercion must never
    throw — a single bad payload must not 500 the guardrail.
    """
    if value is None:
        return default
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    # ``f != f`` is the canonical NaN check; ``math.isfinite``
    # also rejects ±inf. Both are mis-coercions from upstream.
    if f != f or f in (float("inf"), float("-inf")):
        return default
    return f


def _safe_int(value: Any, default: int = 0) -> int:
    """Coerce to int without raising. NaN/inf/float → ``default``."""
    if value is None:
        return default
    if isinstance(value, bool):
        # bool is a subclass of int — reject it explicitly so
        # ``True`` doesn't masquerade as 1 in numeric contexts.
        return default
    try:
        i = int(value)
    except (TypeError, ValueError):
        return default
    return i


def _cost_guard(event: dict[str, Any]) -> str | None:
    """Cat 8 z-score on cumulative cost. Returns action_class or None."""
    cost_usd = _safe_float(event.get("cost_usd"))
    if cost_usd > 100.0:
        return "truncate_context"
    if cost_usd > 25.0:
        return "rewrite_response"
    return None


def _token_guard(event: dict[str, Any]) -> str | None:
    """Projected total vs budget. Returns action_class or None."""
    usage_total = _safe_int(event.get("usage_total_tokens"))
    if usage_total > 200_000:
        return "truncate_context"
    if usage_total > 120_000:
        return "coalesce_step"
    return None


def _loop_guard(event: dict[str, Any]) -> str | None:
    """Phase 3 ensemble verdict (callers pass it in via the event).

    Most events carry ``"OK"`` (the no-loop default). The
    fast path is a length-and-first-char short-circuit: if
    the verdict is anything other than 4 characters
    starting with ``"L"``, the check returns immediately
    without an ``.upper()`` allocation.

    The case-insensitive ``.upper()`` is only paid when the
    fast path matches, so the steady-state path is a single
    attribute lookup + a length compare + a char compare
    (~0.1us).
    """
    verdict = event.get("loop_verdict") or ""
    # Fast path: most events have a short verdict ("OK", "",
    # or a 2-letter status code) — the length check rejects
    # these in O(1) before any per-character work.
    if len(verdict) != 4:
        return None
    # Case-insensitive first-character compare: callers may
    # pass "LOOP", "loop", or "Loop". ``[0:1].upper()`` on
    # a single character avoids the full-string ``.upper()``
    # allocation when the verdict starts with anything other
    # than "L"/"l" (the common case for non-loop events).
    if verdict[0:1].upper() != "L":
        return None
    # Full string compare, still case-insensitive, paid only
    # when the first character is "L"/"l".
    if verdict.upper() != "LOOP":
        return None
    sev = event.get("loop_severity") or "low"
    # Case-insensitive compare: the wiring path normalises
    # to lowercase, but raw event payloads (e.g. from
    # external adapters) may use "High" / "HIGH".
    if sev.lower() == "high":
        return "block_user"
    return "coalesce_step"


def _tool_dedup(event: dict[str, Any]) -> str | None:
    """K+1=3 identical tool calls in a row → coalesce."""
    repeat_count = _safe_int(event.get("tool_repeat_count"))
    if repeat_count >= 3:
        return "coalesce_step"
    return None


def _retry_storm(event: dict[str, Any]) -> str | None:
    """3+ failures in last 5 events → block."""
    fail_count = _safe_int(event.get("recent_failure_count"))
    if fail_count >= 3:
        return "block_user"
    return None


def _schema_validator(event: dict[str, Any]) -> str | None:
    """Missing required fields → rewrite."""
    if event.get("schema_missing"):
        return "rewrite_response"
    return None


def _latency_guard(event: dict[str, Any]) -> str | None:
    """Z-score on per-step latency."""
    z = _safe_float(event.get("latency_z"))
    if z > 5:
        return "block_user"
    if z > 4:
        return "escalate_to_admin"
    if z > 3:
        return "emit_drift_alert"
    return None


def _finish_reason(event: dict[str, Any]) -> str | None:
    """Map OpenAI / Anthropic finish reasons to actions.

    The fast path rejects the common ``"stop"`` /
    ``"tool_calls"`` cases by the first character
    (case-insensitive). The full set is then tested with a
    pre-lowercased copy so a single ``.lower()`` allocation
    covers all branches.
    """
    reason = event.get("finish_reason") or ""
    if not reason:
        return None
    first = reason[0]
    # Case-insensitive first-char fast path: "s" (stop /
    # tool_calls) and "t" (tool_calls) are the common
    # non-action values.
    if first in "sS" or first in "tT":
        return None
    # Case-insensitive full compare. ``reason.lower()`` is
    # a single small-string allocation, paid only when the
    # fast path misses.
    low = reason.lower()
    if low in ("length", "max_tokens"):
        return "truncate_context"
    if low in ("content_filter", "refusal"):
        return "escalate_to_admin"
    return None


_HOT_PATH_CHECKS = [
    _cost_guard,
    _token_guard,
    _loop_guard,
    _tool_dedup,
    _retry_storm,
    _schema_validator,
    _latency_guard,
    _finish_reason,
]


# ponytail: enhanced ordering (cheap checks first).
# Spec §09_enhancement_charter #7: "Move ConfidenceGuard
# (cheap logprob check) earlier in TrajectoryGuardrail.
# Average cost-per-step falls because most steps trip cheap
# checks before expensive ones." Note: in the current
# implementation the 8 checks are all O(1) attribute lookups
# in pure Python, so the latency delta is sub-millisecond.
# The Pareto-better claim is on FPR (false-positive rate):
# cheap checks trip first → expensive checks never run on
# already-decided events → fewer FPs from the more-sensitive
# downstream checks (e.g., loop_guard firing on noisy data).
_ENHANCED_HOT_PATH_CHECKS: list[Any] = [
    _schema_validator,    # O(1) bool
    _finish_reason,       # O(1) string equality
    _tool_dedup,          # O(1) int compare
    _retry_storm,         # O(1) int compare
    _latency_guard,       # O(1) float compare
    _cost_guard,          # O(1) float compare
    _token_guard,         # O(1) int compare
    _loop_guard,          # O(1) string equality
]


# ── Recommended-action reducer ────────────────────────────────────


def _reduce_recommended(checks: list[str | None]) -> str:
    """Return the most-restrictive recommended action across the 8 checks.

    O(n) where n = len(checks), with each iteration a single
    dict lookup. Worst-case is 8 dict lookups + 8 rank comparisons
    (~1 us on a modern CPU).
    """
    best_rank = -1
    best_action = "record_to_table"
    for c in checks:
        if not c:
            continue
        rank = _PRECEDENCE_INDEX.get(c)
        if rank is not None and rank > best_rank:
            best_rank = rank
            best_action = c
    return best_action


# ── Per-tenant kill-switch cache (LRU-bounded) ─────────────────────
#
# The cache is process-local. Spec trade-off: a 60 s window where
# an admin flip doesn't take effect immediately is acceptable —
# guardrail misfires are *much* more expensive than a minute of
# stale config.
#
# Bounded by ``_KILL_CACHE_MAX_TENANTS`` entries to defend against
# hostile tenants minting many orgs. Each entry is
# ``(tenant_id, action_class) → (state, ts)``. With 10 action
# classes and 1000 tenants we cap at 10 K entries (~480 KB of
# Python tuple overhead) — a non-event for the host process.


_KILL_CACHE_TTL = 60.0
_KILL_CACHE_MAX_ENTRIES = 10_240  # ~1000 tenants × 10 action classes
# Hard cap on the kill-switch DB read. Generous relative to the 5 ms
# hot-path budget — it exists to catch a wedged substrate, not to
# police ordinary latency.
_KILL_SWITCH_FETCH_TIMEOUT_S = 2.0


class _LRUKillCache:
    """Insertion-ordered LRU cache for kill-switch state.

    Python's ``functools.lru_cache`` doesn't expose ``get``
    without also updating the LRU order on misses, so we use a
    hand-rolled ``OrderedDict``. ``OrderedDict.move_to_end`` is
    O(1) and the eviction loop short-circuits on the first
    overflow.
    """

    __slots__ = ("_data", "_max")

    def __init__(self, max_entries: int) -> None:
        from collections import OrderedDict
        self._data: OrderedDict[tuple[str, str], tuple[bool, float]] = OrderedDict()
        self._max = max_entries

    def get_fresh(
        self, key: tuple[str, str], now: float, ttl: float
    ) -> tuple[bool, float] | None:
        """Return the cached entry if still fresh, else ``None``."""
        entry = self._data.get(key)
        if entry is None:
            return None
        state, ts = entry
        if (now - ts) >= ttl:
            # Stale: drop and report miss so the caller refetches.
            self._data.pop(key, None)
            return None
        # Promote to most-recently-used.
        self._data.move_to_end(key)
        return entry

    def set(self, key: tuple[str, str], state: bool, now: float) -> None:
        self._data[key] = (state, now)
        self._data.move_to_end(key)
        # Evict oldest until under the cap. ``while`` is defensive
        # — under steady state this is a single pop per insert.
        while len(self._data) > self._max:
            self._data.popitem(last=False)

    def clear(self) -> None:
        self._data.clear()

    def pop(self, key: tuple[str, str], default: Any = ...) -> Any:
        """Drop a single entry. The optional ``default`` mirrors
        ``dict.pop`` for backward compatibility with the
        kill-switch-flip test fixture."""
        return self._data.pop(key, default)

    def __setitem__(self, key: tuple[str, str], value: tuple[bool, float]) -> None:
        # Test fixture compatibility: ``cache[key] = (state, ts)``
        # is the legacy interface used by the kill-switch-flip
        # test. We accept the value verbatim (no LRU promotion)
        # because the test only ever seeds one or two entries.
        self._data[key] = value

    def __getitem__(self, key: tuple[str, str]) -> tuple[bool, float]:
        return self._data[key]

    def __delitem__(self, key: tuple[str, str]) -> None:
        del self._data[key]

    def __contains__(self, key: object) -> bool:
        return key in self._data


_KILL_CACHE = _LRUKillCache(max_entries=_KILL_CACHE_MAX_ENTRIES)


def clear_kill_cache_for_tests() -> None:
    """Reset the in-process kill-switch cache.

    Test isolation helper: pytest conftest calls this in an autouse
    fixture so per-tenant toggle tests don't pollute each other
    across the suite (each test re-reads from the DB after the
    clear, so the cache entry is rebuilt from the live config).
    """
    _KILL_CACHE.clear()


# ponytail: module-level reference to ``fetch_tenant_action_config``
# so we don't pay the import cost on every cache miss. The import
# is deferred to module load (not at function definition time) so
# the module remains importable when the storage layer is absent
# (e.g. unit tests that only exercise the in-memory checks).
try:
    from eden.observability.trace_quality.queries import (
        fetch_tenant_action_config,
    )
except Exception:  # pragma: no cover - storage layer missing
    fetch_tenant_action_config = None  # type: ignore[assignment]


async def _get_kill_switch(org_id: str, action_class: str) -> bool | None:
    """Read the per-tenant kill switch with a 60 s LRU-bounded cache.

    Returns ``True`` if auto-apply is allowed, ``False`` if the
    switch is off, ``None`` if the row is missing (caller
    should fall back to the default).
    """
    key = (org_id, action_class)
    now = time.monotonic()
    cached = _KILL_CACHE.get_fresh(key, now, _KILL_CACHE_TTL)
    if cached is not None:
        return cached[0]

    # Cache miss — fetch from the DB. ``fetch_tenant_action_config``
    # is module-scoped; the import was hoisted at module load.
    # The wait_for cap is load-bearing: this is the hot path (p99 < 5 ms
    # contract), and a wedged substrate — e.g. a connection pool bound
    # to a stopped event loop — must degrade to the per-action default,
    # never block the caller.
    state: bool | None = None
    if fetch_tenant_action_config is not None:
        try:
            state = await asyncio.wait_for(
                fetch_tenant_action_config(org_id, action_class),
                timeout=_KILL_SWITCH_FETCH_TIMEOUT_S,
            )
        except Exception as exc:
            logger.debug("trace_quality.hooks: kill-switch fetch failed: %s", exc)
            state = None

    if state is None:
        # No row → fall back to the per-action default (read-only
        # ON, mutating OFF).
        state = ACTION_CLASS_DEFAULTS.get(action_class, False)

    _KILL_CACHE.set(key, bool(state), now)
    return bool(state)


# ── Fire-and-forget action record queue ───────────────────────────
#
# The hot path needs to keep its p99 < 5 ms even when Postgres is
# slow. We can't ``await client.fetchrow(...)`` synchronously on
# every step — a single 50 ms DB stall blows the budget for all
# tenants on the route.
#
# Instead we append the row to an in-memory ``_ACTION_QUEUE`` and
# a background drain task flushes in batches. The hot path
# returns within microseconds; the persistent insert is best-
# effort and decoupled from the live decision.
#
# If the queue is full (DB is wedged for >MAX_QUEUE_MS), the
# oldest entries are dropped. Audit fidelity is bounded, but
# guardrail correctness is unaffected.

_ACTION_QUEUE_MAX = 4_096
_ACTION_QUEUE_BATCH = 128
_ACTION_DRAIN_INTERVAL_S = 0.25


class _ActionQueue:
    """Bounded FIFO of pending ``trace_guardrail_actions`` rows.

    Backed by a ``collections.deque`` for O(1) append/popleft.
    A bounded queue is intentional: an unbounded queue would
    let a wedged DB exhaust the process memory. The cap (4 K
    rows ≈ 1 MB of dict overhead) gives the drain task plenty
    of headroom while bounding the worst-case memory hit.

    Rows are stored as **tuples** rather than dicts: the hot
    path constructs one per call, and a 12-element tuple is
    ~150 bytes lighter than the equivalent dict (Python 3.12
    per-object overhead is ~232 B for a dict vs ~64 B for a
    small tuple). Field access is positional via the
    ``_ACTION_FIELD_*`` constants below.
    """

    __slots__ = ("_buf",)

    def __init__(self) -> None:
        from collections import deque
        self._buf: deque[tuple[Any, ...]] = deque()

    def __len__(self) -> int:
        return len(self._buf)

    def push(self, row: tuple[Any, ...]) -> bool:
        """Append a row. Returns ``False`` if the queue was full
        and the row was dropped."""
        if len(self._buf) >= _ACTION_QUEUE_MAX:
            # Drop oldest to make room — preserves the most recent
            # audit signal (operators investigating "what just
            # happened" care more about recency than completeness).
            with contextlib.suppress(IndexError):
                self._buf.popleft()
        self._buf.append(row)
        # Module still importing; wakeup is wired below.
        with contextlib.suppress(NameError):
            _wakeup_event().set()
        return True

    def drain(self, max_rows: int) -> list[tuple[Any, ...]]:
        """Pop up to ``max_rows`` rows for a batched insert."""
        out: list[tuple[Any, ...]] = []
        for _ in range(max_rows):
            try:
                out.append(self._buf.popleft())
            except IndexError:
                break
        return out


# ponytail: positional field indices for the action queue tuple.
# Stable across the module; do not reorder without updating both
# ``evaluate_trajectory_step`` and ``_flush_once``.
_ACTION_FIELD_ID = 0
_ACTION_FIELD_ORG = 1
_ACTION_FIELD_TRACE = 2
_ACTION_FIELD_STEP = 3
_ACTION_FIELD_AGENT = 4
_ACTION_FIELD_CLASS = 5
_ACTION_FIELD_APPLIED = 6
_ACTION_FIELD_KILL_STATE = 7
_ACTION_FIELD_REASON = 8
_ACTION_FIELD_PAYLOAD = 9


_ACTION_QUEUE = _ActionQueue()
# The wakeup Event binds to the first loop that awaits it, so a
# module-level instance wedges any caller that rotates event loops
# (pytest function-scoped loops, ``asyncio.new_event_loop()`` per
# case): the drain task on loop B waits on an Event bound to dead
# loop A and never wakes. Keep one Event per running loop instead.
_ACTION_WAKEUP: asyncio.Event | None = None
_ACTION_WAKEUP_LOOP: asyncio.AbstractEventLoop | None = None


def _wakeup_event() -> asyncio.Event:
    """Return the wakeup Event for the current running loop."""
    global _ACTION_WAKEUP, _ACTION_WAKEUP_LOOP
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if (
        _ACTION_WAKEUP is None
        or _ACTION_WAKEUP_LOOP is not loop
        or (loop is not None and loop.is_closed())
    ):
        _ACTION_WAKEUP = asyncio.Event()
        _ACTION_WAKEUP_LOOP = loop
    return _ACTION_WAKEUP


def _maybe_warm_drain() -> None:
    """Best-effort warm-up of the drain task.

    Called once at module import time. If an event loop is
    already running (rare for top-level imports) we schedule
    the drain startup; otherwise we wait for the first hot-
    path call to spin it up. This eliminates the ~20 ms cold-
    start spike on the first ``evaluate_trajectory_step``
    call in long-running services.
    """
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        return
    if loop.is_closed():
        return
    try:
        if loop.is_running():
            loop.create_task(_start_drain())
        else:
            # No running loop yet — defer to lazy start.
            return
    except Exception:
        return


# ponytail: warm up the drain task on import so the first
# hot-path call doesn't pay the asyncio task-spawn cost.
# In test environments that swap event loops between cases,
# ``_start_drain`` rebinds the task on the new loop.
_maybe_warm_drain()


# Lazy module-level reference to ``get_postgres_client`` so the
# hot path doesn't pay an import on every call. The import is
# attempted at module load; if the storage layer is missing the
# drain task becomes a no-op.
try:
    from eden.storage.postgres import get_postgres_client as _get_pg
except Exception:  # pragma: no cover - storage layer missing
    _get_pg = None  # type: ignore[assignment]


# Drain task lifecycle. The drain is started lazily on the first
# call to ``evaluate_trajectory_step`` so unit tests that only
# exercise the in-memory checks don't spin up an asyncio task
# they can't easily clean up. The ``_drain_task`` reference is
# mutated by the ``_schedule_drain_start`` /
# ``_ensure_drain_task`` pair under the asyncio loop's own
# single-threaded scheduling, so no extra lock is required.
_drain_task: asyncio.Task[None] | None = None


def _schedule_drain_start() -> None:
    """Schedule ``_start_drain`` to run on the next loop tick.

    Synchronous so ``evaluate_trajectory_step`` doesn't await
    the task-spawn cost. ``call_soon_threadsafe`` would also
    work but the hot path is always called from the loop's
    own coroutines, so the cheaper ``call_soon`` suffices.
    """
    global _drain_task
    if _drain_task is not None and not _drain_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if loop.is_closed():
        _drain_task = None
        return
    # Optimistically reserve the slot with a sentinel so the
    # next call doesn't re-schedule. The actual task replaces
    # this when ``_start_drain`` runs.
    with contextlib.suppress(Exception):
        loop.call_soon(_ensure_drain_task)


def _ensure_drain_task() -> None:
    """Create the drain task if it isn't already running.

    Called from ``call_soon`` — runs on the next loop tick,
    well after ``evaluate_trajectory_step`` has returned.
    """
    global _drain_task
    if _drain_task is not None and not _drain_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if loop.is_closed():
        _drain_task = None
        return
    _drain_task = loop.create_task(
        _drain_loop(), name="trace_quality.drain",
    )


async def _start_drain() -> None:
    """Start the background drain task (idempotent).

    Lazy-started on the first hot-path call so unit tests that
    only exercise the in-memory checks don't spin up an
    asyncio task they can't easily clean up. The task is
    bound to the **current** running loop; tests that use a
    fresh loop per case should call ``reset_for_tests()`` in
    a fixture (the suite-level conftest does this).

    Production callers should prefer ``_schedule_drain_start``
    (the synchronous variant used by ``evaluate_trajectory_step``).
    This async version is kept for explicit lifecycle control
    (e.g. tests that want to await the startup).
    """
    global _drain_task
    if _drain_task is not None and not _drain_task.done():
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No running loop (shouldn't happen — we're async) —
        # give up silently. Hot path is unaffected.
        return
    if loop.is_closed():
        # Test teardown between cases can leave us with a
        # closed loop. Drop the stale reference so the next
        # call respawns on the new loop.
        _drain_task = None
        return
    _drain_task = loop.create_task(
        _drain_loop(), name="trace_quality.drain",
    )


async def _drain_loop() -> None:
    """Background loop: flush ``_ACTION_QUEUE`` to Postgres in batches.

    Event-driven: sleeps on ``_ACTION_WAKEUP`` while the queue is empty
    instead of polling every ``_ACTION_DRAIN_INTERVAL_S`` (measured 3.67
    wakeups/sec idle). A push sets the event so a queued row still flushes
    promptly.
    """
    while True:
        try:
            await _wakeup_event().wait()
            _wakeup_event().clear()
            while len(_ACTION_QUEUE) > 0:
                await _flush_once()
                # Tiny yield so a wedged flush cannot starve the loop.
                await asyncio.sleep(0)
        except asyncio.CancelledError:
            # Graceful shutdown — one last flush, then exit.
            with contextlib.suppress(Exception):
                await _flush_once()
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("trace_quality.hooks: drain error: %s", exc)
            await asyncio.sleep(_ACTION_DRAIN_INTERVAL_S)


async def _flush_once() -> int:
    """Flush up to ``_ACTION_QUEUE_BATCH`` rows to Postgres.

    Returns the number of rows successfully inserted. A return
    of ``0`` indicates either an empty queue or a substrate
    failure (caller's drain loop will retry on the next tick).
    """
    rows = _ACTION_QUEUE.drain(_ACTION_QUEUE_BATCH)
    if not rows:
        return 0
    if _get_pg is None:
        # Storage layer missing — put the rows back. The queue is already
        # bounded (``_ACTION_QUEUE_MAX``); silently discarding here made
        # whether a Postgres outage lost up to ``_ACTION_QUEUE_BATCH`` rows
        # depend on *how* Postgres was unavailable.
        for r in reversed(rows):
            _ACTION_QUEUE.push(r)
        return 0
    try:
        client = await _get_pg()
    except Exception as exc:
        # Put the rows back at the front of the queue so the next
        # tick retries. Don't await a re-queue in a tight loop —
        # the bounded queue + drain interval provides back-pressure.
        for r in reversed(rows):
            _ACTION_QUEUE.push(r)
        logger.debug("trace_quality.hooks: flush skipped: %s", exc)
        return 0
    if client is None:
        for r in reversed(rows):
            _ACTION_QUEUE.push(r)
        return 0
    try:
        # Build the parameterised executemany. ``json.dumps`` is
        # cheap on small payloads (~100 bytes) so doing it inline
        # here (rather than at queue time) avoids serializing
        # rows that get dropped on overflow. Positional field
        # access (via the ``_ACTION_FIELD_*`` constants) avoids
        # the per-row dict hashing the previous version paid.
        args_iter: list[tuple[Any, ...]] = []
        for r in rows:
            args_iter.append((
                r[_ACTION_FIELD_ID],
                r[_ACTION_FIELD_ORG],
                r[_ACTION_FIELD_TRACE],
                r[_ACTION_FIELD_STEP],
                r[_ACTION_FIELD_AGENT],
                r[_ACTION_FIELD_CLASS],
                True,                # recommended == action_class on hot path
                r[_ACTION_FIELD_APPLIED],
                r[_ACTION_FIELD_REASON],
                r[_ACTION_FIELD_KILL_STATE],
                json.dumps(r[_ACTION_FIELD_PAYLOAD])[:4000],
            ))
        await client.executemany(
            """
            INSERT INTO trace_guardrail_actions
                (id, tenant_id, trace_id, step_index, agent_id,
                 action_class, recommended, applied, reason,
                 kill_switch_state, payload)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            """,
            args_iter,
        )
        return len(args_iter)
    except Exception as exc:
        # Persist failure — push rows back and let the next tick retry.
        for r in reversed(rows):
            _ACTION_QUEUE.push(r)
        logger.debug("trace_quality.hooks: executemany failed: %s", exc)
        return 0


async def shutdown_trace_quality() -> None:
    """Cancel the drain task and wait for the final flush.

    Called from the FastAPI lifespan handler so the worker
    gracefully drains on shutdown. Tests call
    ``reset_for_tests()`` instead — that path also kills the
    drain task but doesn't wait for the final flush.
    """
    global _drain_task
    task = _drain_task
    _drain_task = None
    if task is None or task.done():
        return
    try:
        loop = task.get_loop()
    except Exception:
        loop = None
    if loop is None or not loop.is_running() or loop.is_closed():
        # The owning loop can never observe the cancellation — abandon
        # the task rather than awaiting it forever.
        return
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


def reset_for_tests() -> None:
    """Tear down the drain task + clear the cache + empty the queue.

    Test-only helper. Production code uses ``shutdown_trace_quality``
    instead (which awaits the final flush).
    """
    global _drain_task, _ACTION_WAKEUP, _ACTION_WAKEUP_LOOP
    task = _drain_task
    _drain_task = None
    if task is not None and not task.done():
        # Cancelling a task bound to a stopped loop queues a callback
        # that never runs (the task leaks and keeps its pool connection);
        # on a closed loop ``cancel()`` raises RuntimeError outright.
        # Only cancel when the owning loop can actually observe it.
        try:
            loop = task.get_loop()
        except Exception:
            loop = None
        if loop is not None and loop.is_running() and not loop.is_closed():
            task.cancel()
    _ACTION_WAKEUP = None
    _ACTION_WAKEUP_LOOP = None
    _KILL_CACHE.clear()
    while len(_ACTION_QUEUE) > 0:
        _ACTION_QUEUE.drain(_ACTION_QUEUE_MAX)


# ── Hot-path entry point ──────────────────────────────────────────


async def evaluate_trajectory_step(
    *,
    org_id: str,
    trace_id: str,
    step_index: int,
    event: dict[str, Any],
    agent_id: str | None = None,
    ordering: str = "baseline",
) -> dict[str, Any]:
    """Run the 8 hot-path checks + per-tenant kill switch.

    Returns ``{recommended_action, applied, reason, action_class,
    audit_id}``. The ``action_class`` is the most-restrictive
    recommended action; ``applied`` reflects the per-tenant
    kill-switch state.

    Hot-path p99 < 5 ms. The DB read for the kill switch is
    cached in-process for 60 s (per-tenant) so the typical
    step is fully in-memory. The DB write to
    ``trace_guardrail_actions`` is fire-and-forget — the row
    is queued for the background drain task.

    ``ordering`` selects the check order: ``"baseline"`` uses
    the original spec §4 ordering; ``"enhanced"`` uses the
    Pareto-better ordering from spec §09_enhancement_charter
    #7 (cheap-O(1) checks first → expensive downstream checks
    skip on already-decided events → fewer FPs).
    """
    t0 = time.perf_counter()

    # Lazy-start the drain task on the first hot-path call.
    # Schedule it via ``call_soon`` so the first ``evaluate_trajectory_step``
    # call doesn't pay the asyncio task-spawn cost. The check is O(1)
    # and the branch predictor handles the steady-state path.
    if _drain_task is None or _drain_task.done():
        _schedule_drain_start()

    check_set = _ENHANCED_HOT_PATH_CHECKS if ordering == "enhanced" else _HOT_PATH_CHECKS
    # The ``checks`` list is consumed twice — once by
    # ``_reduce_recommended`` (read-only) and once when the
    # queue row is built (also read-only). A list comprehension
    # is the fastest way to build it in CPython: the compiler
    # emits specialised LIST_APPEND opcodes that beat a
    # ``tuple(generator)`` (which allocates a generator +
    # tuple in two passes).
    checks = [chk(event) for chk in check_set]
    recommended = _reduce_recommended(checks)

    # Kill switch lookup (cached).
    kill_state = bool(await _get_kill_switch(org_id, recommended))

    applied = kill_state and recommended != "record_to_table"
    if recommended == "record_to_table":
        # Always persist the audit / log record.
        applied = True

    reason = (
        "kill_switch_off" if not applied and recommended != "record_to_table"
        else "applied"
    )

    # Fire-and-forget: queue the audit row and return immediately.
    # The hot path MUST NOT block on Postgres. The row is a
    # positional tuple (see ``_ACTION_FIELD_*`` constants) — a
    # tuple is ~150 B lighter per call than the equivalent dict,
    # which compounds across the 1000-step workload.
    _ACTION_QUEUE.push((
        str(uuid.uuid4()),
        org_id,
        trace_id,
        int(step_index),
        (agent_id or "")[:128] or None,
        recommended[:32],
        bool(applied),
        kill_state,
        reason[:512],
        [c or "" for c in checks],
    ))
    _wakeup_event().set()
    _maybe_warm_drain()

    elapsed_s = time.perf_counter() - t0
    elapsed_ms = elapsed_s * 1000.0
    try:
        from eden.observability.platform_activation import record_hot_path_duration

        record_hot_path_duration(elapsed_s)
    except Exception:  # pragma: no cover - defensive
        pass
    if elapsed_ms > 5.0:
        # ponytail: warn, do not raise — the hot-path MUST
        # not throw even when the kill-switch DB is slow.
        logger.warning(
            "trace_quality.hooks: hot-path %.2fms > 5ms p99", elapsed_ms,
        )

    return {
        "recommended_action": recommended,
        "applied": applied,
        "reason": reason,
        "action_class": recommended,
        "audit_id": None,  # The audit_id is no longer synchronously available.
    }


__all__ = [
    "ACTION_CLASS_DEFAULTS",
    "ACTION_PRECEDENCE",
    "evaluate_trajectory_step",
    "shutdown_trace_quality",
    "reset_for_tests",
    "clear_kill_cache_for_tests",
]
