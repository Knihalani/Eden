"""Cat 12 — :class:`ExperimentRecommender`.

The "ship it / don't ship it" call. The recommender reads
the latest auto-eval results (from
:data:`experiment_auto_eval_runs`, populated by
:class:`AutoEvaluator`), applies the 6-case decision tree
documented in the appendix, and writes the
recommendation row to :data:`experiment_recommendations`.

The decision tree:

1. **need_more_data** — fewer than
   :data:`MIN_N_PER_ARM` observations per arm on the
   primary judge. We never recommend shipping without
   enough data.
2. **dont_ship (safety / groundedness regression)** — a
   "hard" judge (safety, groundedness, action_completion)
   favours control with posterior ``> 0.95`` (i.e.
   treatment is worse with high confidence). Fires
   :func:`PromotionHook.on_judge_regression` for the
   regressing judge.
3. **dont_ship (judge-floor violation)** — treatment's
   median score on a hard judge is below an absolute
   floor (``0.6`` for safety / groundedness). Independent
   of the Bayesian comparison; an absolute floor violation
   always means don't ship.
4. **ship_with_monitoring** — treatment wins on the hard
   judges but a soft judge is materially worse
   (delta ``< -0.05``). Recommended ship, but the soft-
   judge delta is surfaced in the rationale so the
   operator can decide whether to ship anyway.
5. **tie** — no judge is significantly different and the
   per-judge deltas are all within ``0.02``. Default to
   "no recommendation; keep collecting data".
6. **ship** — treatment wins on the hard judges and the
   soft judges are not materially worse.

The recommender is the **most-asked customer question**
("should I ship the new prompt?") and is also the entry
point for the v2 simulation surfaces — a "ship_with_monitoring"
recommendation includes a "next step: run a
:func:`Simulator.replay_production_in_staging` simulation
on the top-1 000 production traces" hint.

Routes exposed:

* ``POST /orgs/{org_id}/intelligence/experiments/recommend`` —
  return the ship-it recommendation for an experiment id.
* ``GET  /orgs/{org_id}/intelligence/experiments/recommendations`` —
  list the persisted recommendations for the org.

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
    _fire_dont_ship_hook,
    _prob_treatment_better,
    _safe_float,
    _upsert_recommendation,
    empty_envelope,
    ok_envelope,
)

logger = logging.getLogger(__name__)


#: Minimum absolute score on a hard judge — below this the
#: recommender always says ``dont_ship`` regardless of the
#: Bayesian comparison (e.g. a 0.55 hallucination rate is
#: unacceptable no matter how good the control was).
HARD_JUDGE_FLOOR: float = 0.6

#: Soft-judge "material regression" threshold. A soft judge
#: whose treatment median is ``> MATERIALLY_WORSE`` below
#: the control median flips the recommendation to
#: ``ship_with_monitoring``.
SOFT_JUDGE_MATERIAL_REGRESSION: float = 0.05

#: Tie-detection threshold. If the largest per-judge
#: absolute delta is below this, the recommendation is
#: ``tie`` (i.e. no clear winner).
TIE_DELTA_THRESHOLD: float = 0.02

#: Low-confidence threshold for the per-judge Bayesian
#: posterior. If the largest ``prob_treatment_better`` is
#: between ``0.4`` and ``0.6``, the recommender says
#: ``low_confidence``.
LOW_CONFIDENCE_LOW: float = 0.4
LOW_CONFIDENCE_HIGH: float = 0.6


class ExperimentRecommender:
    """Ship-it / don't-ship-it decision for an experiment.

    The :class:`name` is ``"experiment_recommender"`` and
    matches the ``feature`` field in the response envelope.
    """

    name = "experiment_recommender"

    async def recommend(
        self,
        org_id: str,
        *,
        experiment_id: str,
        auto_eval: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Return the recommendation for ``experiment_id``.

        The caller may pass an explicit ``auto_eval`` (a
        per-judge per-variant median dict from
        :class:`AutoEvaluator`); otherwise the recommender
        uses an in-memory aggregate so the route is always
        callable. The "no data" path is the same as the
        "need more data" path — a friendly hint to the UI.
        """
        if not experiment_id:
            return empty_envelope(
                self.name, message="experiment_id is required",
            )
        # ── 1. Per-judge per-variant comparison ────────
        comparison, totals = _build_comparison(auto_eval)
        # ── 2. need_more_data? ─────────────────────────
        if not comparison:
            return empty_envelope(
                self.name,
                message=(
                    "no auto-eval data — call /auto-evaluate first "
                    "or run more traffic through the experiment"
                ),
                data={
                    "experiment_id": experiment_id,
                    "recommendation": "need_more_data",
                    "confidence": 0.0,
                },
            )
        # ── 3. Compute per-judge deltas and posterior ──
        # We build a NEW per_variant dict per judge so the
        # caller's payload is never mutated. Sharing the
        # inner ``control``/``treatment`` sub-dicts is
        # fine — those are read-only here.
        rng = random.Random(0xC0FFEE ^ hash(experiment_id) & 0xFFFFFFFF)
        augmented: dict[str, dict[str, Any]] = {}
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
            augmented[judge] = {
                "control": control,
                "treatment": treatment,
                "delta": round(t_med - c_med, 4),
                "prob_treatment_better": round(posterior, 4),
                "winner": _winner_label(posterior),
            }
        comparison = augmented
        # ── 4. Min-n check (need_more_data) ────────────
        min_n = min(
            (int(per_variant.get("control", {}).get("n") or 0)
             for per_variant in comparison.values()),
            default=0,
        )
        if min_n < MIN_N_PER_ARM:
            return await _persist(
                org_id=org_id, experiment_id_str=experiment_id,
                recommendation="need_more_data", confidence=0.0,
                rationale=(
                    f"per-arm observation count {min_n} is below the "
                    f"required minimum of {MIN_N_PER_ARM}"
                ),
                judge_comparison=comparison,
                ship_conditions=[],
            )
        # ── 5. dont_ship (hard judge absolute floor) ──
        # The floor is a safety guard that short-circuits
        # every other check — an absolute floor violation
        # is a "don't ship" regardless of the Bayesian
        # posterior, sample size, or other judges. We
        # check it before the Bayesian regression so a
        # floor violation on a near-tie judge still
        # triggers ``dont_ship``.
        floor_violation = _check_floor_violation(comparison)
        if floor_violation is not None:
            judge, score = floor_violation
            _fire_dont_ship_hook(
                org_id=org_id, experiment_id_str=experiment_id,
                judge=judge, delta=score - HARD_JUDGE_FLOOR,
            )
            return await _persist(
                org_id=org_id, experiment_id_str=experiment_id,
                recommendation="dont_ship", confidence=0.92,
                rationale=(
                    f"hard judge {judge!r} treatment median "
                    f"{score:.2f} is below the absolute floor "
                    f"{HARD_JUDGE_FLOOR:.2f}"
                ),
                judge_comparison=comparison,
                ship_conditions=[],
            )
        # ── 6. dont_ship (hard judge Bayesian regression)
        hard_regression = _check_hard_regression(comparison)
        if hard_regression is not None:
            judge, posterior, delta = hard_regression
            _fire_dont_ship_hook(
                org_id=org_id, experiment_id_str=experiment_id,
                judge=judge, delta=delta,
            )
            return await _persist(
                org_id=org_id, experiment_id_str=experiment_id,
                recommendation="dont_ship",
                confidence=round(1.0 - posterior, 4),
                rationale=(
                    f"hard judge {judge!r} favours control "
                    f"(posterior {posterior:.2f} < "
                    f"{TREATMENT_WIN_THRESHOLD:.2f}); regression "
                    f"of {delta:+.2f}"
                ),
                judge_comparison=comparison,
                ship_conditions=[],
            )
        # ── 7. tie (no judge is materially different) ─
        max_delta = max(
            abs(per_variant.get("delta", 0.0))
            for per_variant in comparison.values()
        )
        if max_delta < TIE_DELTA_THRESHOLD:
            return await _persist(
                org_id=org_id, experiment_id_str=experiment_id,
                recommendation="tie", confidence=0.5,
                rationale=(
                    f"largest per-judge absolute delta is "
                    f"{max_delta:.3f} (< {TIE_DELTA_THRESHOLD:.3f}); "
                    "no clear winner"
                ),
                judge_comparison=comparison,
                ship_conditions=[],
            )
        # ── 8. low_confidence (wide posterior band) ────
        max_posterior = max(
            per_variant.get("prob_treatment_better", 0.5)
            for per_variant in comparison.values()
        )
        if (
            LOW_CONFIDENCE_LOW <= max_posterior <= LOW_CONFIDENCE_HIGH
        ):
            return await _persist(
                org_id=org_id, experiment_id_str=experiment_id,
                recommendation="low_confidence",
                confidence=round(max_posterior, 4),
                rationale=(
                    f"largest per-judge posterior "
                    f"{max_posterior:.2f} is in the "
                    f"[{LOW_CONFIDENCE_LOW:.2f}, "
                    f"{LOW_CONFIDENCE_HIGH:.2f}] band; collect more "
                    "data before shipping"
                ),
                judge_comparison=comparison,
                ship_conditions=[],
            )
        # ── 9. ship_with_monitoring (soft judge regression)
        soft_regression = _check_soft_regression(comparison)
        if soft_regression is not None:
            judge, delta = soft_regression
            ship_conditions = _build_ship_conditions(comparison)
            return await _persist(
                org_id=org_id, experiment_id_str=experiment_id,
                recommendation="ship_with_monitoring",
                confidence=round(max_posterior, 4),
                rationale=(
                    f"hard judges favor treatment, but soft judge "
                    f"{judge!r} regressed {delta:+.2f} (below the "
                    f"{-SOFT_JUDGE_MATERIAL_REGRESSION:+.2f} "
                    "threshold); ship with monitoring on that judge"
                ),
                judge_comparison=comparison,
                ship_conditions=ship_conditions,
            )
        # ── 10. ship ─────────────────────────────────
        ship_conditions = _build_ship_conditions(comparison)
        return await _persist(
            org_id=org_id, experiment_id_str=experiment_id,
            recommendation="ship", confidence=round(max_posterior, 4),
            rationale=(
                f"all hard judges favor treatment; largest per-judge "
                f"posterior {max_posterior:.2f} exceeds the "
                f"{TREATMENT_WIN_THRESHOLD:.2f} threshold; "
                f"max delta {max_delta:+.3f}"
            ),
            judge_comparison=comparison,
            ship_conditions=ship_conditions,
        )


