"""OpenAI/Anthropic ingest must preserve SDK correlation ids."""

from __future__ import annotations

from eden.observability.ingestion.providers import (
    _anthropic_to_raw,
    _openai_to_raw,
)


def test_openai_to_raw_prefers_sdk_trace_and_agent_id() -> None:
    raw = _openai_to_raw(
        {
            "id": "chatcmpl-abc",
            "model": "MiniMax-M3",
            "trace_id": "parent-trace-111",
            "agent_id": "minimax-pydantic-agent",
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": "hi"},
                }
            ],
        }
    )
    assert raw["trace_id"] == "parent-trace-111"
    assert raw["agent_id"] == "minimax-pydantic-agent"
    assert raw["event_type"] == "openai.chat_completion"


def test_openai_to_raw_falls_back_to_response_id() -> None:
    raw = _openai_to_raw(
        {
            "id": "chatcmpl-xyz",
            "model": "gpt-4o",
            "usage": {},
            "choices": [],
        }
    )
    assert raw["trace_id"] == "chatcmpl-xyz"


def test_anthropic_to_raw_prefers_sdk_trace_and_agent_id() -> None:
    raw = _anthropic_to_raw(
        {
            "id": "msg_abc",
            "type": "message",
            "model": "claude-sonnet-4-6",
            "trace_id": "parent-trace-222",
            "agent_id": "claude-agent",
            "role": "assistant",
            "content": [{"type": "text", "text": "hi"}],
            "usage": {"input_tokens": 3, "output_tokens": 2},
            "stop_reason": "end_turn",
        }
    )
    assert raw["trace_id"] == "parent-trace-222"
    assert raw["agent_id"] == "claude-agent"
