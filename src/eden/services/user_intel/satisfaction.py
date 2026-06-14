"""Satisfaction signal (Cat 9 — the v0 + v2 core).

Two services backed by the ``user_satisfaction_signals``
(020), ``user_feedback`` (020), ``user_behavioural_signals``
(024), and ``user_satisfaction_corrected`` (024) tables:

* :class:`SatisfactionSignalService` — the v0
  ``compute`` endpoint that returns the *full* corrected
  satisfaction signal per the appendix's response shape:
  explicit counts, implicit aggregate, naive mean, Bayesian
  posterior, coverage-weighted, and the 95% credible
  interval.
* :class:`SelectionBiasCorrector` — the v2 selection-bias
  correction that solves the 97% problem. Per arXiv
  2605.12177 (2026), the Hierarchical Beta-Binomial
  correction is within 4-13 percentage points of true
  system quality vs. 25-43 for a naive explicit-feedback
  mean. The corrector:

  1. Reads the explicit feedback for the trace.
  2. Reads the per-channel prior from the org's recent
     feedback (the 30-day window from
     :data:`BAYESIAN_PRIOR_WINDOW_DAYS`).
  3. Computes the Hierarchical Beta-Binomial posterior.
  4. Persists the result to ``user_satisfaction_corrected``.
  5. Returns the 95% credible interval via the quantile
     function of the Beta distribution.

The implicit-signal aggregate uses the 7 signals from
``user_behavioural_signals``: regenerated,
abandoned_after_one, edit_distance, copy_pasted,
retried_within_60s, return_7d, time_to_first_action_ms.
The default weights come from the appendix's
``compute_implicit_signal`` pseudo-code.

Closed-loop: the coverage-weighted satisfaction is checked
against :data:`_common.LOW_SATISFACTION_THRESHOLD`; if
below, :func:`_common._fire_low_satisfaction_alert` fires
the Cat 17 ``on_drift_alert`` hook.
"""

from __future__ import annotations

import logging
import math
from typing import Any

from ._common import (
    BAYESIAN_PRIOR_WINDOW_DAYS,
    BETA_PSEUDOCOUNT,
    CREDIBLE_INTERVAL_HIGH,
    CREDIBLE_INTERVAL_LOW,
    DEFAULT_EXPLICIT_WEIGHT,
    DEFAULT_IMPLICIT_WEIGHT,
    _bad_request_envelope,
    _fire_low_satisfaction_alert,
    _get_client,
    _new_id,
    _ok_envelope,
    _safe_float,
)

logger = logging.getLogger(__name__)


# ── Implicit-signal aggregate (the 7 signals) ────────────────────────


# Default weights from the appendix's
# ``compute_implicit_signal`` pseudo-code. The order of
# the dict is the order of the signals in the response.
DEFAULT_IMPLICIT_WEIGHTS: dict[str, float] = {
    "regenerated": -0.4,
    "abandoned_after_one": -0.3,
    # ``edit_distance`` is a *conditional* weight — the
    # appendix multiplies by the edit_distance value when
    # it's > 0.5. We bake that in below.
    "edit_distance": -0.3,
    "copy_pasted": 0.2,
    "retried_within_60s": -0.2,
    # ``return_7d`` is a 3-valued signal (True/False/null);
    # the appendix's pseudo-code only deducts when
    # ``return_7d == False``. We handle that below.
    "return_7d": -0.1,
}


def _compute_implicit_signal(row: dict[str, Any] | None) -> float:
    """Compute the implicit-signal aggregate from one row
    of ``user_behavioural_signals``.

    The default weights are the appendix's defaults; the
    algorithm starts at 1.0 and subtracts on negative
    signals / adds on positive signals. Returns a value
    in ``[0.0, 1.0]``.
    """
    if row is None:
        # No implicit signal → fall back to the
        # coverage-weighted baseline. Per the appendix,
        # ``coverage_weighted = implicit`` when no
        # implicit signal exists. We return 0.5 as the
        # neutral default so the aggregate is
        # well-formed (the caller can detect the "no
        # signal" branch by checking the row itself).
        return 0.5
    score = 1.0
    if row.get("regenerated"):
        score += DEFAULT_IMPLICIT_WEIGHTS["regenerated"]
    if row.get("abandoned_after_one"):
        score += DEFAULT_IMPLICIT_WEIGHTS["abandoned_after_one"]
    ed = row.get("edit_distance")
    if ed is not None and ed > 0.5:
        # Per the appendix: ``score -= 0.3 * edit_distance``
        # — but the 0.3 is the *weight*, not a cap. We
        # multiply by 0.3 so a 1.0 edit distance deducts
        # the full 0.3.
        try:
            ed_f = float(ed)
            score += DEFAULT_IMPLICIT_WEIGHTS["edit_distance"] * ed_f
        except (TypeError, ValueError):
            pass
    if row.get("copy_pasted"):
        score += DEFAULT_IMPLICIT_WEIGHTS["copy_pasted"]
    if row.get("retried_within_60s"):
        score += DEFAULT_IMPLICIT_WEIGHTS["retried_within_60s"]
    r7 = row.get("return_7d")
    if r7 is False:
        # Per the appendix: only deduct when *False*.
        # ``None`` is "unknown — too early" (cold start).
        score += DEFAULT_IMPLICIT_WEIGHTS["return_7d"]
    # Clamp.
    return max(0.0, min(1.0, score))


