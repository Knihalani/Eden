"""F20 — AutoIssueScanner + trace.finalized consumer (Wave 2)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.auto_scanner import AutoIssueScanner


def _tool_error_events() -> list[dict[str, Any]]:
    return [
        {
            "event_type": "tool.call",
            "name": "search_kb",
            "outcome": "failure",
            "error": "Timeout after 30s",
            "span_id": "s1",
            "agent_id": "agent-a",
            "attributes": {},
            "duration_ms": 100,
        }
    ]


def _loop_events() -> list[dict[str, Any]]:
    return [
        {
            "event_type": "tool.call",
            "name": "search_kb",
            "outcome": "success",
            "span_id": f"s{i}",
            "agent_id": "agent-a",
            "attributes": {"tool_args": "same"},
            "duration_ms": 10,
        }
        for i in range(4)
    ]


class _CapturingWriter:
    def __init__(self) -> None:
        self.created: list[Any] = []

    async def create(self, sc: Any) -> dict[str, Any]:
        self.created.append(sc)
        return {"stumble_id": "sid", "fingerprint": "fp", "inserted": True, "issue": None}


@pytest.mark.asyncio
async def test_detects_tool_error() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    await scanner.scan("org", "trace-1", events=_tool_error_events())
    kinds = [sc.kind for sc in writer.created]
    assert "tool_error" in kinds
    te = next(sc for sc in writer.created if sc.kind == "tool_error")
    assert te.detail["tool_name"] == "search_kb"
    assert te.detected_by == "auto_scanner"


@pytest.mark.asyncio
async def test_detects_loop_from_repetition() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    await scanner.scan("org", "trace-2", events=_loop_events())
    kinds = [sc.kind for sc in writer.created]
    assert "loop" in kinds
    loop = next(sc for sc in writer.created if sc.kind == "loop")
    assert loop.detail["repeat_count"] >= 3


@pytest.mark.asyncio
async def test_detects_loop_from_etec_score() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    events = [
        {
            "event_type": "span.end",
            "attributes": {"etec_loop_score": "0.92"},
            "duration_ms": 10,
        }
    ]
    await scanner.scan("org", "trace-3", events=events)
    assert any(sc.kind == "loop" for sc in writer.created)


@pytest.mark.asyncio
async def test_detects_task_failure() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    events = [
        {
            "event_type": "span.end",
            "parent_span_id": None,
            "outcome": "failure",
            "error": "unhandled exception",
            "attributes": {},
            "duration_ms": 10,
        }
    ]
    await scanner.scan("org", "trace-4", events=events)
    assert any(sc.kind == "task_failure" for sc in writer.created)


@pytest.mark.asyncio
async def test_detects_slow_trace() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    events = [
        {"event_type": "span.end", "duration_ms": 45_000, "attributes": {}}
    ]
    await scanner.scan("org", "trace-5", events=events)
    assert any(sc.kind == "timeout" for sc in writer.created)


@pytest.mark.asyncio
async def test_healthy_trace_produces_no_stumbles() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    events = [
        {
            "event_type": "llm.completion",
            "outcome": "success",
            "duration_ms": 200,
            "attributes": {},
        }
    ]
    await scanner.scan("org", "trace-6", events=events)
    assert writer.created == []


@pytest.mark.asyncio
async def test_minimal_profile_skips_loop_and_slow() -> None:
    writer = _CapturingWriter()
    scanner = AutoIssueScanner(writer=writer)  # type: ignore[arg-type]
    # loop-y trace but minimal profile → no loop detector.
    await scanner.scan(
        "org", "trace-7", events=_loop_events(), detection_profile="minimal"
    )
    assert not any(sc.kind == "loop" for sc in writer.created)


@pytest.mark.asyncio
async def test_standard_profile_enables_all_detectors() -> None:
    from eden.issues.auto_scanner import _PROFILE_DETECTORS

    standard = _PROFILE_DETECTORS["standard"]
    expected = {
        "tool_error",
        "loop",
        "task_failure",
        "slow_trace",
        "hallucination",
        "user_frustration",
        "confusion_loop",
        "high_cost",
    }
    assert expected.issubset(standard)


@pytest.mark.asyncio
async def test_consumer_handle_scans_and_acks() -> None:
    import eden.workers.trace_finalized_consumer as mod

    consumer = mod.TraceFinalizedConsumer()
    consumer._scanner = MagicMock()
    consumer._scanner.scan = AsyncMock(return_value=[])
    redis = MagicMock()
    redis.xack = AsyncMock()

    fields = {
        b"org_id": b"org_test",
        b"trace_id": b"trace-1",
        b"agent_id": b"agent-a",
        b"session_id": b"",
        b"user_id": b"",
    }
    await consumer._handle(redis, "1-0", fields)

    consumer._scanner.scan.assert_awaited_once()
    _args, kwargs = consumer._scanner.scan.call_args
    assert _args[0] == "org_test"
    assert _args[1] == "trace-1"
    redis.xack.assert_awaited_once()


@pytest.mark.asyncio
async def test_maybe_emit_trace_finalized_only_on_terminal() -> None:
    from eden.observability.trace_finalized import maybe_emit_trace_finalized

    redis = MagicMock()
    redis.xadd = AsyncMock()

    # non-terminal → no emit
    await maybe_emit_trace_finalized(
        {"event_type": "llm.completion", "parent_span_id": "p"}, redis
    )
    redis.xadd.assert_not_awaited()

    # terminal → emit
    await maybe_emit_trace_finalized(
        {
            "event_type": "trace.end",
            "tenant_id": "org_test",
            "trace_id": "trace-1",
            "agent_id": "agent-a",
            "attributes": {},
        },
        redis,
    )
    redis.xadd.assert_awaited_once()
