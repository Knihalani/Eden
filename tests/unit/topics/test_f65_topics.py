"""F65 — topics service tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.topics import service as topics


@pytest.mark.asyncio
async def test_list_topics_falls_back_to_patterns() -> None:
    pg = AsyncMock()
    pg.fetch = AsyncMock(side_effect=Exception("no topic_clusters"))
    patterns = [
        {
            "pattern_id": "p1",
            "name": "billing",
            "topic_label": "Billing questions",
            "sample_count": 12,
            "representative_trace_ids": ["t1"],
            "first_seen": None,
            "last_seen": None,
            "metadata": {},
            "description": None,
            "coherence_score": 0.8,
        }
    ]
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        with patch.object(topics, "_fallback_from_patterns", AsyncMock(return_value=[])):
            # direct call to fallback
            out = await topics._fallback_from_patterns("org", facet="task", limit=10)
    assert len(out) == 0

    pg2 = AsyncMock()
    pg2.fetch = AsyncMock(return_value=patterns)
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg2)):
        out = await topics._fallback_from_patterns("org", facet="issues", limit=10)
    assert out[0]["name"] == "Billing questions"
    assert out[0]["facet"] == "issues"
