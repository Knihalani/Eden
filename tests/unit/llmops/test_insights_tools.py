"""Unit tests for AI Insights tools (Capture / Analyse / Improve)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.llmops import insights_tools as tools


ORG = "org_test_insights"


def _row(data: dict[str, Any]) -> dict[str, Any]:
    return data


@pytest.fixture(autouse=True)
def _clear_dedupe() -> None:
    tools._dedupe_cache.clear()


class TestRegistry:
    def test_list_traces_registered_not_jobs(self) -> None:
        names = {t.name for t in tools.list_tools()}
        assert "list_traces" in names
        assert "list_jobs" not in names
        assert "get_job" not in names
        assert "search_jobs" not in names
        for required in (
            "get_trace",
            "get_cost_breakdown",
            "get_judge_scores",
            "get_anomalies",
            "get_insights",
            "list_agent_issues",
            "list_proposed_patches",
            "preview_nl_alert",
            "create_alert_rule",
            "navigate",
            "propose_filter",
            "find_similar",
            "open_trace",
            "open_issue",
            "open_session",
            "open_alert",
            "open_artifact",
            "preview_nl_signal",
            "create_signal",
            "promote_artifact",
            "export_table",
            "list_analysis_templates",
            "run_analysis_template",
        ):
            assert required in names

    def test_no_jobs_or_cartpole_in_descriptions(self) -> None:
        blob = " ".join(
            f"{t.name} {t.description}" for t in tools.list_tools()
        ).lower()
        assert "cartpole" not in blob
        assert "environment_class" not in blob
        assert " from jobs" not in blob

    def test_anthropic_schema_shape(self) -> None:
        for tool in tools.list_tools():
            spec = tool.to_anthropic_tool()
            assert spec["input_schema"]["type"] == "object"
            assert "properties" in spec["input_schema"]


class TestParseSince:
    def test_relative_hours(self) -> None:
        out = tools._parse_since("3h")
        delta = datetime.now(UTC) - out
        assert timedelta(hours=2, minutes=59) < delta < timedelta(hours=3, minutes=1)


@pytest.mark.asyncio
async def test_list_traces_queries_telemetry_not_jobs() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(
        return_value=[
            _row({
                "trace_id": "trc_1",
                "started_at": datetime(2026, 7, 1, tzinfo=UTC),
                "realm": "production",
                "agent_id": "agent_a",
                "model": "gpt-4o",
                "outcome": "success",
                "error_type": None,
                "span_count": 3,
                "duration_ms": 120.5,
                "cost_usd": 0.02,
            }),
        ]
    )
    with patch.object(tools, "get_postgres_client", AsyncMock(return_value=client)):
        result = await tools.list_traces(ORG, limit=10, since="24h")

    assert result["count"] == 1
    assert result["traces"][0]["trace_id"] == "trc_1"
    assert result["traces"][0]["traces_url"] == "/traces?trace_id=trc_1"
    assert result["traces"][0]["inspector_url"].startswith("/observability?")
    sql = client.fetch.await_args.args[0]
    assert "telemetry_events" in sql
    assert " FROM jobs" not in sql
    assert "environment_class" not in sql


@pytest.mark.asyncio
async def test_get_cost_breakdown_uses_usage_events() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(
        side_effect=[
            [_row({"model": "claude-sonnet", "cost_usd": 1.5, "event_count": 10})],
            [_row({
                "day": datetime(2026, 7, 1, tzinfo=UTC),
                "cost_usd": 1.5,
                "event_count": 10,
            })],
        ]
    )
    with patch.object(tools, "get_postgres_client", AsyncMock(return_value=client)):
        result = await tools.get_cost_breakdown(ORG, since="7d")

    assert result["estimated_total"] == 1.5
    assert result["by_model"][0]["model"] == "claude-sonnet"
    assert len(result["series"]) == 1
    sql = client.fetch.await_args_list[0].args[0]
    assert "usage_events" in sql
    assert " FROM jobs" not in sql


@pytest.mark.asyncio
async def test_list_agent_issues_and_patches() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(
        side_effect=[
            [_row({
                "id": "11111111-1111-1111-1111-111111111111",
                "fingerprint": "fp1",
                "kind": "error",
                "title": "Boom",
                "status": "open",
                "severity": "p1",
                "agent_id": "a1",
                "first_seen": datetime(2026, 7, 1, tzinfo=UTC),
                "last_seen": datetime(2026, 7, 2, tzinfo=UTC),
                "stumble_count": 4,
            })],
            [_row({
                "id": "patch_1",
                "repo_id": "repo_1",
                "trace_id": "trc_9",
                "rca_id": "rca_1",
                "description": "Fix null check",
                "status": "proposed",
                "quality_score": 0.9,
                "cost_usd": 0.01,
                "created_at": datetime(2026, 7, 2, tzinfo=UTC),
                "updated_at": datetime(2026, 7, 2, tzinfo=UTC),
            })],
        ]
    )
    with patch.object(tools, "get_postgres_client", AsyncMock(return_value=client)):
        issues = await tools.list_agent_issues(ORG)
        patches = await tools.list_proposed_patches(ORG)

    assert issues["count"] == 1
    assert issues["issues"][0]["issues_url"].startswith("/issues/")
    assert patches["count"] == 1
    assert patches["patches"][0]["inbox_url"] == "/closed-loop"
    assert patches["patches"][0]["traces_url"] == "/traces?trace_id=trc_9"


@pytest.mark.asyncio
async def test_dispatch_dedupes_identical_calls() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[])
    with patch.object(tools, "get_postgres_client", AsyncMock(return_value=client)):
        first = await tools.dispatch_tool_call(ORG, "list_traces", {"limit": 5})
        second = await tools.dispatch_tool_call(ORG, "list_traces", {"limit": 5})

    assert first["status"] == "ok"
    assert second.get("cached") is True
    assert client.fetch.await_count == 1


@pytest.mark.asyncio
async def test_dispatch_unknown_tool() -> None:
    result = await tools.dispatch_tool_call(ORG, "list_jobs", {})
    assert result["status"] == "error"
    assert "list_jobs" in result["output"]


def test_system_prompt_mentions_pillars() -> None:
    import importlib.util
    import pathlib
    import sys

    path = (
        pathlib.Path(__file__).resolve().parents[3]
        / "src"
        / "eden"
        / "api"
        / "routes"
        / "ai_insights.py"
    )
    spec = importlib.util.spec_from_file_location(
        "eden.api.routes.ai_insights_under_test",
        str(path),
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)

    prompt = mod._build_system_prompt(tools.list_tools())
    assert "Capture" in prompt
    assert "Analyse" in prompt
    assert "Improve" in prompt
    assert "list_traces" in prompt
    assert "list_jobs" not in prompt


@pytest.mark.asyncio
async def test_preview_nl_alert_tool_dispatch() -> None:
    with patch(
        "eden.alerts.compiler.EQLParser.parse",
        AsyncMock(return_value={"status": "ok", "data": {"warnings": []}}),
    ):
        result = await tools.dispatch_tool_call(
            ORG,
            "preview_nl_alert",
            {"nl_text": "cost per call above $0.30 for 15 minutes"},
        )
    assert result["status"] == "ok"
    output = result["output"]
    assert output["approval_required"] is True
    assert output["eql"]
    assert output["alerts_url"] == "/alerts"


@pytest.mark.asyncio
async def test_navigate_and_propose_filter_client_actions() -> None:
    nav = await tools.dispatch_tool_call(ORG, "navigate", {"path": "/traces"})
    assert nav["status"] == "ok"
    assert nav["output"]["client_action"] == "navigate"
    assert nav["output"]["href"] == "/traces"

    bad = await tools.dispatch_tool_call(
        ORG, "navigate", {"path": "https://evil.example/x"}
    )
    assert bad["status"] == "ok"
    assert "error" in bad["output"]

    filt = await tools.dispatch_tool_call(
        ORG,
        "propose_filter",
        {"q": "latency:>2 status:error", "path": "/traces"},
    )
    assert filt["status"] == "ok"
    out = filt["output"]
    assert out["client_action"] == "propose_filter"
    assert out["q"] == "latency:>2 status:error"
    assert out["href"].startswith("/traces?q=")

    opened = await tools.dispatch_tool_call(
        ORG, "open_trace", {"trace_id": "trc_abc"}
    )
    assert opened["status"] == "ok"
    assert opened["output"]["client_action"] == "navigate"
    assert "trc_abc" in opened["output"]["href"]


def test_safe_portal_href() -> None:
    assert tools._safe_portal_href("/issues/abc") == "/issues/abc"
    assert tools._safe_portal_href("//evil") is None
    assert tools._safe_portal_href("http://x") is None
    assert tools._safe_portal_href("/unknown-root") is None
    assert tools._safe_portal_href("/marketplace") is None
    assert tools._safe_portal_href("/builder/run") is None
    assert tools._safe_portal_href("/finops") is None
    assert tools._safe_portal_href("/settings?tab=finops") == "/settings?tab=finops"
    assert tools._safe_portal_href("/analytics") == "/analytics"


@pytest.mark.asyncio
async def test_preview_nl_signal_approval_required() -> None:
    result = await tools.dispatch_tool_call(
        ORG,
        "preview_nl_signal",
        {"description": "LLM refusal rate above 5% in the last 24 hours"},
    )
    assert result["status"] == "ok"
    output = result["output"]
    assert output["approval_required"] is True
    assert output["rule"]["metric"] == "refusal_rate"
    assert output["signals_url"] == "/signals"


@pytest.mark.asyncio
async def test_export_table_slow_traces_csv_client_action() -> None:
    client = AsyncMock()
    client.fetch = AsyncMock(
        return_value=[
            _row({
                "trace_id": "trc_slow",
                "started_at": datetime(2026, 7, 1, tzinfo=UTC),
                "realm": "production",
                "agent_id": "agent_a",
                "model": "gpt-4o",
                "outcome": "success",
                "error_type": None,
                "span_count": 3,
                "duration_ms": 9000.0,
                "cost_usd": 0.02,
            }),
        ]
    )
    with patch.object(tools, "get_postgres_client", AsyncMock(return_value=client)):
        result = await tools.dispatch_tool_call(
            ORG,
            "export_table",
            {"template": "slow_traces", "format": "csv"},
        )
    assert result["status"] == "ok"
    out = result["output"]
    assert out["client_action"] == "download"
    assert out["format"] == "csv"
    assert out["row_count"] >= 1
    assert out["rows"][0]["trace_id"] == "trc_slow"
    assert "spend_preview" in out


@pytest.mark.asyncio
async def test_query_sql_rejects_writes_and_spend_gates() -> None:
    bad = await tools.dispatch_tool_call(
        ORG, "query_sql", {"sql": "DELETE FROM telemetry_events"}
    )
    assert bad["status"] == "ok"
    assert "error" in bad["output"]

    multi = await tools.dispatch_tool_call(
        ORG, "query_sql", {"sql": "SELECT 1; SELECT 2"}
    )
    assert "error" in multi["output"]

    gated = await tools.dispatch_tool_call(
        ORG,
        "query_sql",
        {"sql": "SELECT a FROM t JOIN u ON a=b GROUP BY a ORDER BY a"},
    )
    assert gated["output"].get("approval_required") is True
    assert "spend_preview" in gated["output"]
