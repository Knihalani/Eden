"""Behavioural tests for Cat 13 — Predictive Intelligence.

Exercises the six real services
(:class:`QualityPredictor`, :class:`CostPredictor`,
:class:`CapacityPredictor`, :class:`RiskScorer`,
:class:`DriftDetector`) and the six routes that expose them,
plus the closed-loop hook that
:meth:`DriftDetector.detect_output_drift` and
:meth:`DriftDetector.detect_embedding_drift` fire for
high-severity (PSI >= 0.2) drift.

Mirrors the structure of
:mod:`tests.intelligence.test_cost_intelligence` and
:mod:`tests.intelligence.test_root_cause_incidents`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in :mod:`tests.conftest`
  returns an empty ``fetch()`` by default, which gives the
  services a clean "no data" path. Tests that need data
  override the mock with a side-effect that matches the SQL
  fragment the service runs.

* **Route-level smoke tests** — a minimal :class:`FastAPI` app
  with the ``intelligence_predictive`` router mounted and
  ``get_current_user`` overridden. We hit each of the 6 Cat
  13 routes and assert the response shape.

* **Closed-loop tests** — verify the
  :func:`PromotionHook.on_drift_alert` firing path on a
  high-severity PSI alert. Mirrors the Cat 8 + Cat 2
  pattern.
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


def _judge_row(
    *,
    judge_name: str = "hallucination",
    score: float = 0.85,
    agent_id: str = "agent-1",
    created_at: datetime | None = None,
) -> dict[str, Any]:
    """One row from the judge_scores query."""
    return {
        "judge_name": judge_name,
        "score": float(score),
        "agent_id": agent_id,
        "created_at": created_at or datetime.now(UTC),
    }


def _cost_row(*, cost_usd: float) -> dict[str, Any]:
    """One row from the per-request cost query."""
    return {"cost_usd": float(cost_usd)}


def _daily_calls_row(*, day: datetime, calls: int) -> dict[str, Any]:
    """One row from the daily call count query."""
    return {"day": day, "calls": int(calls)}


def _daily_tokens_row(*, day: datetime, tokens: int) -> dict[str, Any]:
    """One row from the daily token total query."""
    return {"day": day, "tokens": int(tokens)}


def _latency_row(*, latency_ms: float) -> dict[str, Any]:
    """One row from the latency query. Mirrors the
    ``attributes->>'latency_ms'`` extract."""
    return {"latency_ms": float(latency_ms)}


def _response_body_row(*, response_body: str) -> dict[str, Any]:
    """One row from the response-body sample query."""
    return {"response_body": response_body}


# ─── Postgres query-routing mock helper ──────────────────────────────


def _pg_router(
    *,
    judge_rows: list[dict[str, Any]] | None = None,
    cost_rows: list[dict[str, Any]] | None = None,
    daily_calls: list[dict[str, Any]] | None = None,
    daily_tokens: list[dict[str, Any]] | None = None,
    latency_rows: list[dict[str, Any]] | None = None,
    response_bodies: list[dict[str, Any]] | None = None,
    daily_agent_costs: list[dict[str, Any]] | None = None,
) -> MagicMock:
    """Build a MagicMock Postgres client whose ``fetch`` routes
    to different returns based on the SQL fragment. Defaults
    to empty lists so a missing branch returns "no data"."""
    pg = MagicMock()
    pg.fetch = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetch(
            sql, judge_rows, cost_rows, daily_calls,
            daily_tokens, latency_rows, response_bodies,
            daily_agent_costs,
        )
    )
    pg.fetchrow = AsyncMock(return_value=None)
    pg.execute = AsyncMock(return_value="OK")

    # Make ``client.acquire()`` and ``conn.transaction()``
    # return proper async context managers so the
    # ``async with`` in the persistence helpers doesn't
    # produce a "coroutine never awaited" warning. The
    # inner mock conn forwards ``execute`` to the same
    # pg.execute mock so the test can still assert
    # ``pg.execute.await_count``.
    class _AsyncCtx:
        def __init__(self, inner: Any = None) -> None:
            self._inner = inner if inner is not None else pg

        async def __aenter__(self) -> Any:
            return self._inner

        async def __aexit__(self, *exc: Any) -> None:
            return None

    pg.acquire = MagicMock(return_value=_AsyncCtx())
    pg.transaction = MagicMock(return_value=_AsyncCtx())
    return pg


def _route_fetch(
    sql: str,
    judge_rows,
    cost_rows,
    daily_calls,
    daily_tokens,
    latency_rows,
    response_bodies,
    daily_agent_costs,
) -> list[dict[str, Any]]:
    # judge_scores query — either filtered by judge_name (has
    # the 3rd positional bind) or unfiltered.
    if "judge_scores" in sql:
        return list(judge_rows or [])
    # usage_events per-agent daily cost.
    if "usage_events" in sql and "agent_id" in sql:
        return list(daily_agent_costs or [])
    # usage_events per-request cost.
    if "usage_events" in sql and "cost_usd" in sql and "date_trunc" not in sql:
        return list(cost_rows or [])
    # usage_events daily token total (uses COALESCE(SUM)).
    if "usage_events" in sql and "input_tokens" in sql:
        return list(daily_tokens or [])
    # telemetry_events daily call count (event_type = 'agent.step').
    if "telemetry_events" in sql and "COUNT(*)" in sql:
        return list(daily_calls or [])
    # telemetry_events latency (attributes->>'latency_ms').
    if "telemetry_events" in sql and "latency_ms" in sql:
        return list(latency_rows or [])
    # telemetry_events response body sample.
    if "telemetry_events" in sql and "response_body" in sql:
        return list(response_bodies or [])
    return []


# ─── 1. QualityPredictor ─────────────────────────────────────────────


class TestQualityPredictor:
    """Tests for :class:`QualityPredictor`."""

    async def test_empty_history_returns_no_data_envelope(self) -> None:
        from eden.predictive import QualityPredictor

        pg = _pg_router(judge_rows=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await QualityPredictor().predict(
                "org_x", request_id="req-1",
            )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["predictions"] == []
        assert result["data"]["samples_used"] == 0
        assert result["data"]["model"] == "trailing_mean_v1"
        assert result["data"]["trend"] == "insufficient_data"
        assert result["data"]["anomalies"] == []

    async def test_single_judge_projection(self) -> None:
        from eden.predictive import QualityPredictor

        # Spread the rows across 7 distinct days so the
        # per-day bucketing produces a usable series.
        rows = []
        for day_offset in range(7):
            ts = datetime(2026, 6, 1, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            for _ in range(2):
                rows.append(_judge_row(score=0.9, created_at=ts))
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await QualityPredictor().predict(
                "org_x", request_id="req-1", judge_name="hallucination",
            )
        assert result["status"] == "ok"
        assert result["data"]["judge_name"] == "hallucination"
        # The trailing mean of 14 rows of 0.9 is exactly 0.9.
        predictions = result["data"]["predictions"]
        assert len(predictions) == 7
        assert predictions[0]["predicted_score_median"] == pytest.approx(0.9)
        # Default forecast horizon is 7d.
        assert result["data"]["forecast_horizon"] == "7d"
        assert result["data"]["samples_used"] == 14

    async def test_varied_judge_projection_has_stdev(self) -> None:
        from eden.predictive import QualityPredictor

        # Build 14 rows with varying scores spread across
        # 7 days so the daily series is non-degenerate.
        rows = []
        for day_offset in range(7):
            ts = datetime(2026, 6, 1, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            for score in [0.6, 0.8]:
                rows.append(_judge_row(score=score, created_at=ts))
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await QualityPredictor().predict(
                "org_x", request_id="req-1", judge_name="hallucination",
            )
        # Mean of [0.6, 0.8] = 0.7; non-degenerate.
        predictions = result["data"]["predictions"]
        assert predictions[0]["predicted_score_median"] == pytest.approx(0.7)
        # CI is bounded (mean ± 1.96 * stdev).
        assert predictions[0]["ci_95_low"] < 0.7
        assert predictions[0]["ci_95_high"] > 0.7
        # The trend is stable (no clear slope in the daily
        # series).
        assert result["data"]["trend"] == "stable"

    async def test_per_judge_aggregation(self) -> None:
        from eden.predictive import QualityPredictor

        # Build 14 rows for one judge + 14 rows for another
        # so the cross-judge rollup has data for both.
        rows = []
        for day_offset in range(7):
            ts = datetime(2026, 6, 1, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            for score in [0.9, 0.8]:
                rows.append(
                    _judge_row(
                        judge_name="hallucination",
                        score=score,
                        created_at=ts,
                    )
                )
            for score in [0.7, 0.7]:
                rows.append(
                    _judge_row(
                        judge_name="correctness",
                        score=score,
                        created_at=ts,
                    )
                )
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await QualityPredictor().predict(
                "org_x", request_id="req-1", judge_name=None,
            )
        # Headline = cross-judge mean.
        # hallucination: [0.9, 0.8] daily → mean 0.85
        # correctness: [0.7, 0.7] daily → mean 0.7
        # Cross-judge per-row mean = (0.9+0.8+0.7+0.7)/4 = 0.775
        predictions = result["data"]["predictions"]
        assert predictions[0]["predicted_score_median"] == pytest.approx(0.775)

    async def test_quality_prediction_is_persisted(self) -> None:
        from eden.predictive import QualityPredictor

        rows = [_judge_row(score=0.85) for _ in range(20)]
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            await QualityPredictor().predict(
                "org_x", request_id="req-1", judge_name="hallucination",
            )
        # Two execute calls: DELETE then INSERT.
        assert pg.execute.await_count == 2
        # The INSERT should mention ``quality_predictions``.
        insert_call = pg.execute.await_args_list[1]
        assert "INSERT INTO quality_predictions" in insert_call.args[0]


# ─── 2. CostPredictor ────────────────────────────────────────────────


class TestCostPredictor:
    """Tests for :class:`CostPredictor`."""

    async def test_empty_history_returns_no_data_envelope(self) -> None:
        from eden.predictive import CostPredictor

        pg = _pg_router(cost_rows=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CostPredictor().predict(
                "org_x", request_id="req-1",
            )
        assert result["data"]["predicted_cost_usd"] is None
        assert result["data"]["samples_used"] == 0

    async def test_median_projection_is_robust_to_outliers(self) -> None:
        from eden.predictive import CostPredictor

        # 9 normal requests at $0.01 + 1 fat-fingered $5.00.
        # Median should still be $0.01; mean would be ~$0.51.
        rows = [_cost_row(cost_usd=0.01) for _ in range(9)] + [
            _cost_row(cost_usd=5.00)
        ]
        pg = _pg_router(cost_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CostPredictor().predict(
                "org_x", request_id="req-1",
            )
        assert result["data"]["predicted_cost_usd"] == pytest.approx(0.01)
        # p25 = 0.01, p75 = 0.01 (the 8th of 10 sorted values,
        # index 2.25 → interp between 0.01 and 0.01).
        assert result["data"]["p25_usd"] == pytest.approx(0.01)
        # Mean is ~0.51 (CV is large).
        assert result["data"]["mean_usd"] == pytest.approx(0.509)
        assert result["data"]["coefficient_of_variation"] > 1.0

    async def test_high_sample_count_gives_high_confidence(self) -> None:
        from eden.predictive import CostPredictor

        # 50 stable requests at $0.01 — low CV, high confidence.
        rows = [_cost_row(cost_usd=0.01) for _ in range(50)]
        pg = _pg_router(cost_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CostPredictor().predict(
                "org_x", request_id="req-1",
            )
        assert result["data"]["confidence"] > 0.9
        assert result["data"]["stdev_usd"] == pytest.approx(0.0)

    async def test_cost_prediction_is_persisted(self) -> None:
        from eden.predictive import CostPredictor

        rows = [_cost_row(cost_usd=0.01) for _ in range(5)]
        pg = _pg_router(cost_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            await CostPredictor().predict("org_x", request_id="req-1")
        # Two execute calls: DELETE then INSERT.
        assert pg.execute.await_count == 2
        insert_call = pg.execute.await_args_list[1]
        assert "INSERT INTO cost_predictions" in insert_call.args[0]


# ─── 3. CapacityPredictor ───────────────────────────────────────────


class TestCapacityPredictor:
    """Tests for :class:`CapacityPredictor`."""

    async def test_empty_history_returns_no_data_envelope(self) -> None:
        from eden.predictive import CapacityPredictor

        pg = _pg_router(daily_calls=[], daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CapacityPredictor().predict(
                "org_x", horizon_days=7,
            )
        assert result["data"]["total_gpu_hours"] == 0.0
        assert result["data"]["gpu_hours_per_day"] == []

    async def test_mean_fallback_for_short_history(self) -> None:
        from eden.predictive import CapacityPredictor

        # Only 5 days of history — below MIN_FORECAST_HISTORY_DAYS
        # of 14. Service should fall back to the mean.
        base_day = datetime(2026, 6, 1)
        calls = [
            _daily_calls_row(day=base_day + timedelta(days=i), calls=1000)
            for i in range(5)
        ]
        pg = _pg_router(daily_calls=calls, daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CapacityPredictor().predict(
                "org_x", horizon_days=3,
            )
        assert result["data"]["warning"] == "insufficient_history"
        assert result["data"]["model"] == "mean_fallback"
        assert result["data"]["days_observed"] == 5
        # 1000 calls/day * 1.0e-6 GPU-hr/call = 1.0e-3 GPU-hr/day.
        # Mean is exactly 1.0e-3; the band is [0.8e-3, 1.2e-3].
        for row in result["data"]["gpu_hours_per_day"]:
            assert row["predicted_gpu_hours"] == pytest.approx(1e-3)
            assert row["lower"] == pytest.approx(0.8e-3)
            assert row["upper"] == pytest.approx(1.2e-3)

    async def test_linear_regression_projects_growth(self) -> None:
        from eden.predictive import CapacityPredictor

        # 20 days of history with a linear growth trend
        # (1000, 2000, 3000, ...). 20 > MIN_HISTORY (14), so
        # we should use linear regression, not the mean
        # fallback.
        base_day = datetime(2026, 5, 1)
        calls = [
            _daily_calls_row(
                day=base_day + timedelta(days=i),
                calls=1000 * (i + 1),
            )
            for i in range(20)
        ]
        pg = _pg_router(daily_calls=calls, daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CapacityPredictor().predict(
                "org_x", horizon_days=3,
            )
        assert "warning" not in result["data"]
        assert result["data"]["model"] == "linear_regression_v1"
        # The trend is positive (slope > 0); the forecast is
        # bigger than the last observed value.
        rows = result["data"]["gpu_hours_per_day"]
        assert all(r["predicted_gpu_hours"] > 0 for r in rows)
        # The total is the sum of 3 positive predictions.
        assert result["data"]["total_gpu_hours"] > 0

    async def test_capacity_forecast_is_persisted(self) -> None:
        from eden.predictive import CapacityPredictor

        base_day = datetime(2026, 5, 1)
        calls = [
            _daily_calls_row(day=base_day + timedelta(days=i), calls=1000)
            for i in range(20)
        ]
        pg = _pg_router(daily_calls=calls, daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            await CapacityPredictor().predict("org_x", horizon_days=3)
        # Two execute calls: DELETE then INSERT.
        assert pg.execute.await_count == 2
        insert_call = pg.execute.await_args_list[1]
        assert "INSERT INTO capacity_forecasts" in insert_call.args[0]
        # The forecast_json is a stringified JSON payload.
        insert_call.args[0 + 1] if len(insert_call.args) > 4 else None
        # Defensive: just check the INSERT is well-formed.
        assert "INSERT" in insert_call.args[0]

    async def test_horizon_clamped_to_max(self) -> None:
        from eden.predictive import CapacityPredictor

        pg = _pg_router(daily_calls=[], daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CapacityPredictor().predict(
                "org_x", horizon_days=999,
            )
        # 999 is clamped to MAX_HORIZON_DAYS = 90.
        assert result["data"]["horizon_days"] == 90

    async def test_tokens_are_aggregated_into_gpu_hours(self) -> None:
        from eden.predictive import CapacityPredictor

        # 15 days of history with 1M tokens/day (1 GPU-hr/day
        # at the TOKENS_PER_GPU_HOUR conversion).
        base_day = datetime(2026, 5, 1)
        tokens = [
            _daily_tokens_row(
                day=base_day + timedelta(days=i), tokens=1_000_000,
            )
            for i in range(15)
        ]
        pg = _pg_router(daily_calls=[], daily_tokens=tokens)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CapacityPredictor().predict(
                "org_x", horizon_days=2,
            )
        # 1 GPU-hr/day mean → 2 GPU-hrs total.
        assert result["data"]["total_gpu_hours"] == pytest.approx(2.0, abs=1e-6)


# ─── 4. RiskScorer ───────────────────────────────────────────────────


class TestRiskScorer:
    """Tests for :class:`RiskScorer`."""

    async def test_empty_history_returns_no_data_envelope(self) -> None:
        from eden.predictive import RiskScorer

        pg = _pg_router(
            judge_rows=[], cost_rows=[], latency_rows=[],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        assert result["data"]["composite_risk_score"] is None
        assert result["data"]["risk_breakdown"]["judge_drift"] is None
        assert result["data"]["risk_breakdown"]["cost_volatility"] is None

    async def test_high_judge_scores_yield_low_risk(self) -> None:
        from eden.predictive import RiskScorer

        # All judge scores at 0.95, both current and prior
        # windows have the same data → no drift. judge_variance
        # is near 0 (constant scores).
        judge_rows = [_judge_row(score=0.95) for _ in range(20)]
        pg = _pg_router(judge_rows=judge_rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        # judge_drift = 0 (no distribution shift), judge_variance
        # = 0 (constant scores), no cost or latency data.
        breakdown = result["data"]["risk_breakdown"]
        assert breakdown["judge_drift"] == pytest.approx(0.0)
        assert breakdown["judge_variance"] == pytest.approx(0.0)
        assert breakdown["cost_volatility"] is None
        assert breakdown["latency_p95_trend"] is None
        # Composite is 0 (only the zero-valued components are
        # available; the missing ones are excluded from the
        # weighted sum).
        assert result["data"]["composite_risk_score"] == pytest.approx(0.0)

    async def test_high_cost_variance_yields_high_cost_volatility(self) -> None:
        from eden.predictive import RiskScorer

        # No judge or latency data — defaults to None.
        # Costs: [0.001, 0.01, 0.001, 0.01, 0.001] → high CV.
        cost_rows = [
            _cost_row(cost_usd=c) for c in [0.001, 0.01, 0.001, 0.01, 0.001]
        ]
        pg = _pg_router(cost_rows=cost_rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        cv = result["data"]["risk_breakdown"]["cost_volatility"]
        assert cv is not None and cv > 0.5

    async def test_high_latency_yields_high_latency_p95_trend(self) -> None:
        from eden.predictive import RiskScorer

        # All latencies at 1.8s = 1800ms.
        # p95 / 2000ms = 0.9.
        latency_rows = [_latency_row(latency_ms=1800.0) for _ in range(20)]
        pg = _pg_router(latency_rows=latency_rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        assert result["data"]["risk_breakdown"]["latency_p95_trend"] == pytest.approx(0.9)

    async def test_composite_risk_is_in_unit_interval(self) -> None:
        from eden.predictive import RiskScorer

        judge_rows = [_judge_row(score=0.5) for _ in range(20)]
        cost_rows = [_cost_row(cost_usd=0.5) for _ in range(20)]
        latency_rows = [_latency_row(latency_ms=1900.0) for _ in range(20)]
        pg = _pg_router(
            judge_rows=judge_rows,
            cost_rows=cost_rows,
            latency_rows=latency_rows,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        composite = result["data"]["composite_risk_score"]
        assert composite is not None
        assert 0.0 <= composite <= 1.0

    async def test_risk_score_is_persisted(self) -> None:
        from eden.predictive import RiskScorer

        judge_rows = [_judge_row(score=0.85) for _ in range(20)]
        pg = _pg_router(judge_rows=judge_rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            await RiskScorer().score("org_x", request_id="req-1")
        assert pg.execute.await_count == 2
        insert_call = pg.execute.await_args_list[1]
        assert "INSERT INTO risk_scores" in insert_call.args[0]


# ─── 5. DriftDetector ────────────────────────────────────────────────


class TestDriftDetector:
    """Tests for :class:`DriftDetector`."""

    async def test_output_drift_no_data(self) -> None:
        from eden.predictive import DriftDetector

        pg = _pg_router(judge_rows=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await DriftDetector().detect_output_drift(
                "org_x", window="24h",
            )
        assert result["data"]["severity"] == "no_shift"
        assert result["data"]["psi_value"] == 0.0
        assert result["data"]["drift_type"] == "output"

    async def test_output_drift_identical_distributions(self) -> None:
        from eden.predictive import DriftDetector

        # Same distribution in baseline and current → PSI ≈ 0.
        rows = [_judge_row(score=s) for s in [0.5, 0.6, 0.7, 0.8, 0.9]]
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await DriftDetector().detect_output_drift(
                "org_x", window="24h",
            )
        assert result["data"]["psi_value"] < 0.05
        assert result["data"]["severity"] == "no_shift"

    async def test_output_drift_detects_significant_shift(self) -> None:
        from eden.predictive import DriftDetector

        # Build a mock that returns different data on
        # different fetch calls — baseline-shaped on the
        # first call, current-shaped on the second.
        baseline_rows = [_judge_row(score=0.9) for _ in range(20)]
        current_rows = [_judge_row(score=0.1) for _ in range(20)]
        pg = MagicMock()
        pg.fetch = AsyncMock(side_effect=[baseline_rows, current_rows])
        pg.fetchrow = AsyncMock(return_value=None)
        pg.execute = AsyncMock(return_value="OK")

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await DriftDetector().detect_output_drift(
                "org_x", window="24h",
            )
        # Major distribution shift → PSI > 0.2 → "high" severity.
        assert result["data"]["psi_value"] > 0.2
        assert result["data"]["severity"] == "high"

    async def test_output_drift_bad_window(self) -> None:
        from eden.predictive import DriftDetector

        # Bad window string returns a clear envelope.
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await DriftDetector().detect_output_drift(
                "org_x", window="bogus",
            )
        assert result["data"]["severity"] == "bad_request"
        assert "invalid window" in result["data"]["message"]

    async def test_output_drift_persists_alert(self) -> None:
        from eden.predictive import DriftDetector

        rows = [_judge_row(score=0.85) for _ in range(20)]
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            await DriftDetector().detect_output_drift(
                "org_x", window="24h",
            )
        # Exactly one execute call (the drift_alerts INSERT).
        # We only INSERT (no delete-then-insert — drift alerts
        # are an event log).
        assert pg.execute.await_count == 1
        insert_call = pg.execute.await_args_list[0]
        assert "INSERT INTO drift_alerts" in insert_call.args[0]
        assert "output_drift" in insert_call.args

    async def test_embedding_drift_no_data(self) -> None:
        from eden.predictive import DriftDetector

        pg = _pg_router(response_bodies=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await DriftDetector().detect_embedding_drift(
                "org_x", window="24h",
            )
        assert result["data"]["psi_value"] == 0.0
        assert result["data"]["drift_type"] == "embedding"

    async def test_embedding_drift_detects_topic_shift(self) -> None:
        from eden.predictive import DriftDetector

        # Build a mock that returns different response
        # bodies on the two fetches (baseline vs current).
        # We pick texts whose hash buckets will differ so
        # the PSI detects the shift.
        baseline = [
            _response_body_row(response_body=f"aaa-pricing-plan-{i}")
            for i in range(20)
        ]
        current = [
            _response_body_row(response_body=f"zzz-weather-forecast-{i}")
            for i in range(20)
        ]
        pg = MagicMock()
        pg.fetch = AsyncMock(side_effect=[baseline, current])
        pg.fetchrow = AsyncMock(return_value=None)
        pg.execute = AsyncMock(return_value="OK")

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await DriftDetector().detect_embedding_drift(
                "org_x", window="24h",
            )
        # Distinct hash distributions → PSI > 0.
        assert result["data"]["psi_value"] > 0.0
        assert result["data"]["drift_type"] == "embedding"

    async def test_embedding_drift_bad_window(self) -> None:
        from eden.predictive import DriftDetector

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await DriftDetector().detect_embedding_drift(
                "org_x", window="xyz",
            )
        assert result["data"]["severity"] == "bad_request"


# ─── 6. Closed-loop hook firing ──────────────────────────────────────


class TestClosedLoopHook:
    """Verify the high-severity PSI alert fires the
    :func:`PromotionHook.on_drift_alert` hook."""

    async def test_output_drift_high_severity_fires_hook(self) -> None:
        from eden.predictive import DriftDetector

        # We bypass the real PSI computation by mocking
        # ``_psi`` to return a high PSI value.
        rows = [_judge_row(score=0.85) for _ in range(20)]
        pg = _pg_router(judge_rows=rows)

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ), patch(
            "eden.predictive.drift._psi", return_value=(0.5, [], []),
        ), patch(
            "eden.predictive.drift._fire_drift_alert"
        ) as mock_fire:
            await DriftDetector().detect_output_drift(
                "org_x", window="24h",
            )
        # High-severity PSI (>= 0.2) fires the hook.
        mock_fire.assert_called_once()
        kwargs = mock_fire.call_args.kwargs
        assert kwargs["drift_type"] == "output_drift"
        assert kwargs["severity"] == "high"

    async def test_output_drift_low_severity_calls_fire_with_low(
        self,
    ) -> None:
        from eden.predictive import DriftDetector

        rows = [_judge_row(score=0.85) for _ in range(20)]
        pg = _pg_router(judge_rows=rows)

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ), patch(
            "eden.predictive.drift._psi", return_value=(0.05, [], []),
        ), patch(
            "eden.predictive.drift._fire_drift_alert"
        ) as mock_fire:
            await DriftDetector().detect_output_drift(
                "org_x", window="24h",
            )
        # Low PSI → "no_shift". The detector still calls
        # ``_fire_drift_alert`` (so the audit log + drift
        # alert table record the event), but the helper
        # itself is the gating function for the actual
        # ``PromotionHook.on_drift_alert`` call.
        mock_fire.assert_called_once()
        kwargs = mock_fire.call_args.kwargs
        assert kwargs["severity"] == "no_shift"
        # And the helper, when called with low severity,
        # does NOT call the underlying hook.
        from eden.predictive._common import _fire_drift_alert

        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook"
        ) as mock_get_hook:
            _fire_drift_alert("org_x", drift_type="output_drift", severity="no_shift")
            mock_get_hook.assert_not_called()

    async def test_embedding_drift_high_severity_fires_hook(self) -> None:
        from eden.predictive import DriftDetector

        bodies = [_response_body_row(response_body=f"text {i}") for i in range(20)]
        pg = _pg_router(response_bodies=bodies)

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ), patch(
            "eden.predictive.drift._psi", return_value=(0.3, [], []),
        ), patch(
            "eden.predictive.drift._fire_drift_alert"
        ) as mock_fire:
            await DriftDetector().detect_embedding_drift(
                "org_x", window="24h",
            )
        mock_fire.assert_called_once()
        kwargs = mock_fire.call_args.kwargs
        assert kwargs["drift_type"] == "embedding_drift"
        assert kwargs["severity"] == "high"


# ─── 7. Math helpers (pure-Python, no Postgres) ──────────────────────


class TestMathHelpers:
    """Test the pure-Python math helpers in isolation."""

    def test_linear_regression_basic(self) -> None:
        from eden.predictive._common import _linear_regression

        slope, intercept = _linear_regression([0, 1, 2], [1, 2, 3])
        assert slope == pytest.approx(1.0)
        assert intercept == pytest.approx(1.0)

    def test_linear_regression_negative_slope(self) -> None:
        from eden.predictive._common import _linear_regression

        slope, intercept = _linear_regression([0, 1, 2], [3, 2, 1])
        assert slope == pytest.approx(-1.0)
        assert intercept == pytest.approx(3.0)

    def test_linear_regression_degenerate(self) -> None:
        from eden.predictive._common import _linear_regression

        # All x are the same → degenerate → mean fallback.
        slope, intercept = _linear_regression([5, 5, 5], [1, 2, 3])
        assert slope == 0.0
        assert intercept == 2.0

    def test_linear_regression_length_mismatch_raises(self) -> None:
        from eden.predictive._common import _linear_regression

        with pytest.raises(ValueError):
            _linear_regression([1, 2], [1, 2, 3])

    def test_psi_identical_distributions(self) -> None:
        from eden.predictive._common import _psi

        psi, _, _ = _psi([0.5, 0.6, 0.7], [0.5, 0.6, 0.7])
        assert psi < 1e-6

    def test_psi_completely_different_distributions(self) -> None:
        from eden.predictive._common import _psi

        # Non-overlapping samples → high PSI.
        psi, _, _ = _psi([0.0, 0.1, 0.2], [0.9, 0.95, 0.99])
        assert psi > 0.5

    def test_psi_empty_samples(self) -> None:
        from eden.predictive._common import _psi

        psi, _, _ = _psi([], [1.0, 2.0])
        assert psi == 0.0

    def test_hash_bucket_is_deterministic(self) -> None:
        from eden.predictive._common import _hash_bucket

        b1 = _hash_bucket("the quick brown fox")
        b2 = _hash_bucket("the quick brown fox")
        assert b1 == b2
        # Different text → almost certainly different bucket.
        b3 = _hash_bucket("a different sentence altogether")
        assert b1 != b3

    def test_hash_bucket_range(self) -> None:
        from eden.predictive._common import EMBEDDING_BUCKETS, _hash_bucket

        for i in range(100):
            b = _hash_bucket(f"sample text {i}")
            assert 0 <= b < EMBEDDING_BUCKETS

    def test_safe_float_handles_none(self) -> None:
        from eden.predictive._common import _safe_float

        assert _safe_float(None) == 0.0
        assert _safe_float("not a number") == 0.0
        assert _safe_float(1.5) == 1.5
        assert _safe_float(True) == 0.0  # bool is guarded

    def test_zscore_zero_stdev(self) -> None:
        from eden.predictive._common import _zscore

        assert _zscore(5.0, 5.0, 0.0) == 0.0

    def test_zscore_basic(self) -> None:
        from eden.predictive._common import _zscore

        # (10 - 5) / 2 = 2.5
        assert _zscore(10.0, 5.0, 2.0) == 2.5

    def test_parse_window_defaults(self) -> None:
        from eden.predictive._common import _parse_window

        assert _parse_window(None) == "24 hours"
        assert _parse_window("") == "24 hours"
        assert _parse_window("7d") == "7 days"
        assert _parse_window("3h") == "3 hours"
        assert _parse_window("  5m  ") == "5 minutes"
        assert _parse_window("60s") == "60 seconds"

    def test_parse_window_invalid(self) -> None:
        from eden.predictive._common import _parse_window

        assert _parse_window("bogus") is None
        assert _parse_window("7x") is None
        assert _parse_window("d7") is None


# ─── 8. Route-level smoke tests ──────────────────────────────────────


class TestPredictiveRoutes:
    """Mount the Cat 13 router and hit each of the 6 routes."""

    @pytest.fixture(scope="module")
    def client(self) -> TestClient:
        from eden.api.deps import get_current_user
        from eden.api.routes.intelligence_predictive import router
        from eden.config import get_settings

        # Enable the feature flag so the route's
        # ``require_feature_flag`` dependency passes.
        # Module scope so the mutation persists across
        # tests (matches the Cat 8 pattern at
        # ``tests/intelligence/test_cost_intelligence.py:998``).
        settings = get_settings()
        settings.intelligence_gap_v0 = True

        async def _fake_user() -> dict:
            return {"sub": "test-user", "org_id": "org_test"}

        app = FastAPI(title="eden-predictive-test")
        app.dependency_overrides[get_current_user] = _fake_user
        app.include_router(router)
        return TestClient(app)

    def test_all_routes_are_registered(self) -> None:
        from eden.api.routes.intelligence_predictive import router

        paths = {r.path for r in router.routes}
        # The prefix is /orgs/{org_id}/intelligence/predict
        assert any(p.endswith("/quality") for p in paths)
        assert any(p.endswith("/cost") for p in paths)
        assert any(p.endswith("/capacity") for p in paths)
        assert any(p.endswith("/risk") for p in paths)
        assert any(p.endswith("/drift") for p in paths)
        # Back-compat: the v1 /drift/output and /drift/embedding
        # routes are still mounted.
        assert any(p.endswith("/drift/output") for p in paths)
        assert any(p.endswith("/drift/embedding") for p in paths)

    def test_quality_route_returns_envelope(self, client: TestClient) -> None:
        # Spread the rows across 7 days so the per-day
        # bucketing produces a usable forecast.
        rows = []
        for day_offset in range(7):
            ts = datetime(2026, 6, 1, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            for _ in range(2):
                rows.append(_judge_row(score=0.85, created_at=ts))
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/quality",
                json={"request_id": "req-1", "judge_name": "hallucination"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["live"] is True
        # New contract: predictions[] with date + ci_95
        # bands + trend.
        predictions = body["data"]["predictions"]
        assert len(predictions) == 7
        assert predictions[0]["predicted_score_median"] == pytest.approx(0.85)
        assert "trend" in body["data"]
        assert "anomalies" in body["data"]

    def test_cost_route_returns_envelope(self, client: TestClient) -> None:
        pg = _pg_router(cost_rows=[_cost_row(cost_usd=0.01) for _ in range(10)])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/cost",
                json={"request_id": "req-1"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["predicted_cost_usd"] == pytest.approx(0.01)
        # New contract: predictions[] with dates + by_agent
        # map.
        assert "predictions" in body["data"]
        assert "by_agent" in body["data"]
        assert "forecast_horizon" in body["data"]

    def test_capacity_route_returns_envelope(self, client: TestClient) -> None:
        base_day = datetime(2026, 5, 1)
        calls = [
            _daily_calls_row(
                day=base_day + timedelta(days=i), calls=1000,
            )
            for i in range(20)
        ]
        pg = _pg_router(daily_calls=calls, daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/capacity",
                json={"horizon_days": 3},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["horizon_days"] == 3
        assert len(body["data"]["gpu_hours_per_day"]) == 3
        # New contract: scenarios{} + headroom_days{} +
        # recommendation.
        assert "scenarios" in body["data"]
        assert "headroom_days" in body["data"]
        assert "recommendation" in body["data"]

    def test_risk_route_returns_envelope(self, client: TestClient) -> None:
        pg = _pg_router(judge_rows=[_judge_row(score=0.95) for _ in range(20)])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/risk",
                json={"request_id": "req-1"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        # New contract: composite_risk_score + risk_breakdown
        # + alerts + recommendation.
        assert "composite_risk_score" in body["data"]
        assert "risk_breakdown" in body["data"]
        assert "alerts" in body["data"]
        assert "recommendation" in body["data"]

    def test_drift_output_route_returns_envelope(
        self, client: TestClient
    ) -> None:
        pg = _pg_router(judge_rows=[_judge_row(score=0.85) for _ in range(20)])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/drift/output",
                json={"window": "24h"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["drift_type"] == "output"

    def test_drift_embedding_route_returns_envelope(
        self, client: TestClient
    ) -> None:
        pg = _pg_router(
            response_bodies=[
                _response_body_row(response_body=f"text {i}")
                for i in range(20)
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/drift/embedding",
                json={"window": "24h"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["drift_type"] == "embedding"


# ─── 7. CUSUM detector (v0.2 spec) ──────────────────────────────────


class TestCusumDetector:
    """Tests for the new Cat 13 v0.2 CUSUM change-point
    detector and trend classifier. Powers the
    :class:`QualityPredictor` ``anomalies`` and ``trend``
    fields.
    """

    def test_cusum_returns_empty_for_short_series(self) -> None:
        from eden.predictive import cusum_detect

        # Below MIN_POINTS the detector returns an empty
        # list — caller is expected to render
        # "insufficient_data".
        assert cusum_detect([]) == []
        assert cusum_detect([0.5, 0.5, 0.5, 0.5]) == []

    def test_cusum_returns_empty_for_constant_series(self) -> None:
        from eden.predictive import cusum_detect

        # Constant series has stdev = 0 → detector bails
        # out (no shift detectable).
        assert cusum_detect([0.5] * 20) == []

    def test_cusum_detects_sudden_drop(self) -> None:
        from eden.predictive import cusum_detect

        # 7 days stable at 0.9, then 5 days at 0.1. The
        # drop is large (8 sigma equivalent), so the
        # detector must fire.
        series = [0.9] * 7 + [0.1] * 5
        cps = cusum_detect(series)
        assert len(cps) >= 1
        # The first change point should land in the
        # declining tail (index >= 7).
        first = cps[0]
        assert first["index"] >= 7
        assert first["delta_from_baseline"] < 0

    def test_cusum_classify_trend_stable(self) -> None:
        from eden.predictive import cusum_classify_trend

        # Constant series → no trend.
        assert cusum_classify_trend([0.8] * 14) == "stable"

    def test_cusum_classify_trend_regressing(self) -> None:
        from eden.predictive import cusum_classify_trend

        # Linear decline: 0.95 → 0.50 over 14 days.
        series = [0.95 - (i * 0.033) for i in range(14)]
        assert cusum_classify_trend(series) == "regressing"

    def test_cusum_classify_trend_improving(self) -> None:
        from eden.predictive import cusum_classify_trend

        # Linear increase: 0.50 → 0.95 over 14 days.
        series = [0.50 + (i * 0.033) for i in range(14)]
        assert cusum_classify_trend(series) == "improving"

    def test_cusum_classify_trend_insufficient_data(self) -> None:
        from eden.predictive import cusum_classify_trend

        # Below MIN_POINTS.
        assert cusum_classify_trend([0.5, 0.6, 0.7]) == "insufficient_data"

    def test_annotate_change_points_adds_zscore_and_alert(self) -> None:
        from eden.predictive import annotate_change_points, cusum_detect

        series = [0.9] * 7 + [0.1] * 5
        cps = cusum_detect(series)
        annotated = annotate_change_points(
            cps, series=series, dates=[f"2026-06-{i+1:02d}" for i in range(12)],
        )
        assert len(annotated) >= 1
        first = annotated[0]
        # z_score is non-zero (the drop is significant).
        assert "z_score" in first
        assert "alert" in first
        assert "judge score dropped" in first["alert"]
        # The date is attached.
        assert "date" in first


# ─── 8. QualityPredictor v0.2 surface (multi-day + CUSUM) ─────────


class TestQualityPredictorV2:
    """Tests for the Cat 13 v0.2 QualityPredictor API:
    multi-day forecast, CUSUM anomalies, trend."""

    async def test_multi_day_forecast_shape(self) -> None:
        from eden.predictive import QualityPredictor

        # Build 14 rows across 7 days for the per-day
        # bucketing.
        rows = []
        for day_offset in range(7):
            ts = datetime(2026, 6, 1, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            for score in [0.9, 0.85]:
                rows.append(_judge_row(score=score, created_at=ts))
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await QualityPredictor().predict(
                "org_x",
                request_id="req-1",
                judge_name="hallucination",
                forecast_horizon="14d",
                history_window="7d",
            )
        predictions = result["data"]["predictions"]
        assert len(predictions) == 14
        # Each prediction has date + median + CI.
        for p in predictions:
            assert "date" in p
            assert "predicted_score_median" in p
            assert "ci_95_low" in p
            assert "ci_95_high" in p
        # The dates are consecutive (day+1, day+2, ...).
        assert predictions[0]["date"] < predictions[1]["date"]

    async def test_cusum_anomalies_attached(self) -> None:
        from eden.predictive import QualityPredictor

        # 7 days of stable 0.9, then 7 days of 0.1. The
        # large drop should be detected by CUSUM.
        rows = []
        for day_offset in range(14):
            ts = datetime(2026, 5, 1, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            score = 0.9 if day_offset < 7 else 0.1
            for _ in range(2):
                rows.append(_judge_row(score=score, created_at=ts))
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await QualityPredictor().predict(
                "org_x",
                request_id="req-1",
                judge_name="hallucination",
            )
        anomalies = result["data"]["anomalies"]
        assert len(anomalies) >= 1
        # Each anomaly has the CUSUM shape: index, value,
        # z_score, alert.
        first = anomalies[0]
        assert "index" in first
        assert "z_score" in first
        assert "alert" in first

    async def test_trend_classifier_returns_regressing(self) -> None:
        from eden.predictive import QualityPredictor

        # Strictly declining score across 14 days.
        rows = []
        for day_offset in range(14):
            ts = datetime(2026, 5, 1, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            score = 0.95 - (day_offset * 0.03)
            rows.append(_judge_row(score=score, created_at=ts))
        pg = _pg_router(judge_rows=rows)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await QualityPredictor().predict(
                "org_x",
                request_id="req-1",
                judge_name="hallucination",
            )
        assert result["data"]["trend"] == "regressing"


# ─── 9. CostPredictor v0.2 surface (per-agent + alert) ───────────


class TestCostPredictorV2:
    """Tests for the Cat 13 v0.2 CostPredictor API:
    per-agent breakdown + WoW growth-rate alert."""

    async def test_per_agent_breakdown_shape(self) -> None:
        from eden.predictive import CostPredictor

        # Two agents, 14 days each, distinct daily costs.
        per_agent_rows = []
        for agent_id, daily_cost in [
            ("agent_a", 0.10),
            ("agent_b", 0.05),
        ]:
            for day_offset in range(14):
                ts = datetime(2026, 5, 15, tzinfo=UTC) + timedelta(
                    days=day_offset,
                )
                per_agent_rows.append(
                    {
                        "day": ts,
                        "agent_id": agent_id,
                        "cost_usd": daily_cost,
                        "requests": 100,
                    }
                )
        # Build the matching per-request cost feed (the
        # fetcher reads the cost_usd column without
        # grouping).
        per_request_rows = [
            {"cost_usd": 0.05} for _ in range(20)
        ]
        pg = _pg_router(
            cost_rows=per_request_rows,
            # The new per-agent fetcher matches a
            # ``usage_events`` + ``agent_id`` + ``cost_usd``
            # query — the routing in ``_route_fetch`` keys
            # off ``"usage_events" in sql and "agent_id" in sql``
            # which is a new branch.
            daily_agent_costs=per_agent_rows,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CostPredictor().predict(
                "org_x",
                request_id="req-1",
                forecast_horizon="30d",
                history_window="30d",
                group_by="agent",
            )
        by_agent = result["data"]["by_agent"]
        assert "agent_a" in by_agent
        assert "agent_b" in by_agent
        # Each agent has a predicted total + trend.
        for entry in by_agent.values():
            assert "predicted_total_usd" in entry
            assert "trend" in entry
            assert "growth_wow" in entry

    async def test_growth_alert_fires_when_agent_growing(self) -> None:
        from eden.predictive import CostPredictor

        # One agent, last 7 days cost 5x the prior 7 days.
        per_agent_rows = []
        for day_offset in range(14):
            ts = datetime(2026, 5, 15, tzinfo=UTC) + timedelta(
                days=day_offset,
            )
            # Prior 7 days: $1/day. Last 7 days: $5/day.
            cost = 1.0 if day_offset < 7 else 5.0
            per_agent_rows.append(
                {
                    "day": ts,
                    "agent_id": "agent_a",
                    "cost_usd": cost,
                    "requests": 10,
                }
            )
        per_request_rows = [
            {"cost_usd": 1.0} for _ in range(10)
        ]
        pg = _pg_router(
            cost_rows=per_request_rows,
            daily_agent_costs=per_agent_rows,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CostPredictor().predict(
                "org_x",
                request_id="req-1",
                group_by="agent",
            )
        # The alert is set when an agent's WoW growth
        # exceeds the threshold.
        assert "alert" in result["data"]
        assert "agent_a" in result["data"]["by_agent"]
        assert "growing_" in result["data"]["by_agent"]["agent_a"]["trend"]

    async def test_group_by_org_omits_by_agent(self) -> None:
        from eden.predictive import CostPredictor

        pg = _pg_router(cost_rows=[{"cost_usd": 0.01} for _ in range(10)])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CostPredictor().predict(
                "org_x",
                request_id="req-1",
                group_by="org",
            )
        # The org-level rollup returns an empty
        # ``by_agent`` map.
        assert result["data"]["by_agent"] == {}


# ─── 10. CapacityPredictor v0.2 surface (scenarios) ─────────────


class TestCapacityPredictorV2:
    """Tests for the Cat 13 v0.2 CapacityPredictor API:
    scenarios + headroom + recommendation."""

    async def test_scenarios_include_all_four(self) -> None:
        from eden.predictive import CapacityPredictor

        # Use 10M calls/day so the peak GPU-needs actually
        # scale across the 4 scenarios (a 1k-call/day load
        # rounds to 1 GPU in every scenario).
        base_day = datetime(2026, 5, 1)
        calls = [
            _daily_calls_row(
                day=base_day + timedelta(days=i), calls=10_000_000,
            )
            for i in range(20)
        ]
        pg = _pg_router(daily_calls=calls, daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CapacityPredictor().predict(
                "org_x", horizon_days=30,
            )
        scenarios = result["data"]["scenarios"]
        # All 4 scenarios present (baseline | 2x | 3x | 5x).
        for name in ["baseline", "2x", "3x", "5x"]:
            assert name in scenarios
            assert "peak_rpm" in scenarios[name]
            assert "max_gpu_needed" in scenarios[name]
            assert "max_storage_gb" in scenarios[name]
        # The 2x scenario's peak_rpm is 2x the baseline
        # (within rounding tolerance — the response uses
        # round(.., 2)).
        assert scenarios["2x"]["peak_rpm"] == pytest.approx(
            scenarios["baseline"]["peak_rpm"] * 2, abs=0.02,
        )
        # The 5x scenario's max_gpu_needed is 5x the
        # baseline (the integer ceil scales cleanly with
        # the multiplier for inputs at this magnitude).
        assert scenarios["5x"]["max_gpu_needed"] == pytest.approx(
            scenarios["baseline"]["max_gpu_needed"] * 5,
        )

    async def test_recommendation_mentions_gpu_add(self) -> None:
        from eden.predictive import CapacityPredictor

        # 20 days of 1M calls/day → 1 GPU-hour/day.
        # The default fleet of 8 GPUs has headroom; the
        # recommendation is the "no additions needed"
        # canonical sentence.
        base_day = datetime(2026, 5, 1)
        calls = [
            _daily_calls_row(
                day=base_day + timedelta(days=i), calls=1_000_000,
            )
            for i in range(20)
        ]
        pg = _pg_router(daily_calls=calls, daily_tokens=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await CapacityPredictor().predict(
                "org_x", horizon_days=30,
            )
        recommendation = result["data"]["recommendation"]
        assert isinstance(recommendation, str)
        assert len(recommendation) > 0


# ─── 11. RiskScorer v0.2 surface (5 components + alerts) ────────


class TestRiskScorerV2:
    """Tests for the Cat 13 v0.2 RiskScorer API:
    5-component breakdown + per-component alerts + recommendation."""

    async def test_5_component_breakdown_shape(self) -> None:
        from eden.predictive import RiskScorer

        judge_rows = [_judge_row(score=0.8) for _ in range(20)]
        cost_rows = [_cost_row(cost_usd=0.01) for _ in range(20)]
        latency_rows = [_latency_row(latency_ms=1000.0) for _ in range(20)]
        pg = _pg_router(
            judge_rows=judge_rows,
            cost_rows=cost_rows,
            latency_rows=latency_rows,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        breakdown = result["data"]["risk_breakdown"]
        # All 5 components are present in the breakdown.
        for k in [
            "judge_drift",
            "cost_volatility",
            "latency_p95_trend",
            "judge_variance",
            "embedding_drift",
        ]:
            assert k in breakdown

    async def test_alerts_appear_for_high_components(self) -> None:
        from eden.predictive import RiskScorer

        # Latency 1.8s → latency_p95_trend > 0.6 (alert
        # threshold). judge + cost are at safe levels.
        latency_rows = [_latency_row(latency_ms=1800.0) for _ in range(20)]
        judge_rows = [_judge_row(score=0.95) for _ in range(20)]
        cost_rows = [_cost_row(cost_usd=0.01) for _ in range(20)]
        pg = _pg_router(
            judge_rows=judge_rows,
            cost_rows=cost_rows,
            latency_rows=latency_rows,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        alerts = result["data"]["alerts"]
        # The latency alert is the top-level concern.
        latency_alerts = [a for a in alerts if a["type"] == "latency_p95_trend"]
        assert len(latency_alerts) == 1
        assert "latency" in latency_alerts[0]["alert"].lower()

    async def test_recommendation_string_present(self) -> None:
        from eden.predictive import RiskScorer

        # No data → recommendation is the "no data"
        # canonical sentence.
        pg = _pg_router(judge_rows=[], cost_rows=[], latency_rows=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1",
            )
        assert "no data" in result["data"]["recommendation"].lower()

    async def test_window_param_propagates(self) -> None:
        from eden.predictive import RiskScorer

        pg = _pg_router(judge_rows=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            result = await RiskScorer().score(
                "org_x", request_id="req-1", window="12h",
            )
        # The window is echoed in the response payload.
        assert result["data"]["window"] == "12h"


# ─── 12. Consolidated /drift route (v0.2 spec) ──────────────────


class TestDriftRoute:
    """Tests for the new consolidated ``/drift`` route that
    supersedes the v1 ``/drift/output`` + ``/drift/embedding``
    pair. The legacy routes are kept for back-compat.
    """

    @pytest.fixture(scope="class")
    def client(self) -> TestClient:
        from eden.api.deps import get_current_user
        from eden.api.routes.intelligence_predictive import router
        from eden.config import get_settings

        settings = get_settings()
        settings.intelligence_gap_v0 = True

        async def _fake_user() -> dict:
            return {"sub": "test-user", "org_id": "org_test"}

        app = FastAPI(title="eden-predictive-drift-test")
        app.dependency_overrides[get_current_user] = _fake_user
        app.include_router(router)
        return TestClient(app)

    def test_drift_route_dispatches_on_drift_type(
        self, client: TestClient,
    ) -> None:
        # Output drift on judge scores.
        pg = _pg_router(judge_rows=[_judge_row(score=0.85) for _ in range(20)])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/drift",
                json={"window": "24h", "drift_type": "output", "method": "psi"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["drift_type"] == "output"
        # The method param is preserved.
        assert body["data"]["method"] == "psi"

    def test_drift_route_dispatches_to_embedding(
        self, client: TestClient,
    ) -> None:
        pg = _pg_router(
            response_bodies=[
                _response_body_row(response_body=f"text {i}")
                for i in range(20)
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/drift",
                json={"window": "24h", "drift_type": "embedding"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["drift_type"] == "embedding"
