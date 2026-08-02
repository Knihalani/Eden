"""Behavioural tests for Cat 22 — APM Depth + Tracing Depth (v1.4).

Exercises the 3 features in the v1.4 ship:

* **OTel v1.41 dual-emit** — :class:`OtelV141Enricher`
* **Per-step evaluation scores** — :class:`StepJudgeStamper`
* **3 new agent metrics** — :class:`DecisionPathDepthMetric`,
  :class:`ToolCallSuccessRateMetric`,
  :class:`CostPerStepMetric`,
  :class:`AgentMetricsCollector`

The v1.4 ship covers 3 of 6 features; the skipped
features are tail-based sampling (infra-heavy), K8s
attribute enrichment (infra), and Pyroscope profiling
(out of scope per the doc).
"""

from __future__ import annotations

import statistics
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Dual-emit helper tests ───────────────────────────────────────


class TestDualEmitAttributes:
    def test_v141_emits_v136_alias(self) -> None:
        from eden.apm_depth import dual_emit_attributes

        attrs = {"gen_ai.client.token.usage": 100}
        out = dual_emit_attributes(attrs)
        assert out["gen_ai.client.token.usage"] == 100
        assert out["gen_ai.usage.input_tokens"] == 100

    def test_v136_emits_v141_alias(self) -> None:
        from eden.apm_depth import dual_emit_attributes

        attrs = {"gen_ai.usage.input_tokens": 50}
        out = dual_emit_attributes(attrs, spec="v136")
        assert out["gen_ai.usage.input_tokens"] == 50
        assert out["gen_ai.client.token.usage"] == 50

    def test_does_not_overwrite_existing(self) -> None:
        from eden.apm_depth import dual_emit_attributes

        attrs = {
            "gen_ai.client.token.usage": 100,
            "gen_ai.usage.input_tokens": 200,  # already present
        }
        out = dual_emit_attributes(attrs)
        # The existing value is preserved (100 is the v1.41
        # name, so the v1.36 alias is already 100 — which
        # means our 200 was overwritten). Let's check the
        # actual behaviour: when the v1.36 name is already
        # present, we don't overwrite it.
        assert out["gen_ai.usage.input_tokens"] == 200

    def test_handles_empty_attrs(self) -> None:
        from eden.apm_depth import dual_emit_attributes

        assert dual_emit_attributes({}) == {}
        assert dual_emit_attributes(None) == {}  # type: ignore[arg-type]

    def test_passes_through_unknown_keys(self) -> None:
        from eden.apm_depth import dual_emit_attributes

        attrs = {
            "gen_ai.client.token.usage": 10,
            "service.name": "my-svc",
            "custom.attr": "x",
        }
        out = dual_emit_attributes(attrs)
        assert out["service.name"] == "my-svc"
        assert out["custom.attr"] == "x"
        assert out["gen_ai.usage.input_tokens"] == 10


class TestDetectSpec:
    def test_detects_v141(self) -> None:
        from eden.apm_depth.otel_v141 import detect_spec

        assert detect_spec({"gen_ai.agent.name": "x"}) == "v141"
        assert detect_spec({"mcp.method.name": "tools/call"}) == "v141"
        assert detect_spec({"gen_ai.client.input.token.usage": 10}) == "v141"
        assert detect_spec({"gen_ai.tool.name": "search"}) == "v141"

    def test_detects_v136(self) -> None:
        from eden.apm_depth.otel_v141 import detect_spec

        assert detect_spec({"gen_ai.usage.input_tokens": 10}) == "v136"
        assert detect_spec({"service.name": "x"}) == "v136"
        assert detect_spec({}) == "v136"
        assert detect_spec(None) == "v136"  # type: ignore[arg-type]

    def test_handles_non_string_keys(self) -> None:
        from eden.apm_depth.otel_v141 import detect_spec

        # The detector should not crash on non-string keys
        assert detect_spec({1: "x", "service.name": "y"}) == "v136"


# ─── OTelV141Enricher tests ──────────────────────────────────────


