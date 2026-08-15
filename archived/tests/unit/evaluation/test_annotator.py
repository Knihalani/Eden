"""Tests for T1 trace annotator (tags only, no scores)."""

from __future__ import annotations

from eden.evaluation.annotator import (
    ALLOWED_TAGS,
    compact_events,
    filter_covered_by_layer_a,
    parse_annotator_response,
    tags_to_persist,
)


def test_parse_annotator_json() -> None:
    tags, conf = parse_annotator_response(
        '{"tags": ["wrong_tool", "needs_review"], "confidence": 0.8}'
    )
    assert tags == ["needs_review", "wrong_tool"]
    assert conf == 0.8


def test_parse_rejects_unknown_tags() -> None:
    tags, _ = parse_annotator_response(
        '{"tags": ["wrong_tool", "made_up", "looping"], "confidence": 1}'
    )
    assert tags == ["wrong_tool"]
    assert "looping" not in ALLOWED_TAGS or "looping" not in tags


def test_parse_fenced_json() -> None:
    tags, conf = parse_annotator_response(
        '```json\n{"tags": ["success"], "confidence": 0.9}\n```'
    )
    assert tags == ["success"]
    assert conf == 0.9


def test_filter_layer_a_coverage() -> None:
    tags = filter_covered_by_layer_a(
        ["wrong_tool", "user_frustrated", "hallucination"],
        {"wrong_tool", "looping"},
    )
    assert "wrong_tool" not in tags
    assert "user_frustrated" in tags
    assert "hallucination" in tags


def test_tags_to_persist() -> None:
    payload = tags_to_persist(["incomplete", "needs_review"], 0.7)
    assert payload["eval:llm:incomplete"] == "0.700"
    assert payload["eval:llm"] == "incomplete,needs_review"


def test_compact_events_truncates() -> None:
    events = [
        {
            "event_type": "llm",
            "name": "chat",
            "attributes": {"content": "x" * 500},
        }
        for _ in range(5)
    ]
    body = compact_events(events, max_chars=800)
    assert len(body) <= 800
    assert "llm|chat|" in body


def test_compact_events_default_max_chars() -> None:
    """Default max_chars must be 1000 (OOM plan 7.1)."""
    # Build enough content to exceed 1000 chars if the cap were 3500.
    events = [
        {
            "event_type": "llm",
            "name": "chat",
            "attributes": {"content": "y" * 300},
        }
        for _ in range(10)
    ]
    body = compact_events(events)  # use default
    assert len(body) <= 1000


def test_compact_events_default_event_cap() -> None:
    """Default event slice must cap at 25 events (OOM plan 7.1)."""
    events = [
        {"event_type": "ev", "name": str(i)}
        for i in range(80)
    ]
    # With a generous max_chars the only cap is the [:25] slice.
    body = compact_events(events, max_chars=100_000)
    # Each line is "ev|<n>", the 26th event (index 25) is "ev|25".
    # If [:80] were still in effect "ev|25" through "ev|79" would appear.
    assert "ev|25" not in body
    assert "ev|24" in body
