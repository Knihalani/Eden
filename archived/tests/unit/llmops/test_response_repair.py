"""Unit tests for gateway response repair."""

from __future__ import annotations

import json

from eden.llmops.response_repair import repair_chat_completion_response


def test_repair_empty_tool_arguments():
    shaped = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "",
                            "type": "",
                            "function": {"name": "get_weather", "arguments": ""},
                        }
                    ],
                }
            }
        ]
    }
    repaired, count = repair_chat_completion_response(shaped)
    tc = repaired["choices"][0]["message"]["tool_calls"][0]
    assert count > 0
    assert tc["type"] == "function"
    assert tc["id"].startswith("call_")
    assert json.loads(tc["function"]["arguments"]) == {}


def test_repair_trailing_comma_json():
    shaped = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_abc",
                            "type": "function",
                            "function": {
                                "name": "search",
                                "arguments": '{"q": "foo",}',
                            },
                        }
                    ],
                }
            }
        ]
    }
    repaired, count = repair_chat_completion_response(shaped)
    args = repaired["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"]
    assert count >= 1
    assert json.loads(args) == {"q": "foo"}


def test_repair_valid_json_unchanged():
    shaped = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_abc",
                            "type": "function",
                            "function": {
                                "name": "search",
                                "arguments": '{"q": "foo"}',
                            },
                        }
                    ],
                }
            }
        ]
    }
    repaired, count = repair_chat_completion_response(shaped)
    assert count == 0
    assert repaired == shaped
