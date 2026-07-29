"""Periodic anomaly detection loop.

Runs :class:`AnomalyDetector.check_all` on a configurable cadence and
dispatches in-app alerts to org members.

``check_all`` fans out to six gathered Postgres queries plus a persist
step on *every* tick, unconditionally. That makes this loop one of the
main things keeping Neon awake at zero traffic, so it does two things
that the original did not:

* it waits on the shared wall-clock grid
  (:mod:`eden.storage.empty_cooldown`) rather than on its own phase — the
  old 900s cadence was not even a multiple of the 600s grid, so it drifted
  across the boundaries and split the fleet's DB-quiet window every cycle;
* it backs off to the next grid boundary after a tick that finds no
  anomalies, the same empty-poll cooldown the insights detector uses.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from eden.config import Settings, get_settings
from eden.storage.empty_cooldown import make_empty_cooldown, next_grid_delay

logger = logging.getLogger(__name__)

_anomaly_in_cooldown, _anomaly_mark_empty, _anomaly_clear_cooldown = (
    make_empty_cooldown(
        default_seconds=600.0,
        settings_attr="anomaly_empty_cooldown_seconds",
    )
)


class AnomalyDetectorLoop:
    """Background task: data-platform anomaly checks → in-app alerts."""

    def __init__(
        self,
        *,
        interval_seconds: float | None = None,
        settings: Settings | None = None,
    ) -> None:
        s = settings or get_settings()
        self.interval_seconds: float = (
            interval_seconds
            if interval_seconds is not None
            else float(getattr(s, "anomaly_loop_interval_seconds", 1200))
        )
        self._stop = asyncio.Event()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if not self._is_enabled():
            logger.info("anomaly detector loop disabled by settings")
            return
        if self._task is not None and not self._task.done():
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._run(), name="anomaly-detector-loop")
        logger.info(
            "anomaly detector loop started (interval=%ss)",
            self.interval_seconds,
        )

    async def stop(self) -> None:
        self._stop.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            logger.info("anomaly detector loop stopped")

    @staticmethod
    def _is_enabled() -> bool:
        try:
            return bool(getattr(get_settings(), "anomaly_loop_enabled", True))
        except Exception:  # noqa: BLE001
            return True

    async def _run(self) -> None:
        while not self._stop.is_set():
            try:
                await self.tick_once()
            except asyncio.CancelledError:
                break
            except Exception as exc:  # noqa: BLE001
                logger.warning("anomaly detector loop tick failed: %s", exc)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    self._stop.wait(), timeout=self._next_delay()
                )

    def _next_delay(self) -> float:
        """Seconds to sleep: the next shared grid boundary.

        Sleeping ``interval_seconds`` from wherever the tick happened to
        finish leaves this loop permanently out of phase with the rest of
        the fleet. Waiting for the next boundary keeps the average cadence
        at roughly the configured interval while only ever waking on grid
        points the other pollers also use.
        """
        return next_grid_delay(self.interval_seconds)

    async def tick_once(self) -> int:
        from eden.data_platform.anomaly_alerts import AnomalyDetector

        # Skip Postgres entirely while the empty-result cooldown holds.
        # check_all() is six queries plus a persist; running it against a
        # system that produced nothing last cycle is pure idle cost.
        if _anomaly_in_cooldown():
            return 0

        detector = AnomalyDetector()
        report = await detector.check_all()
        if report.alerts:
            _anomaly_clear_cooldown()
            await detector.dispatch_alerts(report.alerts, channels=["in_app"])
        else:
            _anomaly_mark_empty()
        return report.alerts_triggered


_loop: AnomalyDetectorLoop | None = None
_started_for: AnomalyDetectorLoop | None = None


def get_anomaly_detector_loop() -> AnomalyDetectorLoop:
    global _loop
    if _loop is None:
        _loop = AnomalyDetectorLoop()
    return _loop


async def start_anomaly_detector_loop() -> None:
    global _started_for
    try:
        if not bool(getattr(get_settings(), "anomaly_loop_enabled", True)):
            logger.info("anomaly detector loop disabled by settings")
            return
    except Exception:  # noqa: BLE001
        pass
    loop = get_anomaly_detector_loop()
    if _started_for is loop:
        return
    await loop.start()
    _started_for = loop


async def stop_anomaly_detector_loop() -> None:
    global _loop, _started_for
    if _loop is not None:
        await _loop.stop()
    _started_for = None