# ── Private helpers ───────────────────────────────────────────────────


def _build_comparison(
    auto_eval: dict[str, Any] | None,
) -> tuple[dict[str, dict[str, dict[str, Any]]], dict[str, int]]:
    """Normalise the auto-eval payload into the per-judge
    per-variant shape the recommender iterates over. Accepts
    a None (in which case the comparison is empty), a dict
    keyed by ``judge`` → ``variant`` → ``{n, median, …}``,
    or a flat list of ``{judge, variant, n, median, …}``
    rows from the persisted auto-eval-runs table.
    """
    if not auto_eval:
        return {}, {}
    # If the caller passed the persisted rows (flat list
    # of dicts), reshape to the nested form.
    if isinstance(auto_eval, list):
        flat = auto_eval
        nested: dict[str, dict[str, dict[str, Any]]] = {}
        for row in flat:
            judge = str(row.get("judge") or row.get("judge_name") or "")
            variant = str(row.get("variant") or "")
            if not judge or not variant:
                continue
            nested.setdefault(judge, {})[variant] = {
                "n": int(row.get("n") or 0),
                "median": _safe_float(row.get("median") or row.get("score_median")),
                "p5": _safe_float(row.get("p5") or row.get("score_p5")),
                "p95": _safe_float(row.get("p95") or row.get("score_p95")),
            }
        auto_eval = nested
    totals = {
        judge: sum(int(v.get("n", 0)) for v in variants.values())
        for judge, variants in auto_eval.items()
    }
    return auto_eval, totals


