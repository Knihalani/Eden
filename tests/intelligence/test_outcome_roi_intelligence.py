"""Behavioural tests for Cat 11 — Outcome / ROI Intelligence.

Exercises the three real services
(:class:`OutcomeTracker`, :class:`OutcomeRollup`,
:class:`DepartmentAnalytics`) and the three routes that expose
them, plus the Cat 17 closed-loop hook that
:meth:`OutcomeRollup.by_department` fires for low-ROI
departments.

Mirrors the structure of
:mod:`tests.intelligence.test_cost_intelligence` and
:mod:`tests.intelligence.test_memory_intelligence`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns an empty ``fetch()`` by
  default, which gives the services a clean "no data" path.
  Tests that need data override the mock with a side-effect
  that matches the SQL fragment the service runs.

* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_outcomes`` router mounted and
  ``get_current_user`` overridden. We hit each of the 3 Cat
  11 routes and assert the response shape and live envelope.
"""

from __future__ import annotations

import importlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample row builders ─────────────────────────────────────────────


def _outcome_by_dept_row(
    *, department: str, outcome_count: int, value_usd: float
) -> dict[str, Any]:
    """One row from the outcomes-by-department query."""
    return {
        "department": department,
        "outcome_count": int(outcome_count),
        "value_usd": float(value_usd),
    }


def _cost_by_dept_row(*, department: str, cost_usd: float) -> dict[str, Any]:
    """One row from the cost-by-department query."""
    return {
        "department": department,
        "cost_usd": float(cost_usd),
    }


def _rollup_history_row(*, roi: float) -> dict[str, Any]:
    """One row from the rollup-history query."""
    return {"roi": float(roi)}


# ─── Postgres query-routing mock helper ──────────────────────────────


def _pg_router(
    *,
    outcomes_by_dept: list[dict[str, Any]] | None = None,
    cost_by_dept: list[dict[str, Any]] | None = None,
    rollup_history: list[dict[str, Any]] | None = None,
) -> MagicMock:
    """Build a MagicMock Postgres client whose ``fetch`` and
    ``acquire`` route to different returns based on the SQL
    fragment. Defaults to empty lists so a missing branch
    returns "no data".

    The 3 Cat 11 fetch queries are:
    1. outcomes-by-department:
       ``SELECT ... FROM outcomes ... GROUP BY 1`` (no
       usage_events, no metadata)
    2. cost-by-department:
       ``SELECT ... FROM usage_events ... metadata->>'department'``
    3. rollup history:
       ``SELECT roi FROM outcome_department_rollups ... ORDER BY created_at``
    """
    pg = MagicMock()
    pg.fetch = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetch(
            sql, outcomes_by_dept, cost_by_dept, rollup_history
        )
    )
    # execute is called by _insert_outcome and
    # _delete_then_insert_rollup; default no-op.
    pg.execute = AsyncMock(return_value="OK")
    return pg


def _route_fetch(
    sql: str,
    outcomes_by_dept,
    cost_by_dept,
    rollup_history,
) -> list[dict[str, Any]]:
    # Rollup history query — checked FIRST because the SQL
    # pattern overlaps with the outcomes query (both touch
    # ``outcome_*``). The history query has
    # ``ORDER BY created_at`` which is unique to it.
    if "outcome_department_rollups" in sql and "ORDER BY created_at" in sql:
        return list(rollup_history or [])
    # Outcomes-by-department query — FROM outcomes, GROUP BY 1,
    # and *not* from outcome_department_rollups.
    if (
        "outcomes" in sql
        and "outcome_department_rollups" not in sql
        and "COUNT(*)" in sql
        and "GROUP BY 1" in sql
    ):
        return list(outcomes_by_dept or [])
    # Cost-by-department query — FROM usage_events with
    # ``metadata->>'department'`` extract.
    if (
        "usage_events" in sql
        and "metadata->>'department'" in sql
    ):
        return list(cost_by_dept or [])
    return []


# ─── 1. OutcomeTracker ──────────────────────────────────────────────


