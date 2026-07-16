"""Shared helpers for Cat 12 — Experimentation Intelligence.

The eight services (:class:`TrafficSplitter`,
:class:`AutoEvaluator`, :class:`ExperimentRecommender`,
:class:`ExperimentWinnerDetector`, and the four
:class:`Simulator` methods) share five concerns:

* **Envelope shape** — every route returns the
  ``status / feature / live / data / trace_id`` envelope from
  :mod:`eden.intelligence_envelope`. The Cat 12 happy paths
  return ``status: "ok"`` with ``live: true``; the empty-data
  paths return ``status: "ok"`` with a
  ``"no <thing> data"`` message so the UI can render a clear
  "preview" hint.

* **Persistence helpers** — the four Cat 12 tables
  (``experiment_traffic_splits``,
  ``experiment_auto_eval_runs``,
  ``experiment_recommendations``, ``simulation_scenarios``,
  ``simulation_runs``, ``what_if_analyses``) live in
  ``db_migrations/versions/020_intelligence_gap_tables.py``.
  The helpers in this module insert into them with the same
  ``ON CONFLICT`` / delete-then-insert pattern used by
  :mod:`eden.services.cost_intel` and
  :mod:`eden.analytics.outcomes.tracker` so re-running an
  evaluator overwrites the previous result idempotently.

* **Bayesian beta-binomial math** — the winner detector and
  the recommender both need ``P(treatment > control | data)``
  for a per-judge score in ``[0, 1]``. We model the score as
  ``Beta(1 + wins, 1 + n - wins)`` per arm (a uniform
  Beta(1,1) prior) and compute the posterior probability
  via Monte Carlo sampling of 4 000 draws. The Monte Carlo
  estimate has ≤ 1 pp error at the 95 % confidence level
  with that many draws.

* **Deterministic id builders** — the experiment id, the
  eval run id, the recommendation id, the scenario id, the
  simulation run id, and the what-if analysis id are all
  content-derived (``exp_<sha256[:16]>`` etc.) so re-running
  the same operation on the same input produces the same id,
  making the services re-runnable in the test suite without
  collisions.

* **Closed-loop wiring** — the
  :func:`_fire_winner_hook`,
  :func:`_fire_dont_ship_hook`, and
  :func:`_fire_simulation_drift_hook` helpers delegate to
  the existing no-op :class:`ExperimentHook`,
  :class:`PromotionHook` instances so the stubs become
  active the moment a real implementation lands. See
  :mod:`eden.llmops.promotion_hooks`.

The package degrades gracefully when its dependencies are
missing or empty — the typical Eden pattern. An empty
``judge_scores`` table returns a ``"no judge data"`` envelope;
an empty ``telemetry_events`` table returns a
``"no production traces"`` envelope.

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import random
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any, cast

logger = logging.getLogger(__name__)


# ── Tunable thresholds ─────────────────────────────────────────────────

#: Minimum number of observations per arm before the
#: :class:`ExperimentWinnerDetector` will declare a winner.
#: Below this, the recommendation is ``need_more_data``.
MIN_N_PER_ARM: int = 100

#: Posterior probability threshold for declaring
#: ``treatment`` the winner on a per-judge basis. Per the
#: 2026 A/B test methodology reference, ``0.95`` is the
#: industry-standard cutoff; below that we say ``tie`` or
#: ``control``.
TREATMENT_WIN_THRESHOLD: float = 0.95

#: Posterior probability threshold for declaring ``control``
#: the winner (i.e. treatment regressed). Symmetric to
#: :data:`TREATMENT_WIN_THRESHOLD`.
CONTROL_WIN_THRESHOLD: float = 0.05

#: Number of Monte Carlo draws used by
#: :func:`_prob_treatment_better`. 4 000 draws gives ≤ 1 pp
#: error at the 95 % confidence level per a standard normal
#: approximation of the Beta posterior.
BAYESIAN_MC_DRAWS: int = 4_000

#: Default sample size for :meth:`Simulator.replay_production_in_staging`
#: when the caller doesn't specify one. 5 000 traces is the
#: design default per the appendix; lower for fast tests.
DEFAULT_REPLAY_SAMPLE_SIZE: int = 5_000

#: Hard upper bound on the replay sample size — keeps the
#: simulator's wall-clock bounded even when the caller asks
#: for the entire production window.
MAX_REPLAY_SAMPLE_SIZE: int = 50_000

#: Default judges when the caller doesn't specify one. Axes are
#: produced by :class:`UnifiedJudge` (one LLM call) plus
#: :class:`SatisfactionJudge` (SQL / feedback, no LLM).
DEFAULT_JUDGES: tuple[str, ...] = (
    "hallucination",
    "correctness",
    "groundedness",
    "safety",
    "satisfaction",
    "action_completion",
    "tool_selection_quality",
    "reasoning_coherence",
)

#: "Hard" judges that must favor ``treatment`` for the
#: recommender to ever return ``ship``. A regression on any
#: hard judge short-circuits the decision tree to
#: ``dont_ship`` even if the other judges look great.
HARD_JUDGES: frozenset[str] = frozenset(
    {"safety", "groundedness", "action_completion", "hallucination"}
)

#: "Soft" judges — useful signals, but a regression on one
#: is acceptable if the hard judges pass.
SOFT_JUDGES: frozenset[str] = frozenset(
    {
        "correctness",
        "satisfaction",
        "tool_selection_quality",
        "reasoning_coherence",
    }
)

#: Judges the recommender always looks at (union of HARD and
#: SOFT — kept as a list of names for stable iteration order).
ALL_JUDGES: tuple[str, ...] = (
    "safety",
    "groundedness",
    "action_completion",
    "hallucination",
    "correctness",
    "satisfaction",
    "tool_selection_quality",
    "reasoning_coherence",
)

#: Latency / cost budget defaults — the "ship conditions" the
#: recommender checks before signing off. The numbers match
#: the appendix's example payload.
LATENCY_P95_BUDGET_MS: float = 1500.0
COST_PER_1K_TOKENS_BUDGET_USD: float = 5.0


# ── Envelope helpers ───────────────────────────────────────────────────


def _new_trace_id() -> str:
    """Cat 12-prefixed trace id — distinguishes live responses
    from Cat 1/2/8/16 in the audit log."""
    return f"exp_{uuid.uuid4().hex[:12]}"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def ok_envelope(
    feature: str, *, data: dict[str, Any] | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    """The Cat 12 success envelope (``status: "ok"``,
    ``live: true``)."""
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": data or {},
        "message": message,
    }


def empty_envelope(
    feature: str, *, message: str,
    data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The Cat 12 "no data" envelope.

    ``status`` is still ``"ok"`` (the route is live and
    reachable) but ``live`` is still ``True`` and
    ``data`` carries the empty-state hint. The front-end
    renders a "no data" badge off the ``message`` field.
    """
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": data or {},
        "message": message,
    }