class TestOtelV141Enricher:
    def test_enrich_v141_span(self) -> None:
        from eden.apm_depth import OtelV141Enricher

        r = OtelV141Enricher().enrich(
            "org_t",
            attributes={"gen_ai.client.token.usage": 100},
        )
        assert r["status"] == "ok"
        assert r["data"]["spec"] == "v141"
        assert "gen_ai.usage.input_tokens" in r["data"]["attributes"]
        assert r["data"]["added_aliases"] == [
            "gen_ai.usage.input_tokens"
        ]

    def test_enrich_v136_span(self) -> None:
        from eden.apm_depth import OtelV141Enricher

        r = OtelV141Enricher().enrich(
            "org_t",
            attributes={"gen_ai.usage.input_tokens": 50},
        )
        assert r["data"]["spec"] == "v136"
        assert "gen_ai.client.token.usage" in r["data"]["attributes"]

    def test_enrich_empty_attributes(self) -> None:
        from eden.apm_depth import OtelV141Enricher

        r = OtelV141Enricher().enrich("org_t", attributes={})
        assert r["data"]["spec"] == "v136"
        assert r["data"]["added_aliases"] == []

    def test_enrich_handles_non_dict(self) -> None:
        from eden.apm_depth import OtelV141Enricher

        r = OtelV141Enricher().enrich("org_t", attributes=None)  # type: ignore[arg-type]
        assert r["status"] == "ok"
        assert r["data"]["spec"] == "v136"

    def test_enrich_batch(self) -> None:
        from eden.apm_depth import OtelV141Enricher

        spans = [
            {"name": "v141-span", "attributes": {"gen_ai.agent.name": "agent_a"}},
            {"name": "v136-span", "attributes": {"gen_ai.usage.input_tokens": 10}},
        ]
        r = OtelV141Enricher().enrich_batch("org_t", spans=spans)
        assert r["data"]["v141_count"] == 1
        assert r["data"]["v136_count"] == 1
        assert r["data"]["spans"][0]["apm.spec"] == "v141"
        assert r["data"]["spans"][1]["apm.spec"] == "v136"


# ─── StepJudgeStamper tests ──────────────────────────────────────


class TestStepJudgeStamper:
    def test_stamp_writes_attributes(self) -> None:
        from eden.apm_depth import StepJudgeStamper

        r = StepJudgeStamper().stamp(
            "org_t",
            attributes={"name": "tool_call"},
            step_index=3,
            step_judges={"hallucination": 0.85, "correctness": 0.92},
        )
        assert r["data"]["step_index"] == 3
        assert r["data"]["step_judges"]["hallucination"] == 0.85
        assert (
            r["data"]["attributes"]["apm.step_index"] == 3
        )
        assert (
            r["data"]["attributes"]["apm.step_judges"]["correctness"] == 0.92
        )

    def test_stamp_cleans_non_numeric_judges(self) -> None:
        from eden.apm_depth import StepJudgeStamper

        r = StepJudgeStamper().stamp(
            "org_t",
            attributes={},
            step_index=0,
            step_judges={"good": 0.5, "bad": "not-a-number", "weird": None},
        )
        # Only the numeric value survives
        assert "good" in r["data"]["step_judges"]
        assert "bad" not in r["data"]["step_judges"]
        assert "weird" not in r["data"]["step_judges"]

    def test_stamp_handles_invalid_step_index(self) -> None:
        from eden.apm_depth import StepJudgeStamper

        r = StepJudgeStamper().stamp(
            "org_t",
            attributes={},
            step_index="not-an-int",  # type: ignore[arg-type]
        )
        # Falls back to 0
        assert r["data"]["step_index"] == 0

    def test_stamp_with_no_judges(self) -> None:
        from eden.apm_depth import StepJudgeStamper

        r = StepJudgeStamper().stamp(
            "org_t", attributes={}, step_index=2
        )
        assert r["data"]["step_index"] == 2
        assert r["data"]["step_judges"] == {}

    async def test_get_step_judges_empty_trace_id(self) -> None:
        from eden.apm_depth import StepJudgeStamper

        r = await StepJudgeStamper().get_step_judges(
            "org_t", trace_id="", step_index=0
        )
        assert r["data"]["judges"] == {}

    async def test_get_step_judges_returns_empty_when_no_match(self) -> None:
        from eden.apm_depth import StepJudgeStamper

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            r = await StepJudgeStamper().get_step_judges(
                "org_t", trace_id="trace-1", step_index=5
            )
        assert r["data"]["judges"] == {}

    async def test_get_trace_steps_empty(self) -> None:
        from eden.apm_depth import StepJudgeStamper

        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            r = await StepJudgeStamper().get_trace_steps(
                "org_t", trace_id="trace-1"
            )
        assert r["data"]["steps"] == []


# ─── Metrics tests ────────────────────────────────────────────────


