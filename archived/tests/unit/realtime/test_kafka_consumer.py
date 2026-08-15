"""Regression test — _send_to_dlq() must not leak the DLQ producer's TCP
connection when producer.start()/producer.send() raises.

Prior bug: the DLQ producer was constructed and started, then `await
producer.stop()` was only called after a successful `producer.send()`. Any
exception raised by start()/send() skipped stop() entirely, leaking the
connection on every failed DLQ publish attempt.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _fake_aiokafka_module(producer: MagicMock) -> types.ModuleType:
    """Build a fake `aiokafka` module whose AIOKafkaProducer(...) returns
    the given mock producer, so `from aiokafka import AIOKafkaProducer`
    succeeds even though aiokafka isn't installed in this environment."""
    module = types.ModuleType("aiokafka")
    module.AIOKafkaProducer = MagicMock(return_value=producer)
    return module


class TestSendToDlqProducerCleanup:
    @pytest.mark.asyncio
    async def test_stop_called_when_send_raises(self) -> None:
        from eden.realtime.kafka_consumer import KafkaEventConsumer

        producer = MagicMock()
        producer.start = AsyncMock()
        producer.send = AsyncMock(side_effect=RuntimeError("broker unreachable"))
        producer.stop = AsyncMock()

        consumer = KafkaEventConsumer()
        msg = MagicMock(topic="eden-events", partition=0, offset=42, value={"x": 1})

        with patch.dict(sys.modules, {"aiokafka": _fake_aiokafka_module(producer)}):
            await consumer._send_to_dlq(msg, "processing failed")

        producer.start.assert_awaited_once()
        producer.send.assert_awaited_once()
        # The regression: stop() must still run despite send() raising.
        producer.stop.assert_awaited_once()
        # send() failed, so the message was never actually delivered to the DLQ.
        assert consumer._metrics["dlq_messages"] == 0

    @pytest.mark.asyncio
    async def test_stop_called_when_start_raises(self) -> None:
        from eden.realtime.kafka_consumer import KafkaEventConsumer

        producer = MagicMock()
        producer.start = AsyncMock(side_effect=RuntimeError("connect timeout"))
        producer.send = AsyncMock()
        producer.stop = AsyncMock()

        consumer = KafkaEventConsumer()
        msg = MagicMock(topic="eden-events", partition=0, offset=7, value={"x": 1})

        with patch.dict(sys.modules, {"aiokafka": _fake_aiokafka_module(producer)}):
            await consumer._send_to_dlq(msg, "processing failed")

        producer.start.assert_awaited_once()
        producer.send.assert_not_awaited()
        producer.stop.assert_awaited_once()
        assert consumer._metrics["dlq_messages"] == 0

    @pytest.mark.asyncio
    async def test_stop_called_and_metrics_updated_on_success(self) -> None:
        from eden.realtime.kafka_consumer import KafkaEventConsumer

        producer = MagicMock()
        producer.start = AsyncMock()
        producer.send = AsyncMock()
        producer.stop = AsyncMock()

        consumer = KafkaEventConsumer()
        msg = MagicMock(topic="eden-events", partition=0, offset=3, value={"x": 1})

        with patch.dict(sys.modules, {"aiokafka": _fake_aiokafka_module(producer)}):
            await consumer._send_to_dlq(msg, "processing failed")

        producer.stop.assert_awaited_once()
        assert consumer._metrics["dlq_messages"] == 1


class TestConsumeAlerts:
    @pytest.mark.asyncio
    async def test_consume_alerts_invokes_alert_processor_process_event(self) -> None:
        from eden.realtime.kafka_consumer import KafkaEventConsumer

        event = {
            "event_type": "sandbox.security_alert",
            "entity_id": "job-1",
            "tenant_id": "org-1",
            "payload": {"severity": "critical"},
        }

        msg = type(
            "Msg",
            (),
            {
                "topic": "eden-alert",
                "partition": 0,
                "offset": 7,
                "value": event,
                "timestamp": 0,
                "headers": [],
            },
        )()

        class _FakeKafkaConsumer:
            def __init__(self, parent: KafkaEventConsumer) -> None:
                self._parent = parent
                self._yielded = False
                self.topics: list[str] | None = None

            def subscribe(self, topics: list[str]) -> None:
                self.topics = topics

            async def commit(self) -> None:
                return None

            def __aiter__(self):
                return self

            async def __anext__(self):
                if not self._yielded:
                    self._yielded = True
                    return msg
                self._parent._running = False
                raise StopAsyncIteration

        consumer = KafkaEventConsumer()
        consumer._running = True
        consumer._semaphore = __import__("asyncio").Semaphore(4)
        fake_kafka = _FakeKafkaConsumer(consumer)
        consumer._consumer = fake_kafka

        processor = MagicMock()
        processor.process_event = AsyncMock(return_value=[])

        with patch(
            "eden.realtime.alert_stream.get_alert_processor",
            new=AsyncMock(return_value=processor),
        ):
            await consumer.consume_alerts("eden-alert")

        assert fake_kafka.topics == ["eden-alert"]
        processor.process_event.assert_awaited_once_with(event)
        assert consumer._metrics["messages_processed"] == 1