def bad_request_envelope(
    feature: str, *, message: str,
) -> dict[str, Any]:
    """The Cat 12 bad-request envelope (``status: "error"``,
    ``live: true``)."""
    return {
        "status": "error",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": _now_iso(),
        "data": {},
        "message": message,
    }


# ── Id builders ────────────────────────────────────────────────────────


def _content_id(prefix: str, *parts: str) -> str:
    """Content-derived id. ``parts`` is hashed in order; the
    same tuple yields the same id, making the services
    re-runnable in the test suite without collisions.
    """
    payload = "|".join(str(p) for p in parts)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}_{digest}"


def experiment_id(org_id: str, name: str) -> str:
    """The :class:`TrafficSplitter` experiment id.

    Re-using the same ``(org_id, name)`` returns the same id,
    so a user who re-issues the same traffic split (e.g. from
    a retry, or a Terraform re-apply) gets the same
    ``experiment_id`` and the same row in
    ``experiment_traffic_splits``.
    """
    return _content_id("exp", org_id, name)


def eval_run_id(org_id: str, experiment_id_str: str, judge: str) -> str:
    return _content_id("eval", org_id, experiment_id_str, judge)


def recommendation_id(
    org_id: str, experiment_id_str: str, judge_comparison: dict[str, Any]
) -> str:
    """Recommendation id is content-derived from the
    judge-comparison dict, so two re-runs of the recommender
    on the same input produce the same id (and the same
    persisted row in ``experiment_recommendations``).
    """
    payload = json.dumps(
        judge_comparison, sort_keys=True, default=str
    )
    return _content_id("rec", org_id, experiment_id_str, payload)


