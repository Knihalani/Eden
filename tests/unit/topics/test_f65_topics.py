"""F65 — topics service tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

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


def test_row_to_topic_includes_trend_from_metadata() -> None:
    row = {
        "id": "topic-1",
        "facet": "task",
        "name": "Billing",
        "description": None,
        "share_pct": 10.0,
        "keywords": [],
        "sample_count": 5,
        "representative_trace_ids": [],
        "pattern_id": "p1",
        "signal_cluster_id": None,
        "first_seen": None,
        "last_seen": None,
        "metadata": {
            "trend": "rising",
            "trend_score": 0.5,
            "recent_count": 10,
            "baseline_count": 15,
        },
    }
    topic = topics._row_to_topic(row)
    assert topic["trend"] == "rising"
    assert topic["trend_score"] == 0.5
    assert topic["recent_count"] == 10
    assert topic["baseline_count"] == 15


TOPIC = {
    "id": "topic-1",
    "name": "Billing errors",
    "facet": "issues",
    "keywords": ["billing", "refund"],
    "sample_count": 42,
    "representative_trace_ids": ["t1"],
}


@pytest.mark.asyncio
async def test_act_on_topic_alert_creates_rule_and_dispatches() -> None:
    from eden.alerts.unified import DestinationDispatchResult, UnifiedDestinationKind

    email_result = DestinationDispatchResult(
        kind=UnifiedDestinationKind.EMAIL,
        status="sent",
        detail={"recipient_count": 2},
    )
    dispatch_result = MagicMock()
    dispatch_result.any_sent = True
    dispatch_result.results = [email_result]
    dispatch_result.by_kind = lambda kind: email_result if kind == UnifiedDestinationKind.EMAIL else None
    with patch.object(
        topics, "list_topics", AsyncMock(return_value=[TOPIC])
    ), patch(
        "eden.alerts.compiler.AlertCompiler"
    ) as compiler_cls, patch(
        "eden.alerts.repo.create_nl_rule",
        new=AsyncMock(return_value={"id": "rule-1"}),
    ), patch("eden.dsl.AlertAsCode") as dsl_cls, patch(
        "eden.alerts.unified.dispatch_unified_alert",
        new=AsyncMock(return_value=dispatch_result),
    ):
        compiler_cls.return_value.compile = AsyncMock(
            return_value={"eql": "SELECT * FROM traces WHERE error_rate > 0.05"}
        )
        dsl_cls.return_value.compile = AsyncMock(
            return_value={
                "status": "ok",
                "data": {"alert_id": "alert-1"},
            }
        )
        result = await topics.act_on_topic(
            "org-1", "topic-1", action="alert", name="billing-watch"
        )
    assert result["status"] == "sent"
    assert result["rule_id"] == "rule-1"
    assert result["alert_id"] == "alert-1"
    assert result["recipient_count"] == 2


@pytest.mark.asyncio
async def test_act_on_topic_alert_returns_failed_when_dispatch_skipped() -> None:
    from eden.alerts.unified import DestinationDispatchResult, UnifiedDestinationKind

    dispatch_result = MagicMock()
    dispatch_result.any_sent = False
    dispatch_result.results = [
        DestinationDispatchResult(
            kind=UnifiedDestinationKind.EMAIL,
            status="skipped",
            error="no alert recipients (org has no owner/admin emails)",
        )
    ]
    dispatch_result.by_kind = lambda kind: dispatch_result.results[0]

    with patch.object(
        topics, "list_topics", AsyncMock(return_value=[TOPIC])
    ), patch(
        "eden.alerts.compiler.AlertCompiler"
    ) as compiler_cls, patch(
        "eden.alerts.repo.create_nl_rule",
        new=AsyncMock(return_value={"id": "rule-1"}),
    ), patch("eden.dsl.AlertAsCode") as dsl_cls, patch(
        "eden.alerts.unified.dispatch_unified_alert",
        new=AsyncMock(return_value=dispatch_result),
    ):
        compiler_cls.return_value.compile = AsyncMock(
            return_value={"eql": "SELECT * FROM traces WHERE error_rate > 0.05"}
        )
        dsl_cls.return_value.compile = AsyncMock(
            return_value={
                "status": "ok",
                "data": {"alert_id": "alert-1"},
            }
        )
        result = await topics.act_on_topic("org-1", "topic-1", action="alert")
    assert result["status"] == "failed"
    assert result["rule_id"] == "rule-1"
    assert "no alert recipients" in result["error"]


@pytest.mark.asyncio
async def test_act_on_topic_alert_returns_failed_when_compile_fails() -> None:
    with patch.object(
        topics, "list_topics", AsyncMock(return_value=[TOPIC])
    ), patch(
        "eden.alerts.compiler.AlertCompiler"
    ) as compiler_cls, patch(
        "eden.alerts.repo.create_nl_rule",
        new=AsyncMock(return_value={"id": "rule-1"}),
    ), patch("eden.dsl.AlertAsCode") as dsl_cls:
        compiler_cls.return_value.compile = AsyncMock(
            return_value={"eql": "SELECT * FROM traces WHERE error_rate > 0.05"}
        )
        dsl_cls.return_value.compile = AsyncMock(
            return_value={"status": "not_implemented", "message": "bad eql"}
        )
        result = await topics.act_on_topic("org-1", "topic-1", action="alert")
    assert result["status"] == "failed"
    assert "bad eql" in result["error"]
