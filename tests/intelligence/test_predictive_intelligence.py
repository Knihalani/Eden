"""Behavioural tests for Cat 13 — Predictive Intelligence.

Exercises :class:`QualityPredictor`, :class:`CostPredictor`,
:class:`CapacityPredictor`, :class:`RiskScorer`, and
:class:`DriftDetector` (output + embedding), plus the routes
that expose them and the closed-loop hook that
:meth:`DriftDetector.detect_output_drift` fires for
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
  ``get_current_user`` overridden. We hit each of the Cat
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


# ponytail: per upgradespec §D.3 (Phase 0 cut), TestCostPredictor /
# TestCapacityPredictor / TestRiskScorer were deleted along
# with the 3 services. The folded CostPredictor logic lives
# in Cat 7 (Cost Intelligence) — see test_cost_intelligence.py
# in tests/intelligence/.


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
        from eden.api.deps import get_current_user, require_org_member, require_path_org_access
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
        app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
        app.dependency_overrides[require_path_org_access] = lambda: "org_x"
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
        costs = [_cost_row(cost_usd=c) for c in [0.01, 0.02, 0.015, 0.018, 0.012] * 4]
        pg = _pg_router(cost_rows=costs)
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
        assert body["live"] is True
        assert "assumptions" in body["data"]
        assert body["data"]["data_source"] == "postgres"
        assert body["data"]["predicted_cost_usd"] is not None

    def test_capacity_route_returns_envelope(self, client: TestClient) -> None:
        base = datetime(2026, 6, 1, tzinfo=UTC)
        call_rows = [
            _daily_calls_row(day=base + timedelta(days=i), calls=100 + i)
            for i in range(20)
        ]
        token_rows = [
            _daily_tokens_row(day=base + timedelta(days=i), tokens=1_000_000 + i * 1000)
            for i in range(20)
        ]
        pg = _pg_router(daily_calls=call_rows, daily_tokens=token_rows)
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
        assert body["live"] is True
        assert "assumptions" in body["data"]
        assert "gpu_hours_per_day" in body["data"]

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
        assert body["live"] is True
        assert "assumptions" in body["data"]
        assert "risk_breakdown" in body["data"]

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
        bodies = [
            _response_body_row(response_body=f"sample-response-{i}")
            for i in range(20)
        ]
        pg = _pg_router(response_bodies=bodies)
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg,
        ):
            resp = client.post(
                "/orgs/org_x/intelligence/predict/drift/embedding",
                json={"window": "24h"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["live"] is True
        assert body["data"]["drift_type"] == "embedding"
        assert "assumptions" in body["data"]


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


# ponytail: per upgradespec §D.3 (Phase 0 cut), TestCostPredictorV2 /
# TestCapacityPredictorV2 / TestRiskScorerV2 were deleted
# along with the 3 services.


class TestDriftRoute:
    """Tests for the new consolidated ``/drift`` route that
    supersedes the v1 ``/drift/output`` + ``/drift/embedding``
    pair. The legacy routes are kept for back-compat.
    """

    @pytest.fixture(scope="class")
    def client(self) -> TestClient:
        from eden.api.deps import get_current_user, require_org_member, require_path_org_access
        from eden.api.routes.intelligence_predictive import router
        from eden.config import get_settings

        settings = get_settings()
        settings.intelligence_gap_v0 = True

        async def _fake_user() -> dict:
            return {"sub": "test-user", "org_id": "org_test"}

        app = FastAPI(title="eden-predictive-drift-test")
        app.dependency_overrides[get_current_user] = _fake_user
        app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
        app.dependency_overrides[require_path_org_access] = lambda: "org_x"
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
        # Per upgradespec §D.3 the v2 ``/drift`` route only
        # computes PSI on judge-score distribution — it does
        # NOT dispatch to the embedding detector (which is
        # permanently removed). The ``drift_type`` param is
        # preserved in the response envelope but only
        # ``output`` is supported.
        pg = _pg_router(judge_rows=[_judge_row(score=0.85) for _ in range(20)])
        bodies = [
            _response_body_row(response_body=f"sample-response-{i}")
            for i in range(20)
        ]
        pg = _pg_router(
            judge_rows=[_judge_row(score=0.85) for _ in range(20)],
            response_bodies=bodies,
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
        assert body["status"] == "ok"
        assert body["live"] is True
        assert body["data"]["drift_type"] == "embedding"