def scenario_id(org_id: str, name: str) -> str:
    return _content_id("sim", org_id, name)


def simulation_run_id(org_id: str, scenario_id_str: str) -> str:
    return _content_id("simrun", org_id, scenario_id_str)


def what_if_id(org_id: str, question: str) -> str:
    return _content_id("whatif", org_id, question)


def load_simulation_id(
    org_id: str, target_rps: int, duration_seconds: int
) -> str:
    return _content_id(
        "loadsim", org_id, str(target_rps), str(duration_seconds)
    )


# ── Bayesian beta-binomial math ────────────────────────────────────────


def _beta_draw_samples(
    alpha: float, beta: float, *, n: int, rng: random.Random
) -> list[float]:
    """Draw ``n`` samples from a Beta(``alpha``, ``beta``)
    distribution.

    Uses a Gamma-Γ pair: ``X ~ Gamma(alpha, 1)`` and
    ``Y ~ Gamma(beta, 1)`` are independent ⇒
    ``X / (X + Y) ~ Beta(alpha, beta)``. We use the standard
    Marsaglia & Tsang 2000 method for Gamma draws (a normal
    pair for ``alpha >= 1`` and a boostrapped variant for
    ``alpha < 1``).
    """
    samples: list[float] = []
    while len(samples) < n:
        # ── 1. Gamma draw via Marsaglia & Tsang ──
        def _gamma(shape: float) -> float:
            if shape < 1.0:
                # Boostrap: Gamma(shape) = Gamma(shape+1) * U^(1/shape)
                g = _gamma(shape + 1.0)
                u = rng.random() or 1e-12
                return cast(float, g * (u ** (1.0 / shape)))
            d = shape - 1.0 / 3.0
            c = 1.0 / math.sqrt(9.0 * d)
            while True:
                x = rng.gauss(0.0, 1.0)
                v = (1.0 + c * x) ** 3
                if v <= 0.0:
                    continue
                u = rng.random()
                if u < 1.0 - 0.0331 * (x * x) ** 2:
                    return d * v
                if math.log(u) < 0.5 * x * x + d * (1.0 - v + math.log(v)):
                    return d * v

        x = _gamma(alpha)
        y = _gamma(beta)
        total = x + y
        if total > 0.0:
            samples.append(x / total)
    return samples


