"""Wave 8.3 — trace_finalized consumer poison / partial-write hardening."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_stats() -> None:
    import eden.workers.trace_finalized_consumer as mod

    mod.reset_consumer_stats()
    yield
    mod.reset_consumer_stats()


def _fields(**kwargs: str) -> dict[bytes, bytes]:
    base = {
        b"org_id": b"org_test",
        b"trace_id": b"trace-1",
        b"agent_id": b"agent-a",
        b"session_id": b"",
        b"user_id": b"",
    }
    for k, v in kwargs.items():
        base[k.encode()] = v.encode()
    return base


@pytest.mark.asyncio
async def test_poison_missing_ids_dead_letters_and_acks() -> None:
    """Malformed payload (no org/trace) must DLQ then XACK — never silent-drop."""
    import eden.workers.trace_finalized_consumer as mod
    from eden.observability.trace_finalized import TRACE_FINALIZED_DLQ_STREAM

    consumer = mod.TraceFinalizedConsumer()
    consumer._scanner = MagicMock()
    consumer._scanner.scan = AsyncMock(return_value=[])
    redis = MagicMock()
    redis.xack = AsyncMock()
    redis.xadd = AsyncMock()

    await consumer._handle(redis, "1-0", {b"org_id": b"", b"trace_id": b""})

    consumer._scanner.scan.assert_not_awaited()
    redis.xadd.assert_awaited_once()
    args, kwargs = redis.xadd.call_args
    assert args[0] == TRACE_FINALIZED_DLQ_STREAM
    assert "poison" in args[1]["reason"]
    redis.xack.assert_awaited_once()
    stats = mod.get_consumer_stats()
    assert stats["poison_total"] == 1
    assert stats["dlq_total"] == 1


@pytest.mark.asyncio
async def test_transient_scan_retries_then_succeeds() -> None:
    """Transient ConnectionError retries in-process; success ACKs without DLQ."""
    import eden.workers.trace_finalized_consumer as mod

    consumer = mod.TraceFinalizedConsumer()
    calls = {"n": 0}

    async def flaky_scan(*_a: Any, **_k: Any) -> list[Any]:
        calls["n"] += 1
        if calls["n"] < 3:
            raise ConnectionError("db blip")
        return []

    consumer._scanner = MagicMock()
    consumer._scanner.scan = AsyncMock(side_effect=flaky_scan)
    redis = MagicMock()
    redis.xack = AsyncMock()
    redis.xadd = AsyncMock()

    with patch.object(mod, "_RETRY_BASE_DELAY_S", 0.0), patch.object(
        consumer, "_run_layer_a", AsyncMock(return_value=None)
    ), patch.object(
        consumer, "_run_annotator", AsyncMock()
    ), patch.object(
        consumer, "_maybe_prod_eval", AsyncMock()
    ), patch(
        "eden.issues.detection_settings.resolve_profile",
        AsyncMock(return_value="standard"),
    ):
        await consumer._handle(redis, "1-0", _fields())

    assert calls["n"] == 3
    redis.xack.assert_awaited_once()
    redis.xadd.assert_not_awaited()
    stats = mod.get_consumer_stats()
    assert stats["handled_ok"] == 1
    assert stats["retry_total"] == 2
    assert stats["dlq_total"] == 0


@pytest.mark.asyncio
async def test_exhausted_retries_dead_letter_and_ack() -> None:
    """After max transient retries, message is DLQ'd and ACKed (no stuck PEL)."""
    import eden.workers.trace_finalized_consumer as mod
    from eden.observability.trace_finalized import TRACE_FINALIZED_DLQ_STREAM

    consumer = mod.TraceFinalizedConsumer()
    consumer._scanner = MagicMock()
    consumer._scanner.scan = AsyncMock(side_effect=ConnectionError("down"))
    redis = MagicMock()
    redis.xack = AsyncMock()
    redis.xadd = AsyncMock()

    with patch.object(mod, "_RETRY_BASE_DELAY_S", 0.0), patch.object(
        mod, "_MAX_HANDLE_ATTEMPTS", 2
    ), patch.object(
        consumer, "_run_layer_a", AsyncMock(return_value=None)
    ), patch.object(
        consumer, "_run_annotator", AsyncMock()
    ), patch.object(
        consumer, "_maybe_prod_eval", AsyncMock()
    ), patch(
        "eden.issues.detection_settings.resolve_profile",
        AsyncMock(return_value="standard"),
    ):
        await consumer._handle(redis, "9-0", _fields())

    assert consumer._scanner.scan.await_count == 2
    redis.xadd.assert_awaited_once()
    assert redis.xadd.call_args.args[0] == TRACE_FINALIZED_DLQ_STREAM
    assert "scan_failed" in redis.xadd.call_args.args[1]["reason"]
    redis.xack.assert_awaited_once()
    assert mod.get_consumer_stats()["dlq_total"] == 1


