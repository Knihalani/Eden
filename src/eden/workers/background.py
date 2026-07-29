"""Background worker orchestration for the API process.

When ``EDEN_RUN_BACKGROUND_WORKERS`` is enabled, the API lifespan starts
the in-process loops that would otherwise live only on ``eden-worker``.
A single Redis leader lock ensures only one API replica runs the
singleton background tasks at a time.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import socket
from dataclasses import dataclass, field
from typing import Any

from eden.config import Settings, get_settings
from eden.storage.redis import Lock
from eden.workers.leader import (
    _acquire_with_fallback,
    _extend_lock_periodically,
)
from eden.workers.supervisor import supervise as _supervise_with_backoff

logger = logging.getLogger(__name__)

# Backoff before restarting a crashed leader-supervisor task — mirrors
# eden.workers.main's _RESTART_BACKOFF_SECONDS (kept as its own name
# here, not imported, so each module can be tuned independently and
# so tests can patch this module's value without reaching into main).
_RESTART_BACKOFF_SECONDS = 5.0

#: Bundle leader lock name. Rotated 2026-07-29: the previous key
#: (``api-background``) was held indefinitely by a process nothing could
#: reach — every acquire came back "refused" with a live renewer keeping
#: the 60s TTL alive, across a full service restart and several fresh
#: pods, so `_start_all` never ran and the whole in-process fleet stayed
#: down. Rotating the key is the standard remedy for a poisoned lock; the
#: holder identity written into the token below is what makes the next
#: occurrence diagnosable instead of a mystery.
_BUNDLE_LOCK_NAME = "api-background-v2"

# The bundle lock is held continuously by whichever replica is leader,
# so its renewal cadence is a permanent, 24/7 draw on the Upstash
# command budget — unlike run_if_leader's short-lived per-tick locks,
# which the shared 60s/20s defaults are sized for.
#
# At TTL=60 / renew=20 the extender alone issued 86400/20 = 4,320 EVALs
# a day, plus 720 more from the inner ``lock.extend`` at the 120s
# supervise interval: ~5,040 commands/day against a 10,000/day free
# tier. Half the daily budget, spent on one lock — and exhausting that
# budget is what puts Redis into the write-discard mode that took the
# whole fleet down for 7.4 days.
#
# ``sidecars.py`` already made exactly this correction for the guard
# lock (TTL 600 / renew 200, see its module docstring); the same
# arithmetic applies here and had not been carried across. 86400/200 =
# 432 EVALs/day, a ~10x reduction.
#
# The longer TTL also fixes an inversion: the inner liveness check runs
# on ``interval`` (120s), which was LONGER than the 60s TTL, so the lock
# could expire and be taken by another replica between two consecutive
# checks. 120s is comfortably inside a 600s TTL.
_BUNDLE_LOCK_TTL_SECONDS = 600
_BUNDLE_LOCK_RENEW_SECONDS = 200.0

#: Last outcome + consecutive count per lock, for /health. Costs nothing:
#: it records what the acquire call already returned rather than spending
#: an extra Redis command to ask. Distinguishes "another process is
#: leader" (refused) from "the call never came back" (timeout) from "the
#: provider rejected it" (raised:ResponseError) — three states that look
#: identical from outside and need completely different responses.
_acquire_outcomes: dict[str, dict[str, Any]] = {}


def _note_acquire_outcome(lock_name: str, outcome: str) -> None:
    entry = _acquire_outcomes.setdefault(
        lock_name, {"outcome": None, "consecutive": 0}
    )
    if entry["outcome"] == outcome:
        entry["consecutive"] += 1
    else:
        entry["outcome"] = outcome
        entry["consecutive"] = 1


def leader_acquire_outcomes() -> dict[str, dict[str, Any]]:
    """Per-lock ``{outcome, consecutive}`` for the health endpoint."""
    return {k: dict(v) for k, v in _acquire_outcomes.items()}


def _leader_loops_from_worker_main() -> list[tuple[str, Any]]:
    """The leader-gated loops that previously ran only on eden-worker.

    Imported lazily and defensively: ``eden.workers.main`` pulls in the
    whole loop graph, and a failure here must degrade the API to "these
    loops are missing", never to "the API will not boot".
    """
    try:
        from eden.workers import main as _worker_main
    except Exception as exc:  # pragma: no cover - import guard
        logger.warning("background: worker loop import failed: %s", exc)
        return []
    pairs = [
        ("webhook_drain", "_leader_webhook_drain_loop"),
        ("eql_alert_watchdog", "_leader_eql_alert_watchdog"),
        ("artifact_demotion", "_leader_artifact_demotion"),
        ("maintenance", "_leader_maintenance"),
        ("self_obs_probes", "_leader_self_obs_probes"),
    ]
    out: list[tuple[str, Any]] = []
    for name, attr in pairs:
        factory = getattr(_worker_main, attr, None)
        if factory is None:
            logger.warning("background: %s missing from workers.main", name)
            continue
        out.append((name, factory))
    return out


@dataclass
class _BackgroundState:
  """Mutable state for the leader-supervised background worker bundle."""

  started: bool = False
  insights_loop: bool = False
  anomaly_loop: bool = False
  evolution_loop: bool = False
  judge_tailer: Any = None
  #: Supervised tasks for the leader-gated loops adopted from
  #: ``eden.workers.main`` (webhook drain, EQL watchdog, demotion,
  #: maintenance, self-obs). Name → task, so shutdown can drain them.
  leader_loops: dict[str, Any] = field(default_factory=dict)


@dataclass
class BackgroundWorkers:
    """Leader-gated background tasks started from the API lifespan."""

    _task: asyncio.Task[Any] | None = None
    _stop: asyncio.Event = field(default_factory=asyncio.Event)
    _state: _BackgroundState = field(default_factory=_BackgroundState)

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self, settings: Settings | None = None) -> None:
        """Start the leader supervisor (idempotent)."""
        cfg = settings or get_settings()
        if not getattr(cfg, "run_background_workers", False):
            logger.info(
                "background: run_background_workers disabled; supervisor not started"
            )
            return
        if self.running:
            return
        self._stop.clear()
        self._task = asyncio.create_task(
            _supervise_with_backoff(
                "background_leader_supervisor",
                lambda stop_event, _cfg=cfg: self._supervise(_cfg),
                self._stop,
                backoff=_RESTART_BACKOFF_SECONDS,
                logger_=logger,
            ),
            name="background-leader-supervisor",
        )
        logger.info("background: leader supervisor started")

    async def stop(self, timeout: float = 35.0) -> None:
        """Stop the supervisor and drain hosted loops.

        Timeout must be ≥ the quality sidecar's 30s drain budget.
        """
        self._stop.set()
        if self._task is None:
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError, TimeoutError):
            await asyncio.wait_for(self._task, timeout=timeout)
        self._task = None
        await self._stop_all(self._state)

    async def _supervise(self, settings: Settings) -> None:
        """Acquire the global leader lock and host background loops.

        Wrapped by ``eden.workers.supervisor.supervise`` from
        ``start()`` — an unhandled exception here used to permanently
        kill every leader-gated background loop for the process's
        lifetime with no self-healing; now it gets the same
        restart-with-backoff behaviour ``eden.workers.main`` already
        gives its loops.

        The lock TTL is fixed and decoupled from ``interval`` (the
        cadence at which followers retry acquisition) for the same
        reason ``eden.workers.leader.run_if_leader`` decouples its
        TTL from its tick interval: a hard-crashed leader should not
        block failover for however long ``interval`` happens to be
        configured to.
        """
        interval = 30.0
        try:
            from eden.config import get_settings

            interval = max(
                30.0,
                float(
                    getattr(get_settings(), "redis_leader_tick_seconds", 120)
                    or 120
                ),
            )
        except Exception:
            interval = 120.0
        lock = Lock(_BUNDLE_LOCK_NAME, ttl=_BUNDLE_LOCK_TTL_SECONDS, prefix="eden:leader")
        # Identify the holder. A refused lock is otherwise a dead end —
        # you know someone has it and nothing more.
        identity = f"{socket.gethostname()}:{os.getpid()}"

        while not self._stop.is_set():
            # Bounded for the same reason as run_if_leader's acquire: an
            # acquisition that never returns parks this supervisor
            # forever, and because ``running`` only reports "the
            # supervisor task exists", the API keeps answering as though
            # the fleet is up while `_start_all` has never run. That is a
            # silent, total outage of every background loop — the exact
            # failure this module is supposed to prevent.
            acquired, backend = await _acquire_with_fallback(
                lock, _BUNDLE_LOCK_NAME, identity, _BUNDLE_LOCK_TTL_SECONDS
            )
            if backend == "postgres":
                _note_acquire_outcome(_BUNDLE_LOCK_NAME, "acquired(via=postgres)")
            else:
                _note_acquire_outcome(
                    _BUNDLE_LOCK_NAME, "acquired" if acquired else "refused"
                )
            if acquired and backend == "postgres":
                # Redis cannot accept writes; the lease lives in Postgres.
                # Run the bundle and renew the lease on the tick cadence
                # rather than through the Redis extender.
                from eden.storage import pg_lease

                try:
                    await self._start_all(settings, self._state)
                    while not self._stop.is_set():
                        if not await pg_lease.renew(
                            _BUNDLE_LOCK_NAME, identity, _BUNDLE_LOCK_TTL_SECONDS
                        ):
                            logger.warning(
                                "background: lost postgres lease; stopping loops"
                            )
                            break
                        try:
                            await asyncio.wait_for(
                                self._stop.wait(),
                                timeout=min(interval, _BUNDLE_LOCK_TTL_SECONDS / 2),
                            )
                            break
                        except TimeoutError:
                            continue
                finally:
                    await self._stop_all(self._state, include_adopted=False)
                    await pg_lease.release(_BUNDLE_LOCK_NAME, identity)
                continue

            if acquired:
                extender_stop = asyncio.Event()
                # ``lost`` lets the extender report leadership loss directly.
                # The supervise loop used to call ``lock.extend`` itself once
                # per ``interval`` purely to detect loss — a second renewal on
                # top of the extender's own, costing ~720 redundant EVALs/day
                # against a 10,000/day budget (see the module comment above).
                # One renewer, one signal.
                lock_lost = asyncio.Event()
                extender = asyncio.create_task(
                    _extend_lock_periodically(
                        lock,
                        _BUNDLE_LOCK_RENEW_SECONDS,
                        extender_stop,
                        lost=lock_lost,
                    ),
                    name="background-leader-extend",
                )
                try:
                    await self._start_all(settings, self._state)
                    while not self._stop.is_set():
                        if lock_lost.is_set():
                            logger.warning(
                                "background: lost leader lock; stopping loops"
                            )
                            break
                        # Wake on whichever comes first: shutdown, lock loss,
                        # or the tick interval. Waiting only on ``_stop`` would
                        # delay loss handling by up to a full interval.
                        stop_wait = asyncio.ensure_future(self._stop.wait())
                        lost_wait = asyncio.ensure_future(lock_lost.wait())
                        try:
                            done, pending = await asyncio.wait(
                                {stop_wait, lost_wait},
                                timeout=interval,
                                return_when=asyncio.FIRST_COMPLETED,
                            )
                        finally:
                            for task in (stop_wait, lost_wait):
                                if not task.done():
                                    task.cancel()
                        if stop_wait in done:
                            break
                        if lost_wait in done:
                            logger.warning(
                                "background: lost leader lock; stopping loops"
                            )
                            break
                        continue
                finally:
                    extender_stop.set()
                    extender.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await extender
                    # Lock loss ends the non-gated loops, not the
                    # individually-gated adopted ones.
                    await self._stop_all(self._state, include_adopted=False)
                    await lock.release()
            else:
                # The five loops adopted from workers.main are each
                # individually leader-gated by run_if_leader, so the outer
                # bundle lock buys them nothing — and gating them behind it
                # makes that one lock a single point of total, silent
                # failure. Observed in production: supervisor_alive true,
                # started false, every loop idle, /health reporting the
                # fleet as expected-and-running. Start them regardless; the
                # per-loop locks still guarantee one runner cluster-wide.
                #
                # The loops that are NOT individually gated (insights,
                # anomaly, evolution, and the sidecar bundle) stay behind
                # the outer lock, since for them it is the only guard.
                self._start_adopted_loops(self._state)
                logger.debug("background: not leader; retrying in %.0fs", interval)
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=interval)
                    break
                except TimeoutError:
                    continue

    async def _start_all(self, settings: Settings, state: _BackgroundState) -> None:
        if state.started:
            return
        state.started = True

        if getattr(settings, "insights_loop_enabled", True):
            try:
                from eden.insights.detector_loop import start_insights_detector_loop

                await start_insights_detector_loop()
                state.insights_loop = True
                logger.info("background: insights_loop started")
            except Exception as exc:
                logger.warning("background: insights_loop skipped: %s", exc)

        if getattr(settings, "anomaly_loop_enabled", True):
            try:
                from eden.data_platform.anomaly_detector_loop import (
                    start_anomaly_detector_loop,
                )

                await start_anomaly_detector_loop()
                state.anomaly_loop = True
                logger.info("background: anomaly_loop started")
            except Exception as exc:
                logger.warning("background: anomaly_loop skipped: %s", exc)

        if getattr(settings, "evolution_loop_enabled", False):
            try:
                from eden.agents.evolution.loop import start_evolution_loop

                await start_evolution_loop()
                state.evolution_loop = True
                logger.info("background: evolution_loop started")
            except Exception as exc:
                logger.warning("background: evolution_loop skipped: %s", exc)

        try:
            from eden.llmops.promotion_hooks import register_all_hooks

            register_all_hooks()
        except Exception as exc:
            logger.warning("background: promotion hooks skipped: %s", exc)

        try:
            from eden.llmops.learn_wiring import install_learn_filters

            install_learn_filters()
        except Exception as exc:
            logger.warning("background: learn_wiring skipped: %s", exc)

        if getattr(settings, "judges_async_tailer_enabled", False):
            try:
                from eden.llmops.judges.redis_tailer import start_judge_tailer

                state.judge_tailer = await start_judge_tailer(settings)
                logger.info("background: judge tailer started")
            except Exception as exc:
                logger.warning("background: judge tailer skipped: %s", exc)

        # quality_pipeline / trace_finalized / closed_loop (consumer +
        # verify) are duplicated between here and eden.workers.main; the
        # shared helper is guarded by a cross-process lock so at most
        # one process hosts them regardless of EDEN_RUN_BACKGROUND_WORKERS
        # state (that env var alone is not a cross-process guarantee).
        try:
            from eden.workers.sidecars import start_quality_and_closed_loop_sidecars

            await start_quality_and_closed_loop_sidecars("background")
        except Exception as exc:
            logger.warning(
                "background: quality/closed-loop sidecar bundle skipped: %s", exc
            )

        # Leader-gated loops that used to exist ONLY on the eden-worker
        # job: webhook drain, EQL alert watchdog, artifact/nudge demotion,
        # multi-tenant maintenance, self-observability probes.
        #
        # That job is a Northflank *Job*, and jobs are for finite work —
        # its container was reaped and restarted every 96-270s, so none of
        # these ever completed a tick. Webhooks were never delivered,
        # scheduled EQL alerts never fired, retention/compaction never ran,
        # and nothing wrote a self-obs heartbeat for 7.4 days.
        #
        # Hosting them here puts them in the always-on API service. Each is
        # still individually leader-gated, so bringing the worker back does
        # not double-run them — it just adds a second candidate.
        self._start_adopted_loops(state)

    def _start_adopted_loops(self, state: _BackgroundState) -> None:
        """Start the leader-gated loops adopted from ``workers.main``.

        Idempotent, and deliberately callable whether or not this process
        holds the outer bundle lock: every one of these loops elects its
        own leader through ``run_if_leader``, so the outer lock adds no
        safety and would only add a way for all of them to stay silent.
        """
        for name, factory in _leader_loops_from_worker_main():
            existing = state.leader_loops.get(name)
            if existing is not None and not existing.done():
                continue
            try:
                state.leader_loops[name] = asyncio.create_task(
                    _supervise_with_backoff(
                        name,
                        factory,
                        self._stop,
                        backoff=_RESTART_BACKOFF_SECONDS,
                        logger_=logger,
                    ),
                    name=f"background-{name}",
                )
                logger.info("background: %s loop hosted in API process", name)
            except Exception as exc:
                logger.warning("background: %s loop not started: %s", name, exc)

    async def _stop_all(
        self, state: _BackgroundState, *, include_adopted: bool = True
    ) -> None:
        # The adopted loops do not depend on the outer bundle lock, so
        # losing that lock must not tear them down — only real process
        # shutdown does. ``include_adopted=False`` is the lock-loss path.
        if not state.started and not state.leader_loops:
            return

        # Adopted leader loops observe the same stop event; give them a
        # bounded drain so shutdown cannot hang on one wedged tick.
        if include_adopted and state.leader_loops:
            for task in state.leader_loops.values():
                if not task.done():
                    task.cancel()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(
                    asyncio.gather(
                        *state.leader_loops.values(), return_exceptions=True
                    ),
                    timeout=10.0,
                )
            state.leader_loops.clear()

        if state.insights_loop:
            try:
                from eden.insights.detector_loop import stop_insights_detector_loop

                await stop_insights_detector_loop()
            except Exception as exc:
                logger.warning("background: insights_loop stop failed: %s", exc)
            state.insights_loop = False

        if state.anomaly_loop:
            try:
                from eden.data_platform.anomaly_detector_loop import (
                    stop_anomaly_detector_loop,
                )

                await stop_anomaly_detector_loop()
            except Exception as exc:
                logger.warning("background: anomaly_loop stop failed: %s", exc)
            state.anomaly_loop = False

        if state.evolution_loop:
            try:
                from eden.agents.evolution.loop import stop_evolution_loop

                await stop_evolution_loop()
            except Exception as exc:
                logger.warning("background: evolution_loop stop failed: %s", exc)
            state.evolution_loop = False

        if state.judge_tailer is not None:
            try:
                from eden.llmops.judges.redis_tailer import stop_judge_tailer

                await stop_judge_tailer()
            except Exception as exc:
                logger.warning("background: judge tailer stop failed: %s", exc)
            state.judge_tailer = None

        try:
            from eden.workers.sidecars import stop_quality_and_closed_loop_sidecars

            await stop_quality_and_closed_loop_sidecars("background")
        except Exception as exc:
            logger.warning(
                "background: quality/closed-loop sidecar bundle stop failed: %s", exc
            )

        state.started = False


_workers = BackgroundWorkers()


async def start_background_workers(settings: Settings | None = None) -> None:
    """Start API-hosted background loops (leader-gated)."""
    await _workers.start(settings)


async def stop_background_workers(timeout: float = 35.0) -> None:
    """Stop API-hosted background loops."""
    await _workers.stop(timeout)


def background_evolution_loop_running() -> bool:
    """True when this process is leader and the evolution loop is up."""
    return _workers._state.evolution_loop


def background_workers_running() -> bool:
    return _workers.running


def background_loops_snapshot() -> dict[str, Any]:
    """What the bundle has *actually* started, not just that it exists.

    ``background_workers_running`` reports only "the supervisor task is
    alive", which stays True while the supervisor waits for the leader
    lock. During the July 2026 outage that made the API report the fleet
    as up when ``_start_all`` had never run once — the single most
    misleading signal in the incident.

    ``started`` is the fact that matters: the bundle won leadership and
    brought its loops up. ``loops`` names the adopted leader-gated loops
    and whether each task is still alive.
    """
    state = _workers._state
    return {
        "supervisor_alive": _workers.running,
        "started": state.started,
        "acquire": leader_acquire_outcomes(),
        "insights_loop": state.insights_loop,
        "anomaly_loop": state.anomaly_loop,
        "loops": {
            name: ("alive" if not task.done() else "dead")
            for name, task in state.leader_loops.items()
        },
    }