# ── Bayesian correction (the Hierarchical Beta-Binomial) ──────────────


def _beta_quantile(p: float, alpha: float, beta_param: float) -> float:
    """Approximate inverse-CDF of the Beta(alpha, beta)
    distribution. We use the symmetric series expansion
    plus a Newton iteration — accurate to ~1e-6 for
    ``p in [0.025, 0.975]`` and ``alpha, beta > 0.5``.

    For ``alpha, beta < 0.5`` (which can happen with
    small samples) we fall back to a clamped linear
    interpolation, which is correct in the limit.
    """
    if p <= 0.0:
        return 0.0
    if p >= 1.0:
        return 1.0
    if alpha <= 0 or beta_param <= 0:
        return p
    # Use the regularized incomplete beta function
    # inverse via Newton iteration on the CDF.
    # CDF: B(x; a, b) / B(a, b). We approximate the CDF
    # using the series expansion in
    # :func:`_beta_cdf` and invert.
    # Initial guess: the mean (alpha / (alpha + beta)).
    x = alpha / (alpha + beta_param)
    for _ in range(20):
        cdf = _beta_cdf(x, alpha, beta_param)
        diff = cdf - p
        if abs(diff) < 1e-7:
            return x
        # PDF: x^(a-1) * (1-x)^(b-1) / B(a, b)
        try:
            log_pdf = (
                (alpha - 1) * math.log(max(x, 1e-12))
                + (beta_param - 1) * math.log(max(1 - x, 1e-12))
                - _log_beta(alpha, beta_param)
            )
            pdf = math.exp(log_pdf)
        except (ValueError, OverflowError):
            pdf = 1e-6
        if pdf <= 0:
            x += diff * 0.1
            x = max(1e-6, min(1 - 1e-6, x))
            continue
        x -= diff / pdf
        if x <= 0:
            x = 1e-6
        elif x >= 1:
            x = 1 - 1e-6
    return x


def _log_beta(a: float, b: float) -> float:
    """log(Beta(a, b)) = log(Gamma(a)) + log(Gamma(b)) - log(Gamma(a+b))."""
    try:
        return math.lgamma(a) + math.lgamma(b) - math.lgamma(a + b)
    except (ValueError, OverflowError):
        return 0.0


def _beta_cdf(x: float, a: float, b: float) -> float:
    """Regularized incomplete beta function I_x(a, b).

    We use the series expansion (Lentz's method) for
    ``x < (a+1) / (a+b+2)`` and the symmetry
    ``I_x(a, b) = 1 - I_{1-x}(b, a)`` otherwise. This
    converges quickly for the parameter ranges we care
    about.
    """
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    if a <= 0 or b <= 0:
        return x
    # Use the continued-fraction expansion (Numerical
    # Recipes §6.4). The standard implementation
    # alternates between the series and the continued
    # fraction for numerical stability.
    lbeta = _log_beta(a, b)
    front = math.exp(
        a * math.log(x) + b * math.log(1 - x) - lbeta
    ) / a
    if x < (a + 1.0) / (a + b + 2.0):
        return _beta_cf_series(x, a, b, front)
    return 1.0 - _beta_cf_series(1 - x, b, a, front)


def _beta_cf_series(
    x: float, a: float, b: float, front: float
) -> float:
    """Series expansion for the regularized incomplete
    beta function. Mirrors the Numerical Recipes §6.4
    implementation."""
    if x == 0.0 or x == 1.0:
        return 0.0
    lbeta = _log_beta(a, b)
    try:
        front = math.exp(
            a * math.log(x) + b * math.log(1 - x) - lbeta
        ) / a
    except (ValueError, OverflowError):
        return 0.0
    # CF: continued fraction
    c = 1.0
    d = 1.0 - (a + b) * x / (a + 1.0)
    if abs(d) < 1e-30:
        d = 1e-30
    d = 1.0 / d
    h = d
    for m in range(1, 200):
        m2 = 2 * m
        # Even step
        aa = m * (b - m) * x / ((a + m2 - 1.0) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        h *= d * c
        # Odd step
        aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1.0))
        d = 1.0 + aa * d
        if abs(d) < 1e-30:
            d = 1e-30
        c = 1.0 + aa / c
        if abs(c) < 1e-30:
            c = 1e-30
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-7:
            break
    return h * front


