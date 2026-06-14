"""Cat 13 — RiskScorer.

Composite org-level risk score with a 5-component
breakdown, alerts, and a recommendation string. The
headline Cat 13 service from the spec:

    "composite risk score per trace (judge-score variance
    + cost variance + latency variance)"

The composite is in ``[0, 1]`` with the following
component weighting:

* **judge_drift** (25%) — PSI-style judge-score drift
  over the last 24h vs the prior 7d. Captures the
  *regressing* direction; high values mean scores are
  dropping.
* **cost_volatility** (15%) — coefficient of variation
  of the recent cost-per-call. High CV → unpredictable
  spend is risky.
* **latency_p95_trend** (20%) — p95 latency in ms,
  normalised against the Cat 22 2s baseline. Slow
  requests are riskier than fast ones.
* **judge_variance** (25%) — sample stdev of the recent
  judge scores. A noisy judge is riskier than a stable
  one even when the mean is fine.
* **embedding_drift** (15%) — PSI-style embedding drift
  on the response ``response_body`` hash histogram over
  the last 24h vs the prior 7d. Catches topic drift the
  judge alone might miss.

A missing component defaults to ``None`` (and is omitted
from the weighted sum) so the score still surfaces
*something* even when one signal is unavailable. A
zero-history org returns ``composite_risk_score=None``
with a ``"no data"`` message.

The persistence target is ``risk_scores`` — the
``components_json`` column stores the per-component
breakdown so the front-end / audit log can drill in.

Closed-loop wiring: this service does not fire hooks. A
high composite risk is a *prediction* — the per-trace
risk is the input to the Cat 13 :class:`DriftDetector`'s
baseline; the closed-loop fires on a sustained drift,
not on a single high-risk prediction.

See ``docs/observability-gap/13-predictive-intelligence.md``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ._common import (
    PSI_THRESHOLD,
    RISK_HISTORY_HOURS_DEFAULT,
    _fetch_daily_latencies,
    _fetch_recent_costs,
    _fetch_recent_judge_scores,
    _fetch_response_text_samples,
    _ok_envelope,
    _parse_window,
    _psi,
    _safe_float,
    _upsert_risk_score,
)

logger = logging.getLogger(__name__)


#: Component weights. Sum to 1.0. The spec calls out the
#: 5-component rollup; the 25/15/20/25/15 split is the
#: headline surface (judge_drift + judge_variance each
#: carry 25% of the total because judge behaviour is the
#: most sensitive signal).
WEIGHT_JUDGE_DRIFT: float = 0.25
WEIGHT_COST_VOLATILITY: float = 0.15
WEIGHT_LATENCY_P95: float = 0.20
WEIGHT_JUDGE_VARIANCE: float = 0.25
WEIGHT_EMBEDDING_DRIFT: float = 0.15

#: Latency baseline. ``p95 / LATENCY_BASELINE_MS`` clamps
#: to 1.0 above this many milliseconds. 2 seconds matches
#: the Cat 22 ``SLO`` convention.
LATENCY_BASELINE_MS: float = 2000.0

#: Default history window — 24 hours, same as the Cat 8
#: daily aggregation. Long enough to surface variance
#: without being a 7-day lag.
RISK_HISTORY_HOURS: int = RISK_HISTORY_HOURS_DEFAULT

#: Default number of recent judge scores to read. Smaller
#: than the QualityPredictor's 7-day window — the risk
#: score is "what does the recent picture look like", not
#: "what's the trailing-week mean".
RISK_JUDGE_LIMIT: int = 50

#: Embedding-drift sample limit per window. Matches the
#: DriftDetector's ``EMBEDDING_SAMPLE_LIMIT`` to keep the
#: read cost bounded.
EMBEDDING_SAMPLE_LIMIT: int = 200

#: Per-component thresholds above which an alert is
#: raised. The values mirror the v0 spec's risk-of-page
#: thresholds; the front-end renders an alert per row.
ALERT_THRESHOLDS: dict[str, float] = {
    "judge_drift": 0.4,
    "cost_volatility": 0.5,
    "latency_p95_trend": 0.6,
    "judge_variance": 0.4,
    "embedding_drift": 0.4,
}

#: Composite risk thresholds (per-org normalised; the
#: front-end renders "investigate" / "page on-call" as
#: the composite crosses these).
COMPOSITE_INVESTIGATE: float = 0.4
COMPOSITE_PAGE: float = 0.7


class RiskScorer:
    """Composite org-level risk score with 5-component
    breakdown + alerts + recommendation."""

    name = "risk_scorer"

    async def score(
        self,
        org_id: str,
        *,
        request_id: str,
        window: str = "24h",
    ) -> dict[str, Any]:
        """Return the composite risk for the org over the
        configured window.

        Args:
            org_id: The tenant id.
            request_id: The request id the score is for.
                Persisted to ``risk_scores`` along with the
                per-component breakdown.
            window: A window string like ``"24h"`` (default),
                ``"7d"``, ``"12h"``. The current window and
                the prior window are derived from this —
                the current window is the most recent
                ``window`` of data, the prior window is the
                ``window`` immediately preceding the current
                one (so the drift comparison is apples-to-
                apples).

        Returns:
            The live envelope with ``composite_risk_score``
            (0..1), ``risk_breakdown{}`` (per-component
            scores), ``alerts[]`` (per-component alert
            strings for components above their alert
            threshold), ``recommendation`` (a one-sentence
            action string), and the
            ``samples_used{}`` / ``model`` metadata.
        """
        interval_sql = _parse_window(window)
        if interval_sql is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "request_id": request_id,
                    "window": window,
                    "composite_risk_score": None,
                    "risk_breakdown": {
                        "judge_drift": None,
                        "cost_volatility": None,
                        "latency_p95_trend": None,
                        "judge_variance": None,
                        "embedding_drift": None,
                    },
                    "alerts": [],
                    "recommendation": (
                        "invalid window format — use Nh|Nd|Nm"
                    ),
                    "model": "weighted_v1",
                },
            )

        # Read the current window. For the drift components
        # we also read a prior window of the same length
        # (e.g. 24h prior to the current 24h for
        # ``window="24h"``).
        judge_rows = await _fetch_recent_judge_scores(
            org_id, interval_sql,
        )
        judge_rows = judge_rows[:RISK_JUDGE_LIMIT]
        costs = await _fetch_recent_costs(org_id, interval_sql)
        latencies = await _fetch_daily_latencies(org_id, interval_sql)
        # Prior window (for drift) — same interval, anchored
        # to NOW - 2 * interval. We read the same fetcher
        # and slice the time range client-side.
        prior_judge_rows = await _fetch_recent_judge_scores(
            org_id, f"{interval_sql} * 2",
        )
        prior_response_bodies = await _fetch_response_text_samples(
            org_id, f"{interval_sql} * 2",
            limit=EMBEDDING_SAMPLE_LIMIT,
        )
        response_bodies = await _fetch_response_text_samples(
            org_id, interval_sql, limit=EMBEDDING_SAMPLE_LIMIT,
        )

        # Filter the prior rows to the *prior* window
        # only. ``_fetch_recent_judge_scores`` returns the
        # last ``interval``; for the prior window we want
        # the rows in ``[NOW - 2*interval, NOW - interval]``.
        # The fetcher doesn't support that natively, so we
        # over-fetch and slice on the client.
        n_current_judge = len(judge_rows)
        prior_judge_window = prior_judge_rows[
            n_current_judge : n_current_judge * 2
        ]
        # Same for response bodies (chronological order is
        # DESC; the prior window is the rows AFTER the
        # current ones in the over-fetched list).
        n_current_resp = len(response_bodies)
        prior_resp_window = prior_response_bodies[
            n_current_resp : n_current_resp * 2
        ]

        # Component 1: judge_drift = PSI on judge scores.
        # Empty samples → 0.0 (no drift detectable).
        judge_drift: float | None
        if judge_rows and prior_judge_window:
            current_scores = [_safe_float(r.get("score")) for r in judge_rows]
            prior_scores = [_safe_float(r.get("score")) for r in prior_judge_window]
            psi_val, _, _ = _psi(prior_scores, current_scores)
            # Normalise PSI (0..1) by the threshold.
            # PSI >= PSI_THRESHOLD is "significant drift";
            # we cap at 1.0.
            judge_drift = _clamp(psi_val / max(PSI_THRESHOLD, 1e-9), 0.0, 1.0)
        elif judge_rows:
            # Current window has data but prior is empty —
            # treat as no drift (0.0) rather than
            # "insufficient_data" because we have a usable
            # current signal.
            judge_drift = 0.0
        else:
            judge_drift = None

        # Component 2: cost_volatility = CV of recent costs.
        cost_volatility: float | None
        if costs:
            mean = sum(costs) / len(costs)
            if mean > 0 and len(costs) >= 2:
                variance = sum((c - mean) ** 2 for c in costs) / (len(costs) - 1)
                stdev = variance ** 0.5
                cv = stdev / mean
            else:
                cv = 0.0
            cost_volatility = _clamp(cv, 0.0, 1.0)
        else:
            cost_volatility = None

        # Component 3: latency_p95_trend = p95 / baseline,
        # clamped to [0, 1].
        latency_p95_trend: float | None
        if latencies:
            sorted_lat = sorted(latencies)
            p95 = _percentile_inline(sorted_lat, 0.95)
            latency_p95_trend = _clamp(p95 / LATENCY_BASELINE_MS, 0.0, 1.0)
        else:
            latency_p95_trend = None

        # Component 4: judge_variance = sample stdev of
        # recent judge scores, normalised against the
        # theoretical max (0.5 — the stdev of a uniform
        # 0..1 distribution).
        judge_variance: float | None
        if judge_rows:
            scores = [_safe_float(r.get("score")) for r in judge_rows]
            n = len(scores)
            if n >= 2:
                mean = sum(scores) / n
                variance = sum((s - mean) ** 2 for s in scores) / (n - 1)
                stdev = variance ** 0.5
            else:
                stdev = 0.0
            judge_variance = _clamp(stdev / 0.5, 0.0, 1.0)
        else:
            judge_variance = None

        # Component 5: embedding_drift = PSI on
        # response_body hash buckets.
        embedding_drift: float | None
        if response_bodies and prior_resp_window:
            current_hash = [
                _hash_bucket_inline(b) for b in response_bodies
            ]
            prior_hash = [
                _hash_bucket_inline(b) for b in prior_resp_window
            ]
            psi_val, _, _ = _psi(prior_hash, current_hash, n_buckets=64)
            embedding_drift = _clamp(
                psi_val / max(PSI_THRESHOLD, 1e-9), 0.0, 1.0,
            )
        elif response_bodies:
            embedding_drift = 0.0
        else:
            embedding_drift = None

        risk_breakdown = {
            "judge_drift": judge_drift,
            "cost_volatility": cost_volatility,
            "latency_p95_trend": latency_p95_trend,
            "judge_variance": judge_variance,
            "embedding_drift": embedding_drift,
        }

        # Composite. A missing component is excluded from
        # the weighted sum; the remaining weights are
        # re-normalised so the composite still lives in
        # [0, 1].
        weights = {
            "judge_drift": WEIGHT_JUDGE_DRIFT,
            "cost_volatility": WEIGHT_COST_VOLATILITY,
            "latency_p95_trend": WEIGHT_LATENCY_P95,
            "judge_variance": WEIGHT_JUDGE_VARIANCE,
            "embedding_drift": WEIGHT_EMBEDDING_DRIFT,
        }
        available = {k: v for k, v in risk_breakdown.items() if v is not None}
        if not available:
            composite: float | None = None
        else:
            weight_sum = sum(weights[k] for k in available)
            if weight_sum <= 0:
                composite = None
            else:
                composite = sum(
                    available[k] * weights[k] for k in available
                ) / weight_sum
                composite = _clamp(composite, 0.0, 1.0)

        # Alerts — per-component, threshold-driven.
        alerts: list[dict[str, Any]] = []
        for k, value in risk_breakdown.items():
            if value is None:
                continue
            threshold = ALERT_THRESHOLDS.get(k)
            if threshold is None:
                continue
            if value >= threshold:
                alerts.append(
                    {
                        "type": k,
                        "value": round(value, 4),
                        "threshold": threshold,
                        "alert": _alert_message(k, value, threshold),
                    }
                )

        # Recommendation.
        recommendation = _build_recommendation(composite, alerts)

        payload: dict[str, Any] = {
            "org_id": org_id,
            "request_id": request_id,
            "window": window,
            "composite_risk_score": (
                round(composite, 4) if composite is not None else None
            ),
            "risk_breakdown": {
                k: (round(v, 4) if v is not None else None)
                for k, v in risk_breakdown.items()
            },
            "weights": weights,
            "alerts": alerts,
            "recommendation": recommendation,
            "samples_used": {
                "judge_scores": len(judge_rows),
                "prior_judge_scores": len(prior_judge_window),
                "costs": len(costs),
                "latencies": len(latencies),
                "response_bodies": len(response_bodies),
                "prior_response_bodies": len(prior_resp_window),
            },
            "model": "weighted_v1",
        }

        if composite is not None:
            await _upsert_risk_score(
                org_id, request_id, round(composite, 4),
                json.dumps(dict(risk_breakdown.items())),
            )
        return _ok_envelope(self.name, payload)


# ── helpers ───────────────────────────────────────────────────────────


def _clamp(value: float, lo: float, hi: float) -> float:
    """Clamp ``value`` to ``[lo, hi]``."""
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def _percentile_inline(
    sorted_values: list[float], q: float
) -> float:
    """Inline copy of :func:`eden.predictive.cost._percentile`
    so the risk scorer doesn't take a runtime dependency on
    the cost module. Kept identical to avoid subtle
    drift."""
    n = len(sorted_values)
    if n == 0:
        return 0.0
    if n == 1:
        return _safe_float(sorted_values[0])
    if q <= 0:
        return _safe_float(sorted_values[0])
    if q >= 1:
        return _safe_float(sorted_values[-1])
    pos = q * (n - 1)
    lo = int(pos)
    frac = pos - lo
    if lo + 1 >= n:
        return _safe_float(sorted_values[-1])
    return _safe_float(
        sorted_values[lo] + frac * (sorted_values[lo + 1] - sorted_values[lo])
    )


def _hash_bucket_inline(text: str) -> int:
    """Inline copy of :func:`eden.predictive._common._hash_bucket`
    so the risk scorer doesn't gate on the helper's lazy
    import. Returns an int in ``[0, 64)`` — same shape as
    the helper."""
    if not text:
        return 0
    try:
        import hashlib
        digest = hashlib.blake2b(text.encode("utf-8"), digest_size=8).digest()
        return int.from_bytes(digest, "big") % 64
    except Exception:
        return 0


def _alert_message(component: str, value: float, threshold: float) -> str:
    """Build the per-component alert string."""
    if component == "judge_drift":
        return (
            f"judge-score distribution has drifted "
            f"(drift_score={round(value, 2)} >= {threshold})"
        )
    if component == "cost_volatility":
        return (
            f"cost-per-call is unpredictable "
            f"(CV={round(value, 2)} >= {threshold})"
        )
    if component == "latency_p95_trend":
        return (
            f"p95 latency is above baseline "
            f"(score={round(value, 2)} >= {threshold})"
        )
    if component == "judge_variance":
        return (
            f"judge-score variance is high "
            f"(variance_score={round(value, 2)} >= {threshold})"
        )
    if component == "embedding_drift":
        return (
            f"response embedding has drifted "
            f"(drift_score={round(value, 2)} >= {threshold})"
        )
    return f"{component} above threshold ({round(value, 2)} >= {threshold})"


def _build_recommendation(
    composite: float | None,
    alerts: list[dict[str, Any]],
) -> str:
    """Build a one-sentence recommendation from the
    composite + the per-component alerts."""
    if composite is None:
        return "no data — collect more judge / cost / latency history"
    if composite >= COMPOSITE_PAGE:
        return "page on-call — composite risk above 0.7"
    if composite >= COMPOSITE_INVESTIGATE:
        top = alerts[0]["type"] if alerts else "unknown"
        return f"investigate — composite risk above 0.4 (top: {top})"
    if alerts:
        top = alerts[0]["type"]
        return f"monitor — composite below 0.4 but {top} is elevated"
    return "no action — composite risk below 0.4"


__all__ = [
    "ALERT_THRESHOLDS",
    "COMPOSITE_INVESTIGATE",
    "COMPOSITE_PAGE",
    "EMBEDDING_SAMPLE_LIMIT",
    "LATENCY_BASELINE_MS",
    "RISK_HISTORY_HOURS",
    "RISK_JUDGE_LIMIT",
    "WEIGHT_COST_VOLATILITY",
    "WEIGHT_EMBEDDING_DRIFT",
    "WEIGHT_JUDGE_DRIFT",
    "WEIGHT_JUDGE_VARIANCE",
    "WEIGHT_LATENCY_P95",
    "RiskScorer",
]