def _prob_treatment_better(
    *,
    control_score: float, control_n: int,
    treatment_score: float, treatment_n: int,
    rng: random.Random | None = None,
) -> float:
    """Bayesian posterior probability that ``treatment > control``
    on a per-judge basis.

    Both per-arm posteriors are Beta(``1 + wins``,
    ``1 + n - wins``) with ``wins = int(score * n)``. The
    probability is computed by drawing
    :data:`BAYESIAN_MC_DRAWS` samples from each posterior
    and counting the fraction of pairs where the treatment
    draw exceeds the control draw.

    Returns ``0.5`` for either empty arm (the uniform prior
    has equal mass on both sides), matching the convention
    used by the recommender's tie-detection rule.
    """
    if control_n <= 0 or treatment_n <= 0:
        return 0.5
    c_wins = max(0, min(control_n, int(round(control_score * control_n))))
    t_wins = max(0, min(treatment_n, int(round(treatment_score * treatment_n))))
    rng = rng or random.Random(0xC0FFEE)
    c_samples = _beta_draw_samples(
        1.0 + c_wins, 1.0 + (control_n - c_wins),
        n=BAYESIAN_MC_DRAWS, rng=rng,
    )
    t_samples = _beta_draw_samples(
        1.0 + t_wins, 1.0 + (treatment_n - t_wins),
        n=BAYESIAN_MC_DRAWS, rng=rng,
    )
    wins = sum(1 for t, c in zip(t_samples, c_samples, strict=False) if t > c)
    return wins / BAYESIAN_MC_DRAWS


# ── Statistics helpers ─────────────────────────────────────────────────


def _percentile(values: list[float], p: float) -> float:
    """Linear-interpolation percentile (the type-7 quantile
    in R / numpy). Returns 0.0 for empty input."""
    if not values:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    sorted_values = sorted(values)
    if p <= 0:
        return float(sorted_values[0])
    if p >= 100:
        return float(sorted_values[-1])
    rank = (p / 100.0) * (len(sorted_values) - 1)
    lower = int(math.floor(rank))
    upper = int(math.ceil(rank))
    if lower == upper:
        return float(sorted_values[lower])
    frac = rank - lower
    return float(
        sorted_values[lower] + frac * (sorted_values[upper] - sorted_values[lower])
    )


def _safe_float(x: Any, default: float = 0.0) -> float:
    """Coerce to float, defaulting on failure. Used for
    numeric columns that may be ``None`` in the DB."""
    if x is None:
        return default
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


# ── Postgres client (lazy import) ──────────────────────────────────────