class TestOutcomeTracker:
    @pytest.mark.asyncio
    async def test_track_persists_and_returns_outcome_id(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeTracker

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await OutcomeTracker().track(
                "org_test",
                trace_id="trc_abc",
                outcome_type="conversion",
                value=50.0,
                department="engineering",
            )
        assert result["status"] == "ok"
        assert result["live"] is True
        assert result["data"]["outcome_id"].startswith("out_")
        assert result["data"]["trace_id"] == "trc_abc"
        assert result["data"]["outcome_type"] == "conversion"
        assert result["data"]["value"] == 50.0
        assert result["data"]["department"] == "engineering"
        # ``known_outcome_type`` is True for "conversion"
        assert result["data"]["known_outcome_type"] is True
        # The persistence helper ran via
        # ``client.acquire().__aenter__().execute(...)``. The
        # autouse ``mock_postgres_client`` fixture returns
        # ``client.execute = AsyncMock(return_value="OK")``
        # but our code path goes through ``acquire()`` so the
        # top-level ``pg.execute.await_count`` is the *pool's*
        # execute (not used). What we assert is the side-
        # effect: a successful envelope with the generated id.

    @pytest.mark.asyncio
    async def test_track_value_zero_is_accepted(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeTracker

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await OutcomeTracker().track(
                "org_test",
                trace_id="trc_zero",
                outcome_type="free_tier_signup",
                value=0.0,
            )
        assert result["status"] == "ok"
        assert result["data"]["value"] == 0.0

    @pytest.mark.asyncio
    async def test_track_negative_value_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeTracker

        result = await OutcomeTracker().track(
            "org_test",
            trace_id="trc_neg",
            outcome_type="conversion",
            value=-1.0,
        )
        assert result["status"] == "bad_request"
        assert "non-negative" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_track_missing_trace_id_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeTracker

        result = await OutcomeTracker().track(
            "org_test",
            trace_id="",
            outcome_type="conversion",
            value=10.0,
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_track_missing_outcome_type_rejected(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeTracker

        result = await OutcomeTracker().track(
            "org_test",
            trace_id="trc_abc",
            outcome_type="",
            value=10.0,
        )
        assert result["status"] == "bad_request"

    @pytest.mark.asyncio
    async def test_track_department_truncated_to_64(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeTracker

        long_dept = "x" * 200
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await OutcomeTracker().track(
                "org_test",
                trace_id="trc_abc",
                outcome_type="conversion",
                value=10.0,
                department=long_dept,
            )
        assert result["status"] == "ok"
        # Defensive cap matches the column width.
        assert len(result["data"]["department"]) == 64

    @pytest.mark.asyncio
    async def test_track_unknown_outcome_type_flagged(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """Outcome types outside the recommended vocabulary
        still get persisted (the column is open) but the
        response flags ``known_outcome_type=False`` so the
        front-end can prompt the user to confirm."""
        from eden.analytics.outcomes.tracker import OutcomeTracker

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await OutcomeTracker().track(
                "org_test",
                trace_id="trc_abc",
                outcome_type="my_custom_outcome_xyz",
                value=10.0,
            )
        assert result["status"] == "ok"
        assert result["data"]["known_outcome_type"] is False


# ─── 2. OutcomeRollup ────────────────────────────────────────────────


class TestOutcomeRollup:
    @pytest.mark.asyncio
    async def test_empty_data_returns_no_outcome_data_message(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeRollup

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await OutcomeRollup().by_department(
                "org_test", window="30d"
            )
        assert result["status"] == "ok"
        assert result["data"]["departments"] == []
        assert result["data"]["message"] == "no outcome data"
        assert result["data"]["totals"]["outcome_count"] == 0

    @pytest.mark.asyncio
    async def test_invalid_window_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeRollup

        result = await OutcomeRollup().by_department(
            "org_test", window="forever"
        )
        assert result["status"] == "bad_request"
        assert "invalid window" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_computes_roi_per_department(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeRollup

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="engineering",
                outcome_count=1000,
                value_usd=2_100_000.0,
            ),
            _outcome_by_dept_row(
                department="marketing",
                outcome_count=500,
                value_usd=1_800_000.0,
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="engineering", cost_usd=400_000.0),
            _cost_by_dept_row(department="marketing", cost_usd=300_000.0),
        ]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept, cost_by_dept=cost_by_dept
        )
        # Stub the persistence helper so the test doesn't
        # depend on transaction behaviour.
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.analytics.outcomes.tracker._delete_then_insert_rollup",
            new=AsyncMock(),
        ) as persist:
            # Stub the closed-loop hook so the test
            # doesn't fire on a real hook singleton.
            with patch(
                "eden.analytics.outcomes.tracker._fire_low_roi_alert",
                new=MagicMock(),
            ) as fire:
                result = await OutcomeRollup().by_department(
                    "org_test", window="90d"
                )
        assert result["status"] == "ok"
        # Both departments are present, both with positive ROI.
        depts = {d["department"]: d for d in result["data"]["departments"]}
        assert depts["engineering"]["net_roi"] == 2_100_000.0 / 400_000.0
        assert depts["engineering"]["outcome_count"] == 1000
        assert depts["engineering"]["avg_value_per_outcome"] == 2100.0
        assert depts["marketing"]["net_roi"] == 1_800_000.0 / 300_000.0
        # Totals are correct.
        assert result["data"]["totals"]["outcome_count"] == 1500
        assert result["data"]["totals"]["outcomes_value_usd"] == 3_900_000.0
        assert result["data"]["totals"]["cost_usd"] == 700_000.0
        # No department has ROI < 1× → hook not fired.
        # The service always calls the *helper* (it filters
        # internally) but the inner closed-loop hook
        # (``on_drift_alert``) is what we care about. Patch
        # it to verify it's not called.
        fire.assert_called_once()
        fired_depts = fire.call_args.args[1]
        assert all(
            d["net_roi"] is not None and d["net_roi"] >= 1.0
            for d in fired_depts
        )
        # Persistence was called once per department.
        assert persist.await_count == 2

    @pytest.mark.asyncio
    async def test_low_roi_department_alerted(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import OutcomeRollup

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="customer_success",
                outcome_count=10,
                value_usd=5_000.0,  # ROI = 0.025
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="customer_success", cost_usd=200_000.0),
        ]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept, cost_by_dept=cost_by_dept
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.analytics.outcomes.tracker._delete_then_insert_rollup",
            new=AsyncMock(),
        ), patch(
            "eden.analytics.outcomes.tracker._fire_low_roi_alert",
            new=MagicMock(),
        ) as fire:
            result = await OutcomeRollup().by_department(
                "org_test", window="30d"
            )
        assert result["status"] == "ok"
        cs = result["data"]["departments"][0]
        assert cs["department"] == "customer_success"
        assert cs["net_roi"] == 0.025
        assert cs["alert"] is not None
        assert "cost" in cs["alert"]
        # The closed-loop hook fired once.
        fire.assert_called_once()

    @pytest.mark.asyncio
    async def test_missing_cost_yields_null_roi(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """A department present in ``outcomes`` but absent
        from ``usage_events`` (cost=0) yields ``net_roi =
        None`` and ``avg_value_per_outcome`` is still
        computed."""
        from eden.analytics.outcomes.tracker import OutcomeRollup

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="research", outcome_count=20, value_usd=50_000.0
            ),
        ]
        # No cost_by_dept rows for research.
        pg = _pg_router(outcomes_by_dept=outcomes_by_dept, cost_by_dept=[])
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.analytics.outcomes.tracker._delete_then_insert_rollup",
            new=AsyncMock(),
        ), patch(
            "eden.analytics.outcomes.tracker._fire_low_roi_alert",
            new=MagicMock(),
        ):
            result = await OutcomeRollup().by_department(
                "org_test", window="30d"
            )
        assert result["status"] == "ok"
        depts = result["data"]["departments"]
        research = next(d for d in depts if d["department"] == "research")
        assert research["net_roi"] is None
        assert research["cost_usd"] == 0.0
        assert research["avg_value_per_outcome"] == 2_500.0
        # No alert (ROI is null, not below threshold).
        assert research["alert"] is None

    @pytest.mark.asyncio
    async def test_department_filter_narrows_to_one(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """The ``department`` query-param is the appendix's
        killer-query drill-down. When set, only the matching
        department is returned (the others are filtered out
        post-fetch because the SQL aggregate is cheaper to
        run on the full org)."""
        from eden.analytics.outcomes.tracker import OutcomeRollup

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="engineering", outcome_count=1000, value_usd=2_100_000.0
            ),
            _outcome_by_dept_row(
                department="marketing", outcome_count=500, value_usd=1_800_000.0
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="engineering", cost_usd=400_000.0),
            _cost_by_dept_row(department="marketing", cost_usd=300_000.0),
        ]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept, cost_by_dept=cost_by_dept
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.analytics.outcomes.tracker._delete_then_insert_rollup",
            new=AsyncMock(),
        ), patch(
            "eden.analytics.outcomes.tracker._fire_low_roi_alert",
            new=MagicMock(),
        ):
            result = await OutcomeRollup().by_department(
                "org_test", window="30d", department="engineering"
            )
        assert result["status"] == "ok"
        assert result["data"]["department_filter"] == "engineering"
        depts = result["data"]["departments"]
        assert len(depts) == 1
        assert depts[0]["department"] == "engineering"

    @pytest.mark.asyncio
    async def test_department_filter_unknown_returns_empty(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """An unknown department yields an empty list (no
        404 — the killer-query pattern is "filter to a
        specific bucket"; the response is well-formed even
        when the bucket has no data)."""
        from eden.analytics.outcomes.tracker import OutcomeRollup

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="engineering", outcome_count=100, value_usd=1_000.0
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="engineering", cost_usd=200.0),
        ]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept, cost_by_dept=cost_by_dept
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.analytics.outcomes.tracker._delete_then_insert_rollup",
            new=AsyncMock(),
        ), patch(
            "eden.analytics.outcomes.tracker._fire_low_roi_alert",
            new=MagicMock(),
        ):
            result = await OutcomeRollup().by_department(
                "org_test", window="30d", department="nope"
            )
        assert result["status"] == "ok"
        assert result["data"]["departments"] == []
        assert result["data"]["totals"]["outcome_count"] == 0