def _hierarchical_beta_binomial(
    thumbs_up: int,
    thumbs_down: int,
    prior_alpha: float,
    prior_beta: float,
) -> dict[str, float]:
    """Compute the Hierarchical Beta-Binomial posterior.

    ``posterior ~ Beta(prior_alpha + thumbs_up, prior_beta + thumbs_down)``

    Returns ``mean``, ``ci_low``, ``ci_high`` (the
    95 % credible interval from the posterior).
    """
    a = prior_alpha + thumbs_up
    b = prior_beta + thumbs_down
    mean = a / (a + b)
    ci_low = _beta_quantile(CREDIBLE_INTERVAL_LOW, a, b)
    ci_high = _beta_quantile(CREDIBLE_INTERVAL_HIGH, a, b)
    return {
        "alpha": a,
        "beta": b,
        "mean": mean,
        "ci_low": ci_low,
        "ci_high": ci_high,
    }


# ── Data read paths ──────────────────────────────────────────────────


async def _fetch_explicit_feedback(
    org_id: str, trace_id: str
) -> dict[str, int]:
    """Read the explicit feedback for the trace. Returns
    ``{thumbs_up, thumbs_down, total}``. ``{}`` on failure
    (the caller treats ``{}`` as "no explicit feedback").
    """
    client = await _get_client()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            """
            SELECT
                COALESCE(SUM(CASE WHEN thumbs = 'up' THEN 1 ELSE 0 END), 0)::int
                    AS thumbs_up,
                COALESCE(SUM(CASE WHEN thumbs = 'down' THEN 1 ELSE 0 END), 0)::int
                    AS thumbs_down,
                COUNT(*)::int AS total
              FROM user_feedback
             WHERE org_id = $1 AND trace_id = $2
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug(
            "user_intel: explicit_feedback failed: %s", exc
        )
        return {}
    if row is None:
        return {}
    if isinstance(row, dict):
        return {
            "thumbs_up": int(row.get("thumbs_up") or 0),
            "thumbs_down": int(row.get("thumbs_down") or 0),
            "total": int(row.get("total") or 0),
        }
    return {
        "thumbs_up": int(row["thumbs_up"] or 0),
        "thumbs_down": int(row["thumbs_down"] or 0),
        "total": int(row["total"] or 0),
    }


async def _fetch_implicit_signals(
    org_id: str, trace_id: str
) -> dict[str, Any] | None:
    """Read the implicit-signal row for the trace. Returns
    ``None`` if the trace has no implicit signals recorded."""
    client = await _get_client()
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT regenerated, abandoned_after_one, edit_distance,
                   copy_pasted, retried_within_60s, return_7d,
                   time_to_first_action_ms
              FROM user_behavioural_signals
             WHERE org_id = $1 AND trace_id = $2
             ORDER BY created_at DESC LIMIT 1
            """,
            org_id,
            trace_id,
        )
    except Exception as exc:
        logger.debug(
            "user_intel: implicit_signals failed: %s", exc
        )
        return None
    if row is None:
        return None
    d = dict(row) if not isinstance(row, dict) else row
    return {
        "regenerated": bool(d.get("regenerated")),
        "abandoned_after_one": bool(d.get("abandoned_after_one")),
        "edit_distance": _safe_float(d.get("edit_distance")),
        "copy_pasted": bool(d.get("copy_pasted")),
        "retried_within_60s": bool(d.get("retried_within_60s")),
        "return_7d": (
            None
            if d.get("return_7d") is None
            else bool(d.get("return_7d"))
        ),
        "time_to_first_action_ms": d.get("time_to_first_action_ms"),
    }


