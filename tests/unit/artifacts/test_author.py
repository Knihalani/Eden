"""Tests for ArtifactAuthor loop DSL."""

from eden.nudges.author import ArtifactAuthor


def test_loop_dsl_same_tool_repeats():
    author = ArtifactAuthor()
    trigger, content, name = author._loop_dsl(
        "same_tool_repeats", {"tool_name": "search"}
    )
    assert trigger["all"][0]["event"] == "tool_call"
    assert "search" in content
    assert name.startswith("loop-")


def test_loop_dsl_tool_error():
    author = ArtifactAuthor()
    trigger, content, name = author._loop_dsl("tool_error", {"tool_name": "run_sql"})
    assert trigger["all"][0]["event"] == "tool_error"
    assert "run_sql" in content
