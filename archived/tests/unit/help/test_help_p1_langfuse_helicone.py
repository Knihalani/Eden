"""P1.3: joinable Langfuse BOOLEAN + Helicone {rating: bool} -> SessionOutcome."""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.helicone import HeliconeDecoder
from eden.observability.ingestion.langfuse import LangfuseDecoder
from eden.sessions.rollup import coerce_competitor_bool, derive_helped


def _attr(fmt: str) -> Attribution:
    return Attribution(tenant_id="org_abc", source_format=fmt)


def _langfuse_trace(*, session_id="sess_1", scores=None, **overrides) -> dict:
    t = {
        "id": "trace_1",
        "name": "my-trace",
        "userId": "user-1",
        "sessionId": session_id,
        "observations": [
            {
                "id": "obs_1",
                "traceId": "trace_1",
                "type": "GENERATION",
                "name": "openai-chat",
                "startTime": "2024-01-01T00:00:00.000Z",
                "endTime": "2024-01-01T00:00:01.000Z",
                "model": "gpt-4o",
            }
        ],
        "scores": scores or [],
    }
    t.update(overrides)
    return t


def _helicone_log(**overrides) -> dict:
    log = {
        "request_id": "req_abc123",
        "node_id": "root",
        "model": "gpt-4o",
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        "request": {},
        "response": {},
        "response_status": 200,
        "start_time": "2024-01-01T00:00:00Z",
        "end_time": "2024-01-01T00:00:01Z",
    }
    log.update(overrides)
    return log


async def _decode_langfuse(payload, captured: dict):
    async def fake_record(org_id, **kwargs):
        captured["org_id"] = org_id
        captured.update(kwargs)
        captured["called"] = True
        captured.setdefault("calls", []).append(dict(kwargs, org_id=org_id))
        return {"id": "so1", **kwargs}

    with patch(
        "eden.sessions.rollup.record_competitor_boolean",
        fake_record,
    ):
        return await LangfuseDecoder().decode(json.dumps(payload).encode(), _attr("langfuse"))


async def _decode_helicone(payload, captured: dict):
    async def fake_record(org_id, **kwargs):
        captured["org_id"] = org_id
        captured.update(kwargs)
        captured["called"] = True
        captured.setdefault("calls", []).append(dict(kwargs, org_id=org_id))
        return {"id": "so1", **kwargs}

    with patch(
        "eden.sessions.rollup.record_competitor_boolean",
        fake_record,
    ):
        return await HeliconeDecoder().decode(json.dumps(payload).encode(), _attr("helicone"))


def test_coerce_competitor_bool_rejects_scores() -> None:
    assert coerce_competitor_bool(True) is True
    assert coerce_competitor_bool(False) is False
    assert coerce_competitor_bool(1) is True
    assert coerce_competitor_bool(0) is False
    assert coerce_competitor_bool("true") is True
    assert coerce_competitor_bool("false") is False
    assert coerce_competitor_bool(0.95) is None
    assert coerce_competitor_bool(5) is None
    assert coerce_competitor_bool("good") is None
    assert coerce_competitor_bool(None) is None


def test_derive_helped_extra_work_wins_competitor_thumb() -> None:
    assert (
        derive_helped(
            [
                {"polarity": "extra_work", "confidence": "medium"},
                {
                    "source": "product",
                    "value": "helped",
                    "explicit": True,
                    "channel": "helicone",
                    "reason": "helicone_rating",
                    "confidence": "medium",
                },
            ]
        )
        == "not_helped"
    )


def test_derive_helped_native_person_wins_over_competitor() -> None:
    assert (
        derive_helped(
            [
                {"source": "person", "value": "helped", "explicit": True},
                {
                    "source": "product",
                    "value": "not_helped",
                    "explicit": True,
                    "channel": "langfuse",
                    "reason": "langfuse_boolean",
                    "confidence": "medium",
                },
            ]
        )
        == "helped"
    )


def test_derive_helped_competitor_boolean_alone() -> None:
    up = {
        "source": "product",
        "value": "helped",
        "explicit": True,
        "channel": "langfuse",
        "reason": "langfuse_boolean",
        "confidence": "medium",
    }
    down = {**up, "value": "not_helped", "channel": "helicone", "reason": "helicone_rating"}
    assert derive_helped([up]) == "helped"
    assert derive_helped([down]) == "not_helped"


def test_derive_helped_native_product_still_beats_competitor() -> None:
    assert (
        derive_helped(
            [
                {"source": "product", "value": "helped", "explicit": True, "channel": "sdk"},
                {
                    "source": "product",
                    "value": "not_helped",
                    "explicit": True,
                    "channel": "langfuse",
                    "reason": "langfuse_boolean",
                    "confidence": "medium",
                },
            ]
        )
        == "helped"
    )


