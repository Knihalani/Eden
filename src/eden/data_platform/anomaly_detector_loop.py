"""Periodic anomaly detection loop.

Runs :class:`AnomalyDetector.check_all` on a configurable cadence
(default 900s) and dispatches in-app alerts to org members.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from eden.config import Settings, get_settings

logger = logging.getLogger(__name__)


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
            else float(getattr(s, "anomaly_loop_interval_seconds", 900))
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
                await asyncio.wait_for(self._stop.wait(), timeout=self.interval_seconds)

    async def tick_once(self) -> int:
        from eden.data_platform.anomaly_alerts import AnomalyDetector

        detector = AnomalyDetector()
        report = await detector.check_all()
        if report.alerts:
            await detector.dispatch_alerts(report.alerts, channels=["in_app"])
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
