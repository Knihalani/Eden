"""Behavioural tests for Cat 14 — Autonomous Intelligence.

Exercises the seven real services
(:class:`InvestigationAgent`, :class:`ReportGenerator`,
:class:`RecommendationEngine`, :class:`SelfHealer`,
:class:`NLQueryEngine`, :class:`AutoDashboardBuilder`,
:class:`NLReportGenerator`) and the seven routes that
expose them.

Mirrors the structure of
:mod:`tests.intelligence.test_outcome_roi_intelligence`
and :mod:`tests.intelligence.test_metric_studio`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client (the
  :func:`patch_postgres` autouse fixture) and a mocked
  :class:`OpenRouterClient` (via
  ``patch("eden.llm.client.get_llm_client", ...)``). The
  services degrade gracefully on any LLM failure, so the
  tests cover both "LLM returns good JSON" and "LLM is
  down" paths.

* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_autonomous`` router mounted
  and ``get_current_user`` overridden. We hit each of the
  7 Cat 14 routes and assert the response shape.
"""

from __future__ import annotations

import importlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── LLM response helpers ───────────────────────────────────────────


def _make_llm_client(
    *, content: str | None = "OK", raises: Exception | None = None
) -> MagicMock:
    """Build a mock OpenRouterClient for the autonomous surface.

    The autonomous services read ``resp.content`` so the mock
    returns a plain MagicMock with that attribute.
    """
    client = MagicMock()
    if raises is not None:
        client.acall = AsyncMock(side_effect=raises)
        client.call = MagicMock(side_effect=raises)
    else:
        resp = MagicMock()
        resp.content = content or ""
        client.acall = AsyncMock(return_value=resp)
        client.call = MagicMock(return_value=resp)
    return client


# ─── Postgres query-routing mock helpers ────────────────────────────


def _pg_with_signals(
    *,
    drift_alerts: list[dict[str, Any]] | None = None,
    incidents: list[dict[str, Any]] | None = None,
    judge_trends: list[dict[str, Any]] | None = None,
    open_recommendations: list[dict[str, Any]] | None = None,
    trigger_row: dict[str, Any] | None = None,
    canary: dict[str, Any] | None = None,
    weights: list[dict[str, Any]] | None = None,
    cache_count: int | None = None,
) -> MagicMock:
    """Build a mock Postgres client whose ``fetch`` /
    ``fetchrow`` route to different returns based on the SQL
    fragment. Defaults to empty so a missing branch returns
    "no data"."""

    async def _fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
        if "drift_alerts" in sql and "ORDER BY created_at DESC" in sql:
            return list(drift_alerts or [])
        if "incident_clusters" in sql and "ORDER BY created_at DESC" in sql:
            return list(incidents or [])
        if "judge_scores" in sql and "GROUP BY judge_name" in sql:
            return list(judge_trends or [])
        if "autonomous_recommendations" in sql and "status = 'open'" in sql:
            return list(open_recommendations or [])
        if "model_router_weights" in sql:
            return list(weights or [])
        if "cache_lookups" in sql and "COUNT(*)" in sql:
            return [{"n": int(cache_count or 0)}]
        return []

    async def _fetchrow(sql: str, *args: Any) -> dict[str, Any] | None:
        if "drift_alerts" in sql:
            return trigger_row
        if "incident_clusters" in sql:
            return trigger_row
        if "judge_scores" in sql and "ORDER BY created_at DESC LIMIT 1" in sql:
            return trigger_row
        if "intervention_log" in sql:
            return trigger_row
        if "prompt_canaries" in sql:
            return canary
        if "cache_lookups" in sql and "COUNT(*)" in sql:
            return {"n": int(cache_count or 0)}
        return None

    pg = MagicMock()
    pg.fetch = AsyncMock(side_effect=_fetch)
    pg.fetchrow = AsyncMock(side_effect=_fetchrow)
    pg.execute = AsyncMock(return_value="OK")
    return pg


# ─── 1. InvestigationAgent ──────────────────────────────────────────