async def _get_pg() -> Any:
    """Lazily resolve the Postgres client.

    The :mod:`eden.storage.postgres` module exposes a
    :func:`get_postgres_client` factory; we import it inside
    the helper so the Cat 12 package doesn't drag the
    asyncpg import into the test-suite process eagerly.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:  # pragma: no cover - missing dep
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:  # pragma: no cover - transient
        logger.debug("Cat 12: get_postgres_client failed: %s", exc)
        return None


# ── Persistence helpers ────────────────────────────────────────────────


async def _upsert_traffic_split(
    *,
    org_id: str, exp_id: str, name: str,
    control_version: str, treatment_version: str,
    control_weight: float, treatment_weight: float,
    duration_hours: int, stopping_rule: str,
) -> None:
    """Persist a traffic split row (delete-then-insert so
    re-running the splitter overwrites the previous weights
    idempotently)."""
    client = await _get_pg()
    if client is None:
        return
    try:
        await client.execute(
            "DELETE FROM experiment_traffic_splits "
            "WHERE org_id = $1 AND experiment_id = $2",
            org_id, exp_id,
        )
        await client.execute(
            "INSERT INTO experiment_traffic_splits "
            "(id, org_id, experiment_id, variant_id, weight, status) "
            "VALUES ($1, $2, $3, $4, $5, $6), ($7, $2, $3, $8, $9, $6)",
            str(uuid.uuid4()), org_id, exp_id, "control",
            control_weight, "active",
            str(uuid.uuid4()), "treatment", treatment_weight,
        )
    except Exception as exc:
        logger.debug("Cat 12: upsert traffic split failed: %s", exc)


async def _fetch_traffic_splits(
    org_id: str, exp_id: str
) -> list[dict[str, Any]]:
    """Read the traffic-split rows for an experiment. Used
    by the splitter and the winner detector."""
    client = await _get_pg()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            "SELECT variant_id, weight, status "
            "FROM experiment_traffic_splits "
            "WHERE org_id = $1 AND experiment_id = $2",
            org_id, exp_id,
        )
        return [dict(r) for r in rows]
    except Exception as exc:
        logger.debug("Cat 12: fetch traffic splits failed: %s", exc)
        return []


async def _upsert_eval_run(
    *,
    org_id: str, exp_id: str, judge: str,
    variant: str, n: int,
    score_median: float, score_p5: float, score_p95: float,
    run_id: str,
) -> None:
    """Persist an auto-eval run row. Idempotent on
    ``(org_id, exp_id, judge, variant, run_at)`` — re-running
    the evaluator overwrites the previous row."""
    client = await _get_pg()
    if client is None:
        return
    try:
        await client.execute(
            "DELETE FROM experiment_auto_eval_runs "
            "WHERE org_id = $1 AND experiment_id = $2 "
            "AND judge_name = $3 AND variant = $4",
            org_id, exp_id, judge, variant,
        )
        await client.execute(
            "INSERT INTO experiment_auto_eval_runs "
            "(id, org_id, experiment_id, status, results_json) "
            "VALUES ($1, $2, $3, $4, $5)",
            str(uuid.uuid4()), org_id, exp_id, "completed",
            json.dumps({
                "judge": judge,
                "variant": variant,
                "n": int(n),
                "score_median": float(score_median),
                "score_p5": float(score_p5),
                "score_p95": float(score_p95),
                "run_id": run_id,
                "run_at": _now_iso(),
            }, sort_keys=True),
        )
    except Exception as exc:
        logger.debug("Cat 12: upsert eval run failed: %s", exc)


async def _fetch_eval_runs(
    org_id: str, exp_id: str
) -> list[dict[str, Any]]:
    """Read the latest eval runs for an experiment. Returns
    a flat list of dicts (one per ``(judge, variant)``) parsed
    out of the ``results_json`` blob."""
    client = await _get_pg()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            "SELECT results_json FROM experiment_auto_eval_runs "
            "WHERE org_id = $1 AND experiment_id = $2 "
            "ORDER BY created_at DESC",
            org_id, exp_id,
        )
    except Exception as exc:
        logger.debug("Cat 12: fetch eval runs failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        try:
            payload = json.loads(row["results_json"] or "{}")
        except (TypeError, ValueError):
            continue
        if isinstance(payload, dict):
            out.append(payload)
    return out


async def _upsert_recommendation(
    *,
    org_id: str, exp_id: str,
    recommendation: str, confidence: float,
    rationale: str,
    judge_comparison: dict[str, Any],
    ship_conditions: list[str],
) -> str:
    """Persist a recommendation row and return the
    recommendation id. Idempotent on ``exp_id``."""
    rec_id = recommendation_id(org_id, exp_id, judge_comparison)
    client = await _get_pg()
    if client is None:
        return rec_id
    try:
        await client.execute(
            "DELETE FROM experiment_recommendations "
            "WHERE org_id = $1 AND experiment_id = $2",
            org_id, exp_id,
        )
        await client.execute(
            "INSERT INTO experiment_recommendations "
            "(id, org_id, recommendation, rationale) "
            "VALUES ($1, $2, $3, $4)",
            rec_id, org_id, recommendation, rationale,
        )
    except Exception as exc:
        logger.debug("Cat 12: upsert recommendation failed: %s", exc)
    return rec_id


async def _upsert_scenario(
    *,
    org_id: str, name: str, spec: dict[str, Any],
) -> str:
    """Persist (or update) a simulation scenario. Returns the
    scenario id."""
    sid = scenario_id(org_id, name)
    client = await _get_pg()
    if client is None:
        return sid
    try:
        await client.execute(
            "DELETE FROM simulation_scenarios "
            "WHERE org_id = $1 AND name = $2",
            org_id, name,
        )
        await client.execute(
            "INSERT INTO simulation_scenarios "
            "(id, org_id, name, spec_json) "
            "VALUES ($1, $2, $3, $4)",
            str(uuid.uuid4()), org_id, name,
            json.dumps(spec, sort_keys=True, default=str),
        )
    except Exception as exc:
        logger.debug("Cat 12: upsert scenario failed: %s", exc)
    return sid


async def _fetch_scenario(
    org_id: str, name: str
) -> dict[str, Any] | None:
    client = await _get_pg()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            "SELECT spec_json FROM simulation_scenarios "
            "WHERE org_id = $1 AND name = $2",
            org_id, name,
        )
    except Exception as exc:
        logger.debug("Cat 12: fetch scenario failed: %s", exc)
        return None
    if row is None:
        return None
    try:
        return cast(dict[str, Any] | None, json.loads(row["spec_json"] or "{}"))
    except (TypeError, ValueError):
        return None


async def _upsert_simulation_run(
    *,
    org_id: str, scenario_id_str: str,
    n_replayed: int, n_succeeded: int, n_failed: int,
    duration_seconds: int,
    judge_comparison: dict[str, Any],
    regressions: list[dict[str, Any]],
    improvements: list[dict[str, Any]],
    recommendation: str, rationale: str,
) -> str:
    run_id = simulation_run_id(org_id, scenario_id_str)
    client = await _get_pg()
    if client is None:
        return run_id
    try:
        await client.execute(
            "DELETE FROM simulation_runs WHERE org_id = $1 AND scenario_id = $2",
            org_id, scenario_id_str,
        )
        await client.execute(
            "INSERT INTO simulation_runs "
            "(id, org_id, scenario_id, status, result_json) "
            "VALUES ($1, $2, $3, $4, $5)",
            str(uuid.uuid4()), org_id, scenario_id_str, "completed",
            json.dumps({
                "n_traces_replayed": n_replayed,
                "n_traces_succeeded": n_succeeded,
                "n_traces_failed": n_failed,
                "duration_seconds": duration_seconds,
                "judge_comparison": judge_comparison,
                "regressions": regressions,
                "improvements": improvements,
                "recommendation": recommendation,
                "rationale": rationale,
                "run_id": run_id,
            }, sort_keys=True, default=str),
        )
    except Exception as exc:
        logger.debug("Cat 12: upsert simulation run failed: %s", exc)
    return run_id


async def _upsert_what_if(
    *,
    org_id: str, question: str,
    baseline_cost_usd: float | None,
    baseline_judge_score_median: float | None,
    estimated_cost_usd: float | None,
    estimated_judge_score: float | None,
    estimated_latency_p95_ms: float | None,
    confidence_interval_cost: list[float] | None,
    confidence_interval_judge_score: list[float] | None,
    method: str,
) -> str:
    wid = what_if_id(org_id, question)
    client = await _get_pg()
    if client is None:
        return wid
    try:
        await client.execute(
            "DELETE FROM what_if_analyses "
            "WHERE org_id = $1 AND question = $2",
            org_id, question,
        )
        await client.execute(
            "INSERT INTO what_if_analyses "
            "(id, org_id, question, result_json) "
            "VALUES ($1, $2, $3, $4)",
            str(uuid.uuid4()), org_id, question,
            json.dumps({
                "baseline_cost_usd": baseline_cost_usd,
                "baseline_judge_score_median": baseline_judge_score_median,
                "estimated_cost_usd": estimated_cost_usd,
                "estimated_judge_score": estimated_judge_score,
                "estimated_latency_p95_ms": estimated_latency_p95_ms,
                "confidence_interval_cost": confidence_interval_cost,
                "confidence_interval_judge_score": confidence_interval_judge_score,
                "method": method,
                "analysis_id": wid,
            }, sort_keys=True, default=str),
        )
    except Exception as exc:
        logger.debug("Cat 12: upsert what-if failed: %s", exc)
    return wid


# ── Closed-loop hook firing helpers ────────────────────────────────────


def _fire_winner_hook(
    *, org_id: str, experiment_id_str: str, winner_variant: str,
) -> None:
    """Fire :func:`ExperimentHook.on_winner` on a real
    winner declaration. The hook is a no-op logger in stub
    mode; a real implementation (Phase 5) would archive the
    losing variants and update the canary's traffic mix.
    """
    try:
        from eden.llmops.promotion_hooks import get_experiment_hook
    except Exception:  # pragma: no cover - missing dep
        return
    try:
        get_experiment_hook().on_winner(
            org_id,
            experiment_id=experiment_id_str,
            winner_variant=winner_variant,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Cat 12: winner hook fire failed: %s", exc)


def _fire_dont_ship_hook(
    *, org_id: str, experiment_id_str: str,
    judge: str, delta: float,
) -> None:
    """Fire :func:`PromotionHook.on_judge_regression` when
    the recommender decides ``dont_ship`` because of a
    per-judge regression. A real Phase 5 implementation
    would block the promotion and require human approval.
    """
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception:  # pragma: no cover
        return
    try:
        get_promotion_hook().on_judge_regression(
            org_id,
            judge_name=judge,
            trace_id=experiment_id_str,
            score=delta,
        )
    except Exception as exc:  # pragma: no cover
        logger.debug("Cat 12: dont-ship hook fire failed: %s", exc)


def _fire_simulation_drift_hook(
    *, org_id: str, scenario_id_str: str, severity: str,
) -> None:
    """Fire :func:`PromotionHook.on_drift_alert` when the
    simulator finds a high-severity regression (a single
    trace whose candidate judge score is far below the
    control).
    """
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception:  # pragma: no cover
        return
    try:
        get_promotion_hook().on_drift_alert(
            org_id,
            drift_type=f"simulation_regression:{scenario_id_str[:16]}",
            severity=severity,
        )
    except Exception as exc:  # pragma: no cover
        logger.debug("Cat 12: drift hook fire failed: %s", exc)


# ── Pure-Python deterministic split ────────────────────────────────────


def _hash_to_unit_interval(*parts: str) -> float:
    """Stable hash → unit-interval mapping. Re-uses the
    convention from :mod:`eden.experiments.service` so the
    per-user assignment is consistent across the existing
    A/B testing service and the new Cat 12
    :class:`TrafficSplitter`."""
    h = hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()
    return int(h[:16], 16) / float(1 << 64)


def _assign_variant_by_weight(
    *, user_id: str, experiment_id_str: str,
    variants: list[tuple[str, float]],
) -> str:
    """Deterministic weighted-bucket assignment.

    ``variants`` is a list of ``(variant_id, weight)``
    tuples. The user is hashed with the experiment id to
    a stable bucket in ``[0, sum_of_weights)`` and the
    cumulative-weight walk returns the matching variant.
    Returns the last variant as a floating-point safety
    net (matches :mod:`eden.experiments.service`).
    """
    if not variants:
        raise ValueError("variants must be a non-empty list")
    total = sum(weight for _, weight in variants)
    if total <= 0.0:
        raise ValueError("variant weights must sum to a positive number")
    bucket = _hash_to_unit_interval(experiment_id_str, user_id) * total
    cumulative = 0.0
    for variant_id, weight in variants:
        cumulative += weight
        if bucket < cumulative:
            return variant_id
    return variants[-1][0]


# ── Helpful adapters ───────────────────────────────────────────────────


def _normalize_judges(judges: Iterable[str] | None) -> list[str]:
    """Coerce the caller-supplied judges to a stable list,
    filtered against the known :data:`DEFAULT_JUDGES`. The
    filter is permissive — unknown judge names pass through
    untouched so a v2 expansion doesn't need to update the
    Cat 12 code.
    """
    if not judges:
        return list(DEFAULT_JUDGES)
    seen: list[str] = []
    for j in judges:
        name = str(j).strip()
        if name and name not in seen:
            seen.append(name)
    return seen or list(DEFAULT_JUDGES)