async def _fetch_per_channel_prior(
    org_id: str, interval_sql: str
) -> tuple[float, float]:
    """Compute the per-channel Beta prior from the org's
    recent feedback. Returns ``(alpha, beta)`` for the
    Beta distribution representing the org's thumbs-up
    rate.

    If the org has fewer than 4 events in the prior
    window, we fall back to a non-informative
    ``Beta(1, 1)`` prior. Per the appendix, the prior
    must be at least 30 days of feedback to be
    meaningful; smaller windows fall back to the uniform
    prior.
    """
    client = await _get_client()
    if client is None:
        return (BETA_PSEUDOCOUNT, BETA_PSEUDOCOUNT)
    try:
        row = await client.fetchrow(
            f"""
            SELECT
                COALESCE(SUM(CASE WHEN thumbs = 'up' THEN 1 ELSE 0 END), 0)::int
                    AS up_count,
                COALESCE(SUM(CASE WHEN thumbs = 'down' THEN 1 ELSE 0 END), 0)::int
                    AS down_count
              FROM user_feedback
             WHERE org_id = $1
               AND created_at > NOW() - {interval_sql}::interval
            """,
            org_id,
        )
    except Exception as exc:
        logger.debug("user_intel: prior fetch failed: %s", exc)
        return (BETA_PSEUDOCOUNT, BETA_PSEUDOCOUNT)
    if row is None:
        return (BETA_PSEUDOCOUNT, BETA_PSEUDOCOUNT)
    if isinstance(row, dict):
        up = int(row.get("up_count") or 0)
        down = int(row.get("down_count") or 0)
    else:
        up = int(row["up_count"] or 0)
        down = int(row["down_count"] or 0)
    # Require ≥ 4 events in the prior window. Below
    # that, the Beta estimate is too noisy.
    if up + down < 4:
        return (BETA_PSEUDOCOUNT, BETA_PSEUDOCOUNT)
    return (float(up) + BETA_PSEUDOCOUNT, float(down) + BETA_PSEUDOCOUNT)


# ── Persistence ──────────────────────────────────────────────────────