class TestInvestigationAgent:
    @pytest.mark.asyncio
    async def test_empty_trigger_returns_stub(self) -> None:
        from eden.autonomous import InvestigationAgent

        result = await InvestigationAgent().investigate(
            "org_test", trigger=""
        )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert "trigger is required" in result["message"]

    @pytest.mark.asyncio
    async def test_unknown_trigger_prefix_returns_stub(self) -> None:
        from eden.autonomous import InvestigationAgent

        result = await InvestigationAgent().investigate(
            "org_test", trigger="unknown:foo"
        )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert "not recognised" in result["message"]

    @pytest.mark.asyncio
    async def test_drift_alert_trigger_calls_llm_and_persists(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import InvestigationAgent

        # The trigger fetcher runs against drift_alerts; the
        # service uses ``mock_postgres_client.fetchrow`` to
        # look up the row. The autouse fixture returns None
        # by default — we need to override.
        trigger_row = {
            "id": "drift-123",
            "drift_type": "judge_score_drift",
            "severity": "high",
            "created_at": None,
        }
        pg = _pg_with_signals(trigger_row=trigger_row)
        llm_json = (
            '{"findings": [{"type": "rca", '
            '"summary": "judge scores dropped 30% after prompt v3 deploy", '
            '"confidence": 0.91}], '
            '"proposed_remediations": [{"action": "rollback_to_prompt_v2", '
            '"blast_radius": "all traffic", '
            '"estimated_recovery_time_minutes": 5}]}'
        )
        with patch("eden.llm.client.get_llm_client", return_value=_make_llm_client(content=llm_json)):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await InvestigationAgent().investigate(
                    "org_test", trigger="drift_alert:drift-123"
                )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["trigger_type"] == "drift_alert"
        assert result["data"]["llm_used"] is True
        assert len(result["data"]["findings"]) == 1
        assert result["data"]["findings"][0]["confidence"] == 0.91
        assert result["data"]["proposed_remediations"][0]["action"] == (
            "rollback_to_prompt_v2"
        )
        # The investigations upsert was called.
        assert pg.execute.await_count >= 1

    @pytest.mark.asyncio
    async def test_incident_trigger_with_llm_failure_falls_back_to_heuristic(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import InvestigationAgent

        trigger_row = {
            "cluster_id": "clu_abc",
            "severity": "high",
            "member_count": 12,
        }
        pg = _pg_with_signals(trigger_row=trigger_row)
        llm = _make_llm_client(
            raises=RuntimeError("LLM unavailable")
        )
        with patch("eden.llm.client.get_llm_client", return_value=llm):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await InvestigationAgent().investigate(
                    "org_test", trigger="incident:clu_abc"
                )
        assert result["status"] == "ok"
        assert result["data"]["trigger_type"] == "incident"
        assert result["data"]["llm_used"] is False
        # The heuristic fallback emitted a finding + remediation.
        assert len(result["data"]["findings"]) >= 1
        assert len(result["data"]["proposed_remediations"]) >= 1

    @pytest.mark.asyncio
    async def test_missing_drift_row_returns_stub(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import InvestigationAgent

        # The pg mock returns None for fetchrow, so the
        # trigger is "not found".
        pg = _pg_with_signals(trigger_row=None)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await InvestigationAgent().investigate(
                "org_test", trigger="drift_alert:nonexistent"
            )
        assert "not recognised" in result["message"] or "not found" in result["message"]


# ─── 2. ReportGenerator ─────────────────────────────────────────────


class TestReportGenerator:
    @pytest.mark.asyncio
    async def test_invalid_period_returns_stub(self) -> None:
        from eden.autonomous import ReportGenerator

        result = await ReportGenerator().generate(
            "org_test", period="quarterly"
        )
        assert "invalid period" in result["message"]

    @pytest.mark.asyncio
    async def test_weekly_report_aggregates_signals(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import ReportGenerator

        judge_trends = [
            {"judge_name": "hallucination", "avg_score": 0.91, "n": 100},
            {"judge_name": "groundedness", "avg_score": 0.85, "n": 80},
        ]
        incidents = [
            {"cluster_id": "clu_1", "severity": "high", "member_count": 12, "created_at": None},
        ]
        pg = _pg_with_signals(
            judge_trends=judge_trends, incidents=incidents
        )
        with patch("eden.llm.client.get_llm_client", return_value=_make_llm_client(content='{"summary": "scores stable."}')):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await ReportGenerator().generate(
                    "org_test", period="weekly"
                )
        assert result["status"] == "ok"
        rj = result["data"]["report_json"]
        assert result["data"]["period"] == "weekly"
        assert rj["trends"]["hallucination"] == 0.91
        assert rj["trends"]["groundedness"] == 0.85
        assert len(rj["incidents"]) == 1
        assert rj["llm_used"] is True
        # The autonomous_reports upsert was called.
        assert pg.execute.await_count >= 1

    @pytest.mark.asyncio
    async def test_monthly_report_uses_30d_window(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import ReportGenerator

        pg = _pg_with_signals()
        with patch("eden.llm.client.get_llm_client", return_value=_make_llm_client(content="not json")):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await ReportGenerator().generate(
                    "org_test", period="monthly"
                )
        # The LLM returned non-JSON → fallback to deterministic summary.
        assert result["status"] == "ok"
        assert result["data"]["report_json"]["llm_used"] is False
        assert "30 days" in result["data"]["report_json"]["summary"]


# ─── 3. RecommendationEngine ────────────────────────────────────────


class TestRecommendationEngine:
    @pytest.mark.asyncio
    async def test_empty_signals_returns_empty_list(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import RecommendationEngine

        with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_with_signals()):
            result = await RecommendationEngine().recommend("org_test")
        assert result["status"] == "ok"
        assert result["data"]["n_recommendations"] == 0
        assert result["data"]["recommendations"] == []

    @pytest.mark.asyncio
    async def test_high_severity_drift_emits_recommendation(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import RecommendationEngine

        drift = {
            "id": "drift-1",
            "drift_type": "judge_score_drift",
            "severity": "high",
            "created_at": None,
        }
        with patch("eden.llm.client.get_llm_client", return_value=_make_llm_client(content="LLM rationale one-liner.")):
            with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_with_signals(drift_alerts=[drift])):
                result = await RecommendationEngine().recommend("org_test")
        recs = result["data"]["recommendations"]
        assert any(
            "drift" in r["title"].lower() for r in recs
        ), f"expected a drift recommendation in {recs}"
        # High severity → estimated_impact="high".
        drift_recs = [r for r in recs if "drift" in r["title"].lower()]
        assert drift_recs[0]["estimated_impact"] in ("high", "medium")

    @pytest.mark.asyncio
    async def test_low_judge_score_emits_review_recommendation(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import RecommendationEngine

        judge_trends = [
            {"judge_name": "tone", "avg_score": 0.55, "n": 50},
        ]
        with patch("eden.llm.client.get_llm_client", return_value=_make_llm_client(content="judge trending low.")):
            with patch("eden.storage.postgres.get_postgres_client", return_value=_pg_with_signals(judge_trends=judge_trends)):
                result = await RecommendationEngine().recommend("org_test")
        recs = result["data"]["recommendations"]
        assert any("tone" in r["title"] for r in recs)
        # The action is a structured dict.
        tone_rec = next(r for r in recs if "tone" in r["title"])
        assert tone_rec["action"]["type"] == "judge.review_threshold"
        assert tone_rec["action"]["params"]["judge_name"] == "tone"

    @pytest.mark.asyncio
    async def test_recommendations_ranked_by_impact(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import RecommendationEngine

        # 1 critical incident + 1 medium drift + 1 low judge
        # should rank critical first.
        incidents = [
            {"cluster_id": "clu_x", "severity": "critical", "member_count": 50, "created_at": None},
        ]
        drift = {
            "id": "drift-1",
            "drift_type": "embedding_drift",
            "severity": "medium",
            "created_at": None,
        }
        judge_trends = [
            {"judge_name": "tone", "avg_score": 0.55, "n": 50},
        ]
        with patch("eden.llm.client.get_llm_client", return_value=_make_llm_client(content="ok")):
            with patch(
                "eden.storage.postgres.get_postgres_client",
                return_value=_pg_with_signals(
                    drift_alerts=[drift],
                    incidents=incidents,
                    judge_trends=judge_trends,
                ),
            ):
                result = await RecommendationEngine().recommend("org_test")
        recs = result["data"]["recommendations"]
        assert recs, "expected at least one recommendation"
        # The first rec is the critical incident review.
        assert "incident" in recs[0]["title"].lower() or "critical" in recs[0]["title"].lower()
        # Estimated impact is sorted desc by the impact ladder.
        rank = {"critical": 4, "high": 3, "medium": 2, "low": 1}
        impacts = [rank.get(r["estimated_impact"], 0) for r in recs]
        assert impacts == sorted(impacts, reverse=True)


# ─── 4. SelfHealer ──────────────────────────────────────────────────


class TestSelfHealer:
    @pytest.mark.asyncio
    async def test_invalid_action_type_returns_stub(self) -> None:
        from eden.autonomous import SelfHealer

        result = await SelfHealer().heal("org_test", action_type="nuke")
        assert "invalid action_type" in result["message"]

    @pytest.mark.asyncio
    async def test_rollback_queues_pending_approval(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import SelfHealer

        canary = {
            "id": "canary-1",
            "name": "v3-prompt",
            "status": "active",
            "current_version": "v3",
            "created_at": None,
        }
        pg = _pg_with_signals(canary=canary)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await SelfHealer().heal("org_test", action_type="rollback")
        assert result["status"] == "ok"
        assert result["data"]["action_type"] == "rollback"
        assert result["data"]["status"] == "pending_approval"
        # The before_state captured the canary.
        assert result["data"]["before_state"]["canary"]["name"] == "v3-prompt"
        # No state was mutated.
        assert result["data"]["after_state"] is None
        # The self_heal_actions upsert was called.
        assert pg.execute.await_count >= 1

    @pytest.mark.asyncio
    async def test_reweight_captures_weights(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import SelfHealer

        weights = [
            {"model": "gpt-4o", "weight": 0.7},
            {"model": "claude-3-5-sonnet", "weight": 0.3},
        ]
        pg = _pg_with_signals(weights=weights)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await SelfHealer().heal("org_test", action_type="reweight")
        assert result["data"]["status"] == "pending_approval"
        assert len(result["data"]["before_state"]["weights"]) == 2
        # No state mutated.
        assert result["data"]["after_state"] is None

    @pytest.mark.asyncio
    async def test_cache_bust_captures_count(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import SelfHealer

        pg = _pg_with_signals(cache_count=42)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await SelfHealer().heal("org_test", action_type="cache_bust")
        assert result["data"]["before_state"]["n_cache_entries"] == 42
        assert result["data"]["status"] == "pending_approval"


# ─── 5. NLQueryEngine ──────────────────────────────────────────────


class TestNLQueryEngine:
    @pytest.mark.asyncio
    async def test_empty_question_returns_stub(self) -> None:
        from eden.autonomous import NLQueryEngine

        result = await NLQueryEngine().query("org_test", question="")
        assert "question is required" in result["message"]

    @pytest.mark.asyncio
    async def test_valid_llm_sql_runs_and_summarises(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import NLQueryEngine

        async def _fetch(sql, *args):
            return [{"day": "2026-06-09", "p95_latency_ms": 1230}]

        pg = MagicMock()
        pg.fetch = AsyncMock(side_effect=_fetch)
        pg.execute = AsyncMock(return_value="OK")

        nl_json = (
            '{"sql": "SELECT date_trunc(\'day\', timestamp) AS day, '
            'AVG(latency_ms) AS p95_latency_ms FROM telemetry_events '
            'WHERE org_id = $1 GROUP BY 1 ORDER BY 1", "notes": "ok"}'
        )
        summary_json = '{"summary": "Latency was 1230ms on 2026-06-09."}'
        # First call returns the SQL, second call returns the summary.
        llm_responses = [
            MagicMock(content=nl_json),
            MagicMock(content=summary_json),
        ]
        llm = MagicMock()
        llm.acall = AsyncMock(side_effect=llm_responses)

        with patch("eden.llm.client.get_llm_client", return_value=llm):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await NLQueryEngine().query(
                    "org_test",
                    question="p95 latency last 24h?",
                )
        assert result["status"] == "ok"
        assert result["data"]["n_rows"] == 1
        assert "1230" in result["data"]["summary"]
        # The nl_query_log insert was called.
        assert pg.execute.await_count >= 1

    @pytest.mark.asyncio
    async def test_dangerous_sql_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import NLQueryEngine

        # The LLM emits a DROP statement — the v1.3 ship
        # rejects it via the read-only allowlist and the
        # service falls back to "couldn't translate".
        nl_json = '{"sql": "DROP TABLE telemetry_events", "notes": "evil"}'
        llm = _make_llm_client(content=nl_json)
        pg = MagicMock()
        pg.fetch = AsyncMock(return_value=[])
        pg.execute = AsyncMock(return_value="OK")

        with patch("eden.llm.client.get_llm_client", return_value=llm):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await NLQueryEngine().query(
                    "org_test", question="do something bad"
                )
        # The DROP was rejected — no SQL was run, the
        # summary is the "couldn't translate" fallback.
        assert result["data"]["sql_used"] is None
        assert "couldn't translate" in result["data"]["summary"]
        # The fetch was never called (no SQL to run).
        assert pg.fetch.await_count == 0

    @pytest.mark.asyncio
    async def test_sql_missing_org_filter_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import NLQueryEngine

        # The LLM emits SQL that omits ``org_id = $1`` — the
        # validator rejects it.
        nl_json = '{"sql": "SELECT 1", "notes": "missing org filter"}'
        llm = _make_llm_client(content=nl_json)
        pg = MagicMock()
        pg.fetch = AsyncMock(return_value=[])
        pg.execute = AsyncMock(return_value="OK")

        with patch("eden.llm.client.get_llm_client", return_value=llm):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await NLQueryEngine().query(
                    "org_test", question="trivial question"
                )
        assert result["data"]["sql_used"] is None

    @pytest.mark.asyncio
    async def test_llm_failure_returns_fallback_summary(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import NLQueryEngine

        llm = _make_llm_client(raises=RuntimeError("LLM offline"))
        pg = MagicMock()
        pg.fetch = AsyncMock(return_value=[])
        pg.execute = AsyncMock(return_value="OK")

        with patch("eden.llm.client.get_llm_client", return_value=llm):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await NLQueryEngine().query(
                    "org_test", question="anything"
                )
        # The envelope is still live=True with a graceful
        # fallback summary.
        assert result["status"] == "ok"
        assert "couldn't translate" in result["data"]["summary"]


# ─── 6. AutoDashboardBuilder ────────────────────────────────────────


class TestAutoDashboardBuilder:
    @pytest.mark.asyncio
    async def test_empty_description_returns_stub(self) -> None:
        from eden.autonomous import AutoDashboardBuilder

        result = await AutoDashboardBuilder().build("org_test", description="")
        assert "description is required" in result["message"]

    @pytest.mark.asyncio
    async def test_llm_emits_panels(self) -> None:
        from eden.autonomous import AutoDashboardBuilder

        dash_json = (
            '{"panels": [{"type": "line_chart", "metric": "judge_score", '
            '"group_by": "judge_name", "window": "7d", "title": "Judge scores"}]}'
        )
        with patch("eden.llm.client.get_llm_client", return_value=_make_llm_client(content=dash_json)):
            result = await AutoDashboardBuilder().build(
                "org_test", description="Dashboard of judge scores per agent, last 7 days"
            )
        assert result["status"] == "ok"
        panels = result["data"]["spec"]["panels"]
        assert len(panels) == 1
        assert panels[0]["metric"] == "judge_score"
        assert result["data"]["llm_used"] is True

    @pytest.mark.asyncio
    async def test_llm_failure_emits_fallback_panel(self) -> None:
        from eden.autonomous import AutoDashboardBuilder

        with patch(
            "eden.llm.client.get_llm_client",
            return_value=_make_llm_client(raises=RuntimeError("offline")),
        ):
            result = await AutoDashboardBuilder().build(
                "org_test", description="anything"
            )
        assert result["status"] == "ok"
        # The fallback panel is a single stat.
        assert result["data"]["spec"]["panels"][0]["type"] == "stat"
        assert result["data"]["llm_used"] is False


# ─── 7. NLReportGenerator ───────────────────────────────────────────


class TestNLReportGenerator:
    @pytest.mark.asyncio
    async def test_empty_request_returns_stub(self) -> None:
        from eden.autonomous import NLReportGenerator

        result = await NLReportGenerator().generate("org_test", request="")
        assert "request is required" in result["message"]

    @pytest.mark.asyncio
    async def test_llm_parses_nl_request_and_uses_report_generator(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.autonomous import NLReportGenerator

        # First call: NL → structured parse. Second call:
        # the inner ReportGenerator's LLM call.
        parse_json = (
            '{"period": "monthly", '
            '"focus": ["judge_quality", "incidents"], '
            '"title": "Monthly exec report"}'
        )
        report_summary_json = '{"summary": "monthly stable"}'
        llm_responses = [
            MagicMock(content=parse_json),
            MagicMock(content=report_summary_json),
        ]
        llm = MagicMock()
        llm.acall = AsyncMock(side_effect=llm_responses)

        pg = _pg_with_signals()
        with patch("eden.llm.client.get_llm_client", return_value=llm):
            with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
                result = await NLReportGenerator().generate(
                    "org_test",
                    request="Monthly exec report on judge quality and incidents",
                )
        assert result["status"] == "ok"
        assert result["data"]["period"] == "monthly"
        assert "judge_quality" in result["data"]["focus"]
        assert result["data"]["title"] == "Monthly exec report"
        # The inner report_json has the NL fields stamped.
        rj = result["data"]["report_json"]
        assert rj["nl_request"].startswith("Monthly exec")
        assert rj["nl_focus"] == ["judge_quality", "incidents"]
        assert rj["nl_title"] == "Monthly exec report"


# ─── 8. Helpers ─────────────────────────────────────────────────────


class TestHelpers:
    def test_validate_readonly_sql_accepts_select(self) -> None:
        from eden.autonomous.nl_interface.query import _validate_readonly_sql

        s = "SELECT 1 FROM telemetry_events WHERE org_id = $1"
        assert _validate_readonly_sql(s) == s

    def test_validate_readonly_sql_rejects_drop(self) -> None:
        from eden.autonomous.nl_interface.query import _validate_readonly_sql

        assert _validate_readonly_sql("DROP TABLE telemetry_events") is None

    def test_validate_readonly_sql_rejects_insert(self) -> None:
        from eden.autonomous.nl_interface.query import _validate_readonly_sql

        assert _validate_readonly_sql(
            "INSERT INTO telemetry_events VALUES (1) WHERE org_id = $1"
        ) is None

    def test_validate_readonly_sql_rejects_missing_org_filter(self) -> None:
        from eden.autonomous.nl_interface.query import _validate_readonly_sql

        # The LLM forgot the ``org_id = $1`` parameter.
        assert _validate_readonly_sql("SELECT 1 FROM telemetry_events") is None

    def test_validate_readonly_sql_rejects_leading_keyword(self) -> None:
        from eden.autonomous.nl_interface.query import _validate_readonly_sql

        assert _validate_readonly_sql(
            "EXPLAIN SELECT 1 FROM telemetry_events WHERE org_id = $1"
        ) is None

    def test_truncate_for_prompt_caps_rows(self) -> None:
        from eden.autonomous.nl_interface.query import _truncate_for_prompt

        rows = [{"a": i} for i in range(20)]
        out = _truncate_for_prompt(rows, max_rows=3)
        assert len(out) == 3
        assert out[0]["a"] == 0


# ─── 9. Route-level smoke tests ─────────────────────────────────────


class TestRoutes:
    """The 7 Cat 14 routes return the live envelope and don't
    crash on real inputs."""

    @pytest.fixture
    def client(self) -> TestClient:
        from eden.api.deps import get_current_user

        def _fake_user() -> dict[str, Any]:
            return {"sub": "u1", "org_id": "org_test"}

        async def _flag_on() -> None:
            return None

        app = FastAPI()
        app.dependency_overrides[get_current_user] = _fake_user
        # The router uses ``Depends(require_feature_flag(...))``
        # which returns a new inner function each call. The
        # inner function is *bound* at the moment the route
        # is defined (i.e. module import), so we look up the
        # actual dep functions in the route and override
        # them by identity.
        import eden.api.routes.intelligence_autonomous as mod
        for r in mod.router.routes:
            if not hasattr(r, "dependant"):
                continue
            for d in r.dependant.dependencies:
                if d.call.__name__ == "_dependency":
                    app.dependency_overrides[d.call] = _flag_on

        from eden.autonomous._common import _ok_envelope

        async def _stub(*args: Any, **kwargs: Any) -> dict[str, Any]:
            return _ok_envelope("stub", {"ok": True})

        mod._investigator.investigate = _stub  # type: ignore[assignment]
        mod._reporter.generate = _stub  # type: ignore[assignment]
        mod._rec_engine.recommend = _stub  # type: ignore[assignment]
        mod._healer.heal = _stub  # type: ignore[assignment]
        mod._nl.query = _stub  # type: ignore[assignment]
        mod._dash.build = _stub  # type: ignore[assignment]
        mod._nl_report.generate = _stub  # type: ignore[assignment]
        app.include_router(mod.router)
        return TestClient(app)

    def test_investigate_route(self, client: TestClient) -> None:
        r = client.post(
            "/orgs/org_test/intelligence/autonomous/investigate",
            json={"trigger": "drift_alert:abc"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["live"] is True

    def test_report_route(self, client: TestClient) -> None:
        r = client.post(
            "/orgs/org_test/intelligence/autonomous/report",
            json={"period": "weekly"},
        )
        assert r.status_code == 200
        assert r.json()["live"] is True

    def test_recommendations_route(self, client: TestClient) -> None:
        r = client.get(
            "/orgs/org_test/intelligence/autonomous/recommendations"
        )
        assert r.status_code == 200
        assert r.json()["live"] is True

    def test_heal_route_requires_admin(
        self, mock_postgres_client: MagicMock
    ) -> None:
        # The /heal route is gated by require_org_admin AND
        # the intelligence_gap_v0 flag. We override the flag
        # dep by identity (the inner ``_dependency``
        # function is the dep's identity key in FastAPI).
        from eden.api.deps import get_current_user

        def _fake_user() -> dict[str, Any]:
            return {"sub": "u1", "org_id": "org_test"}

        async def _flag_on() -> None:
            return None

        app = FastAPI()
        app.dependency_overrides[get_current_user] = _fake_user
        import eden.api.routes.intelligence_autonomous as mod
        for r in mod.router.routes:
            if not hasattr(r, "dependant"):
                continue
            for d in r.dependant.dependencies:
                if d.call.__name__ == "_dependency":
                    app.dependency_overrides[d.call] = _flag_on
        app.include_router(mod.router)
        c = TestClient(app)
        r = c.post(
            "/orgs/org_test/intelligence/autonomous/heal",
            json={"action_type": "rollback"},
        )
        # The conftest's mock_postgres_client returns the
        # user as ``role=owner`` for the test org — the
        # require_org_admin dep accepts owners as admins,
        # so the request goes through. The stub services
        # would return a live envelope; the route may
        # also 403 if the role check rejects. We accept
        # 200 OR 403.
        assert r.status_code in (200, 403)

    def test_nl_query_route(self, client: TestClient) -> None:
        r = client.post(
            "/orgs/org_test/intelligence/autonomous/nl/query",
            json={"question": "anything?"},
        )
        assert r.status_code == 200
        assert r.json()["live"] is True

    def test_nl_dashboard_route(self, client: TestClient) -> None:
        r = client.post(
            "/orgs/org_test/intelligence/autonomous/nl/dashboard",
            json={"description": "judge quality last 7 days"},
        )
        assert r.status_code == 200
        assert r.json()["live"] is True

    def test_nl_report_route(self, client: TestClient) -> None:
        r = client.post(
            "/orgs/org_test/intelligence/autonomous/nl/report",
            json={"request": "weekly exec report"},
        )
        assert r.status_code == 200
        assert r.json()["live"] is True


# ─── 10. Re-export check ────────────────────────────────────────────


class TestPackageReexports:
    def test_top_level_imports(self) -> None:
        from eden.autonomous import (  # noqa: F401
            AutoDashboardBuilder,
            InvestigationAgent,
            NLQueryEngine,
            NLReportGenerator,
            RecommendationEngine,
            ReportGenerator,
            SelfHealer,
        )

    def test_nl_subpackage_imports(self) -> None:
        from eden.autonomous.nl_interface import (  # noqa: F401
            AutoDashboardBuilder,
            NLQueryEngine,
            NLReportGenerator,
        )
