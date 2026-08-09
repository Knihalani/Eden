"""FEAT-61: ``get_trace_tree`` nodes expose agent_id and operation_name."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.telemetry_collector import TelemetryCollector


def _trace_row(**overrides):
    row = {
        "span_id": "span-1",
        "parent_span_id": None,
        "name": "chat.completions",
        "event_type": "llm.completion",
        "timestamp": datetime(2026, 8, 4, 10, 0, 0, tzinfo=UTC),
        "duration_ms": 42.0,
        "realm": "production",
        "outcome": "success",
        "agent_id": "planner",
        "operation_name": "chat.completions",
        "metrics": {},
        "attributes": {},
        "payload": {},
        "request_body": None,
        "response_body": None,
        "reasoning": None,
        "tool_calls_full": [],
        "tool_results": [],
        "images": [],
        "audio": [],
        "logprobs": None,
        "citations": [],
        "finish_reason": None,
        "stop_sequence": None,
        "system_fingerprint": None,
        "cache_hit": False,
        "prompt_cache_savings_usd": None,
        "model_version": None,
        "service_tier": None,
        "error_type": None,
        "error_message": None,
        "payload_zstd": None,
        "metrics_zstd": None,
        "attributes_zstd": None,
    }
    row.update(overrides)
    return row


@pytest.mark.asyncio
async def test_get_trace_tree_node_includes_agent_id_and_operation_name() -> None:
    fake_pg = MagicMock()
    fake_pg.fetch = AsyncMock(return_value=[_trace_row()])

    collector = TelemetryCollector()
    collector._postgres = fake_pg

    with patch(
        "eden.storage.compression.decompress_many",
        return_value=[None, None, None],
    ):
        tree = await collector.get_trace_tree(
            "org-1",
            "trace-1",
            hydrate_bodies=False,
        )

    assert tree is not None
    assert len(tree.root_spans) == 1
    node = tree.root_spans[0]
    assert node["agent_id"] == "planner"
    assert node["operation_name"] == "chat.completions"
    assert tree.span_map["span-1"]["agent_id"] == "planner"
    assert tree.span_map["span-1"]["operation_name"] == "chat.completions"


@pytest.mark.asyncio
async def test_get_trace_tree_cheap_path_omits_body_and_reasoning_fields() -> None:
    fake_pg = MagicMock()
    fake_pg.fetch = AsyncMock(
        return_value=[
            _trace_row(
                reasoning="long chain of thought",
                tool_calls_full=[{"name": "search"}],
                tool_results=[{"content": "big"}],
                request_body={"messages": [{"role": "user", "content": "hi"}]},
                response_body={"content": "hello"},
            )
        ]
    )

    collector = TelemetryCollector()
    collector._postgres = fake_pg

    with patch(
        "eden.storage.compression.decompress_many",
        return_value=[None, None, None],
    ):
        tree = await collector.get_trace_tree(
            "org-1",
            "trace-1",
            hydrate_bodies=False,
        )

    assert tree is not None
    node = tree.root_spans[0]
    for key in (
        "request_body",
        "response_body",
        "reasoning",
        "tool_calls_full",
        "tool_results",
    ):
        assert key not in node
    assert node["agent_id"] == "planner"
    assert node["metrics"] == {}
    assert node["attributes"] == {}
    assert node["payload"] == {}


@pytest.mark.asyncio
async def test_get_trace_tree_hydrated_path_includes_body_fields() -> None:
    fake_pg = MagicMock()
    fake_pg.fetch = AsyncMock(
        return_value=[
            _trace_row(
                reasoning="thought",
                tool_calls_full=[{"name": "search"}],
                tool_results=[{"content": "ok"}],
                request_body={"messages": [{"role": "user", "content": "hi"}]},
                response_body={"content": "hello"},
            )
        ]
    )

    collector = TelemetryCollector()
    collector._postgres = fake_pg

    with patch(
        "eden.storage.compression.decompress_many",
        return_value=[None, None, None, None, None, None, None, None],
    ):
        tree = await collector.get_trace_tree(
            "org-1",
            "trace-1",
            hydrate_bodies=True,
        )

    assert tree is not None
    node = tree.root_spans[0]
    assert node["request_body"] == {"messages": [{"role": "user", "content": "hi"}]}
    assert node["response_body"] == {"content": "hello"}
    assert node["reasoning"] == "thought"
    assert node["tool_calls_full"] == [{"name": "search"}]
    assert node["tool_results"] == [{"content": "ok"}]