def _winner_label(posterior: float) -> str:
    if posterior >= TREATMENT_WIN_THRESHOLD:
        return "treatment"
    if posterior <= 1.0 - TREATMENT_WIN_THRESHOLD:
        return "control"
    return "tie"


def _check_hard_regression(
    comparison: dict[str, dict[str, dict[str, Any]]],
) -> tuple[str, float, float] | None:
    """Return the first hard judge that favours control with
    posterior ``> TREATMENT_WIN_THRESHOLD`` (= the
    control-favours threshold), or None when no hard judge
    regresses."""
    for judge in HARD_JUDGES:
        per_variant = comparison.get(judge)
        if not per_variant:
            continue
        posterior = per_variant.get("prob_treatment_better", 0.5)
        if posterior <= 1.0 - TREATMENT_WIN_THRESHOLD:
            return judge, posterior, per_variant.get("delta", 0.0)
    return None


def _check_floor_violation(
    comparison: dict[str, dict[str, dict[str, Any]]],
) -> tuple[str, float] | None:
    """Return the first hard judge whose treatment median is
    below :data:`HARD_JUDGE_FLOOR`."""
    for judge in HARD_JUDGES:
        per_variant = comparison.get(judge)
        if not per_variant:
            continue
        treatment = per_variant.get("treatment") or {}
        score = _safe_float(treatment.get("median"))
        if score and score < HARD_JUDGE_FLOOR:
            return judge, score
    return None