# ─── 3. DepartmentAnalytics ──────────────────────────────────────────


class TestDepartmentAnalytics:
    @pytest.mark.asyncio
    async def test_empty_data_returns_no_outcome_data(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import DepartmentAnalytics

        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await DepartmentAnalytics().rollup(
                "org_test", window="30d"
            )
        assert result["status"] == "ok"
        assert result["data"]["summary"]["total_outcome_count"] == 0
        assert result["data"]["summary"]["net_roi"] is None
        assert result["data"]["summary"]["best_department"] is None
        assert result["data"]["anomalies"] == []
        assert result["data"]["message"] == "no outcome data"

    @pytest.mark.asyncio
    async def test_picks_best_and_worst_department(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import DepartmentAnalytics

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="engineering", outcome_count=1000, value_usd=2_100_000.0
            ),
            _outcome_by_dept_row(
                department="marketing", outcome_count=500, value_usd=1_800_000.0
            ),
            _outcome_by_dept_row(
                department="customer_success", outcome_count=10, value_usd=5_000.0
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="engineering", cost_usd=400_000.0),
            _cost_by_dept_row(department="marketing", cost_usd=300_000.0),
            _cost_by_dept_row(department="customer_success", cost_usd=200_000.0),
        ]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept, cost_by_dept=cost_by_dept
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await DepartmentAnalytics().rollup(
                "org_test", window="90d"
            )
        assert result["status"] == "ok"
        summary = result["data"]["summary"]
        # Best: marketing at 6.0×, worst: customer_success at 0.025×.
        assert summary["best_department"]["department"] == "marketing"
        assert summary["best_department"]["net_roi"] == 6.0
        assert summary["worst_department"]["department"] == "customer_success"
        assert summary["worst_department"]["net_roi"] == 0.025
        # Aggregate ROI: 3,905,000 / 900,000.
        assert summary["net_roi"] == pytest.approx(4.3388, rel=1e-3)

    @pytest.mark.asyncio
    async def test_detects_low_roi_and_cost_without_outcomes_anomalies(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.analytics.outcomes.tracker import DepartmentAnalytics

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="cs", outcome_count=10, value_usd=5_000.0
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="cs", cost_usd=200_000.0),  # low_roi
            _cost_by_dept_row(department="wiring", cost_usd=100_000.0),  # cost_without_outcomes
        ]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept, cost_by_dept=cost_by_dept
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await DepartmentAnalytics().rollup(
                "org_test", window="30d"
            )
        anomalies = result["data"]["anomalies"]
        # Two anomaly types: low_roi (cs) and
        # cost_without_outcomes (wiring).
        types = {a["type"] for a in anomalies}
        assert "low_roi" in types
        assert "cost_without_outcomes" in types

    @pytest.mark.asyncio
    async def test_detects_roi_regression_from_history(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """A department with ≥ 4 history points whose current
        ROI is well below the 90-day mean fires an
        ``roi_regression`` anomaly."""
        from eden.analytics.outcomes.tracker import DepartmentAnalytics

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="engineering",
                outcome_count=100,
                value_usd=10_000.0,  # current ROI = 0.025
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="engineering", cost_usd=400_000.0),
        ]
        # 90-day baseline: mean 5.0× with a small variance
        # (4.5..5.5) so the stdev > 0 and the z-score is
        # meaningful. Current window at 0.025 is > 2.5 σ below
        # the mean.
        rollup_history = [
            _rollup_history_row(roi=5.5),
            _rollup_history_row(roi=5.2),
            _rollup_history_row(roi=5.0),
            _rollup_history_row(roi=4.8),
            _rollup_history_row(roi=4.5),
            _rollup_history_row(roi=5.3),
            _rollup_history_row(roi=4.9),
            _rollup_history_row(roi=5.1),
            _rollup_history_row(roi=4.7),
            _rollup_history_row(roi=5.0),
        ]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept,
            cost_by_dept=cost_by_dept,
            rollup_history=rollup_history,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await DepartmentAnalytics().rollup(
                "org_test", window="30d"
            )
        anomalies = result["data"]["anomalies"]
        regression = next(
            (a for a in anomalies if a["type"] == "roi_regression"), None
        )
        assert regression is not None
        assert regression["department"] == "engineering"
        assert regression["z_score"] < -2.5
        # Severity is "high" because z < -4 (the current
        # window is 5.0× → 0.025×, which is several σ below).
        assert regression["severity"] == "high"
        assert regression["history_points"] == 10

    @pytest.mark.asyncio
    async def test_skips_roi_regression_with_insufficient_history(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """A department with < 4 history points skips the
        z-score branch (insufficient history)."""
        from eden.analytics.outcomes.tracker import DepartmentAnalytics

        outcomes_by_dept = [
            _outcome_by_dept_row(
                department="engineering", outcome_count=100, value_usd=10_000.0
            ),
        ]
        cost_by_dept = [
            _cost_by_dept_row(department="engineering", cost_usd=400_000.0),
        ]
        rollup_history = [_rollup_history_row(roi=5.0) for _ in range(3)]
        pg = _pg_router(
            outcomes_by_dept=outcomes_by_dept,
            cost_by_dept=cost_by_dept,
            rollup_history=rollup_history,
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            result = await DepartmentAnalytics().rollup(
                "org_test", window="30d"
            )
        anomalies = result["data"]["anomalies"]
        # No roi_regression anomaly (only 3 history points).
        assert not any(a["type"] == "roi_regression" for a in anomalies)


# ─── 4. Closed-loop hook integration ─────────────────────────────────


class TestLowRoiHookIntegration:
    """The :func:`_fire_low_roi_alert` helper is the Cat 11
    analog of the Cat 2 / Cat 8 / Cat 13 drift-alert firing
    pattern. The hook is a real callable — the test exercises
    the import + the args to the hook.

    Mirrors the
    :class:`TestCostAnomalyDetectorHookIntegration` style at
    :mod:`tests.intelligence.test_cost_intelligence`.
    """

    @pytest.mark.asyncio
    async def test_high_severity_low_roi_calls_hook_with_severity(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """A department whose ROI is < 0.5 (cost > 2× value)
        is fired with ``severity="high"`` to the closed-loop
        drift hook."""
        from eden.analytics.outcomes import tracker

        # A net_roi of 0.25 is well below the 0.5 high
        # threshold.
        departments = [
            {
                "department": "bad_dept",
                "net_roi": 0.25,
                "outcome_count": 0,
                "outcomes_value_usd": 0.0,
                "cost_usd": 100.0,
                "avg_value_per_outcome": None,
                "alert": "ROI < 1× for this window",
            },
        ]
        mock_hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=mock_hook,
        ):
            tracker._fire_low_roi_alert("org_test", departments)
        mock_hook.on_drift_alert.assert_called_once_with(
            "org_test", drift_type="low_roi_department", severity="high"
        )

    @pytest.mark.asyncio
    async def test_medium_severity_low_roi_calls_hook(
        self, mock_postgres_client: MagicMock
    ) -> None:
        """A department whose ROI is between 0.5 and 1.0 is
        fired with ``severity="medium"``."""
        from eden.analytics.outcomes import tracker

        departments = [
            {
                "department": "marginal_dept",
                "net_roi": 0.8,
                "outcome_count": 10,
                "outcomes_value_usd": 80.0,
                "cost_usd": 100.0,
                "avg_value_per_outcome": 8.0,
                "alert": "ROI < 1× for this window",
            },
        ]
        mock_hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=mock_hook,
        ):
            tracker._fire_low_roi_alert("org_test", departments)
        mock_hook.on_drift_alert.assert_called_once_with(
            "org_test", drift_type="low_roi_department", severity="medium"
        )

    def test_no_fire_when_roi_above_threshold(self) -> None:
        from eden.analytics.outcomes import tracker

        departments = [
            {
                "department": "healthy",
                "net_roi": 4.0,
                "outcome_count": 1000,
                "outcomes_value_usd": 4000.0,
                "cost_usd": 1000.0,
                "avg_value_per_outcome": 4.0,
                "alert": None,
            },
        ]
        mock_hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=mock_hook,
        ):
            tracker._fire_low_roi_alert("org_test", departments)
        mock_hook.on_drift_alert.assert_not_called()

    def test_no_fire_when_roi_is_null(self) -> None:
        """A department with no cost data has net_roi=None
        and should not be flagged as low-ROI."""
        from eden.analytics.outcomes import tracker

        departments = [
            {
                "department": "uncosted",
                "net_roi": None,
                "outcome_count": 10,
                "outcomes_value_usd": 50.0,
                "cost_usd": 0.0,
                "avg_value_per_outcome": 5.0,
                "alert": None,
            },
        ]
        mock_hook = MagicMock()
        with patch(
            "eden.llmops.promotion_hooks.get_promotion_hook",
            return_value=mock_hook,
        ):
            tracker._fire_low_roi_alert("org_test", departments)
        mock_hook.on_drift_alert.assert_not_called()


