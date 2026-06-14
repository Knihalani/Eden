"""Behavioural tests for Cat 8 — Cost Intelligence.

Exercises the four real services
(:class:`CostEfficiencyScorer`, :class:`ROIAnalyzer`,
:class:`CostAnomalyDetector`, :class:`CostForecast`) and the
four routes that expose them, plus the closed-loop hook that
the :meth:`CostAnomalyDetector.detect` fires for high-severity
(|z| > 4) cost anomalies.

Mirrors the structure of
:mod:`tests.intelligence.test_decision_intelligence` and
:mod:`tests.intelligence.test_root_cause_incidents`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in :mod:`tests.conftest`
  returns an empty ``fetch()`` by default, which gives the
  services a clean "no data" path. Tests that need data
  override the mock with a side-effect that matches the SQL
  fragment the service runs.

* **Route-level smoke tests** — a minimal :class:`FastAPI` app
  with the ``intelligence_cost`` router mounted and
  ``get_current_user`` overridden. We hit each of the 4 Cat 8
  routes and assert the response shape.
"""

from __future__ import annotations

import importlib
from datetime import UTC, datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample row builders ─────────────────────────────────────────────


def _daily_cost_row(*, day: datetime, cost: float) -> dict[str, Any]:
    """One row from the daily cost series query."""
    return {"day": day, "cost": float(cost)}


def _cost_by_group_row(
    *, group_value: str, total_cost: float
) -> dict[str, Any]:
    """One row from the cost-by-group query."""
    return {"group_value": group_value, "total_cost": float(total_cost)}


def _outcome_count_row(
    *, outcome_type: str, outcome_count: int
) -> dict[str, Any]:
    """One row from the outcome-count-by-type query."""
    return {"outcome_type": outcome_type, "outcome_count": int(outcome_count)}


def _total_row(*, spend: float = 0.0) -> dict[str, Any]:
    """One row from the total-cost fetchrow query."""
    return {"spend": float(spend)}


def _value_row(*, value: float = 0.0) -> dict[str, Any]:
    """One row from the total-value fetchrow query."""
    return {"value": float(value)}


def _attribution_row(
    *, day: datetime, model: str = "gpt-4", agent_id: str = "agent-1", cost: float = 10.0
) -> dict[str, Any]:
    """One row from the attribution-by-day query."""
    return {
        "day": day,
        "model": model,
        "agent_id": agent_id,
        "cost": float(cost),
    }


# ─── Postgres query-routing mock helper ──────────────────────────────


def _pg_router(
    *,
    cost_by_group: list[dict[str, Any]] | None = None,
    outcome_counts: list[dict[str, Any]] | None = None,
    total_cost: float | None = None,
    total_value: float | None = None,
    daily_costs: list[dict[str, Any]] | None = None,
    attribution: list[dict[str, Any]] | None = None,
) -> MagicMock:
    """Build a MagicMock Postgres client whose ``fetch`` and
    ``fetchrow`` route to different returns based on the SQL
    fragment. Defaults to empty lists / None so a missing
    branch returns "no data"."""
    pg = MagicMock()
    pg.fetch = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetch(
            sql, cost_by_group, outcome_counts, daily_costs, attribution
        )
    )
    pg.fetchrow = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetchrow(sql, total_cost, total_value)
    )
    pg.execute = AsyncMock(return_value="OK")
    return pg


def _route_fetch(
    sql: str,
    cost_by_group,
    outcome_counts,
    daily_costs,
    attribution,
) -> list[dict[str, Any]]:
    # Cost-by-group query (uses metadata->>$3 + GROUP BY 1)
    if (
        "usage_events" in sql
        and "metadata->>$3" in sql
        and "GROUP BY 1" in sql
    ):
        return list(cost_by_group or [])
    # Outcome count query
    if "outcomes" in sql and "COUNT(*)" in sql and "GROUP BY 1" in sql:
        return list(outcome_counts or [])
    # Attribution query (uses anomaly_days CTE) — must be
    # checked BEFORE the daily-cost query because the
    # attribution SQL also contains ``date_trunc('day'`` and
    # ``GROUP BY 1``, which would otherwise match the daily-
    # cost pattern first.
    if "anomaly_days" in sql:
        return list(attribution or [])
    # Daily cost series query
    if (
        "usage_events" in sql
        and "date_trunc('day'" in sql
        and "GROUP BY 1" in sql
    ):
        return list(daily_costs or [])
    return []


