"""Unit tests for the closed-loop correlation report.

Covers:
- The bug fix in ``write_all_pending_insights_to_kb`` (no more
  ``AttributeError`` from ``.values()`` on a list)
- The bug fix in ``write_insight_to_kb`` (Insight has no
  ``title``/``description``; use ``summary``/``recommended_action``)
- The correlation report's SLO target computation
- Empty state (no data yet) returns target_slo_met=False without raising
- SQL-injection guard via the parameterized query
"""

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.insights.detectors import Insight
from eden.insights.insights_service import InsightsService
from eden.insights.correlation import (
    CorrelationReport,
    GOLD_TIER_UPLIFT_TARGET,
    WeekBucket,
    correlation_report,
)


# ────────────────────────────────────────────────────────────────────────
# Bug-fix regressions (June 2026 audit)
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_write_all_pending_does_not_crash_on_list():
    """Pre-fix: ``self._insights.values()`` raised AttributeError because
    ``_insights`` is a list. Post-fix: iteration works."""
    svc = InsightsService()
    for i in range(3):
        svc._insights.append(Insight(
            insight_id=f"ins_{i}",
            detector="test",
            severity="low",
            confidence=0.5,
            summary=f"summary {i}",
        ))

    async def fake_write(insight, *, organization_id=None):
        return f"ent_{insight.insight_id}"

    with patch.object(svc, "write_insight_to_kb", side_effect=fake_write):
        result = await svc.write_all_pending_insights_to_kb()
    assert result["total"] == 3
    assert len(result["written"]) == 3
    assert result["failed"] == []


@pytest.mark.asyncio
async def test_write_insight_to_kb_no_longer_uses_nonexistent_fields():
    """Pre-fix: payload referenced ``insight.title`` and
    ``insight.description`` which don't exist on the Insight dataclass.
    Post-fix: uses ``summary`` and ``recommended_action``."""
    svc = InsightsService()
    insight = Insight(
        insight_id="ins_xyz",
        detector="failure_pattern",
        severity="high",
        confidence=0.9,
        summary="Recurring timeout in tool X",
        recommended_action="Increase tool X timeout to 30s",
        affected_trace_ids=["trace_a", "trace_b"],
    )

    captured = {}

    class FakeSemantic:
        async def search(self, *, collection, query_vector, filter_conditions=None, limit=20, score_threshold=None):
            return []

        async def upsert(self, *, collection, points):
            captured["payload"] = points[0]["payload"]
            captured["entity_id"] = points[0]["id"]
            return True

    with patch(
        "eden.kb.semantic.vector_client.get_vector_client",
        return_value=FakeSemantic(),
    ):
        result = await svc.write_insight_to_kb(insight)

    assert result == captured["entity_id"]
    # payload uses the real field names now
    p = captured["payload"]
    assert p["title"] == "Recurring timeout in tool X"
    assert p["description"] == "Increase tool X timeout to 30s"


# ────────────────────────────────────────────────────────────────────────
# Correlation report — empty state
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_correlation_report_empty_state_when_db_unavailable():
    """If the DB is unreachable, the report returns target_slo_met=False
    rather than raising. The portal renders an empty state."""
    with patch(
        "eden.storage.postgres.get_postgres_client",
        side_effect=RuntimeError("no DB"),
    ):
        report = await correlation_report(organization_id=None, lookback_days=30)
    assert isinstance(report, CorrelationReport)
    assert report.weeks == []
    assert report.target_slo_met is False
    assert report.aggregate_post_rate is None


@pytest.mark.asyncio
async def test_correlation_report_empty_state_no_data():
    """DB is reachable but returns no rows."""
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=[])

    async def _client():
        return fake_client

    with patch("eden.storage.postgres.get_postgres_client", side_effect=_client):
        report = await correlation_report(organization_id="00000000-0000-0000-0000-000000000001")
    assert report.weeks == []
    assert report.target_slo_met is False
    assert report.target_slo == GOLD_TIER_UPLIFT_TARGET


# ────────────────────────────────────────────────────────────────────────
# Correlation report — SLO target computation
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_correlation_report_meets_slo_target():
    """When aggregate gold-tier rate >= 5%, target_slo_met=True."""
    fake_rows = [
        # 100 jobs, 10 gold → 10% rate, meets 5% SLO
        {"week_start": datetime(2026, 5, 4).date(), "insights_written": 2,
         "kb_writes": 2, "jobs_after": 50, "gold_after": 5},
        {"week_start": datetime(2026, 5, 11).date(), "insights_written": 1,
         "kb_writes": 1, "jobs_after": 50, "gold_after": 5},
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=fake_rows)

    async def _client():
        return fake_client

    with patch("eden.storage.postgres.get_postgres_client", side_effect=_client):
        report = await correlation_report(organization_id=None, lookback_days=30)

    assert report.aggregate_post_jobs == 100
    assert report.aggregate_post_gold == 10
    assert report.aggregate_post_rate == pytest.approx(0.10)
    assert report.target_slo_met is True
    assert len(report.weeks) == 2


