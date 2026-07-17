"""Wave 28 — F64 agentic metrics, F34 classifiers, MCP stretch (unit)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.evaluation.agentic_metrics.service import AgenticMetricsService
from eden.signals.classifier_pipeline import ClassifierTrainingPipeline
from eden.signals.shadow_compare import ShadowComparator


def test_agentic_empty_metrics_shape() -> None:
    empty = AgenticMetricsService._empty_metrics()
    assert "tool_selection" in empty
    assert "action_completion" in empty
    assert "flow_adherence" in empty
    assert "intent_change" in empty
    assert empty["_trace_count"] == 0


@pytest.mark.asyncio
async def test_agentic_summary_disabled() -> None:
    class _S:
        agentic_metrics_v1 = False

    with patch("eden.config.get_settings", return_value=_S()):
        out = await AgenticMetricsService().summary("org1")
    assert out["status"] == "disabled"


@pytest.mark.asyncio
async def test_classifier_predict_majority_fallback() -> None:
    model, metrics = ClassifierTrainingPipeline._fit_logistic(
        [[0.1] * 16, [0.9] * 16, [0.2] * 16],
        [0, 1, 0],
    )
    assert "f1" in metrics
    fired, score = ClassifierTrainingPipeline._predict(model, [0.9] * 16)
    assert isinstance(fired, bool)
    assert 0.0 <= score <= 1.0


@pytest.mark.asyncio
async def test_shadow_compare_unavailable_without_db() -> None:
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        report = await ShadowComparator().report("org", "sig")
    assert report["status"] == "unavailable"


@pytest.mark.asyncio
async def test_classifier_worker_no_classifiers_skips() -> None:
    from eden.signals.classifier_worker import run_classifiers_before_investigator

    with (
        patch(
            "eden.signals.classifier_worker._load_active_classifiers",
            new=AsyncMock(return_value=[]),
        ),
        patch("eden.config.get_settings", return_value=MagicMock(signal_classifiers_v1=True)),
    ):
        out = await run_classifiers_before_investigator("org", "tr1")
    assert out["skip_investigator"] is False
    assert out["status"] == "no_classifiers"


def test_mcp_catalog_includes_w28_tools() -> None:
    from eden.mcp_server.server import TOOL_CATALOG

    names = {t["name"] for t in TOOL_CATALOG}
    for required in (
        "query_eql",
        "query_sql",
        "list_datasets",
        "list_experiments",
        "get_judge_scores",
        "get_cost_breakdown",
        "get_agentic_metrics",
    ):
        assert required in names


@pytest.mark.asyncio
async def test_mcp_query_eql_and_sql_handlers() -> None:
    from eden.mcp_server import tools as tool_fns

    class _Client:
        pass

    eql = await tool_fns.query_eql(_Client(), "org1", nl_text="errors")
    assert eql["status"] == "ok"
    assert "eql" in eql

    sql = await tool_fns.query_sql(_Client(), "org1", sql="SELECT 1")
    assert sql["status"] == "ok"
    assert sql["sql"] == "SELECT 1"


@pytest.mark.asyncio
async def test_mcp_http_initialize() -> None:
    from eden.mcp_server.http_transport import _handle_rpc

    resp = await _handle_rpc(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        api_key=None,
        org_id="org1",
    )
    assert resp["result"]["serverInfo"]["transport"] == "streamable-http"


@pytest.mark.asyncio
async def test_mcp_get_agentic_metrics_local() -> None:
    from eden.mcp_server import tools as tool_fns

    class _Client:
        pass

    with patch.object(
        AgenticMetricsService,
        "summary",
        new=AsyncMock(
            return_value={"status": "ok", "metrics": {}, "trace_count": 0}
        ),
    ):
        out = await tool_fns.get_agentic_metrics(_Client(), "org1")
    assert out["status"] == "ok"


def test_known_features_include_f34_tags() -> None:
    from eden.llmops.cost_ledger import KNOWN_FEATURES

    assert "signal_classifier" in KNOWN_FEATURES
    assert "signal_investigator" in KNOWN_FEATURES