def _route_fetchrow(
    sql: str, total_cost: float | None, total_value: float | None
) -> dict[str, Any] | None:
    if "usage_events" in sql and "SUM(cost_usd)" in sql and "GROUP BY" not in sql:
        return _total_row(spend=total_cost if total_cost is not None else 0.0)
    if "outcomes" in sql and "SUM(value)" in sql:
        return _value_row(value=total_value if total_value is not None else 0.0)
    return None


# ─── 1. CostEfficiencyScorer ─────────────────────────────────────────


class TestCostEfficiencyScorer:
    @pytest.mark.asyncio
    async def test_empty_window_returns_ok_with_message(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostEfficiencyScorer

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_efficiency",
            new=AsyncMock(),
        ) as persist:
            result = await CostEfficiencyScorer().score(
                "org_test", group_by="outcome_type", window="7d"
            )
        assert result["status"] == "ok"
        assert result["data"]["per_outcome"] == []
        assert result["data"]["message"] == "no usage data"
        persist.assert_not_called()

    @pytest.mark.asyncio
    async def test_groups_by_outcome_type_with_samples(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostEfficiencyScorer

        cost_by_group = [
            _cost_by_group_row(group_value="ticket_resolved", total_cost=420.0),
            _cost_by_group_row(group_value="report_generated", total_cost=120.0),
        ]
        outcome_counts = [
            _outcome_count_row(outcome_type="ticket_resolved", outcome_count=1000),
            _outcome_count_row(outcome_type="report_generated", outcome_count=100),
        ]
        pg = _pg_router(cost_by_group=cost_by_group, outcome_counts=outcome_counts)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_efficiency",
            new=AsyncMock(),
        ) as persist:
            result = await CostEfficiencyScorer().score(
                "org_test", group_by="outcome_type", window="7d"
            )
        assert result["status"] == "ok"
        per = result["data"]["per_outcome"]
        assert len(per) == 2
        ticket = next(p for p in per if p["outcome_type"] == "ticket_resolved")
        report = next(p for p in per if p["outcome_type"] == "report_generated")
        # 420 / 1000 = 0.42
        assert ticket["cost_per_outcome"] == pytest.approx(0.42)
        assert ticket["sample_size"] == 1000
        assert ticket["total_cost_usd"] == pytest.approx(420.0)
        # 120 / 100 = 1.20
        assert report["cost_per_outcome"] == pytest.approx(1.2)
        persist.assert_awaited_once()
        # Persist call args
        args = persist.await_args.args
        assert args[0] == "org_test"
        assert args[1] == "outcome_type"
        assert len(args[2]) == 2  # 2 rows persisted

    @pytest.mark.asyncio
    async def test_group_with_no_outcomes_returns_null(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostEfficiencyScorer

        # Costs exist for "ticket_resolved" but no outcomes
        cost_by_group = [
            _cost_by_group_row(group_value="ticket_resolved", total_cost=100.0),
        ]
        pg = _pg_router(cost_by_group=cost_by_group, outcome_counts=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_efficiency",
            new=AsyncMock(),
        ):
            result = await CostEfficiencyScorer().score(
                "org_test", group_by="outcome_type", window="7d"
            )
        assert result["status"] == "ok"
        per = result["data"]["per_outcome"]
        assert len(per) == 1
        assert per[0]["cost_per_outcome"] is None
        assert per[0]["sample_size"] == 0
        assert per[0]["warning"] == "no_outcomes_in_window"

    @pytest.mark.asyncio
    async def test_persists_one_row_per_group(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostEfficiencyScorer

        cost_by_group = [
            _cost_by_group_row(group_value="a", total_cost=10.0),
            _cost_by_group_row(group_value="b", total_cost=20.0),
        ]
        outcome_counts = [
            _outcome_count_row(outcome_type="a", outcome_count=5),
            _outcome_count_row(outcome_type="b", outcome_count=10),
        ]
        pg = _pg_router(cost_by_group=cost_by_group, outcome_counts=outcome_counts)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_efficiency",
            new=AsyncMock(),
        ) as persist:
            await CostEfficiencyScorer().score(
                "org_test", group_by="outcome_type", window="7d"
            )
        persist.assert_awaited_once()
        # Args: (org_id, group_by_key, rows)
        args = persist.await_args.args
        assert args[0] == "org_test"
        assert args[1] == "outcome_type"
        rows = args[2]
        assert len(rows) == 2
        # Row shape: {group_by_value, cost_per_outcome, sample_size}
        for r in rows:
            assert set(r.keys()) == {
                "group_by_value",
                "cost_per_outcome",
                "sample_size",
            }

    @pytest.mark.asyncio
    async def test_bad_group_by_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostEfficiencyScorer

        result = await CostEfficiencyScorer().score(
            "org_test", group_by="malicious_input", window="7d"
        )
        assert result["status"] == "bad_request"
        assert "group_by" in result["data"]["message"]
        assert result["live"] is True

    @pytest.mark.asyncio
    async def test_bad_window_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostEfficiencyScorer

        result = await CostEfficiencyScorer().score(
            "org_test", group_by="outcome_type", window="forever"
        )
        assert result["status"] == "bad_request"
        assert "window" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_non_outcome_group_by_returns_null_per_outcome(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """When group_by is ``model`` (or similar), outcomes aren't
        bucketed, so ``cost_per_outcome`` is null and the
        warning flags this."""
        from eden.services.cost_intel.efficiency import CostEfficiencyScorer

        cost_by_group = [
            _cost_by_group_row(group_value="gpt-4", total_cost=200.0),
            _cost_by_group_row(group_value="claude-opus-4", total_cost=300.0),
        ]
        pg = _pg_router(cost_by_group=cost_by_group, outcome_counts=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_efficiency",
            new=AsyncMock(),
        ):
            result = await CostEfficiencyScorer().score(
                "org_test", group_by="model", window="7d"
            )
        assert result["status"] == "ok"
        per = result["data"]["per_outcome"]
        assert len(per) == 2
        for p in per:
            assert p["cost_per_outcome"] is None
            assert p["sample_size"] == 0
            assert p["warning"] == "outcomes_not_bucketed_by_group"


# ─── 2. ROIAnalyzer ──────────────────────────────────────────────────


class TestROIAnalyzer:
    @pytest.mark.asyncio
    async def test_zero_spend_zero_value_returns_null_roi(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import ROIAnalyzer

        pg = _pg_router(total_cost=0.0, total_value=0.0)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_roi",
            new=AsyncMock(),
        ) as persist:
            result = await ROIAnalyzer().roi("org_test", window="30d")
        assert result["status"] == "ok"
        assert result["data"]["spend_usd"] == 0.0
        assert result["data"]["value_generated_usd"] == 0.0
        assert result["data"]["net_return_usd"] == 0.0
        assert result["data"]["roi"] is None
        persist.assert_awaited_once()
        # Persisted row has roi=None
        roi_arg = persist.await_args.args[4]
        assert roi_arg is None

    @pytest.mark.asyncio
    async def test_positive_roi_with_value(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import ROIAnalyzer

        pg = _pg_router(total_cost=100.0, total_value=500.0)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_roi",
            new=AsyncMock(),
        ) as persist:
            result = await ROIAnalyzer().roi("org_test", window="30d")
        assert result["status"] == "ok"
        assert result["data"]["spend_usd"] == pytest.approx(100.0)
        assert result["data"]["value_generated_usd"] == pytest.approx(500.0)
        assert result["data"]["net_return_usd"] == pytest.approx(400.0)
        # (500 - 100) / 100 = 4.0
        assert result["data"]["roi"] == pytest.approx(4.0)
        persist.assert_awaited_once()
        assert persist.await_args.args[3] == pytest.approx(500.0)
        assert persist.await_args.args[4] == pytest.approx(4.0)

    @pytest.mark.asyncio
    async def test_negative_roi_cleanly_handled(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import ROIAnalyzer

        # Spent more than the value generated → losing money
        pg = _pg_router(total_cost=100.0, total_value=50.0)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_roi",
            new=AsyncMock(),
        ):
            result = await ROIAnalyzer().roi("org_test", window="30d")
        assert result["status"] == "ok"
        # (50 - 100) / 100 = -0.5
        assert result["data"]["roi"] == pytest.approx(-0.5)
        assert result["data"]["net_return_usd"] == pytest.approx(-50.0)

    @pytest.mark.asyncio
    async def test_zero_spend_with_value_returns_null_roi(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """No spend but value generated — ROI is undefined
        (division by zero), return null with a non-zero net."""
        from eden.services.cost_intel.efficiency import ROIAnalyzer

        pg = _pg_router(total_cost=0.0, total_value=200.0)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_roi",
            new=AsyncMock(),
        ):
            result = await ROIAnalyzer().roi("org_test", window="30d")
        assert result["status"] == "ok"
        assert result["data"]["spend_usd"] == 0.0
        assert result["data"]["value_generated_usd"] == pytest.approx(200.0)
        assert result["data"]["net_return_usd"] == pytest.approx(200.0)
        assert result["data"]["roi"] is None

    @pytest.mark.asyncio
    async def test_persists_to_roi_analyses(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import ROIAnalyzer

        pg = _pg_router(total_cost=200.0, total_value=600.0)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_roi",
            new=AsyncMock(),
        ) as persist:
            await ROIAnalyzer().roi("org_test", window="7d")
        persist.assert_awaited_once()
        args = persist.await_args.args
        # (org_id, window, spend, value, roi)
        assert args[0] == "org_test"
        assert args[1] == "7d"
        assert args[2] == pytest.approx(200.0)
        assert args[3] == pytest.approx(600.0)
        assert args[4] == pytest.approx(2.0)

    @pytest.mark.asyncio
    async def test_empty_outcomes_table_returns_zero_value(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """When the ``outcomes`` table is empty, value defaults to
        0 and ROI is null (or negative if spend is also 0)."""
        from eden.services.cost_intel.efficiency import ROIAnalyzer

        # ``total_value`` not set → defaults to 0.0
        pg = _pg_router(total_cost=50.0)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._delete_then_insert_roi",
            new=AsyncMock(),
        ):
            result = await ROIAnalyzer().roi("org_test", window="30d")
        assert result["status"] == "ok"
        assert result["data"]["value_generated_usd"] == 0.0
        assert result["data"]["net_return_usd"] == pytest.approx(-50.0)
        # spend > 0 with value 0 → roi = (0 - 50) / 50 = -1.0
        assert result["data"]["roi"] == pytest.approx(-1.0)

    @pytest.mark.asyncio
    async def test_bad_window_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import ROIAnalyzer

        result = await ROIAnalyzer().roi("org_test", window="bad")
        assert result["status"] == "bad_request"
        assert "window" in result["data"]["message"]


# ─── 3. CostAnomalyDetector ─────────────────────────────────────────


def _make_daily_costs(n_days: int, base: float = 100.0) -> list[dict[str, Any]]:
    """Build ``n_days`` consecutive days of constant ``base`` cost.
    Start from a fixed date so the result is deterministic."""
    start = datetime(2026, 6, 1, tzinfo=UTC)
    return [
        _daily_cost_row(day=start + timedelta(days=i), cost=base)
        for i in range(n_days)
    ]


class TestCostAnomalyDetector:
    @pytest.mark.asyncio
    async def test_no_history_returns_empty_with_message(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        pg = _pg_router(daily_costs=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        assert result["status"] == "ok"
        assert result["data"]["anomalies"] == []
        assert result["data"]["message"] == "no usage data"
        assert result["data"]["days_observed"] == 0

    @pytest.mark.asyncio
    async def test_single_day_returns_empty_with_insufficient_message(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        pg = _pg_router(daily_costs=[_daily_cost_row(day=datetime(2026, 6, 1, tzinfo=UTC), cost=100.0)])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        assert result["status"] == "ok"
        assert result["data"]["anomalies"] == []
        assert "insufficient" in result["data"]["message"].lower()
        assert result["data"]["days_observed"] == 1

    @pytest.mark.asyncio
    async def test_cost_spike_detected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        # 14 normal days at 100 + 1 day at 500 → |z| ~ 3.6 (medium)
        # (1 outlier in only 7 days has |z| capped at ~2.27 by
        # the sample-stdev formula; need ≥ 14 baseline days
        # to cross the 2.5 threshold.)
        daily = _make_daily_costs(14, base=100.0)
        spike_day = datetime(2026, 6, 15, tzinfo=UTC)
        daily.append(_daily_cost_row(day=spike_day, cost=500.0))
        pg = _pg_router(daily_costs=daily, attribution=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        assert result["status"] == "ok"
        anomalies = result["data"]["anomalies"]
        assert len(anomalies) >= 1
        spike = next((a for a in anomalies if a["type"] == "cost_spike"), None)
        assert spike is not None
        assert spike["observed_usd"] == pytest.approx(500.0)
        assert spike["z_score"] > 0

    @pytest.mark.asyncio
    async def test_cost_drop_detected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        # 14 normal days at 100 + 1 day at 0 → drop
        daily = _make_daily_costs(14, base=100.0)
        drop_day = datetime(2026, 6, 15, tzinfo=UTC)
        daily.append(_daily_cost_row(day=drop_day, cost=0.0))
        pg = _pg_router(daily_costs=daily, attribution=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        assert result["status"] == "ok"
        anomalies = result["data"]["anomalies"]
        assert len(anomalies) >= 1
        drop = next((a for a in anomalies if a["type"] == "cost_drop"), None)
        assert drop is not None
        assert drop["z_score"] < 0

    @pytest.mark.asyncio
    async def test_severity_high_when_z_above_4(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        # 30 days at 100 + 1 day at 1000 → |z| ~ 5.4 → "high"
        daily = _make_daily_costs(30, base=100.0)
        spike_day = datetime(2026, 7, 1, tzinfo=UTC)
        daily.append(_daily_cost_row(day=spike_day, cost=1000.0))
        pg = _pg_router(daily_costs=daily, attribution=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._fire_cost_anomaly_alert"
        ) as fire:
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        anomalies = result["data"]["anomalies"]
        assert any(a["severity"] == "high" for a in anomalies)
        fire.assert_called_once()
        # ``_fire_cost_anomaly_alert`` is a sync function, so
        # use ``call_args`` (not ``await_args``). The service
        # calls the helper with ``(org_id, anomalies)`` and
        # the helper itself filters to high-only before
        # touching the hook (see TestFireCostAnomalyAlert).
        args = fire.call_args.args
        assert args[0] == "org_test"
        fired_anomalies = args[1]
        assert all(a["severity"] == "high" for a in fired_anomalies)

    @pytest.mark.asyncio
    async def test_attribution_includes_top_model_and_agent(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        spike_day = datetime(2026, 6, 15, tzinfo=UTC)
        daily = _make_daily_costs(14, base=100.0)
        daily.append(_daily_cost_row(day=spike_day, cost=500.0))
        attribution = [
            _attribution_row(
                day=spike_day, model="gpt-4", agent_id="agent-planner", cost=400.0
            ),
        ]
        pg = _pg_router(daily_costs=daily, attribution=attribution)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        anomalies = result["data"]["anomalies"]
        assert len(anomalies) >= 1
        cause = anomalies[0]["likely_cause"]
        assert cause is not None
        assert "model=gpt-4" in cause
        assert "agent=agent-planner" in cause

    @pytest.mark.asyncio
    async def test_high_severity_fires_drift_alert_hook(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        daily = _make_daily_costs(30, base=100.0)
        spike_day = datetime(2026, 7, 1, tzinfo=UTC)
        daily.append(_daily_cost_row(day=spike_day, cost=1000.0))
        pg = _pg_router(daily_costs=daily, attribution=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.llmops.promotion_hooks.get_promotion_hook"
        ) as get_hook:
            hook = MagicMock()
            get_hook.return_value = hook
            await CostAnomalyDetector().detect("org_test", window="7d")
        # Hook getter called at least once (could be once per high anomaly)
        assert get_hook.call_count >= 1
        # Hook fired at least once with cost_anomaly drift type
        assert hook.on_drift_alert.call_count >= 1
        for call in hook.on_drift_alert.call_args_list:
            assert call.kwargs["drift_type"] == "cost_anomaly"
            assert call.kwargs["severity"] == "high"

    @pytest.mark.asyncio
    async def test_medium_severity_helper_filter_does_not_fire(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """The :func:`_fire_cost_anomaly_alert` helper is called
        with the full anomaly list (medium + high). The helper
        itself filters to high-only before calling the hook.
        This test confirms the *service* passes the full list
        to the helper — the helper's internal filtering is
        tested in :class:`TestFireCostAnomalyAlert` below."""
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        # Medium spike: 14 days at 100 + 1 day at 500 → |z| ~ 3.6
        daily = _make_daily_costs(14, base=100.0)
        spike_day = datetime(2026, 6, 15, tzinfo=UTC)
        daily.append(_daily_cost_row(day=spike_day, cost=500.0))
        pg = _pg_router(daily_costs=daily, attribution=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.services.cost_intel.efficiency._fire_cost_anomaly_alert"
        ) as fire:
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        anomalies = result["data"]["anomalies"]
        # Should have at least 1 medium anomaly
        assert len(anomalies) >= 1
        # All are medium (the 1-day spike can't hit |z| > 4 with 15 days of data)
        assert all(a["severity"] == "medium" for a in anomalies)
        # Helper called with the full list (including medium ones)
        fire.assert_called_once()
        fired = fire.call_args.args[1]
        assert fired == anomalies
        assert all(a["severity"] == "medium" for a in fired)

    @pytest.mark.asyncio
    async def test_zero_variance_returns_no_anomalies(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostAnomalyDetector

        # Every day is 100.0 → stdev = 0 → no anomalies
        daily = _make_daily_costs(7, base=100.0)
        pg = _pg_router(daily_costs=daily)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostAnomalyDetector().detect("org_test", window="7d")
        assert result["status"] == "ok"
        assert result["data"]["anomalies"] == []
        assert "no variance" in result["data"]["message"].lower()


class TestFireCostAnomalyAlert:
    """Direct tests of the :func:`_fire_cost_anomaly_alert`
    helper. Mirrors the Cat 2 ``TestClusterHooks`` class.

    The helper does a defensive ``from eden.llmops.promotion_hooks
    import get_promotion_hook`` *inside* the function, so we
    patch the source module path
    (``eden.llmops.promotion_hooks.get_promotion_hook``) — not
    the local import inside the helper."""

    def test_no_high_anomalies_does_not_call_hook(self) -> None:
        from eden.services.cost_intel._common import _fire_cost_anomaly_alert

        anomalies = [{"severity": "medium", "type": "cost_spike"}]
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook"
        ) as get_hook:
            _fire_cost_anomaly_alert("org_test", anomalies)
        get_hook.assert_not_called()

    def test_high_severity_calls_hook_with_drift_type(self) -> None:
        from eden.services.cost_intel._common import _fire_cost_anomaly_alert

        anomalies = [
            {"severity": "high", "type": "cost_spike"},
            {"severity": "medium", "type": "cost_drop"},
        ]
        hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=hook,
        ):
            _fire_cost_anomaly_alert("org_test", anomalies)
        # Only the high-severity one fires
        assert hook.on_drift_alert.call_count == 1
        kwargs = hook.on_drift_alert.call_args.kwargs
        assert kwargs["drift_type"] == "cost_anomaly"
        assert kwargs["severity"] == "high"

    def test_hook_exception_does_not_propagate(self) -> None:
        from eden.services.cost_intel._common import _fire_cost_anomaly_alert

        anomalies = [{"severity": "high", "type": "cost_spike"}]
        hook = MagicMock()
        hook.on_drift_alert.side_effect = RuntimeError("boom")
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=hook,
        ):
            # Should not raise
            _fire_cost_anomaly_alert("org_test", anomalies)


# ─── 4. CostForecast ─────────────────────────────────────────────────


class TestCostForecast:
    @pytest.mark.asyncio
    async def test_no_history_returns_empty_with_message(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostForecast

        pg = _pg_router(daily_costs=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostForecast().forecast("org_test", horizon_days=7)
        assert result["status"] == "ok"
        assert result["data"]["forecast"] == []
        assert result["data"]["message"] == "no usage data"
        assert result["data"]["days_observed"] == 0

    @pytest.mark.asyncio
    async def test_insufficient_history_uses_mean_with_warning(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostForecast

        # 5 days of constant 100 — below the 14-day threshold
        daily = _make_daily_costs(5, base=100.0)
        pg = _pg_router(daily_costs=daily)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostForecast().forecast("org_test", horizon_days=7)
        assert result["status"] == "ok"
        assert result["data"]["warning"] == "insufficient_history"
        assert result["data"]["model"] == "mean_fallback"
        f = result["data"]["forecast"]
        assert len(f) == 7
        for row in f:
            assert row["predicted_cost_usd"] == pytest.approx(100.0)
            assert row["lower"] == pytest.approx(80.0)
            assert row["upper"] == pytest.approx(120.0)

    @pytest.mark.asyncio
    async def test_linear_regression_15_days_constant(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostForecast

        # 15 days of constant 100 → slope 0, intercept 100
        daily = _make_daily_costs(15, base=100.0)
        pg = _pg_router(daily_costs=daily)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostForecast().forecast("org_test", horizon_days=7)
        assert result["status"] == "ok"
        assert result["data"]["warning"] is None
        assert result["data"]["model"] == "linear_regression_v1"
        # Slope is essentially zero (constant series)
        assert abs(result["data"]["slope"]) < 1e-6
        assert result["data"]["intercept"] == pytest.approx(100.0, abs=1e-6)
        f = result["data"]["forecast"]
        assert len(f) == 7
        for row in f:
            assert row["predicted_cost_usd"] == pytest.approx(100.0, abs=0.1)
            assert row["lower"] == pytest.approx(row["predicted_cost_usd"] * 0.8)
            assert row["upper"] == pytest.approx(row["predicted_cost_usd"] * 1.2)

    @pytest.mark.asyncio
    async def test_linear_regression_captures_upward_trend(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostForecast

        # 30 days of linearly-increasing cost (100, 110, 120, ...)
        daily = [
            _daily_cost_row(
                day=datetime(2026, 5, 1, tzinfo=UTC) + timedelta(days=i),
                cost=100.0 + 10.0 * i,
            )
            for i in range(30)
        ]
        pg = _pg_router(daily_costs=daily)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostForecast().forecast("org_test", horizon_days=7)
        assert result["status"] == "ok"
        assert result["data"]["slope"] > 9.0  # approx 10
        f = result["data"]["forecast"]
        # Last predicted should be > first predicted
        assert f[-1]["predicted_cost_usd"] > f[0]["predicted_cost_usd"]

    @pytest.mark.asyncio
    async def test_horizon_days_respected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostForecast

        daily = _make_daily_costs(20, base=100.0)
        pg = _pg_router(daily_costs=daily)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostForecast().forecast("org_test", horizon_days=14)
        f = result["data"]["forecast"]
        assert len(f) == 14

    @pytest.mark.asyncio
    async def test_confidence_band_is_predicted_times_point_eight_and_one_two(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.services.cost_intel.efficiency import CostForecast

        # Variable series (20 days of varying cost)
        daily = [
            _daily_cost_row(
                day=datetime(2026, 5, 1, tzinfo=UTC) + timedelta(days=i),
                cost=100.0 + (i % 5) * 10.0,
            )
            for i in range(20)
        ]
        pg = _pg_router(daily_costs=daily)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await CostForecast().forecast("org_test", horizon_days=5)
        for row in result["data"]["forecast"]:
            assert row["lower"] == pytest.approx(row["predicted_cost_usd"] * 0.8)
            assert row["upper"] == pytest.approx(row["predicted_cost_usd"] * 1.2)


# ─── 5. Envelope helpers ─────────────────────────────────────────────


class TestEnvelopeHelpers:
    def test_ok_envelope_shape(self) -> None:
        from eden.services.cost_intel._common import _ok_envelope

        env = _ok_envelope("cost_efficiency", {"x": 1})
        assert env["status"] == "ok"
        assert env["feature"] == "cost_efficiency"
        assert env["live"] is True
        assert env["trace_id"].startswith("ci_")
        assert env["data"] == {"x": 1}
        assert "timestamp" in env

    def test_bad_request_envelope_shape(self) -> None:
        from eden.services.cost_intel._common import _bad_request_envelope

        env = _bad_request_envelope("cost_efficiency", "bad input")
        assert env["status"] == "bad_request"
        assert env["feature"] == "cost_efficiency"
        assert env["live"] is True
        assert env["data"]["message"] == "bad input"

    def test_real_response_never_has_live_false(self) -> None:
        """Sanity check: a real response never has ``live: false``
        (that's the stub envelope marker). The 4 services always
        return either ``ok`` or ``bad_request`` with ``live=True``."""
        from eden.services.cost_intel._common import _ok_envelope

        for status in ("ok", "bad_request"):
            env = _ok_envelope("test", {})
            env["status"] = status  # type: ignore[index]
            assert env["live"] is True


# ─── 6. Linear regression helper ────────────────────────────────────


class TestLinearRegression:
    def test_perfect_linear_fit(self) -> None:
        from eden.services.cost_intel._common import _linear_regression

        slope, intercept = _linear_regression(
            [0.0, 1.0, 2.0, 3.0], [2.0, 4.0, 6.0, 8.0]
        )
        assert slope == pytest.approx(2.0)
        assert intercept == pytest.approx(2.0)

    def test_constant_series_returns_zero_slope(self) -> None:
        from eden.services.cost_intel._common import _linear_regression

        slope, intercept = _linear_regression(
            [0.0, 1.0, 2.0, 3.0], [5.0, 5.0, 5.0, 5.0]
        )
        assert slope == pytest.approx(0.0, abs=1e-9)
        assert intercept == pytest.approx(5.0)

    def test_two_points_exact_fit(self) -> None:
        from eden.services.cost_intel._common import _linear_regression

        slope, intercept = _linear_regression(
            [0.0, 10.0], [0.0, 20.0]
        )
        assert slope == pytest.approx(2.0)
        assert intercept == pytest.approx(0.0)

    def test_zero_length_returns_zero_slope(self) -> None:
        from eden.services.cost_intel._common import _linear_regression

        slope, intercept = _linear_regression([], [])
        assert slope == 0.0
        assert intercept == 0.0

    def test_all_x_identical_returns_zero_slope(self) -> None:
        from eden.services.cost_intel._common import _linear_regression

        slope, intercept = _linear_regression(
            [5.0, 5.0, 5.0], [1.0, 2.0, 3.0]
        )
        # Degenerate (denominator 0) → falls back to (0, mean(y))
        assert slope == 0.0
        assert intercept == pytest.approx(2.0)


# ─── 7. Package contract ─────────────────────────────────────────────


class TestPackageContract:
    def test_lazy_re_exports_resolve(self) -> None:
        import eden.services.cost_intel as pkg

        assert pkg.CostEfficiencyScorer is not None
        assert pkg.ROIAnalyzer is not None
        assert pkg.CostAnomalyDetector is not None
        assert pkg.CostForecast is not None

    def test_unknown_attribute_raises(self) -> None:
        import eden.services.cost_intel as pkg

        with pytest.raises(AttributeError):
            _ = pkg.NotARealSymbol  # type: ignore[attr-defined]

    def test_dir_lists_public_names(self) -> None:
        import eden.services.cost_intel as pkg

        names = dir(pkg)
        for expected in (
            "CostEfficiencyScorer",
            "ROIAnalyzer",
            "CostAnomalyDetector",
            "CostForecast",
        ):
            assert expected in names


# ─── 8. Route-level smoke tests ─────────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def cost_app() -> FastAPI:
    from eden.api.deps import get_current_user
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-cost-test")
    app.dependency_overrides[get_current_user] = _fake_user
    mod = importlib.import_module("eden.api.routes.intelligence_cost")
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def cost_client(cost_app: FastAPI) -> TestClient:
    return TestClient(cost_app)


def test_efficiency_route_returns_envelope(cost_client: TestClient) -> None:
    """POST /cost/efficiency returns the uniform envelope shape."""
    resp = cost_client.post(
        "/orgs/org_x/intelligence/cost/efficiency",
        json={"group_by": "outcome_type", "window": "7d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert "feature" in data
    assert "live" in data
    assert "trace_id" in data


def test_roi_route_returns_envelope(cost_client: TestClient) -> None:
    """POST /cost/roi returns the uniform envelope shape."""
    resp = cost_client.post(
        "/orgs/org_x/intelligence/cost/roi",
        json={"window": "30d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["feature"] == "roi_analyzer"


def test_anomalies_route_returns_envelope(cost_client: TestClient) -> None:
    """POST /cost/anomalies returns the uniform envelope shape."""
    resp = cost_client.post(
        "/orgs/org_x/intelligence/cost/anomalies",
        json={"window": "7d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["feature"] == "cost_anomaly"


def test_forecast_route_returns_envelope(cost_client: TestClient) -> None:
    """GET /cost/forecast returns the uniform envelope shape."""
    resp = cost_client.get(
        "/orgs/org_x/intelligence/cost/forecast?horizon_days=7"
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["feature"] == "cost_forecast"


def test_cost_routes_registered_under_intelligence_cost_tag() -> None:
    """The 4 Cat 8 routes are registered under the
    ``intelligence-cost`` OpenAPI tag, with the right methods
    and paths. The flag-off test is omitted because the
    ``require_feature_flag`` dep requires module-level
    settings state, which is shared across the suite."""
    from eden.api.routes.intelligence_cost import router

    paths = sorted({r.path for r in router.routes})
    expected = sorted(
        {
            "/orgs/{org_id}/intelligence/cost/efficiency",
            "/orgs/{org_id}/intelligence/cost/roi",
            "/orgs/{org_id}/intelligence/cost/anomalies",
            "/orgs/{org_id}/intelligence/cost/forecast",
        }
    )
    assert paths == expected
