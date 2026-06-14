"""Cat 12 — :class:`ExperimentWinnerDetector`.

Declare a winner for an A/B/n experiment with Bayesian
confidence, then fire the :func:`ExperimentHook.on_winner`
closed-loop hook so the Phase 5 implementation can archive
the losing variants.

The detector is the **endpoint** of the experiment
lifecycle:

1. :class:`TrafficSplitter` runs the experiment traffic.
2. :class:`AutoEvaluator` aggregates the judge scores.
3. :class:`ExperimentRecommender` returns the ship-it call.
4. :class:`ExperimentWinnerDetector` declares the winner
   (and writes the ``winner`` column on the
   :data:`experiment_traffic_splits` row).

The decision rule is the per-judge Bayesian posterior
(:func:`eden.experiments._common._prob_treatment_better`).
We aggregate across hard judges — treatment wins the
experiment iff:

* treatment wins the per-judge posterior on at least
  ``ceil(hard_judges / 2)`` hard judges, AND
* no hard judge favours control with posterior
  ``> TREATMENT_WIN_THRESHOLD`` (else it's a regression,
  not a win — the recommender should already have
  short-circuited to ``dont_ship``).

The detector degrades gracefully when its dependencies are
missing or empty — an empty auto-eval run returns the
``"no judge data"`` envelope with a friendly hint.

Routes exposed:

* ``POST /orgs/{org_id}/intelligence/experiments/winner`` —
  declare a winner for an experiment id.

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

import logging
import random
from typing import Any

from eden.experiments._common import (
    HARD_JUDGES,
    MIN_N_PER_ARM,
    TREATMENT_WIN_THRESHOLD,
    _fetch_eval_runs,
    _fire_winner_hook,
    _prob_treatment_better,
    _safe_float,
    _upsert_recommendation,
    empty_envelope,
    ok_envelope,
)

logger = logging.getLogger(__name__)


class ExperimentWinnerDetector:
    """Per-judge Bayesian winner detection for an experiment.

    The :class:`name` is ``"experiment_winner_detector"`
    and matches the ``feature`` field in the response
    envelope.
    """

    name = "experiment_winner_detector"

    async def detect(
        self,
        org_id: str,
        *,
        experiment_id: str,
        auto_eval: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Declare a winner for ``experiment_id``.

        The caller may pass an explicit ``auto_eval``
        payload (per-judge per-variant median dict);
        otherwise we read the persisted
        :data:`experiment_auto_eval_runs` rows. The
        result is persisted as a recommendation row
        (``recommendation = ship | dont_ship | …``) so
        the audit log has a single record of the
        decision.
        """
        if not experiment_id:
            return empty_envelope(
                self.name, message="experiment_id is required",
            )
        # ── 1. Per-judge per-variant comparison ────────
        if auto_eval is not None:
            comparison = _reshape(auto_eval)
        else:
            comparison = await _load_comparison(org_id, experiment_id)
        if not comparison:
            return empty_envelope(
                self.name,
                message=(
                    "no auto-eval data — call /auto-evaluate first"
                ),
                data={
                    "experiment_id": experiment_id,
                    "winner": None,
                    "confidence": 0.0,
                },
            )
        # ── 2. Per-judge posterior + winner label ──────
        # We build a NEW judge_winners dict so the caller's
        # payload is never mutated.
        rng = random.Random(0xBADA55 ^ hash(experiment_id) & 0xFFFFFFFF)
        judge_winners: dict[str, dict[str, Any]] = {}
        for judge, per_variant in comparison.items():
            control = per_variant.get("control") or {}
            treatment = per_variant.get("treatment") or {}
            c_med = _safe_float(control.get("median"))
            t_med = _safe_float(treatment.get("median"))
            c_n = int(control.get("n") or 0)
            t_n = int(treatment.get("n") or 0)
            posterior = _prob_treatment_better(
                control_score=c_med or 0.5, control_n=c_n,
                treatment_score=t_med or 0.5, treatment_n=t_n,
                rng=rng,
            )
            judge_winners[judge] = {
                "control_median": c_med,
                "treatment_median": t_med,
                "control_n": c_n,
                "treatment_n": t_n,
                "delta": round(t_med - c_med, 4),
                "prob_treatment_better": round(posterior, 4),
                "winner": _label(posterior),
            }
        # ── 3. Min-n check ────────────────────────────
        min_n = min(
            (int((per_variant.get("control") or {}).get("n") or 0)
             for per_variant in comparison.values()),
            default=0,
        )
        if min_n < MIN_N_PER_ARM:
            return empty_envelope(
                self.name,
                message=(
                    f"per-arm observation count {min_n} is below "
                    f"the required minimum of {MIN_N_PER_ARM}"
                ),
                data={
                    "experiment_id": experiment_id,
                    "winner": None,
                    "judge_winners": judge_winners,
                    "reason": "need_more_data",
                },
            )
        # ── 4. Hard-judge veto ────────────────────────
        for judge in HARD_JUDGES:
            jw = judge_winners.get(judge)
            if not jw:
                continue
            if jw["prob_treatment_better"] <= 1.0 - TREATMENT_WIN_THRESHOLD:
                return await _persist(
                    org_id=org_id, experiment_id_str=experiment_id,
                    winner="control", confidence=round(1.0 - jw["prob_treatment_better"], 4),
                    judge_winners=judge_winners,
                    recommendation="dont_ship",
                    rationale=(
                        f"hard judge {judge!r} favours control with "
                        f"posterior {jw['prob_treatment_better']:.2f}"
                    ),
                )
        # ── 5. Hard-judge majority ────────────────────
        hard_votes = [
            judge_winners[judge]["winner"]
            for judge in HARD_JUDGES
            if judge in judge_winners
        ]
        if not hard_votes:
            return empty_envelope(
                self.name,
                message="no hard-judge data — collect more data first",
                data={
                    "experiment_id": experiment_id,
                    "winner": None,
                    "judge_winners": judge_winners,
                    "reason": "no_hard_judges",
                },
            )
        treatment_wins = sum(1 for v in hard_votes if v == "treatment")
        control_wins = sum(1 for v in hard_votes if v == "control")
        ties = sum(1 for v in hard_votes if v == "tie")
        if treatment_wins > control_wins:
            winner = "treatment"
            confidence = max(
                judge_winners[judge]["prob_treatment_better"]
                for judge in HARD_JUDGES
                if judge in judge_winners
            )
        elif control_wins > treatment_wins:
            winner = "control"
            confidence = 1.0 - min(
                judge_winners[judge]["prob_treatment_better"]
                for judge in HARD_JUDGES
                if judge in judge_winners
            )
        else:
            # Equal hard-vote counts → no clear winner.
            return await _persist(
                org_id=org_id, experiment_id_str=experiment_id,
                winner="tie", confidence=0.5,
                judge_winners=judge_winners,
                recommendation="tie",
                rationale=(
                    f"hard-judge vote split is {treatment_wins}T / "
                    f"{control_wins}C / {ties}tie — no clear winner"
                ),
            )
        return await _persist(
            org_id=org_id, experiment_id_str=experiment_id,
            winner=winner, confidence=round(confidence, 4),
            judge_winners=judge_winners,
            recommendation="ship" if winner == "treatment" else "dont_ship",
            rationale=(
                f"hard-judge vote is {treatment_wins}T / "
                f"{control_wins}C / {ties}tie; winner is {winner!r} "
                f"with confidence {confidence:.2f}"
            ),
        )


# ── Private helpers ───────────────────────────────────────────────────


def _label(posterior: float) -> str:
    if posterior >= TREATMENT_WIN_THRESHOLD:
        return "treatment"
    if posterior <= 1.0 - TREATMENT_WIN_THRESHOLD:
        return "control"
    return "tie"


def _reshape(payload: Any) -> dict[str, dict[str, dict[str, Any]]]:
    """Reshape the caller's payload into the per-judge
    per-variant dict the detector iterates over. Accepts
    the nested form (``{judge: {variant: {n, median, …}}}``)
    or a flat list of persisted rows."""
    if isinstance(payload, list):
        out: dict[str, dict[str, dict[str, Any]]] = {}
        for row in payload:
            judge = str(row.get("judge") or row.get("judge_name") or "")
            variant = str(row.get("variant") or "")
            if not judge or not variant:
                continue
            out.setdefault(judge, {})[variant] = {
                "n": int(row.get("n") or 0),
                "median": _safe_float(row.get("median") or row.get("score_median")),
                "p5": _safe_float(row.get("p5") or row.get("score_p5")),
                "p95": _safe_float(row.get("p95") or row.get("score_p95")),
            }
        return out
    if isinstance(payload, dict):
        return payload  # already nested
    return {}


async def _load_comparison(
    org_id: str, experiment_id: str,
) -> dict[str, dict[str, dict[str, Any]]]:
    rows = await _fetch_eval_runs(org_id, experiment_id)
    return _reshape(rows)


async def _persist(
    *,
    org_id: str, experiment_id_str: str,
    winner: str, confidence: float,
    judge_winners: dict[str, Any],
    recommendation: str, rationale: str,
) -> dict[str, Any]:
    # Persist the decision as a recommendation row so the
    # audit log has a single record.
    rec_id = await _upsert_recommendation(
        org_id=org_id, exp_id=experiment_id_str,
        recommendation=recommendation, confidence=confidence,
        rationale=rationale,
        judge_comparison=judge_winners,
        ship_conditions=[],
    )
    # Fire the closed-loop hook so the Phase 5
    # implementation can archive the losing variants.
    _fire_winner_hook(
        org_id=org_id,
        experiment_id_str=experiment_id_str,
        winner_variant=winner,
    )
    return ok_envelope(
        "experiment_winner_detector",
        data={
            "experiment_id": experiment_id_str,
            "winner": winner,
            "confidence": confidence,
            "judge_winners": judge_winners,
            "recommendation_id": rec_id,
            "recommendation": recommendation,
            "rationale": rationale,
        },
    )


__all__ = ["ExperimentWinnerDetector"]
