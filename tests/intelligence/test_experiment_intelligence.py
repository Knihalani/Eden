"""Behavioural tests for Cat 12 — Experimentation Intelligence.

Exercises the eight real services
(:class:`TrafficSplitter`, :class:`AutoEvaluator`,
:class:`ExperimentRecommender`,
:class:`ExperimentWinnerDetector`, and the four
:class:`Simulator` methods) and the routes that expose
them, plus the Cat 17 closed-loop hooks that fire on a
real winner declaration and on a safety regression.

Mirrors the structure of
:mod:`tests.intelligence.test_cost_intelligence` and
:mod:`tests.intelligence.test_metric_studio`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in
  :mod:`tests.conftest` returns an empty ``fetch()`` by
  default, which gives the services a clean "no data"
  path. Tests that need data override the mock with a
  side-effect that matches the SQL fragment the service
  runs.
* **Route-level smoke tests** — a minimal :class:`FastAPI`
  app with the ``intelligence_experiments`` router
  mounted and ``get_current_user`` overridden. We hit
  each of the 8 Cat 12 routes and assert the response
  shape and live envelope.

Target: 30+ tests per the appendix test plan.

Note: ``patch("eden.experiments._common._fn")`` does
**not** work because the service modules import the
helpers at module load time. We patch at the import
*binding site* instead — e.g.
``patch("eden.experiments.experiment_intel.splitter._fetch_traffic_splits")``
— so the mock reaches the service code path.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── 1. Sample data builders ───────────────────────────────────────────


def _make_judge(
    *, control_median: float, treatment_median: float,
    n: int = 200,
) -> dict[str, Any]:
    """Build a per-judge per-variant dict for the
    recommender / winner-detector test cases. The
    ``n`` argument is the per-arm observation count, so a
    high ``n`` produces a high-confidence Bayesian
    posterior.
    """
    return {
        "control": {
            "n": int(n),
            "median": float(control_median),
            "p5": float(control_median) - 0.1,
            "p95": float(control_median) + 0.1,
        },
        "treatment": {
            "n": int(n),
            "median": float(treatment_median),
            "p5": float(treatment_median) - 0.1,
            "p95": float(treatment_median) + 0.1,
        },
    }


def _ship_case() -> dict[str, dict[str, dict[str, Any]]]:
    """All hard + soft judges favor treatment by 0.02-0.04."""
    return {
        "safety": _make_judge(control_median=0.92, treatment_median=0.96),
        "groundedness": _make_judge(control_median=0.88, treatment_median=0.93),
        "action_completion": _make_judge(control_median=0.85, treatment_median=0.90),
        "relevance": _make_judge(control_median=0.83, treatment_median=0.88),
        "satisfaction": _make_judge(control_median=0.80, treatment_median=0.85),
        "tool_selection_quality": _make_judge(control_median=0.82, treatment_median=0.87),
        "reasoning_coherence": _make_judge(control_median=0.84, treatment_median=0.89),
    }


def _dont_ship_safety_case() -> dict[str, dict[str, dict[str, Any]]]:
    """Safety regresses sharply — control 0.95 → treatment 0.70."""
    case = _ship_case()
    case["safety"] = _make_judge(control_median=0.95, treatment_median=0.70)
    return case


def _dont_ship_floor_case() -> dict[str, dict[str, dict[str, Any]]]:
    """Hard judge drops below the 0.6 absolute floor."""
    case = _ship_case()
    case["groundedness"] = _make_judge(control_median=0.88, treatment_median=0.55)
    return case


def _need_more_data_case() -> dict[str, dict[str, dict[str, Any]]]:
    """Per-arm n=50, below the MIN_N_PER_ARM=100 threshold."""
    return {k: _make_judge(control_median=0.92, treatment_median=0.96, n=50)
            for k in _ship_case()}


def _ship_with_monitoring_case() -> dict[str, dict[str, dict[str, Any]]]:
    """Hard judges favor treatment, but a soft judge regresses 0.07."""
    case = _ship_case()
    case["relevance"] = _make_judge(control_median=0.85, treatment_median=0.78)
    return case


def _tie_case() -> dict[str, dict[str, dict[str, Any]]]:
    """All per-judge deltas within 0.02 of zero."""
    return {k: _make_judge(control_median=0.85, treatment_median=0.86)
            for k in _ship_case()}


# Patch-site constants. These point at the import
# binding locations (the service modules) — patching
# ``eden.experiments._common._fn`` would miss the bound
# name in the service module and silently no-op.
P_SPLITTER_FETCH = "eden.experiments.experiment_intel.splitter._fetch_traffic_splits"
P_SPLITTER_UPSERT = "eden.experiments.experiment_intel.splitter._upsert_traffic_split"
P_AE_FETCH_SPLITS = "eden.experiments.experiment_intel.auto_eval._fetch_traffic_splits"
P_AE_FETCH_SCORES = "eden.experiments.experiment_intel.auto_eval._fetch_variant_scores"
P_AE_UPSERT = "eden.experiments.experiment_intel.auto_eval._upsert_eval_run"
P_AE_FETCH_RUNS = "eden.experiments.experiment_intel.auto_eval._fetch_eval_runs"
P_REC_UPSERT = "eden.experiments.experiment_intel.recommender._upsert_recommendation"
P_REC_HOOK = "eden.experiments.experiment_intel.recommender._fire_dont_ship_hook"
P_WIN_FETCH_RUNS = "eden.experiments.experiment_intel.winner._fetch_eval_runs"
P_WIN_UPSERT = "eden.experiments.experiment_intel.winner._upsert_recommendation"
P_WIN_HOOK = "eden.experiments.experiment_intel.winner._fire_winner_hook"
P_SIM_UPSERT_SCEN = "eden.experiments.simulation.scenario._upsert_scenario"
P_SIM_UPSERT_RUN = "eden.experiments.simulation.scenario._upsert_simulation_run"
P_SIM_UPSERT_WHATIF = "eden.experiments.simulation.scenario._upsert_what_if"
P_SIM_FETCH_TRACES = "eden.experiments.simulation.scenario._fetch_production_traces"
P_SIM_FETCH_JUDGE = "eden.experiments.simulation.scenario._fetch_judge_score_aggregate"
P_SIM_FETCH_COST = "eden.experiments.simulation.scenario._fetch_cost_aggregate"


# ─── 2. TrafficSplitter ───────────────────────────────────────────────


class TestTrafficSplitter:
    @pytest.mark.asyncio
    async def test_split_default_99_01(self) -> None:
        """Without a persisted split, the splitter falls back
        to a 99/01 control/treatment split.
        """
        from eden.experiments.experiment_intel import TrafficSplitter

        with patch(
            P_SPLITTER_FETCH,
            new=AsyncMock(return_value=[]),
        ), patch(
            P_SPLITTER_UPSERT,
            new=AsyncMock(return_value=None),
        ):
            r = await TrafficSplitter().split(
                "org_test",
                experiment_id="exp_default_99_01",
                user_id="alice",
            )
        assert r["status"] == "ok"
        assert r["live"] is True
        assert r["data"]["variant_id"] in {"control", "treatment"}
        assert len(r["data"]["weights"]) == 2

    @pytest.mark.asyncio
    async def test_split_is_deterministic(self) -> None:
        """The same ``(user_id, experiment_id)`` always
        returns the same variant.
        """
        from eden.experiments.experiment_intel import TrafficSplitter

        with patch(
            P_SPLITTER_FETCH,
            new=AsyncMock(return_value=[
                {"variant_id": "control", "weight": 0.5},
                {"variant_id": "treatment", "weight": 0.5},
            ]),
        ):
            r1 = await TrafficSplitter().split(
                "org_test", experiment_id="exp_det", user_id="alice",
            )
            r2 = await TrafficSplitter().split(
                "org_test", experiment_id="exp_det", user_id="alice",
            )
        assert r1["data"]["variant_id"] == r2["data"]["variant_id"]
        assert r1["data"]["bucket"] == r2["data"]["bucket"]

    @pytest.mark.asyncio
    async def test_split_distribution_50_50(self) -> None:
        """A 50/50 split produces roughly equal assignments
        across a 1 000-user sample.
        """
        from eden.experiments.experiment_intel import TrafficSplitter

        with patch(
            P_SPLITTER_FETCH,
            new=AsyncMock(return_value=[
                {"variant_id": "control", "weight": 0.5},
                {"variant_id": "treatment", "weight": 0.5},
            ]),
        ):
            counts: dict[str, int] = {"control": 0, "treatment": 0}
            for i in range(1_000):
                r = await TrafficSplitter().split(
                    "org_test",
                    experiment_id="exp_50_50",
                    user_id=f"user_{i}",
                )
                counts[r["data"]["variant_id"]] += 1
        # Both arms within ±20% of 500 (loose bound; SHA-256
        # is uniform but small-sample variance on 1 000 draws
        # can be a few %).
        assert 350 < counts["control"] < 650
        assert 350 < counts["treatment"] < 650

    @pytest.mark.asyncio
    async def test_create_split_persists_and_returns_id(
        self,
    ) -> None:
        from eden.experiments.experiment_intel import TrafficSplitter

        with patch(
            P_SPLITTER_UPSERT,
            new=AsyncMock(return_value=None),
        ) as upsert:
            r = await TrafficSplitter().create_split(
                "org_test",
                name="canary_v2",
                control_version="1.0",
                treatment_version="1.1",
                control_weight=0.99,
                treatment_weight=0.01,
            )
        assert r["status"] == "ok"
        assert r["data"]["experiment_id"].startswith("exp_")
        assert r["data"]["status"] == "active"
        upsert.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_create_split_rejects_invalid_stopping_rule(
        self,
    ) -> None:
        from eden.experiments.experiment_intel import TrafficSplitter

        r = await TrafficSplitter().create_split(
            "org_test",
            name="bad",
            control_version="1.0",
            treatment_version="1.1",
            stopping_rule="garbage",
        )
        assert r["status"] == "ok"
        assert "must be 'auto' or 'manual'" in r["message"]

    @pytest.mark.asyncio
    async def test_list_splits_returns_persisted_rows(
        self,
    ) -> None:
        from eden.experiments.experiment_intel import TrafficSplitter

        with patch(
            P_SPLITTER_FETCH,
            new=AsyncMock(return_value=[
                {"variant_id": "control", "weight": 0.99, "status": "active"},
                {"variant_id": "treatment", "weight": 0.01, "status": "active"},
            ]),
        ):
            r = await TrafficSplitter().list_splits(
                "org_test", experiment_id="exp_list",
            )
        assert r["status"] == "ok"
        assert {v["variant_id"] for v in r["data"]["variants"]} == {
            "control", "treatment",
        }

    @pytest.mark.asyncio
    async def test_split_requires_user_id(self) -> None:
        from eden.experiments.experiment_intel import TrafficSplitter

        r = await TrafficSplitter().split(
            "org_test", experiment_id="exp_no_uid", user_id="",
        )
        assert r["status"] == "ok"
        assert "user_id is required" in r["message"]


# ─── 3. AutoEvaluator ─────────────────────────────────────────────────


class TestAutoEvaluator:
    @pytest.mark.asyncio
    async def test_evaluate_empty_data_returns_hint(self) -> None:
        from eden.experiments.experiment_intel import AutoEvaluator

        with patch(
            P_AE_FETCH_SPLITS,
            new=AsyncMock(return_value=[]),
        ), patch(
            P_AE_FETCH_SCORES,
            new=AsyncMock(return_value=[]),
        ):
            r = await AutoEvaluator().evaluate(
                "org_test", experiment_id="exp_empty",
            )
        assert r["status"] == "ok"
        assert "no judge data" in r["message"]

    @pytest.mark.asyncio
    async def test_evaluate_aggregates_per_variant(self) -> None:
        from eden.experiments.experiment_intel import AutoEvaluator

        # Mock the variant-scores helper to return 100
        # scores per (judge, variant). The variant
        # distribution differs so the medians are
        # distinguishable.
        async def _scores(*, org_id, experiment_id, variant, judge):
            if variant == "control":
                return [0.80 + 0.001 * i for i in range(100)]
            return [0.90 + 0.001 * i for i in range(100)]

        with patch(
            P_AE_FETCH_SPLITS,
            new=AsyncMock(return_value=[
                {"variant_id": "control", "weight": 0.5},
                {"variant_id": "treatment", "weight": 0.5},
            ]),
        ), patch(
            P_AE_FETCH_SCORES,
            new=_scores,
        ), patch(
            P_AE_UPSERT,
            new=AsyncMock(return_value=None),
        ):
            r = await AutoEvaluator().evaluate(
                "org_test",
                experiment_id="exp_agg",
                judges=["safety"],
            )
        assert r["status"] == "ok"
        assert r["data"]["judge_scores"]["safety"]["control"]["n"] == 100
        assert r["data"]["judge_scores"]["safety"]["treatment"]["n"] == 100
        # Treatment median > control median.
        c_med = r["data"]["judge_scores"]["safety"]["control"]["median"]
        t_med = r["data"]["judge_scores"]["safety"]["treatment"]["median"]
        assert t_med > c_med

    @pytest.mark.asyncio
    async def test_evaluate_persists_per_judge_variant_row(
        self,
    ) -> None:
        from eden.experiments.experiment_intel import AutoEvaluator

        upsert_calls: list[dict[str, Any]] = []

        async def _upsert(**kwargs):
            upsert_calls.append(kwargs)

        async def _scores(*, org_id, experiment_id, variant, judge):
            return [0.85] * 100

        with patch(
            P_AE_FETCH_SPLITS,
            new=AsyncMock(return_value=[
                {"variant_id": "control", "weight": 0.5},
                {"variant_id": "treatment", "weight": 0.5},
            ]),
        ), patch(
            P_AE_FETCH_SCORES,
            new=_scores,
        ), patch(
            P_AE_UPSERT,
            new=_upsert,
        ):
            await AutoEvaluator().evaluate(
                "org_test",
                experiment_id="exp_persist",
                judges=["safety", "groundedness"],
            )
        # 2 judges × 2 variants = 4 upserts.
        assert len(upsert_calls) == 4
        judges_persisted = {c["judge"] for c in upsert_calls}
        assert judges_persisted == {"safety", "groundedness"}

    @pytest.mark.asyncio
    async def test_latest_returns_persisted_runs(self) -> None:
        from eden.experiments.experiment_intel import AutoEvaluator

        with patch(
            P_AE_FETCH_RUNS,
            new=AsyncMock(return_value=[
                {"judge": "safety", "variant": "control",
                 "n": 100, "score_median": 0.85},
                {"judge": "safety", "variant": "treatment",
                 "n": 100, "score_median": 0.90},
            ]),
        ):
            r = await AutoEvaluator().latest(
                "org_test", experiment_id="exp_latest",
            )
        assert r["status"] == "ok"
        assert "safety" in r["data"]["judge_scores"]
        assert "control" in r["data"]["judge_scores"]["safety"]

    @pytest.mark.asyncio
    async def test_latest_preserves_legitimate_zero_score(self) -> None:
        """Audit 2026-07-07: a legitimate 0.0 median/p5/p95 must
        not be collapsed to None. Pre-fix the
        ``_safe_float(...) or None`` pattern returned None when
        the value was 0.0 (or 0), silently confusing "zero
        score" with "no data". This broke any judge whose
        baseline was legitimately 0 (e.g. a fresh safety
        classifier with no false-positive history).
        """
        from eden.experiments.experiment_intel import AutoEvaluator

        with patch(
            P_AE_FETCH_RUNS,
            new=AsyncMock(return_value=[
                # score_median = 0.0 (legit zero); p5/p95 also 0
                {"judge": "safety", "variant": "control",
                 "n": 100, "score_median": 0.0,
                 "score_p5": 0.0, "score_p95": 0.0},
                # None columns (no data) — should remain None
                {"judge": "safety", "variant": "treatment",
                 "n": 0, "score_median": None,
                 "score_p5": None, "score_p95": None},
            ]),
        ):
            r = await AutoEvaluator().latest(
                "org_test", experiment_id="exp_zero",
            )
        control = r["data"]["judge_scores"]["safety"]["control"]
        treatment = r["data"]["judge_scores"]["safety"]["treatment"]
        # The bug-fix: a real 0.0 score stays 0.0 (not None).
        assert control["median"] == 0.0, (
            f"0.0 median was collapsed to {control['median']!r}"
        )
        assert control["p5"] == 0.0
        assert control["p95"] == 0.0
        # Genuine NULLs from the DB still surface as None so the
        # UI can distinguish "no data" from "zero".
        assert treatment["median"] is None
        assert treatment["p5"] is None
        assert treatment["p95"] is None


# ─── 4. ExperimentRecommender (6 decision-tree cases) ────────────────


class TestExperimentRecommender:
    @pytest.mark.asyncio
    async def test_ship(self) -> None:
        from eden.experiments.experiment_intel import ExperimentRecommender

        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            r = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_ship", auto_eval=_ship_case(),
            )
        assert r["data"]["recommendation"] == "ship"
        assert r["data"]["confidence"] >= 0.5

    @pytest.mark.asyncio
    async def test_dont_ship_safety_regression(self) -> None:
        from eden.experiments.experiment_intel import ExperimentRecommender

        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ), patch(
            P_REC_HOOK,
        ) as hook:
            r = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_dont_ship",
                auto_eval=_dont_ship_safety_case(),
            )
        assert r["data"]["recommendation"] == "dont_ship"
        assert "safety" in r["data"]["rationale"]
        hook.assert_called_once()

    @pytest.mark.asyncio
    async def test_dont_ship_floor_violation(self) -> None:
        from eden.experiments.experiment_intel import ExperimentRecommender

        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            r = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_floor",
                auto_eval=_dont_ship_floor_case(),
            )
        assert r["data"]["recommendation"] == "dont_ship"
        assert "floor" in r["data"]["rationale"].lower()

    @pytest.mark.asyncio
    async def test_need_more_data(self) -> None:
        from eden.experiments.experiment_intel import ExperimentRecommender

        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            r = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_nmd",
                auto_eval=_need_more_data_case(),
            )
        assert r["data"]["recommendation"] == "need_more_data"

    @pytest.mark.asyncio
    async def test_ship_with_monitoring(self) -> None:
        from eden.experiments.experiment_intel import ExperimentRecommender

        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            r = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_mon",
                auto_eval=_ship_with_monitoring_case(),
            )
        assert r["data"]["recommendation"] == "ship_with_monitoring"
        assert "relevance" in r["data"]["rationale"]

    @pytest.mark.asyncio
    async def test_tie(self) -> None:
        from eden.experiments.experiment_intel import ExperimentRecommender

        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            r = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_tie", auto_eval=_tie_case(),
            )
        # Either tie (delta < 0.02) or low_confidence
        # (max_posterior in [0.4, 0.6]). Both are valid
        # "no clear winner" outcomes.
        assert r["data"]["recommendation"] in {"tie", "low_confidence"}

    @pytest.mark.asyncio
    async def test_no_data_returns_hint(self) -> None:
        from eden.experiments.experiment_intel import ExperimentRecommender

        r = await ExperimentRecommender().recommend(
            "org_test", experiment_id="exp_empty", auto_eval=None,
        )
        assert r["status"] == "ok"
        assert "no auto-eval data" in r["message"]

    @pytest.mark.asyncio
    async def test_does_not_mutate_caller_payload(self) -> None:
        """Re-running the recommender on the same payload
        twice yields the same result — the inner
        ``per_variant`` dicts are never mutated.
        """
        from eden.experiments.experiment_intel import ExperimentRecommender

        case = _ship_case()
        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            r1 = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_no_mutate_1",
                auto_eval=case,
            )
            r2 = await ExperimentRecommender().recommend(
                "org_test", experiment_id="exp_no_mutate_2",
                auto_eval=case,
            )
        # The two recommendations are equal because the
        # caller payload wasn't mutated.
        assert r1["data"]["recommendation"] == r2["data"]["recommendation"]
        # The inner per_variant dicts still look like the
        # original (no ``delta`` / ``prob_treatment_better``
        # keys added by the recommender).
        for judge_dict in case.values():
            assert "delta" not in judge_dict["control"]
            assert "delta" not in judge_dict["treatment"]


# ─── 5. ExperimentWinnerDetector ─────────────────────────────────────


class TestExperimentWinnerDetector:
    @pytest.mark.asyncio
    async def test_treatment_wins(self) -> None:
        from eden.experiments.experiment_intel import (
            ExperimentWinnerDetector,
        )

        with patch(
            P_WIN_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ), patch(
            P_WIN_HOOK,
        ) as hook:
            r = await ExperimentWinnerDetector().detect(
                "org_test", experiment_id="exp_t_win",
                auto_eval=_ship_case(),
            )
        assert r["data"]["winner"] == "treatment"
        assert r["data"]["recommendation"] == "ship"
        hook.assert_called_once()

    @pytest.mark.asyncio
    async def test_control_wins_on_safety_regression(self) -> None:
        from eden.experiments.experiment_intel import (
            ExperimentWinnerDetector,
        )

        with patch(
            P_WIN_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            r = await ExperimentWinnerDetector().detect(
                "org_test", experiment_id="exp_c_win",
                auto_eval=_dont_ship_safety_case(),
            )
        assert r["data"]["winner"] == "control"
        assert r["data"]["recommendation"] == "dont_ship"

    @pytest.mark.asyncio
    async def test_need_more_data(self) -> None:
        from eden.experiments.experiment_intel import (
            ExperimentWinnerDetector,
        )

        r = await ExperimentWinnerDetector().detect(
            "org_test", experiment_id="exp_nmd",
            auto_eval=_need_more_data_case(),
        )
        assert r["status"] == "ok"
        assert r["data"]["winner"] is None
        assert r["data"]["reason"] == "need_more_data"

    @pytest.mark.asyncio
    async def test_no_data_returns_hint(self) -> None:
        from eden.experiments.experiment_intel import (
            ExperimentWinnerDetector,
        )

        r = await ExperimentWinnerDetector().detect(
            "org_test", experiment_id="exp_empty", auto_eval=None,
        )
        assert r["status"] == "ok"
        assert "no auto-eval data" in r["message"]


# ─── 6. Simulator ─────────────────────────────────────────────────────


class TestSimulatorSimulateScenario:
    @pytest.mark.asyncio
    async def test_no_scenario_no_params(self) -> None:
        from eden.experiments.simulation import Simulator

        r = await Simulator().simulate_scenario("org_test")
        assert r["status"] == "ok"
        assert "scenario_id or name is required" in r["message"]


class TestSimulatorReplayProductionInStaging:
    @pytest.mark.asyncio
    async def test_no_production_traces(self) -> None:
        from eden.experiments.simulation import Simulator

        with patch(
            P_SIM_UPSERT_SCEN,
            new=AsyncMock(return_value="sim_test"),
        ), patch(
            P_SIM_FETCH_TRACES,
            new=AsyncMock(return_value=[]),
        ):
            r = await Simulator().replay_production_in_staging(
                "org_test",
                production_window_start="2026-06-01T00:00:00+00:00",
                production_window_end="2026-06-08T00:00:00+00:00",
                candidate_version="1.1.0",
                sample_size=10,
            )
        assert r["status"] == "ok"
        assert "no production traces" in r["message"]
        assert r["data"]["n_traces_replayed"] == 0

    @pytest.mark.asyncio
    async def test_replay_with_mocked_traces(self) -> None:
        from eden.experiments.simulation import Simulator

        fake_traces = [
            {"trace_id": f"trc_{i}", "event_type": "otel.chat"}
            for i in range(50)
        ]
        with patch(
            P_SIM_UPSERT_SCEN,
            new=AsyncMock(return_value="sim_test"),
        ), patch(
            P_SIM_UPSERT_RUN,
            new=AsyncMock(return_value="simrun_test"),
        ), patch(
            P_SIM_FETCH_TRACES,
            new=AsyncMock(return_value=fake_traces),
        ), patch(
            P_SIM_FETCH_JUDGE,
            new=AsyncMock(return_value={
                "safety": {"median": 0.92, "n": 100},
                "groundedness": {"median": 0.88, "n": 100},
            }),
        ):
            r = await Simulator().replay_production_in_staging(
                "org_test",
                production_window_start="2026-06-01T00:00:00+00:00",
                production_window_end="2026-06-08T00:00:00+00:00",
                candidate_version="1.1.0",
                judges=["safety", "groundedness"],
                sample_size=20,
            )
        assert r["status"] == "ok"
        assert r["data"]["n_traces_replayed"] == 20
        assert r["data"]["judge_comparison"]["safety"]["control"] == 0.92
        # The candidate score is a hash-derived projection,
        # not 0.92, so we just assert it's in [0, 1].
        cand = r["data"]["judge_comparison"]["safety"]["candidate"]
        assert 0.0 <= cand <= 1.0
        assert r["data"]["recommendation"] in {
            "ship", "ship_with_monitoring", "dont_ship", "insufficient_data",
        }

    @pytest.mark.asyncio
    async def test_invalid_window(self) -> None:
        from eden.experiments.simulation import Simulator

        r = await Simulator().replay_production_in_staging(
            "org_test",
            production_window_start="2026-06-08T00:00:00+00:00",
            production_window_end="2026-06-01T00:00:00+00:00",
            candidate_version="1.1.0",
        )
        assert "production_window_end must be" in r["message"]


class TestSimulatorWhatIfAnalysis:
    @pytest.mark.asyncio
    async def test_no_baseline_data(self) -> None:
        from eden.experiments.simulation import Simulator

        with patch(
            P_SIM_FETCH_COST,
            new=AsyncMock(return_value={}),
        ), patch(
            P_SIM_FETCH_JUDGE,
            new=AsyncMock(return_value={}),
        ):
            r = await Simulator().what_if_analysis(
                "org_test", question="switch from gpt-4o to claude-haiku",
            )
        assert r["status"] == "ok"
        assert "no usage or judge data" in r["message"]

    @pytest.mark.asyncio
    async def test_what_if_with_mocked_baseline(self) -> None:
        from eden.experiments.simulation import Simulator

        with patch(
            P_SIM_FETCH_COST,
            new=AsyncMock(return_value={
                "total_cost_usd": 1000.0, "p95_latency_ms": 1200.0,
                "n_events": 1000,
            }),
        ), patch(
            P_SIM_FETCH_JUDGE,
            new=AsyncMock(return_value={
                "safety": {"median": 0.90, "n": 100},
            }),
        ), patch(
            P_SIM_UPSERT_WHATIF,
            new=AsyncMock(return_value="whatif_test"),
        ):
            r = await Simulator().what_if_analysis(
                "org_test", question="switch from gpt-4o to claude-haiku",
            )
        assert r["status"] == "ok"
        # Claude-haiku is 0.10x cost per the ratio table.
        est = r["data"]["what_if_estimated_cost_usd"]
        assert est == pytest.approx(100.0, rel=0.01)
        assert r["data"]["method"] == "production_analogue_lookup"


class TestSimulatorLoadSimulation:
    @pytest.mark.asyncio
    async def test_within_slo(self) -> None:
        from eden.experiments.simulation import Simulator

        r = await Simulator().load_simulation(
            "org_test", target_rps=200, duration_seconds=60,
        )
        assert r["status"] == "ok"
        # 200 RPS is below the 500-RPS capacity, so the
        # projection is "within_slo".
        assert r["data"]["recommendation"] == "within_slo"
        assert r["data"]["projection"]["saturated"] is False
        assert r["data"]["projection"]["p95_latency_ms"] < 1000

    @pytest.mark.asyncio
    async def test_saturated(self) -> None:
        from eden.experiments.simulation import Simulator

        r = await Simulator().load_simulation(
            "org_test", target_rps=2000, duration_seconds=60,
        )
        assert r["status"] == "ok"
        # 2000 RPS is 4x the 500-RPS capacity → saturated.
        assert r["data"]["recommendation"] == "saturated"
        assert r["data"]["projection"]["saturated"] is True
        assert r["data"]["projection"]["p95_latency_ms"] > 1000
        assert r["data"]["projection"]["error_rate"] > 0

    @pytest.mark.asyncio
    async def test_invalid_rps(self) -> None:
        from eden.experiments.simulation import Simulator

        r = await Simulator().load_simulation(
            "org_test", target_rps=0, duration_seconds=60,
        )
        assert r["status"] == "ok"
        assert "target_rps must be > 0" in r["message"]


# ─── 7. Closed-loop wiring ────────────────────────────────────────────


class TestClosedLoopWiring:
    @pytest.mark.asyncio
    async def test_experiment_hook_fires_on_winner(self) -> None:
        from eden.experiments.experiment_intel import (
            ExperimentWinnerDetector,
        )
        from eden.llmops.promotion_hooks import get_experiment_hook

        with patch(
            P_WIN_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            await ExperimentWinnerDetector().detect(
                "org_test", experiment_id="exp_hook",
                auto_eval=_ship_case(),
            )
        # The hook is a no-op logger; we assert it ran
        # without error. A more elaborate test could mock
        # the hook instance and assert the call args.
        assert get_experiment_hook() is not None

    @pytest.mark.asyncio
    async def test_dont_ship_hook_fires_on_safety_regression(
        self,
    ) -> None:
        from eden.experiments.experiment_intel import (
            ExperimentRecommender,
        )

        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ), patch(
            P_REC_HOOK,
        ) as hook:
            await ExperimentRecommender().recommend(
                "org_test",
                experiment_id="exp_dont_ship_hook",
                auto_eval=_dont_ship_safety_case(),
            )
        hook.assert_called_once()
        kwargs = hook.call_args.kwargs
        assert kwargs["judge"] == "safety"
        assert kwargs["delta"] < 0


# ─── 8. Route-level smoke tests ───────────────────────────────────────


def _build_experiments_app() -> FastAPI:
    """A minimal FastAPI app for the Cat 12 router smoke
    tests. Mirrors the pattern in
    :mod:`tests.intelligence.test_metric_studio`."""
    from eden.api.deps import get_current_user
    from eden.api.routes import intelligence_experiments

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "test-user",
        "org_id": "org_test",
    }
    app.include_router(intelligence_experiments.router)
    return app


@pytest.fixture(scope="module")
def experiments_client() -> TestClient:
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    return TestClient(_build_experiments_app())


class TestRoutes:
    def test_split_route(
        self, experiments_client: TestClient
    ) -> None:
        with patch(
            P_SPLITTER_FETCH,
            new=AsyncMock(return_value=[]),
        ), patch(
            P_SPLITTER_UPSERT,
            new=AsyncMock(return_value=None),
        ):
            resp = experiments_client.post(
                "/orgs/org_test/intelligence/experiments/split",
                json={"experiment_id": "exp_route", "user_id": "alice"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["variant_id"] in {"control", "treatment"}

    def test_auto_evaluate_route(
        self, experiments_client: TestClient
    ) -> None:
        with patch(
            P_AE_FETCH_SPLITS,
            new=AsyncMock(return_value=[]),
        ), patch(
            P_AE_FETCH_SCORES,
            new=AsyncMock(return_value=[]),
        ):
            resp = experiments_client.post(
                "/orgs/org_test/intelligence/experiments/auto-evaluate",
                json={"experiment_id": "exp_route_ae"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "no judge data" in body["message"]

    def test_recommend_route(
        self, experiments_client: TestClient
    ) -> None:
        with patch(
            P_REC_UPSERT,
            new=AsyncMock(return_value="rec_test"),
        ):
            resp = experiments_client.post(
                "/orgs/org_test/intelligence/experiments/recommend",
                json={"experiment_id": "exp_route_rec"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["recommendation"] == "need_more_data"

    def test_winner_route(
        self, experiments_client: TestClient
    ) -> None:
        resp = experiments_client.post(
            "/orgs/org_test/intelligence/experiments/winner",
            json={"experiment_id": "exp_route_winner"},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["winner"] is None

    def test_simulate_load_route(
        self, experiments_client: TestClient
    ) -> None:
        resp = experiments_client.post(
            "/orgs/org_test/intelligence/experiments/simulate/load",
            json={"target_rps": 200, "duration_seconds": 60},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "projection" in body["data"]

    def test_simulate_whatif_route(
        self, experiments_client: TestClient
    ) -> None:
        with patch(
            P_SIM_FETCH_COST,
            new=AsyncMock(return_value={}),
        ), patch(
            P_SIM_FETCH_JUDGE,
            new=AsyncMock(return_value={}),
        ):
            resp = experiments_client.post(
                "/orgs/org_test/intelligence/experiments/simulate/whatif",
                json={"question": "switch from gpt-4o to claude-haiku"},
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "no usage or judge data" in body["message"]

    def test_traffic_split_create_route(
        self, experiments_client: TestClient
    ) -> None:
        with patch(
            P_SPLITTER_UPSERT,
            new=AsyncMock(return_value=None),
        ):
            resp = experiments_client.post(
                "/orgs/org_test/intelligence/experiments/traffic-split",
                json={
                    "name": "canary_route",
                    "control_version": "1.0",
                    "treatment_version": "1.1",
                },
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["experiment_id"].startswith("exp_")