def test_labeling_not_imported_by_decoders() -> None:
    import eden.observability.ingestion.helicone as helicone
    import eden.observability.ingestion.langfuse as langfuse

    assert "eden.evaluation.labeling" not in getattr(helicone, "__dict__", {})
    assert "eden.evaluation.labeling" not in getattr(langfuse, "__dict__", {})
    src_h = Path_read("src/eden/observability/ingestion/helicone.py")
    src_l = Path_read("src/eden/observability/ingestion/langfuse.py")
    assert "labeling" not in src_h
    assert "labeling" not in src_l
    assert "langfuse.app" not in src_h + src_l
    assert "helicone.ai" not in src_h + src_l
    assert "httpx" not in src_h
    assert "httpx" not in src_l


def Path_read(rel: str) -> str:
    from pathlib import Path

    return Path(rel).read_text()


@pytest.mark.asyncio
async def test_langfuse_boolean_true_maps_when_joinable() -> None:
    captured: dict = {}
    events = await _decode_langfuse(
        _langfuse_trace(
            scores=[
                {
                    "id": "s1",
                    "name": "user-feedback",
                    "dataType": "BOOLEAN",
                    "value": True,
                }
            ]
        ),
        captured,
    )
    assert events
    assert captured.get("called") is True
    assert captured["session_id"] == "sess_1"
    assert captured["channel"] == "langfuse"
    assert captured["reason"] == "langfuse_boolean"
    assert captured["rating"] is True
    assert captured["channel"] == "langfuse"


@pytest.mark.asyncio
async def test_langfuse_boolean_false_maps_not_helped() -> None:
    captured: dict = {}
    events = await _decode_langfuse(
        _langfuse_trace(
            scores=[{"name": "fb", "data_type": "BOOLEAN", "value": 0}]
        ),
        captured,
    )
    assert events
    assert captured.get("called") is True
    assert captured["rating"] is False
    assert captured["session_id"] == "sess_1"


@pytest.mark.asyncio
async def test_langfuse_numeric_score_does_not_map() -> None:
    captured: dict = {}
    events = await _decode_langfuse(
        _langfuse_trace(
            scores=[{"name": "quality", "dataType": "NUMERIC", "value": 0.95}]
        ),
        captured,
    )
    assert events
    assert captured.get("called") is None
    assert events[0].attributes["score.quality"] == "0.95"


@pytest.mark.asyncio
async def test_langfuse_score_without_datatype_does_not_map() -> None:
    captured: dict = {}
    events = await _decode_langfuse(
        _langfuse_trace(scores=[{"name": "overall", "value": 1}]),
        captured,
    )
    assert events
    assert captured.get("called") is None


@pytest.mark.asyncio
async def test_langfuse_boolean_without_session_id_does_not_map() -> None:
    captured: dict = {}
    events = await _decode_langfuse(
        _langfuse_trace(
            session_id="",
            scores=[{"name": "fb", "dataType": "BOOLEAN", "value": True}],
        ),
        captured,
    )
    assert events
    assert captured.get("called") is None


@pytest.mark.asyncio
async def test_helicone_rating_true_maps_when_joinable() -> None:
    captured: dict = {}
    events = await _decode_helicone(
        _helicone_log(session_id="sess_h", rating=True),
        captured,
    )
    assert events
    assert captured.get("called") is True
    assert captured["session_id"] == "sess_h"
    assert captured["channel"] == "helicone"
    assert captured["reason"] == "helicone_rating"
    assert captured["rating"] is True


@pytest.mark.asyncio
async def test_helicone_rating_in_properties() -> None:
    captured: dict = {}
    events = await _decode_helicone(
        _helicone_log(properties={"sessionId": "sess_p", "rating": False}),
        captured,
    )
    assert events
    assert captured.get("called") is True
    assert captured["session_id"] == "sess_p"
    assert captured["rating"] is False


@pytest.mark.asyncio
async def test_helicone_rating_without_session_id_does_not_map() -> None:
    captured: dict = {}
    events = await _decode_helicone(_helicone_log(rating=True), captured)
    assert events
    assert captured.get("called") is None


@pytest.mark.asyncio
async def test_helicone_non_bool_rating_does_not_map() -> None:
    captured: dict = {}
    events = await _decode_helicone(
        _helicone_log(session_id="sess_h", rating=5),
        captured,
    )
    assert events
    assert captured.get("called") is None