def _check_soft_regression(
    comparison: dict[str, dict[str, dict[str, Any]]],
) -> tuple[str, float] | None:
    """Return the first soft judge whose treatment median is
    materially below the control median (delta ``<
    -SOFT_JUDGE_MATERIAL_REGRESSION``), or None when no
    soft judge regresses.
    """
    for judge in SOFT_JUDGES_CACHED:
        per_variant = comparison.get(judge)
        if not per_variant:
            continue
        delta = per_variant.get("delta", 0.0)
        if delta < -SOFT_JUDGE_MATERIAL_REGRESSION:
            return judge, delta
    return None


# The frozenset of soft judges is constant; cache the
# iteration order for stable tests.
SOFT_JUDGES_CACHED = (
    "relevance", "satisfaction", "tool_selection_quality", "reasoning_coherence",
)


def _build_ship_conditions(
    comparison: dict[str, dict[str, dict[str, Any]]],
) -> list[str]:
    """Build the human-readable "ship conditions" list — the
    bullet points the operator can copy into a release
    ticket. Always returns at least one bullet so the
    ``data.ship_conditions`` field is non-empty on a
    ship / ship_with_monitoring recommendation.
    """
    bullets: list[str] = []
    for judge in HARD_JUDGES:
        per_variant = comparison.get(judge)
        if not per_variant:
            continue
        treatment = per_variant.get("treatment") or {}
        median = _safe_float(treatment.get("median"))
        if median:
            bullets.append(
                f"treatment.{judge} > {HARD_JUDGE_FLOOR:.2f} "
                f"(passes: {median:.2f})"
            )
    if not bullets:
        bullets.append("no hard-judge data — collect at least "
                       f"{MIN_N_PER_ARM} traces per arm before shipping")
    return bullets


async def _persist(
    *,
    org_id: str, experiment_id_str: str,
    recommendation: str, confidence: float,
    rationale: str,
    judge_comparison: dict[str, Any],
    ship_conditions: list[str],
) -> dict[str, Any]:
    """Persist the recommendation row and return the live
    envelope. The persisted id is returned in
    ``data.recommendation_id`` so the front-end can deep-
    link to the audit log.
    """
    rec_id = await _upsert_recommendation(
        org_id=org_id, exp_id=experiment_id_str,
        recommendation=recommendation, confidence=confidence,
        rationale=rationale,
        judge_comparison=judge_comparison,
        ship_conditions=ship_conditions,
    )
    return ok_envelope(
        "experiment_recommender",
        data={
            "experiment_id": experiment_id_str,
            "recommendation_id": rec_id,
            "recommendation": recommendation,
            "confidence": confidence,
            "rationale": rationale,
            "judge_comparison": judge_comparison,
            "ship_conditions": ship_conditions,
        },
    )


__all__ = [
    "ExperimentRecommender",
    "HARD_JUDGE_FLOOR",
    "SOFT_JUDGE_MATERIAL_REGRESSION",
    "TIE_DELTA_THRESHOLD",
    "LOW_CONFIDENCE_LOW",
    "LOW_CONFIDENCE_HIGH",
]