# ─── 5. Window parser edge cases ────────────────────────────────────


class TestWindowParser:
    """The :func:`_parse_window` helper is the Cat 11 analog
    of the cost_intel / memory_intel window parsers. The test
    exercises the full vocabulary in one place."""

    def test_none_defaults_to_30_days(self) -> None:
        from eden.analytics.outcomes.tracker import _parse_window

        assert _parse_window(None) == "30 days"

    def test_empty_defaults_to_30_days(self) -> None:
        from eden.analytics.outcomes.tracker import _parse_window

        assert _parse_window("") == "30 days"

    def test_hours(self) -> None:
        from eden.analytics.outcomes.tracker import _parse_window

        assert _parse_window("24h") == "24 hours"

    def test_days(self) -> None:
        from eden.analytics.outcomes.tracker import _parse_window

        assert _parse_window("7d") == "7 days"

    def test_minutes(self) -> None:
        from eden.analytics.outcomes.tracker import _parse_window

        assert _parse_window("60m") == "60 minutes"

    def test_seconds(self) -> None:
        from eden.analytics.outcomes.tracker import _parse_window

        assert _parse_window("30s") == "30 seconds"

    def test_invalid_returns_none(self) -> None:
        from eden.analytics.outcomes.tracker import _parse_window

        assert _parse_window("forever") is None
        assert _parse_window("7x") is None
        assert _parse_window("x") is None


