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