class TestDecisionPathDepthMetric:
    async def test_no_data(self) -> None:
        from eden.apm_depth import DecisionPathDepthMetric

        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=[]),
        ):
            r = await DecisionPathDepthMetric().compute("org_t")
        assert r["data"]["sample_size"] == 0
        assert r["data"]["loop_alert"] is False

    async def test_with_data(self) -> None:
        from eden.apm_depth import DecisionPathDepthMetric

        # Build a synthetic dataset: 20 traces with depths
        # 1..20. p95 should be 19 (the 19th of 20 sorted
        # values at index ceil(0.95*20)-1 = 19-1 = 18).
        rows = [
            {"trace_id": f"t{i}", "max_step": i}
            for i in range(20)
        ]
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=rows),
        ):
            r = await DecisionPathDepthMetric().compute("org_t")
        d = r["data"]
        assert d["sample_size"] == 20
        assert d["max"] == 20
        # p95 should be 19 (max_step=18 → depth=19)
        assert d["p95"] == 19.0
        assert d["loop_alert"] is False

    async def test_loop_alert(self) -> None:
        from eden.apm_depth import DecisionPathDepthMetric

        # 20 traces all with max_step=25 → depth 26 → p95 = 26
        rows = [
            {"trace_id": f"t{i}", "max_step": 25} for i in range(20)
        ]
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=rows),
        ):
            r = await DecisionPathDepthMetric().compute("org_t")
        assert r["data"]["p95"] == 26.0
        assert r["data"]["loop_alert"] is True

    async def test_handles_null_max_step(self) -> None:
        from eden.apm_depth import DecisionPathDepthMetric

        rows = [
            {"trace_id": "t1", "max_step": None},
            {"trace_id": "t2", "max_step": 5},
        ]
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=rows),
        ):
            r = await DecisionPathDepthMetric().compute("org_t")
        # Only the second row contributes
        assert r["data"]["sample_size"] == 1
        assert r["data"]["max"] == 6


class TestToolCallSuccessRateMetric:
    async def test_no_data(self) -> None:
        from eden.apm_depth import ToolCallSuccessRateMetric

        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=[]),
        ):
            r = await ToolCallSuccessRateMetric().compute("org_t")
        assert r["data"]["per_tool"] == {}
        assert r["data"]["alert"] is False

    async def test_healthy_tool(self) -> None:
        from eden.apm_depth import ToolCallSuccessRateMetric

        rows = [
            {"tool_name": "search", "total": 100, "failures": 5},
        ]
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=rows),
        ):
            r = await ToolCallSuccessRateMetric().compute("org_t")
        assert r["data"]["per_tool"]["search"]["success_rate"] == 0.95
        assert r["data"]["per_tool"]["search"]["alert"] is False
        assert r["data"]["alert"] is False

    async def test_failing_tool_alerts(self) -> None:
        from eden.apm_depth import ToolCallSuccessRateMetric

        rows = [
            {"tool_name": "flaky_tool", "total": 100, "failures": 30},
        ]
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=rows),
        ):
            r = await ToolCallSuccessRateMetric().compute("org_t")
        # 30/100 = 0.30 failures → 0.70 success rate
        assert r["data"]["per_tool"]["flaky_tool"]["success_rate"] == 0.7
        assert r["data"]["per_tool"]["flaky_tool"]["alert"] is True
        assert r["data"]["alert"] is True

    async def test_zero_total(self) -> None:
        from eden.apm_depth import ToolCallSuccessRateMetric

        rows = [{"tool_name": "unused", "total": 0, "failures": 0}]
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=rows),
        ):
            r = await ToolCallSuccessRateMetric().compute("org_t")
        # 0 total → rate is 1.0 (no failures), no alert
        assert r["data"]["per_tool"]["unused"]["success_rate"] == 1.0
        assert r["data"]["per_tool"]["unused"]["alert"] is False