@pytest.mark.asyncio
async def test_correlation_report_below_slo_target():
    """When aggregate gold-tier rate < 5%, target_slo_met=False."""
    fake_rows = [
        {"week_start": datetime(2026, 5, 4).date(), "insights_written": 2,
         "kb_writes": 2, "jobs_after": 100, "gold_after": 2},
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=fake_rows)

    async def _client():
        return fake_client

    with patch("eden.storage.postgres.get_postgres_client", side_effect=_client):
        report = await correlation_report(organization_id=None, lookback_days=30)

    assert report.aggregate_post_rate == pytest.approx(0.02)
    assert report.target_slo_met is False


# ────────────────────────────────────────────────────────────────────────
# SQL-injection guard — the query is parameterized; the org_id
# argument is passed as a parameter, never interpolated.
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_correlation_report_passes_org_id_as_parameter():
    """The org_id argument must be passed as a $1 query parameter, not
    interpolated into the SQL string. A malicious org_id value should
    arrive at the driver unchanged."""
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=[])

    async def _client():
        return fake_client

    malicious_org = "x'; DROP TABLE insights; --"

    with patch("eden.storage.postgres.get_postgres_client", side_effect=_client):
        await correlation_report(organization_id=malicious_org, lookback_days=30)

    # Inspect the call: the SQL string is the first positional arg, the
    # bound parameters follow in order (lookback_days, organization_id).
    call = fake_client.fetch.call_args
    positional = call.args
    assert len(positional) >= 3
    # The SQL contains the $1 placeholder; the malicious string is bound
    # as a parameter (never interpolated).
    assert "$1" in positional[0]
    assert "$2" in positional[0]
    assert positional[1] == 30
    assert positional[2] == malicious_org


# ────────────────────────────────────────────────────────────────────────
# §3.2 — Pluggable embedder (real embeddings, not hash stub)
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_insights_service_uses_injected_embedder():
    """When an embedder is passed to __init__, write_insight_to_kb
    calls it instead of building a default."""
    from eden.insights.insights_service import InsightsService

    class FakeEmbedder:
        def __init__(self):
            self.calls = []
        def embed(self, text: str) -> list[float]:
            self.calls.append(text)
            return [0.1] * 1536

    fake = FakeEmbedder()
    svc = InsightsService(embedder=fake)

    class FakeSemantic:
        def __init__(self):
            self.upserts = []
        async def search(self, **_):
            return []
        async def upsert(self, *, collection, points):
            self.upserts.append(points[0])
            return True

    fake_s = FakeSemantic()
    insight = Insight(
        insight_id="ins_embed",
        detector="failure_pattern",
        severity="high",
        confidence=0.9,
        summary="Slow tool X",
        recommended_action="Increase timeout",
    )

    with patch("eden.kb.semantic.vector_client.get_vector_client", return_value=fake_s):
        result = await svc.write_insight_to_kb(insight)

    assert result is not None
    assert len(fake.calls) == 1
    assert "Slow tool X" in fake.calls[0]
    assert "Increase timeout" in fake.calls[0]
    # The upsert used the real vector, not a hash stub
    assert fake_s.upserts[0]["vector"] == [0.1] * 1536


def test_hash_fallback_embedder_is_deterministic():
    """The fallback embedder is deterministic — same input → same
    output. Critical for KB dedup (AUDN relies on this)."""
    from eden.insights.insights_service import _HashFallbackEmbedder
    e = _HashFallbackEmbedder(dim=1536)
    v1 = e.embed("insight:abc")
    v2 = e.embed("insight:abc")
    assert v1 == v2
    assert len(v1) == 1536


def test_hash_fallback_embedder_distinguishes_inputs():
    """Different inputs produce different vectors."""
    from eden.insights.insights_service import _HashFallbackEmbedder
    e = _HashFallbackEmbedder(dim=1536)
    a = e.embed("insight:abc")
    b = e.embed("insight:xyz")
    assert a != b


@pytest.mark.asyncio
async def test_write_insight_falls_back_when_embedder_fails():
    """If the embedder raises, the KB write still completes via the
    deterministic fallback vector (so the advisory path never blocks
    the pipeline)."""
    from eden.insights.insights_service import InsightsService

    class BrokenEmbedder:
        def embed(self, text: str) -> list[float]:
            raise RuntimeError("embedding service down")

    svc = InsightsService(embedder=BrokenEmbedder())

    class FakeSemantic:
        def __init__(self):
            self.last_vec = None
        async def search(self, **_):
            return []
        async def upsert(self, *, collection, points):
            self.last_vec = points[0]["vector"]
            return True

    fake = FakeSemantic()
    insight = Insight(
        insight_id="ins_fb",
        detector="failure_pattern",
        severity="low",
        confidence=0.5,
        summary="fallback test",
    )

    with patch("eden.kb.semantic.vector_client.get_vector_client", return_value=fake):
        result = await svc.write_insight_to_kb(insight)

    assert result is not None
    # The fallback produced a 1536-dim vector and it was used.
    assert len(fake.last_vec) == 1536