@pytest.mark.asyncio
async def test_non_transient_error_dead_letters_without_retry() -> None:
    """Permanent ValueError is poison-class: one attempt, then DLQ+ACK."""
    import eden.workers.trace_finalized_consumer as mod

    consumer = mod.TraceFinalizedConsumer()
    consumer._scanner = MagicMock()
    consumer._scanner.scan = AsyncMock(side_effect=ValueError("bad event shape"))
    redis = MagicMock()
    redis.xack = AsyncMock()
    redis.xadd = AsyncMock()

    with patch.object(mod, "_RETRY_BASE_DELAY_S", 0.0), patch.object(
        consumer, "_run_layer_a", AsyncMock(return_value=None)
    ), patch.object(
        consumer, "_run_annotator", AsyncMock()
    ), patch.object(
        consumer, "_maybe_prod_eval", AsyncMock()
    ), patch(
        "eden.issues.detection_settings.resolve_profile",
        AsyncMock(return_value="standard"),
    ):
        await consumer._handle(redis, "2-0", _fields())

    assert consumer._scanner.scan.await_count == 1
    redis.xadd.assert_awaited_once()
    redis.xack.assert_awaited_once()


@pytest.mark.asyncio
async def test_decode_list_of_pairs() -> None:
    import eden.workers.trace_finalized_consumer as mod

    decoded = mod._decode(
        [[b"org_id", b"o1"], [b"trace_id", b"t1"], ["agent_id", "a1"]]
    )
    assert decoded == {"org_id": "o1", "trace_id": "t1", "agent_id": "a1"}


@pytest.mark.asyncio
async def test_layer_a_judge_scores_skip_existing_axes() -> None:
    """Partial-write retry must not duplicate already-persisted Layer A axes."""
    from eden.evaluation.descriptors.engine import TraceDescriptorReport
    from eden.evaluation.descriptors.persist import persist_layer_a_judge_scores

    executed: list[str] = []

    class _PG:
        async def fetch(self, sql: str, *args: Any) -> list[dict[str, str]]:
            return [{"judge_name": "tool_selection_quality"}]

        async def execute(self, sql: str, *args: Any) -> str:
            executed.append(str(args[2]))  # judge_name
            return "OK"

    report = TraceDescriptorReport(
        trace_id="t1",
        descriptors=(),
        scores={
            "tool_selection_quality": 0.9,
            "action_completion": 0.8,
            "groundedness": 0.7,
            "safety": 1.0,
            "efficiency": 0.6,
            "trace_quality": 0.85,
        },
        latency_ms=1.0,
        detector_version="test",
    )

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_PG()),
    ):
        written = await persist_layer_a_judge_scores("org", "t1", report)

    assert "tool_selection_quality" not in executed
    assert "action_completion" in executed
    assert written == 5  # 6 axes minus the one already present


@pytest.mark.asyncio
async def test_layer_a_partial_insert_raises_transient() -> None:
    """Transient failure mid-axis-insert must raise so the consumer retries."""
    from eden.evaluation.descriptors.engine import TraceDescriptorReport
    from eden.evaluation.descriptors.persist import persist_layer_a_judge_scores

    class _PG:
        def __init__(self) -> None:
            self.n = 0

        async def fetch(self, sql: str, *args: Any) -> list[Any]:
            return []

        async def execute(self, sql: str, *args: Any) -> str:
            self.n += 1
            if self.n == 2:
                raise ConnectionError("pool timeout")
            return "OK"

    report = TraceDescriptorReport(
        trace_id="t1",
        descriptors=(),
        scores={
            "tool_selection_quality": 0.9,
            "action_completion": 0.8,
            "groundedness": 0.7,
            "safety": 1.0,
            "efficiency": 0.6,
            "trace_quality": 0.85,
        },
        latency_ms=1.0,
        detector_version="test",
    )

    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_PG()),
    ), pytest.raises(ConnectionError, match="pool timeout"):
        await persist_layer_a_judge_scores("org", "t1", report)