class TestCostPerStepMetric:
    async def test_no_data(self) -> None:
        from eden.apm_depth import CostPerStepMetric

        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=[]),
        ):
            r = await CostPerStepMetric().compute("org_t")
        assert r["data"]["per_agent"] == {}
        assert r["data"]["alert"] is False

    async def test_within_baseline(self) -> None:
        from eden.apm_depth import CostPerStepMetric

        rows = [
            {"agent_id": "agent_a", "step_count": 10, "total_cost": 1.0},
        ]
        baseline = [{"agent_id": "agent_a", "avg_cost": 0.1}]  # baseline = $0.10/step
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(side_effect=[rows, baseline]),
        ):
            r = await CostPerStepMetric().compute("org_t")
        # avg = 1.0/10 = 0.1, ratio = 1.0 → no alert
        assert r["data"]["per_agent"]["agent_a"]["avg_cost_per_step_usd"] == 0.1
        assert r["data"]["per_agent"]["agent_a"]["ratio"] == 1.0
        assert r["data"]["per_agent"]["agent_a"]["alert"] is False

    async def test_3x_baseline_alerts(self) -> None:
        from eden.apm_depth import CostPerStepMetric

        rows = [
            {"agent_id": "agent_a", "step_count": 10, "total_cost": 4.0},
        ]
        baseline = [{"agent_id": "agent_a", "avg_cost": 0.1}]
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(side_effect=[rows, baseline]),
        ):
            r = await CostPerStepMetric().compute("org_t")
        # avg = 0.4, ratio = 4.0 → alert
        assert r["data"]["per_agent"]["agent_a"]["ratio"] == 4.0
        assert r["data"]["per_agent"]["agent_a"]["alert"] is True
        assert r["data"]["alert"] is True

    async def test_no_baseline(self) -> None:
        from eden.apm_depth import CostPerStepMetric

        rows = [
            {"agent_id": "agent_a", "step_count": 5, "total_cost": 0.5},
        ]
        baseline: list[dict[str, Any]] = []  # no baseline data
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(side_effect=[rows, baseline]),
        ):
            r = await CostPerStepMetric().compute("org_t")
        # No baseline → ratio=0, no alert
        assert r["data"]["per_agent"]["agent_a"]["ratio"] == 0
        assert r["data"]["per_agent"]["agent_a"]["alert"] is False


class TestAgentMetricsCollector:
    async def test_aggregate(self) -> None:
        from eden.apm_depth import AgentMetricsCollector

        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=[]),
        ):
            r = await AgentMetricsCollector().aggregate("org_t")
        d = r["data"]
        assert "decision_path_depth" in d
        assert "tool_call_success_rate" in d
        assert "cost_per_step" in d
        assert d["decision_path_depth"]["sample_size"] == 0
        assert d["tool_call_success_rate"]["per_tool"] == {}
        assert d["cost_per_step"]["per_agent"] == {}


# ─── Route tests ──────────────────────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def apm_depth_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_org_member, require_path_org_access
    from eden.api.routes import intelligence_apm_depth as mod
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-apm-depth-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = lambda: "org_test"
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    # Router gates on the shared ``require_path_org_access`` (overridden
    # above) — the module-local ``_require_path_org`` wrapper was removed
    # in the shared-gate consolidation.
    async def _flag_on() -> None:
        return None
    for r in mod.router.routes:
        if not hasattr(r, "dependant"):
            continue
        for d in r.dependant.dependencies:
            if getattr(d.call, "__name__", "") == "_dependency":
                app.dependency_overrides[d.call] = _flag_on
    app.include_router(mod.router)
    return app


class TestApmDepthRoutes:
    def test_enrich_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        r = client.post(
            "/orgs/org_test/intelligence/apm-depth/enrich",
            json={"attributes": {"gen_ai.client.token.usage": 100}},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["spec"] == "v141"
        assert "gen_ai.usage.input_tokens" in body["data"]["attributes"]

    def test_enrich_batch_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        r = client.post(
            "/orgs/org_test/intelligence/apm-depth/enrich-batch",
            json={"spans": [{"attributes": {"gen_ai.agent.name": "a"}}]},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["v141_count"] == 1

    def test_stamp_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        r = client.post(
            "/orgs/org_test/intelligence/apm-depth/steps/stamp",
            json={
                "attributes": {"name": "tool"},
                "step_index": 2,
                "step_judges": {"hallucination": 0.9},
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["step_index"] == 2

    def test_list_trace_steps_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            r = client.get(
                "/orgs/org_test/intelligence/apm-depth/steps/trace-1"
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["steps"] == []

    def test_get_step_judges_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        with patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ):
            r = client.get(
                "/orgs/org_test/intelligence/apm-depth/steps/trace-1/3"
            )
        assert r.status_code == 200
        body = r.json()
        assert body["data"]["judges"] == {}

    def test_agent_metrics_route(self, apm_depth_app: FastAPI) -> None:
        client = TestClient(apm_depth_app)
        with patch(
            "eden.apm_depth.metrics._fetch_rows",
            AsyncMock(return_value=[]),
        ):
            r = client.get(
                "/orgs/org_test/intelligence/apm-depth/metrics/agents"
            )
        assert r.status_code == 200
        body = r.json()
        assert "decision_path_depth" in body["data"]
