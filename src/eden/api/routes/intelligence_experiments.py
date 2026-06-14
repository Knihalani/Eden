"""Intelligence Gap — Experiment + Simulation (Cat 12) routes.

Real implementations (2026-06-12):

* ``POST /split``           — assign a user to a variant
  for an experiment id
* ``POST /traffic-split``   — create or replace a traffic
  split (writes the row in
  ``experiment_traffic_splits``)
* ``GET  /traffic-split``   — list the variants and
  weights for an experiment
* ``POST /auto-evaluate``   — run the Cat 3 judge set on
  every variant of an experiment
* ``GET  /auto-evaluate/latest`` — read the latest
  auto-eval runs for an experiment
* ``POST /recommend``       — return the ship-it
  recommendation for an experiment id (the "ship it /
  don't ship it" call)
* ``POST /winner``          — declare a winner for an
  experiment id with Bayesian confidence
* ``POST /simulate``        — load a saved scenario and
  re-run it
* ``POST /simulate/replay`` — the headline: replay
  ``sample_size`` production traces in staging against
  the candidate version
* ``POST /simulate/whatif`` — "what would happen if I
  switched from gpt-4o to claude-haiku?"
* ``POST /simulate/load``   — synthetic-load projection
  of latency / cost / error rate

Gates:
* ``intelligence_gap_v0`` umbrella flag
* Org scoping via ``{org_id}`` path param
* ``get_current_user`` for auth

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_feature_flag
from eden.experiments.experiment_intel import (
    AutoEvaluator,
    ExperimentRecommender,
    ExperimentWinnerDetector,
    TrafficSplitter,
)
from eden.experiments.simulation import Simulator

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/intelligence/experiments",
    tags=["intelligence-experiments"],
    dependencies=[
        Depends(require_feature_flag("intelligence_gap_v0")),
        Depends(get_current_user),
    ],
)

_splitter = TrafficSplitter()
_auto = AutoEvaluator()
_rec = ExperimentRecommender()
_winner = ExperimentWinnerDetector()
_sim = Simulator()


# ─── 1. TrafficSplitter ──────────────────────────────────────────────


class SplitRequest(BaseModel):
    experiment_id: str | None = None
    name: str | None = None
    user_id: str = Field(..., description="The user id to assign.")


class TrafficSplitCreateRequest(BaseModel):
    name: str = Field(..., description="Friendly name of the experiment.")
    control_version: str
    treatment_version: str
    control_weight: float = 0.99
    treatment_weight: float = 0.01
    duration_hours: int = 24
    stopping_rule: str = "auto"


@router.post("/split")
async def split(
    org_id: str = Path(...),
    body: SplitRequest = Body(...),
) -> dict[str, Any]:
    return await _splitter.split(
        org_id,
        experiment_id=body.experiment_id,
        name=body.name,
        user_id=body.user_id,
    )


@router.post("/traffic-split")
async def traffic_split_create(
    org_id: str = Path(...),
    body: TrafficSplitCreateRequest = Body(...),
) -> dict[str, Any]:
    return await _splitter.create_split(
        org_id,
        name=body.name,
        control_version=body.control_version,
        treatment_version=body.treatment_version,
        control_weight=body.control_weight,
        treatment_weight=body.treatment_weight,
        duration_hours=body.duration_hours,
        stopping_rule=body.stopping_rule,
    )


@router.get("/traffic-split")
async def traffic_split_list(
    org_id: str = Path(...),
    experiment_id: str | None = None,
    name: str | None = None,
) -> dict[str, Any]:
    return await _splitter.list_splits(
        org_id, experiment_id=experiment_id, name=name,
    )


# ─── 2. AutoEvaluator ────────────────────────────────────────────────


class AutoEvalRequest(BaseModel):
    experiment_id: str
    judges: list[str] | None = None


@router.post("/auto-evaluate")
async def auto_evaluate(
    org_id: str = Path(...),
    body: AutoEvalRequest = Body(...),
) -> dict[str, Any]:
    return await _auto.evaluate(
        org_id,
        experiment_id=body.experiment_id,
        judges=body.judges,
    )


@router.get("/auto-evaluate/latest")
async def auto_evaluate_latest(
    org_id: str = Path(...),
    experiment_id: str = ...,
) -> dict[str, Any]:
    return await _auto.latest(org_id, experiment_id=experiment_id)


# ─── 3. Recommender ─────────────────────────────────────────────────


class RecommendRequest(BaseModel):
    experiment_id: str


@router.post("/recommend")
async def recommend(
    org_id: str = Path(...),
    body: RecommendRequest = Body(...),
) -> dict[str, Any]:
    return await _rec.recommend(
        org_id, experiment_id=body.experiment_id,
    )


# ─── 4. WinnerDetector ───────────────────────────────────────────────


class WinnerRequest(BaseModel):
    experiment_id: str


@router.post("/winner")
async def winner(
    org_id: str = Path(...),
    body: WinnerRequest = Body(...),
) -> dict[str, Any]:
    return await _winner.detect(
        org_id, experiment_id=body.experiment_id,
    )


# ─── 5. Simulator ────────────────────────────────────────────────────


class ScenarioRequest(BaseModel):
    scenario_id: str | None = None
    name: str | None = None
    parameters: dict[str, Any] | None = None


class ReplayRequest(BaseModel):
    production_window_start: str
    production_window_end: str
    candidate_version: str
    judges: list[str] | None = None
    sample_size: int = 5_000
    scenario_name: str | None = None


class WhatIfRequest(BaseModel):
    question: str
    baseline_window_start: str | None = None
    baseline_window_end: str | None = None


class LoadSimRequest(BaseModel):
    target_rps: int
    duration_seconds: int


@router.post("/simulate")
async def simulate(
    org_id: str = Path(...),
    body: ScenarioRequest = Body(...),
) -> dict[str, Any]:
    return await _sim.simulate_scenario(
        org_id,
        scenario_id=body.scenario_id,
        name=body.name,
        parameters=body.parameters,
    )


@router.post("/simulate/replay")
async def simulate_replay(
    org_id: str = Path(...),
    body: ReplayRequest = Body(...),
) -> dict[str, Any]:
    return await _sim.replay_production_in_staging(
        org_id,
        production_window_start=body.production_window_start,
        production_window_end=body.production_window_end,
        candidate_version=body.candidate_version,
        judges=body.judges,
        sample_size=body.sample_size,
        scenario_name=body.scenario_name,
    )


@router.post("/simulate/whatif")
async def whatif(
    org_id: str = Path(...),
    body: WhatIfRequest = Body(...),
) -> dict[str, Any]:
    return await _sim.what_if_analysis(
        org_id,
        question=body.question,
        baseline_window_start=body.baseline_window_start,
        baseline_window_end=body.baseline_window_end,
    )


@router.post("/simulate/load")
async def load(
    org_id: str = Path(...),
    body: LoadSimRequest = Body(...),
) -> dict[str, Any]:
    return await _sim.load_simulation(
        org_id,
        target_rps=body.target_rps,
        duration_seconds=body.duration_seconds,
    )
