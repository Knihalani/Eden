"""Consolidated quality/closed-loop sidecar start+stop.

``eden.workers.main`` (the dedicated ``eden-worker`` process) and
``eden.workers.background`` (the in-process API bundle, gated by
``EDEN_RUN_BACKGROUND_WORKERS``) each used to duplicate the exact same
start/stop logic for the quality_pipeline worker, the trace_finalized
consumer, and the closed_loop consumer + verify worker — with the
``EDEN_RUN_BACKGROUND_WORKERS`` env var as the *only* thing stopping
both from running them at once. That var is a deploy-time convention,
not a safety net: a rolling deploy that briefly has both values live,
or the var simply being misconfigured, would double-run the same
consumer groups from two processes.

This module gives both call sites one place to start/stop these
sidecars from, guarded by a real cross-process lock reusing the same
Redis leader-lock primitive already used elsewhere
(:mod:`eden.workers.leader`) — so at most one process hosts them
regardless of env var state.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from eden.storage.redis import Lock
from eden.workers.leader import _extend_lock_periodically

logger = logging.getLogger(__name__)

_GUARD_NAME = "sidecars"

#: Fallbacks used only when settings are unreadable. The guard is
#: acquired once at startup and held until shutdown, so the renewal task
#: runs forever even though nothing ever contends the lock — and every
#: renewal is a Lua ``EVAL``, i.e. one Upstash command. At the original
#: TTL=60s/renew=20s that was 4,320 commands/day against a 10k/day free
#: tier. See ``sidecar_guard_ttl_seconds`` in ``eden.config`` for the
#: full rationale.
_GUARD_TTL_SECONDS = 600
_GUARD_RENEW_SECONDS = 200.0
# A held lock must be renewed comfortably more often than it expires, or
# one slow/descheduled tick silently drops the guard and a second process
# can start a duplicate set of consumers. Half the TTL is the ceiling.
_GUARD_RENEW_MAX_FRACTION_OF_TTL = 0.5


def _guard_ttl_and_renew() -> tuple[int, float]:
    """Return ``(ttl_seconds, renew_seconds)`` from settings.

    ``renew`` is clamped below ``ttl/2`` regardless of configuration so a
    mistuned setting cannot produce a guard that expires under its own
    renewal cadence.
    """
    ttl = _GUARD_TTL_SECONDS
    renew = _GUARD_RENEW_SECONDS
    try:
        from eden.config import get_settings

        settings = get_settings()
        ttl = int(
            getattr(settings, "sidecar_guard_ttl_seconds", ttl) or ttl
        )
        renew = float(
            getattr(settings, "sidecar_guard_renew_seconds", renew) or renew
        )
    except Exception:
        pass
    ttl = max(1, ttl)
    renew = max(1.0, min(renew, ttl * _GUARD_RENEW_MAX_FRACTION_OF_TTL))
    return ttl, renew
# A handful of quick retries rides out a boot-time Redis blip without
# meaningfully delaying startup; after that we fail closed (mirroring
# eden.storage.redis.Lock's own fail-closed policy) rather than risk
# two processes double-consuming the same queues.
_GUARD_ACQUIRE_ATTEMPTS = 3
_GUARD_RETRY_DELAY_SECONDS = 1.0

_guard_lock: Lock | None = None
_guard_extender: asyncio.Task | None = None
_guard_extender_stop: asyncio.Event | None = None
_started = False


async def _acquire_guard() -> bool:
    """Best-effort cross-process guard for the sidecar bundle.

    Returns True once this process holds the guard (starting a
    background renewal task); False when another process already
    holds it, or Redis stays unavailable across all retry attempts —
    in either case the caller must not start the sidecars.
    """
    global _guard_lock, _guard_extender, _guard_extender_stop
    if _guard_lock is not None:
        return True  # already held by this process

    guard_ttl, guard_renew = _guard_ttl_and_renew()

    for attempt in range(1, _GUARD_ACQUIRE_ATTEMPTS + 1):
        lock = Lock(_GUARD_NAME, ttl=guard_ttl, prefix="eden:leader")
        try:
            acquired = await lock.acquire()
        except Exception as exc:
            logger.warning(
                "sidecars: guard acquire raised (attempt %d/%d): %s",
                attempt,
                _GUARD_ACQUIRE_ATTEMPTS,
                exc,
            )
            acquired = False

        if acquired:
            _guard_lock = lock
            _guard_extender_stop = asyncio.Event()
            _guard_extender = asyncio.create_task(
                _extend_lock_periodically(
                    lock, guard_renew, _guard_extender_stop
                ),
                name="sidecar-guard-extend",
            )
            return True

        if attempt < _GUARD_ACQUIRE_ATTEMPTS:
            await asyncio.sleep(_GUARD_RETRY_DELAY_SECONDS)

    logger.warning(
        "sidecars: guard not acquired after %d attempts (another process "
        "already hosts quality/closed-loop sidecars, or Redis is down) — "
        "skipping sidecar start in this process",
        _GUARD_ACQUIRE_ATTEMPTS,
    )
    return False


async def _release_guard() -> None:
    global _guard_lock, _guard_extender, _guard_extender_stop
    if _guard_extender_stop is not None:
        _guard_extender_stop.set()
    if _guard_extender is not None:
        _guard_extender.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await _guard_extender
    if _guard_lock is not None:
        try:
            await _guard_lock.release()
        except Exception as exc:
            logger.warning("sidecars: guard release failed: %s", exc)
    _guard_lock = None
    _guard_extender = None
    _guard_extender_stop = None


async def start_quality_and_closed_loop_sidecars(label: str) -> bool:
    """Start quality_pipeline + trace_finalized + closed_loop (consumer & verify).

    ``label`` is only used in log lines (``"worker"`` vs ``"background"``)
    so existing log-based dashboards/greps keep working. Returns True
    once this process holds the cross-process guard (whether or not
    individual sidecars underneath failed to start — those failures
    are swallowed + logged exactly as before); False when another
    process already holds the guard, in which case nothing here is
    started.
    """
    global _started
    if not await _acquire_guard():
        return False
    if _started:
        return True
    _started = True

    try:
        from eden.observability.quality_pipeline.worker import start_worker

        await start_worker()
        logger.info("%s: quality_pipeline started", label)
    except Exception as exc:
        logger.warning("%s: quality_pipeline skipped: %s", label, exc)

    try:
        from eden.workers.trace_finalized_consumer import start_consumer

        await start_consumer()
        logger.info("%s: trace_finalized consumer started", label)
    except Exception as exc:
        logger.warning("%s: trace_finalized consumer skipped: %s", label, exc)

    try:
        from eden.closed_loop.event_bus import start_consumer as start_loop

        await start_loop()
        logger.info("%s: closed_loop consumer started", label)
    except Exception as exc:
        logger.warning("%s: closed_loop consumer skipped: %s", label, exc)

    try:
        from eden.closed_loop.verify import start_verify_worker

        await start_verify_worker()
        logger.info("%s: closed_loop verify started", label)
    except Exception as exc:
        logger.warning("%s: closed_loop verify skipped: %s", label, exc)

    return True


async def stop_quality_and_closed_loop_sidecars(label: str) -> None:
    """Drain the sidecar bundle and release the cross-process guard."""
    global _started

    try:
        from eden.closed_loop.verify import stop_verify_worker

        await stop_verify_worker()
    except Exception as exc:
        logger.warning("%s: closed_loop verify stop failed: %s", label, exc)

    try:
        from eden.closed_loop.event_bus import stop_consumer

        await stop_consumer()
    except Exception as exc:
        logger.warning("%s: closed_loop consumer stop failed: %s", label, exc)

    try:
        from eden.workers.trace_finalized_consumer import stop_consumer

        await stop_consumer()
    except Exception as exc:
        logger.warning("%s: trace_finalized stop failed: %s", label, exc)

    try:
        from eden.observability.quality_pipeline.worker import stop_worker

        await stop_worker()
    except Exception as exc:
        logger.warning("%s: quality_pipeline stop failed: %s", label, exc)

    _started = False
    await _release_guard()


def _reset_state_for_tests() -> None:
    """Test-only: clear cached guard/started module state between tests.

    Production never needs this — a real process only ever starts and
    stops the bundle once per lifetime.
    """
    global _guard_lock, _guard_extender, _guard_extender_stop, _started
    _guard_lock = None
    _guard_extender = None
    _guard_extender_stop = None
    _started = False
