"""``eden-alert`` Kafka topic consumer → AlertStreamProcessor (FEAT-14).

Wires :meth:`eden.realtime.kafka_consumer.KafkaEventConsumer.consume_alerts`
to :class:`eden.realtime.alert_stream.AlertStreamProcessor` so alert rules
(cost spikes, pipeline failures, HILT waits, and the P0
``rule_sandbox_escape``) actually evaluate against live events instead of
sitting fully wired but never invoked.

Follows the module-level start/stop lifecycle used by
:mod:`eden.workers.trace_finalized_consumer` so it plugs into the same
sidecar bundle (:mod:`eden.workers.sidecars`). Gracefully no-ops when Kafka
isn't configured/installed — this must never block the rest of the sidecar
bundle from starting.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

logger = logging.getLogger(__name__)

_TASK: asyncio.Task | None = None
_CONSUMER: Any = None


def _kafka_available() -> bool:
    """True when a Kafka bootstrap server is configured and aiokafka is
    importable. Best-effort — this consumer is opt-in infrastructure,
    not yet deployed everywhere, so absence must be silent."""
    try:
        from eden.config import get_settings

        bootstrap = getattr(get_settings(), "kafka_bootstrap_servers", "")
    except Exception:
        return False
    if not bootstrap:
        return False
    try:
        import aiokafka  # noqa: F401
    except ImportError:
        return False
    return True


async def _run() -> None:
    global _CONSUMER

    from eden.realtime.kafka_consumer import EDEN_TOPICS, KafkaEventConsumer

    consumer = KafkaEventConsumer(group_id="eden-alerts")
    _CONSUMER = consumer
    try:
        # ``.start()`` sets the internal running flag that
        # ``consume_alerts``'s poll loop checks on every iteration —
        # required before consuming, per this module's own usage docs.
        await consumer.start()
        await consumer.consume_alerts(EDEN_TOPICS["alert"])
    except Exception as exc:
        logger.warning("alert_kafka_consumer: consume_alerts exited: %s", exc)


async def start_consumer() -> None:
    """Start the ``eden-alert`` consumer task (idempotent)."""
    global _TASK
    if _TASK is not None and not _TASK.done():
        return
    if not _kafka_available():
        logger.info(
            "alert_kafka_consumer: disabled (no kafka_bootstrap_servers "
            "configured or aiokafka not installed)"
        )
        return
    _TASK = asyncio.create_task(_run(), name="alert_kafka_consumer")


async def stop_consumer() -> None:
    """Gracefully stop the ``eden-alert`` consumer task."""
    global _TASK, _CONSUMER
    if _CONSUMER is not None:
        with contextlib.suppress(Exception):
            await _CONSUMER.stop()
    if _TASK is not None:
        try:
            await asyncio.wait_for(_TASK, timeout=15.0)
        except TimeoutError:
            _TASK.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await _TASK
        except Exception:
            pass
    _TASK = None
    _CONSUMER = None


def is_consumer_running() -> bool:
    return _TASK is not None and not _TASK.done()