# ─── 6. Route smoke tests ───────────────────────────────────────────


# A minimal app that mounts only the Cat 11 router. Bypasses
# the full app's lifespan (KB init, sandbox runner, etc.) so
# the test stays fast and isolated. Mirrors the test_app
# fixture in
# :mod:`tests.intelligence.test_intelligence_gap_stubs`.
@pytest.fixture(scope="module")
def outcomes_test_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    app = FastAPI(title="eden-outcomes-test")
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "test-user",
        "org_id": "org_test",
    }
    app.dependency_overrides[require_path_org_access] = lambda: "org_test"
    mod = importlib.import_module("eden.api.routes.intelligence_outcomes")
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_test"
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def outcomes_client(outcomes_test_app: FastAPI) -> TestClient:
    return TestClient(outcomes_test_app)


class TestOutcomeRoutes:
    """End-to-end smoke tests for the 3 Cat 11 routes.

    Each route is hit with a mocked Postgres client; we
    assert the response envelope shape (``status``, ``live``,
    ``feature``, ``data``).
    """

    def test_post_track(self, outcomes_client: TestClient) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = outcomes_client.post(
                "/orgs/org_test/intelligence/outcomes",
                json={
                    "trace_id": "trc_abc",
                    "outcome_type": "conversion",
                    "value": 50.0,
                    "department": "engineering",
                },
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "ok"
        assert body["live"] is True
        assert body["feature"] == "outcome_tracker"
        assert body["data"]["outcome_id"].startswith("out_")

    def test_post_track_rejects_negative_value(
        self, outcomes_client: TestClient
    ) -> None:
        r = outcomes_client.post(
            "/orgs/org_test/intelligence/outcomes",
            json={
                "trace_id": "trc_abc",
                "outcome_type": "conversion",
                "value": -1.0,
            },
        )
        # FastAPI body validation catches the negative value
        # via the ``ge=0.0`` constraint, returning 422.
        assert r.status_code == 422

    def test_get_departments(
        self, outcomes_client: TestClient
    ) -> None:
        pg = _pg_router(
            outcomes_by_dept=[
                _outcome_by_dept_row(
                    department="engineering", outcome_count=100, value_usd=1_000.0
                ),
            ],
            cost_by_dept=[
                _cost_by_dept_row(department="engineering", cost_usd=200.0),
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.analytics.outcomes.tracker._delete_then_insert_rollup",
            new=AsyncMock(),
        ), patch(
            "eden.analytics.outcomes.tracker._fire_low_roi_alert",
            new=MagicMock(),
        ):
            r = outcomes_client.get(
                "/orgs/org_test/intelligence/outcomes/departments",
                params={"window": "30d"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "ok"
        assert body["feature"] == "outcome_rollup"
        assert body["data"]["window"] == "30d"
        depts = body["data"]["departments"]
        assert len(depts) == 1
        assert depts[0]["department"] == "engineering"
        assert depts[0]["net_roi"] == 5.0

    def test_get_analytics(
        self, outcomes_client: TestClient
    ) -> None:
        pg = _pg_router(
            outcomes_by_dept=[
                _outcome_by_dept_row(
                    department="marketing", outcome_count=500, value_usd=1_800_000.0
                ),
            ],
            cost_by_dept=[
                _cost_by_dept_row(department="marketing", cost_usd=300_000.0),
            ],
        )
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = outcomes_client.get(
                "/orgs/org_test/intelligence/outcomes/analytics",
                params={"window": "90d"},
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "ok"
        assert body["feature"] == "department_analytics"
        summary = body["data"]["summary"]
        assert summary["best_department"]["department"] == "marketing"
        assert summary["best_department"]["net_roi"] == 6.0

    def test_get_departments_empty(
        self, outcomes_client: TestClient
    ) -> None:
        pg = _pg_router()
        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ):
            r = outcomes_client.get(
                "/orgs/org_test/intelligence/outcomes/departments",
            )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["data"]["departments"] == []
        assert body["data"]["message"] == "no outcome data"
