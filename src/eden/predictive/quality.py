"""Cat 13 — QualityPredictor.

Per-day judge-score forecast with CUSUM anomaly detection
+ trend classification. Reads recent ``judge_scores`` rows
for the org over the last :data:`QUALITY_HISTORY_DAYS` days
(default 7, configurable via ``history_window``), buckets
the scores into a daily series, and returns:

* A per-day forecast for the next ``forecast_horizon``
  days (default 7), each entry carrying the predicted
  median, the 95% confidence band, and the date.
* A CUSUM-derived list of anomalies (sudden drops in the
  daily series).
* A trend classification (``stable | improving | regressing
  | insufficient_data``).

The headline Cat 13 service from the spec:

    "based on the last 7 days of judge score drift, here's
    the predicted hallucination rate for tomorrow"

Algorithm:

* **Forecast** — trailing mean per day, with the band
  scaled by the series stdev. When the daily history is
  shorter than :data:`MIN_FORECAST_DAYS`, the service
  falls back to the window mean with a wider band.
* **CUSUM** — the Page (1954) cumulative-sum algorithm
  parameterised on the in-control stdev. The detector
  resets after every change point so the same shift
  isn't flagged twice.
* **Trend** — OLS slope sign + R² test (see
  :func:`eden.predictive.cusum.cusum_classify_trend`).

A real implementation trains per-tenant models on
``telemetry_events`` + ``judge_scores``; the v1 ship
re-uses the existing judge-score data with no new model
artefact (no model registry, no fine-tune step).

Closed-loop wiring: this service does not fire hooks.
:meth:`DriftDetector.detect_output_drift` fires
:func:`PromotionHook.on_drift_alert` on a sustained PSI
drift; the QualityPredictor returns the per-day prediction
+ anomalies the drift detector compares against.

See ``docs/observability-gap/13-predictive-intelligence.md``.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from datetime import date as _date
from typing import Any

from ._common import (
    CONF_BAND_LOWER,
    CONF_BAND_UPPER,
    MIN_FORECAST_HISTORY_DAYS,
    QUALITY_HISTORY_DAYS,
    _fetch_recent_judge_scores,
    _ok_envelope,
    _safe_float,
    _upsert_quality_prediction,
)
from .cusum import (
    annotate_change_points,
    cusum_classify_trend,
    cusum_detect,
)

logger = logging.getLogger(__name__)


#: Identifies the algorithm in the response ``data.model``
#: and in the persisted ``model_version`` column. The
#: "v1" suffix is a contract for the front-end / audit log.
MODEL_NAME: str = "trailing_mean_v1"


#: Minimum days of daily history required to attempt the
#: CUSUM detector. Below this the daily series is too
#: short for the cumulative-sum to converge.
MIN_FORECAST_DAYS: int = 7

#: Default forecast horizon (in days) when the caller
#: doesn't pass ``forecast_horizon``.
DEFAULT_FORECAST_HORIZON_DAYS: int = 7

#: Maximum forecast horizon (in days) the service will
#: project. Defensive bound — the route also enforces
#: ``le=30``.
MAX_FORECAST_HORIZON_DAYS: int = 30

#: Maximum history window (in days) the service will read.
#: Defensive bound — the route also enforces ``le=90``.
MAX_HISTORY_DAYS: int = 90


class QualityPredictor:
    """Predict the next N days of judge scores from history."""

    name = "quality_predictor"

    async def predict(
        self,
        org_id: str,
        *,
        request_id: str,
        judge_name: str | None = None,
        forecast_horizon: str = f"{DEFAULT_FORECAST_HORIZON_DAYS}d",
        history_window: str = f"{QUALITY_HISTORY_DAYS}d",
    ) -> dict[str, Any]:
        """Return the per-day forecast + anomalies + trend.

        Args:
            org_id: The tenant id.
            request_id: The request id the prediction is
                for. Persisted to ``quality_predictions`` so
                a later observer can correlate the prediction
                with the actual score (closes the
                predict-vs-actuals loop).
            judge_name: Optional filter — when set, the
                prediction is for that judge only (e.g.
                ``"hallucination"``). When ``None``, the
                service aggregates across all judges.
            forecast_horizon: A window string like ``"7d"``
                (default), ``"14d"``, ``"30d"``. Defensive
                bounds in :data:`MAX_FORECAST_HORIZON_DAYS`.
            history_window: A window string like ``"7d"``,
                ``"30d"``, ``"90d"``. Defensive bounds in
                :data:`MAX_HISTORY_DAYS`.

        Returns:
            The live envelope with ``predictions[]`` (one
            entry per day in the forecast horizon),
            ``trend`` (``stable | improving | regressing |
            insufficient_data``), ``anomalies[]`` (CUSUM-
            detected change points), and the
            ``history_window`` / ``forecast_horizon`` /
            ``samples_used`` / ``model`` metadata.
        """
        history_days = _parse_day_window(history_window, default=QUALITY_HISTORY_DAYS)
        horizon_days = _parse_day_window(
            forecast_horizon, default=DEFAULT_FORECAST_HORIZON_DAYS,
        )
        if history_days < 1:
            history_days = 1
        if history_days > MAX_HISTORY_DAYS:
            history_days = MAX_HISTORY_DAYS
        if horizon_days < 1:
            horizon_days = 1
        if horizon_days > MAX_FORECAST_HORIZON_DAYS:
            horizon_days = MAX_FORECAST_HORIZON_DAYS

        rows = await _fetch_recent_judge_scores(
            org_id, f"{history_days} days", judge_name=judge_name,
        )

        if not rows:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "request_id": request_id,
                    "judge_name": judge_name,
                    "history_window": f"{history_days}d",
                    "forecast_horizon": f"{horizon_days}d",
                    "predictions": [],
                    "trend": "insufficient_data",
                    "anomalies": [],
                    "samples_used": 0,
                    "model": MODEL_NAME,
                    "message": "no judge-score history",
                },
            )

        # Bucket rows into a per-day series of mean scores
        # (one row per day, regardless of how many judge
        # events landed on that day). Oldest day first.
        daily = _bucket_scores_by_day(rows)
        daily_dates = [d for d, _v in daily]
        daily_values = [v for _d, v in daily]
        n_days = len(daily_values)

        # Forecast — when we have enough history, use the
        # trailing mean per day. When we don't, fall back
        # to the window mean with a wider band.
        last_date = _coerce_to_date(daily_dates[-1])
        if last_date is None:
            last_date = _today()
        if n_days >= MIN_FORECAST_HISTORY_DAYS:
            mean = sum(daily_values) / n_days
            if n_days >= 2:
                variance = sum(
                    (v - mean) ** 2 for v in daily_values
                ) / (n_days - 1)
                stdev = variance ** 0.5
            else:
                stdev = 0.0
            confidence_band = _build_band(mean, stdev)
            model_name = MODEL_NAME
            warning: str | None = None
        else:
            mean = sum(daily_values) / max(1, n_days)
            stdev = 0.0
            # Wider band when the daily history is short
            # (±50% instead of the canonical ±20%).
            confidence_band = (mean * 0.5, mean * 1.5)
            model_name = "mean_fallback"
            warning = "insufficient_history"

        predictions: list[dict[str, Any]] = []
        for i in range(1, horizon_days + 1):
            day = last_date + timedelta(days=i)
            predictions.append(
                {
                    "date": day.isoformat(),
                    "predicted_score_median": round(mean, 4),
                    "ci_95_low": round(confidence_band[0], 4),
                    "ci_95_high": round(confidence_band[1], 4),
                }
            )

        # CUSUM anomaly detection — only meaningful when
        # the daily series is long enough.
        trend = cusum_classify_trend(daily_values)
        if n_days >= MIN_FORECAST_DAYS:
            change_points = cusum_detect(daily_values)
            anomalies = annotate_change_points(
                change_points, series=daily_values, dates=daily_dates,
            )
        else:
            anomalies = []

        # Persist a *summary* row keyed on the request_id
        # with the headline (mean) prediction and the
        # confidence-band half-width. The per-day series
        # and the CUSUM anomalies live in the response
        # payload only — the table is a single composite
        # row.
        samples_used = len(rows)
        confidence = _confidence_from_samples(samples_used, stdev)
        await _upsert_quality_prediction(
            org_id, request_id, round(mean, 4), confidence, model_name,
        )

        data: dict[str, Any] = {
            "org_id": org_id,
            "request_id": request_id,
            "judge_name": judge_name,
            "history_window": f"{history_days}d",
            "forecast_horizon": f"{horizon_days}d",
            "predictions": predictions,
            "trend": trend,
            "anomalies": anomalies,
            "samples_used": samples_used,
            "days_observed": n_days,
            "model": model_name,
        }
        if warning is not None:
            data["warning"] = warning
        return _ok_envelope(self.name, data)


# ── helpers ───────────────────────────────────────────────────────────


def _bucket_scores_by_day(
    rows: list[dict[str, Any]],
) -> list[tuple[_date, float]]:
    """Bucket ``rows`` into a per-day mean series, oldest first.

    The ``created_at`` field may be a ``datetime`` or a
    pre-coerced ``date``; the helper handles both. Rows
    with unparseable timestamps are skipped silently — the
    downstream forecast can still project a trend from the
    remaining days.
    """
    buckets: OrderedDict[_date, list[float]] = OrderedDict()
    for r in rows:
        ts = r.get("created_at")
        d = _coerce_to_date(ts)
        if d is None:
            continue
        buckets.setdefault(d, []).append(_safe_float(r.get("score")))
    out: list[tuple[_date, float]] = []
    for d in sorted(buckets.keys()):
        scores = buckets[d]
        out.append((d, sum(scores) / len(scores) if scores else 0.0))
    return out


def _coerce_to_date(value: Any) -> _date | None:
    """Best-effort coercion of ``value`` to a ``date``."""
    if value is None:
        return None
    if isinstance(value, _date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value).date()
        except Exception:
            return None
    return None


def _today() -> _date:
    return datetime.now(UTC).date()


def _parse_day_window(value: str, default: int) -> int:
    """Parse a day-window string like ``"7d"`` or ``"30d"``."""
    if not value:
        return default
    s = value.strip().lower()
    if s.endswith("d") and s[:-1].isdigit():
        try:
            return int(s[:-1])
        except Exception:
            return default
    if s.isdigit():
        try:
            return int(s)
        except Exception:
            return default
    return default


def _build_band(mean: float, stdev: float) -> tuple[float, float]:
    """Build a 95% CI band around ``mean`` from the series
    stdev. Uses the canonical ±20% band scaled by the
    observed stdev ratio."""
    if stdev == 0:
        return (mean * CONF_BAND_LOWER, mean * CONF_BAND_UPPER)
    lower = mean - 1.96 * stdev
    upper = mean + 1.96 * stdev
    if lower < 0:
        lower = 0.0
    if upper > 1:
        upper = 1.0
    return (lower, upper)


def _confidence_from_samples(n: int, stdev: float) -> float:
    """Confidence scaling for the persisted summary row.

    The headline Cat 13 service persists one row per
    request; the ``confidence`` is a single float in
    ``[0, 1]``. We use the same
    ``min(1.0, n / 30)`` sample term as the per-judge
    summary, modulated by the stdev ratio (a tight
    series is more confident than a noisy one).
    """
    sample_term = min(1.0, n / 30.0)
    if stdev <= 0:
        return round(sample_term, 4)
    spread_term = max(0.0, 1.0 - stdev)
    return round(sample_term * spread_term, 4)


__all__ = [
    "DEFAULT_FORECAST_HORIZON_DAYS",
    "MAX_FORECAST_HORIZON_DAYS",
    "MAX_HISTORY_DAYS",
    "MIN_FORECAST_DAYS",
    "MODEL_NAME",
    "QualityPredictor",
]
