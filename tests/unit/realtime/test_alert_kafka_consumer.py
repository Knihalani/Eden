"""Tests for the eden-alert consumer start/stop lifecycle (FEAT-14).

Kafka (aiokafka) isn't installed in this environment, so these tests
exercise the graceful no-op path plus the task-lifecycle bookkeeping
with a stubbed-in consumer.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_module_state():
    import eden.workers.alert_kafka_consumer as mod

    mod._TASK = None
    mod._CONSUMER = None
    yield
    mod._TASK = None
    mod._CONSUMER = None


class TestStartConsumerNoOp:
    @pytest.mark.asyncio
    async def test_start_is_noop_when_aiokafka_not_installed(self) -> None:
        import eden.workers.alert_kafka_consumer as mod

        await mod.start_consumer()

        assert mod.is_consumer_running() is False
        assert mod._TASK is None

    @pytest.mark.asyncio
    async def test_start_is_noop_when_no_bootstrap_servers_configured(self) -> None:
        import eden.workers.alert_kafka_consumer as mod

        with patch(
            "eden.config.get_settings",
            return_value=type("S", (), {"kafka_bootstrap_servers": ""})(),
        ):
            await mod.start_consumer()

        assert mod.is_consumer_running() is False

    @pytest.mark.asyncio
    async def test_stop_is_safe_when_never_started(self) -> None:
        import eden.workers.alert_kafka_consumer as mod

        await mod.stop_consumer()  # must not raise
        assert mod.is_consumer_running() is False


class TestStartStopLifecycle:
    @pytest.mark.asyncio
    async def test_start_creates_task_when_kafka_available(self) -> None:
        import eden.workers.alert_kafka_consumer as mod

        with (
            patch.object(mod, "_kafka_available", return_value=True),
            patch.object(mod, "_run", new=AsyncMock()),
        ):
            await mod.start_consumer()
            assert mod.is_consumer_running() is True

            # Calling start again while already running is a no-op
            # (idempotent) rather than spawning a second task.
            existing_task = mod._TASK
            await mod.start_consumer()
            assert mod._TASK is existing_task

            await mod.stop_consumer()

        assert mod._TASK is None
        assert mod.is_consumer_running() is False

    @pytest.mark.asyncio
    async def test_stop_calls_consumer_stop(self) -> None:
        import asyncio

        import eden.workers.alert_kafka_consumer as mod

        fake_consumer = AsyncMock()

        async def _fake_run() -> None:
            # Simulates KafkaEventConsumer.consume_alerts() assigning
            # _CONSUMER then returning once the poll loop exits (real
            # code exits when consumer.stop() flips _running off).
            mod._CONSUMER = fake_consumer

        with (
            patch.object(mod, "_kafka_available", return_value=True),
            patch.object(mod, "_run", new=_fake_run),
        ):
            await mod.start_consumer()
            await asyncio.sleep(0)  # let the task run to completion
            await mod.stop_consumer()

        fake_consumer.stop.assert_awaited_once()
        assert mod._TASK is None
        assert mod._CONSUMER is None


class TestRunWiring:
    @pytest.mark.asyncio
    async def test_run_subscribes_to_eden_alert_and_calls_consume_alerts(self) -> None:
        import eden.workers.alert_kafka_consumer as mod

        fake_consumer = AsyncMock()
        fake_consumer.start = AsyncMock()
        fake_consumer.consume_alerts = AsyncMock()

        with patch(
            "eden.realtime.kafka_consumer.KafkaEventConsumer",
            return_value=fake_consumer,
        ):
            await mod._run()

        fake_consumer.start.assert_awaited_once()
        fake_consumer.consume_alerts.assert_awaited_once_with("eden-alert")
