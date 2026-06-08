"""Tests for the HallucinationJudge."""

import json
from unittest.mock import MagicMock

import pytest

from eden.llmops.judges.base import JudgeContext
from eden.llmops.judges.hallucination import (
    HallucinationJudge,
    _extract_text_and_spec,
    _parse_judge_response,
)


def _fake_response(content: str):
    r = MagicMock()
    r.content = content
    r.model = "claude-haiku-20250520"
    return r


def _fake_event(payload=None, attributes=None, tags=None, event_type="otel.chat"):
    class _E:
        pass
    e = _E()
    e.event_type = event_type
    e.event_id = "evt_1"
    e.trace_id = "tr_1"
    e.span_id = "sp_1"
    e.payload = payload or {}
    e.attributes = attributes or {}
    e.tags = tags or []
    return e


@pytest.mark.asyncio
async def test_hallucination_judge_no_llm_returns_unknown():
    j = HallucinationJudge()
    score = await j.score(_fake_event(payload={"openai": {"first_message_content": "hi"}}),
                          JudgeContext(event=_fake_event(), llm_client=None))
    assert score.score == 0.5
    assert "no llm_client" in score.rationale


@pytest.mark.asyncio
async def test_hallucination_judge_empty_response_returns_unknown():
    client = MagicMock()
    j = HallucinationJudge()
    score = await j.score(_fake_event(payload={"openai": {}}),
                          JudgeContext(event=_fake_event(), llm_client=client))
    assert score.score == 0.5
    assert "empty_response" in score.rationale
    client.call.assert_not_called()


@pytest.mark.asyncio
async def test_hallucination_judge_success():
    client = MagicMock()
    client.call.return_value = _fake_response(
        json.dumps({"score": 0.82, "rationale": "mostly accurate"})
    )
    j = HallucinationJudge()
    ev = _fake_event(payload={"openai": {"first_message_content": "Hello world."}})
    score = await j.score(ev, JudgeContext(event=ev, llm_client=client))
    assert score.score == 0.82
    assert score.rationale == "mostly accurate"
    assert score.judge_name == "hallucination"
    assert score.model == "claude-haiku-20250520"
    assert score.latency_ms > 0
    # Prompt format
    client.call.assert_called_once()
    prompt = client.call.call_args.kwargs["prompt"]
    assert "Hello world." in prompt
    assert "judge_hallucination" == client.call.call_args.kwargs["agent"]


@pytest.mark.asyncio
async def test_hallucination_judge_clamps_out_of_range():
    client = MagicMock()
    client.call.return_value = _fake_response(json.dumps({"score": 1.5, "rationale": "x"}))
    j = HallucinationJudge()
    ev = _fake_event(payload={"openai": {"first_message_content": "Hi"}})
    score = await j.score(ev, JudgeContext(event=ev, llm_client=client))
    assert score.score == 1.0  # clamped


@pytest.mark.asyncio
async def test_hallucination_judge_handles_malformed_response():
    client = MagicMock()
    client.call.return_value = _fake_response("not json at all")
    j = HallucinationJudge()
    ev = _fake_event(payload={"openai": {"first_message_content": "Hi"}})
    score = await j.score(ev, JudgeContext(event=ev, llm_client=client))
    # Falls back to score=0.5 with the raw content as rationale.
    assert score.score == 0.5
    assert score.rationale  # non-empty


@pytest.mark.asyncio
async def test_hallucination_judge_handles_llm_exception():
    client = MagicMock()
    client.call.side_effect = RuntimeError("LLM down")
    j = HallucinationJudge()
    ev = _fake_event(payload={"openai": {"first_message_content": "Hi"}})
    score = await j.score(ev, JudgeContext(event=ev, llm_client=client))
    assert score.score == 0.5
    assert "judge_error" in score.rationale


# ── _parse_judge_response ──────────────────────────────────────


def test_parse_strict_json():
    score, rationale = _parse_judge_response('{"score": 0.7, "rationale": "ok"}')
    assert score == 0.7
    assert rationale == "ok"


def test_parse_json_with_prose():
    content = 'Sure, here you go: {"score": 0.4, "rationale": "weak"} thanks!'
    score, rationale = _parse_judge_response(content)
    assert score == 0.4
    assert rationale == "weak"


def test_parse_bare_float():
    score, _ = _parse_judge_response("0.65")
    assert score == 0.65


def test_parse_clamps():
    score, _ = _parse_judge_response('{"score": 1.5}')
    assert score == 1.0
    score, _ = _parse_judge_response('{"score": -0.2}')
    assert score == 0.0


def test_parse_empty_returns_unknown():
    score, rationale = _parse_judge_response("")
    assert score == 0.5
    assert "empty" in rationale


def test_parse_garbage_returns_unknown():
    score, _ = _parse_judge_response("@@@ not parseable @@@")
    assert score == 0.5


# ── _extract_text_and_spec ──────────────────────────────────────


def test_extract_text_from_openai_payload():
    payload = {"openai": {"first_message_content": "Hello"}}
    text, spec = _extract_text_and_spec(_fake_event(payload=payload))
    assert text == "Hello"
    assert spec == ""


def test_extract_text_from_anthropic_payload():
    payload = {"anthropic": {"content_text": "Bonjour"}}
    text, _ = _extract_text_and_spec(_fake_event(payload=payload))
    assert text == "Bonjour"


def test_extract_text_returns_empty_when_no_decoder_match():
    """The function does NOT fall back to stringification. If no
    decoder schema matched, the judge gets empty text and emits a
    ``no_score:empty_response`` rather than a meaningless stringified
    payload."""
    payload = {"random": "fallback string here"}
    text, _ = _extract_text_and_spec(_fake_event(payload=payload))
    assert text == ""


def test_extract_text_empty_when_no_payload():
    text, _ = _extract_text_and_spec(_fake_event(payload={}))
    # No decoder schema matched → empty.
    assert text == ""


# ── matches ────────────────────────────────────────────────────


def test_hallucination_judge_matches_llm_events():
    j = HallucinationJudge()
    assert j.matches(_fake_event(payload={"openai": {}})) is True
    assert j.matches(_fake_event(payload={"anthropic": {}})) is True
    assert j.matches(_fake_event(payload={"langfuse": {}})) is True


def test_hallucination_judge_does_not_match_empty_payload():
    j = HallucinationJudge()
    # Base matches() requires LLM event_type, which this provides,
    # but the override also requires a payload key.
    ev = _fake_event(payload={}, event_type="otel.chat")
    assert j.matches(ev) is False


def test_hallucination_judge_does_not_match_non_llm_events():
    j = HallucinationJudge()
    ev = _fake_event(payload={"openai": {}}, event_type="env.step")
    assert j.matches(ev) is False
