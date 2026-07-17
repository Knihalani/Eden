"""Trigger DSL parity with ArtifactAuthor loop DSL."""

from eden.nudges.trigger_eval import evaluate_trigger


def test_tool_call_min_repeats():
    ctx = {
        "recent_tool_calls": [
            {"tool_name": "grep"},
            {"tool_name": "grep"},
        ]
    }
    trigger = {"all": [{"event": "tool_call", "tool": "grep", "min_repeats": 2}]}
    assert evaluate_trigger(trigger, ctx)


def test_tool_error_matches():
    ctx = {
        "recent_tool_calls": [
            {"tool_name": "run_sql", "error": True},
        ]
    }
    trigger = {"all": [{"event": "tool_error", "tool": "run_sql"}]}
    assert evaluate_trigger(trigger, ctx)
