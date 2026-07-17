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
from dataclasses import dataclass, field
from typing import Any

from eden.config import Settings, get_settings
from eden.storage.redis import Lock
from eden.workers.leader import _extend_lock_periodically

logger = logging.getLogger(__name__)


@dataclass
class _BackgroundState:
  """Mutable state for the leader-supervised background worker bundle."""

  started: bool = False
  insights_loop: bool = False
  anomaly_loop: bool = False
  evolution_loop: bool = False
  judge_tailer: Any = None


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
        if self.running:
            return
        self._stop.clear()
        self._task = asyncio.create_task(
            self._supervise(settings or get_settings()),
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
        """Acquire the global leader lock and host background loops."""
        interval = 30.0
        lock = Lock("api-background", ttl=int(interval * 3), prefix="eden:leader")

        while not self._stop.is_set():
            if await lock.acquire():
                extender_stop = asyncio.Event()
                extender = asyncio.create_task(
                    _extend_lock_periodically(lock, interval, extender_stop),
                    name="background-leader-extend",
                )
                try:
                    await self._start_all(settings, self._state)
                    while not self._stop.is_set():
                        if not await lock.extend(lock.ttl):
                            logger.warning("background: lost leader lock; stopping loops")
                            break
                        try:
                            await asyncio.wait_for(self._stop.wait(), timeout=interval)
                            break
                        except TimeoutError:
                            continue
                finally:
                    extender_stop.set()
                    extender.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await extender
                    await self._stop_all(self._state)
                    await lock.release()
            else:
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

        if getattr(settings, "evolution_loop_enabled", True):
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

        try:
            from eden.observability.quality_pipeline.worker import start_worker

            await start_worker()
            logger.info("background: quality_pipeline worker started")
        except Exception as exc:
            logger.warning("background: quality_pipeline skipped: %s", exc)

        if getattr(settings, "judges_async_tailer_enabled", False):
            try:
                from eden.llmops.judges.redis_tailer import start_judge_tailer

                state.judge_tailer = await start_judge_tailer(settings)
                logger.info("background: judge tailer started")
            except Exception as exc:
                logger.warning("background: judge tailer skipped: %s", exc)

        try:
            from eden.workers.trace_finalized_consumer import start_consumer

            await start_consumer()
            logger.info("background: trace_finalized consumer started")
        except Exception as exc:
            logger.warning("background: trace_finalized consumer skipped: %s", exc)

        try:
            from eden.closed_loop.event_bus import start_consumer as start_loop

            await start_loop()
            logger.info("background: closed_loop consumer started")
        except Exception as exc:
            logger.warning("background: closed_loop consumer skipped: %s", exc)

        try:
            from eden.closed_loop.verify import start_verify_worker

            await start_verify_worker()
            logger.info("background: closed_loop verify worker started")
        except Exception as exc:
            logger.warning("background: closed_loop verify skipped: %s", exc)

    async def _stop_all(self, state: _BackgroundState) -> None:
        if not state.started:
            return

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

        for label, mod_path, fn_name in (
            ("quality_pipeline", "eden.observability.quality_pipeline.worker", "stop_worker"),
            ("trace_finalized", "eden.workers.trace_finalized_consumer", "stop_consumer"),
            ("closed_loop", "eden.closed_loop.event_bus", "stop_consumer"),
            ("closed_loop_verify", "eden.closed_loop.verify", "stop_verify_worker"),
        ):
            try:
                import importlib

                mod = importlib.import_module(mod_path)
                await getattr(mod, fn_name)()
            except Exception as exc:
                logger.warning("background: %s stop failed: %s", label, exc)

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
