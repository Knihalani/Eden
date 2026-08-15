"""FEAT-179 — topics CSV export."""

from __future__ import annotations

import csv
import io
from unittest.mock import AsyncMock, patch

import pytest

from eden.topics.service import TOPIC_CSV_FIELDS, topics_to_csv


def _sample_topic(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "topic-1",
        "facet": "issues",
        "name": "Billing questions",
        "description": "Users ask about invoices",
        "share_pct": 12.5,
        "sample_count": 10,
        "keywords": ["billing", "invoice"],
        "representative_trace_ids": ["trace-1", "trace-2"],
        "pattern_id": "p1",
        "signal_cluster_id": None,
        "first_seen": "2026-01-01T00:00:00Z",
        "last_seen": "2026-02-01T00:00:00Z",
        "source": "patterns",
        "trend": "up",
        "trend_score": 0.8,
        "recent_count": 5,
        "baseline_count": 2,
    }
    base.update(overrides)
    return base


def test_topics_to_csv_header_and_one_row_per_topic() -> None:
    topics = [_sample_topic(), _sample_topic(id="topic-2", name="Latency")]
    csv_text = topics_to_csv(topics)

    reader = csv.DictReader(io.StringIO(csv_text))
    assert reader.fieldnames == list(TOPIC_CSV_FIELDS)
    rows = list(reader)
    assert len(rows) == 2
    assert rows[0]["id"] == "topic-1"
    assert rows[0]["name"] == "Billing questions"
    assert rows[0]["keywords"] == "billing; invoice"
    assert rows[0]["representative_trace_ids"] == "trace-1; trace-2"
    assert rows[1]["id"] == "topic-2"
    assert rows[1]["name"] == "Latency"


def test_topics_to_csv_empty_list_still_has_header() -> None:
    csv_text = topics_to_csv([])
    lines = csv_text.strip().splitlines()
    assert len(lines) == 1
    assert lines[0] == ",".join(TOPIC_CSV_FIELDS)


def test_topics_to_csv_escapes_commas_in_name() -> None:
    csv_text = topics_to_csv([_sample_topic(name='Billing, refunds, and "quotes"')])
    reader = csv.DictReader(io.StringIO(csv_text))
    row = next(reader)
    assert row["name"] == 'Billing, refunds, and "quotes"'


@pytest.mark.asyncio
async def test_export_topics_route_returns_csv() -> None:
    from eden.api.routes.topics import export_topics

    topics = [_sample_topic()]
    with patch(
        "eden.api.routes.topics.list_topics",
        AsyncMock(return_value=topics),
    ):
        resp = await export_topics(org_id="org-1", facet=None, format="csv", user={})

    body = b""
    async for chunk in resp.body_iterator:
        body += chunk
    text = body.decode()
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    assert len(rows) == 1
    assert rows[0]["id"] == "topic-1"
    assert resp.media_type == "text/csv"
    assert "attachment" in resp.headers.get("Content-Disposition", "")


@pytest.mark.asyncio
async def test_export_topics_route_returns_json() -> None:
    from eden.api.routes.topics import export_topics

    topics = [_sample_topic()]
    with patch(
        "eden.api.routes.topics.list_topics",
        AsyncMock(return_value=topics),
    ):
        out = await export_topics(org_id="org-1", facet="task", format="json", user={})

    assert out["status"] == "ok"
    assert out["feature"] == "f65_topics"
    assert out["count"] == 1
    assert out["topics"][0]["id"] == "topic-1"
