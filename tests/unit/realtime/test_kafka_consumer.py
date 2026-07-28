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