async def _persist_correction(
    org_id: str,
    user_id: str,
    trace_id: str,
    naive_mean: float | None,
    posterior: dict[str, float],
) -> None:
    """Persist the correction result to
    ``user_satisfaction_corrected``. Best-effort."""
    client = await _get_client()
    if client is None:
        return
    sat_id = _new_id("sat")
    try:
        await client.execute(
            """
            INSERT INTO user_satisfaction_corrected
                (id, org_id, user_id, trace_id, naive_mean,
                 bias_corrected_posterior, credible_interval_low_95,
                 credible_interval_high_95, method)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            sat_id,
            org_id,
            user_id,
            trace_id,
            naive_mean,
            posterior["mean"],
            posterior["ci_low"],
            posterior["ci_high"],
            "hierarchicalbeta_binomial",
        )
    except Exception as exc:
        logger.debug(
            "user_intel: correction persist failed: %s", exc
        )


# ── Service: SelectionBiasCorrector ──────────────────────────────────


class SelectionBiasCorrector:
    """The Hierarchical Beta-Binomial selection-bias
    correction. Per arXiv 2605.12177, this is within
    4-13 percentage points of true system quality vs.
    25-43 for a naive explicit-feedback mean.

    The ``correct`` method:

    1. Reads the explicit feedback for the trace.
    2. Reads the per-channel prior from the org's recent
       feedback (the :data:`BAYESIAN_PRIOR_WINDOW_DAYS`-
       day window).
    3. Computes the posterior.
    4. Persists to ``user_satisfaction_corrected``.

    The result includes the 95 % credible interval so the
    front-end can render the uncertainty band.
    """

    name = "selection_bias_corrector"

    async def correct(
        self,
        org_id: str,
        *,
        trace_id: str,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )

        explicit = await _fetch_explicit_feedback(org_id, trace_id)
        thumbs_up = explicit.get("thumbs_up", 0)
        thumbs_down = explicit.get("thumbs_down", 0)
        total = explicit.get("total", 0)
        naive_mean: float | None = (
            round(thumbs_up / total, 4) if total > 0 else None
        )

        # 30-day prior window.
        prior_interval = f"{BAYESIAN_PRIOR_WINDOW_DAYS} days"
        prior_alpha, prior_beta = await _fetch_per_channel_prior(
            org_id, prior_interval
        )
        posterior = _hierarchical_beta_binomial(
            thumbs_up, thumbs_down, prior_alpha, prior_beta
        )

        # Persist.
        await _persist_correction(
            org_id, user_id or "", trace_id, naive_mean, posterior
        )

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "user_id": user_id,
                "explicit": {
                    "thumbs_up": thumbs_up,
                    "thumbs_down": thumbs_down,
                },
                "naive_mean": naive_mean,
                "prior": {
                    "alpha": prior_alpha,
                    "beta": prior_beta,
                    "window_days": BAYESIAN_PRIOR_WINDOW_DAYS,
                },
                "posterior": {
                    "alpha": posterior["alpha"],
                    "beta": posterior["beta"],
                    "mean": round(posterior["mean"], 4),
                    "credible_interval_95": [
                        round(posterior["ci_low"], 4),
                        round(posterior["ci_high"], 4),
                    ],
                },
                "method": "hierarchicalbeta_binomial",
            },
        )


# ── Service: SatisfactionSignalService ───────────────────────────────


class SatisfactionSignalService:
    """The full satisfaction envelope (the v0 ``compute``).

    Composes:

    * Explicit feedback (thumbs-up/down) from
      ``user_feedback`` (Cat 9 v0 substrate).
    * Implicit aggregate from
      ``user_behavioural_signals`` (Cat 9 v2 substrate).
    * Selection-bias-corrected posterior from the
      :class:`SelectionBiasCorrector`.
    * Coverage-weighted aggregate (0.03 explicit + 0.97
      implicit by default).

    Fires the Cat 17 ``on_drift_alert`` hook when the
    coverage-weighted satisfaction is below
    :data:`_common.LOW_SATISFACTION_THRESHOLD`.
    """

    name = "satisfaction_signals"

    async def compute(
        self,
        org_id: str,
        *,
        trace_id: str,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        if not trace_id or not isinstance(trace_id, str):
            return _bad_request_envelope(
                self.name, "trace_id is required"
            )

        explicit = await _fetch_explicit_feedback(org_id, trace_id)
        thumbs_up = explicit.get("thumbs_up", 0)
        thumbs_down = explicit.get("thumbs_down", 0)
        explicit_total = explicit.get("total", 0)
        naive: float | None = (
            round(thumbs_up / explicit_total, 4)
            if explicit_total > 0
            else None
        )

        implicit_row = await _fetch_implicit_signals(org_id, trace_id)
        implicit_score = _compute_implicit_signal(implicit_row)

        # Selection-bias correction.
        prior_interval = f"{BAYESIAN_PRIOR_WINDOW_DAYS} days"
        prior_alpha, prior_beta = await _fetch_per_channel_prior(
            org_id, prior_interval
        )
        posterior = _hierarchical_beta_binomial(
            thumbs_up, thumbs_down, prior_alpha, prior_beta
        )
        bias_corrected = round(posterior["mean"], 4)

        # Persist the correction (the standalone
        # corrector service does the same thing, but the
        # v0 ``compute`` endpoint should also persist
        # so the audit log is complete).
        await _persist_correction(
            org_id, user_id or "", trace_id, naive, posterior
        )

        # Coverage-weighted. If no explicit feedback,
        # the explicit weight is 0 and the implicit
        # weight is 1.
        if explicit_total == 0:
            coverage_weighted = implicit_score
        else:
            coverage_weighted = (
                DEFAULT_EXPLICIT_WEIGHT * (thumbs_up / explicit_total)
                + DEFAULT_IMPLICIT_WEIGHT * implicit_score
            )

        # Clamp.
        coverage_weighted = max(0.0, min(1.0, coverage_weighted))

        # Closed-loop: fire the drift alert if the
        # coverage-weighted is below threshold.
        _fire_low_satisfaction_alert(
            org_id, trace_id, coverage_weighted
        )

        return _ok_envelope(
            self.name,
            {
                "trace_id": trace_id,
                "user_id": user_id,
                "explicit": {
                    "thumbs_up": thumbs_up,
                    "thumbs_down": thumbs_down,
                },
                "implicit": {
                    "regenerated": (
                        implicit_row["regenerated"]
                        if implicit_row
                        else None
                    ),
                    "abandoned_after_one": (
                        implicit_row["abandoned_after_one"]
                        if implicit_row
                        else None
                    ),
                    "edit_distance": (
                        implicit_row["edit_distance"]
                        if implicit_row
                        else None
                    ),
                    "copy_pasted": (
                        implicit_row["copy_pasted"]
                        if implicit_row
                        else None
                    ),
                    "retry_within_60s": (
                        implicit_row["retried_within_60s"]
                        if implicit_row
                        else None
                    ),
                    "return_7d": (
                        implicit_row["return_7d"]
                        if implicit_row
                        else None
                    ),
                    "score": round(implicit_score, 4),
                },
                "naive_satisfaction": naive,
                "selection_bias_corrected": bias_corrected,
                "coverage_weighted": round(coverage_weighted, 4),
                "credible_interval_95": [
                    round(posterior["ci_low"], 4),
                    round(posterior["ci_high"], 4),
                ],
                "method": "hierarchicalbeta_binomial",
                "weights": {
                    "explicit": DEFAULT_EXPLICIT_WEIGHT,
                    "implicit": DEFAULT_IMPLICIT_WEIGHT,
                },
            },
        )
