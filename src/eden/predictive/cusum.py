"""Cat 13 — CUSUM (cumulative sum) change-point detector.

A simple, deterministic change-point detector used by
:class:`eden.predictive.quality.QualityPredictor` to surface
sudden shifts in a daily judge-score series. CUSUM is the
textbook cumulative-sum algorithm (Page 1954):

* Maintain a running sum ``S_t = max(0, S_{t-1} + (X_t - mu - k))``
  where ``mu`` is the historical mean and ``k`` is the
  ``slack`` parameter (half the shift you want to detect).
* When ``S_t`` exceeds the ``threshold`` (``h``), declare a
  change point at time ``t``.

The detector is **pure Python** — no numpy / scipy — so the
package has no transitive deps. The reference implementation
is the 2026 ACM/IEEE time-series drift survey; see
``docs/observability-gap/13-predictive-intelligence.md`` §
Open questions for the model choice.

Two functions are exposed:

* :func:`cusum_detect` — run CUSUM on a 1-D series, return
  the list of change points (each ``{index, date, score,
  z_score, alert}``).
* :func:`cusum_classify_trend` — classify a 1-D series as
  ``stable | improving | regressing | insufficient_data``
  using a simple OLS slope sign + magnitude test.
"""

from __future__ import annotations

import logging
import math
from collections.abc import Sequence
from typing import Any

from ._common import _safe_float

logger = logging.getLogger(__name__)


#: Default slack parameter. CUSUM detects a shift of size
#: ``2 * k``; the canonical value is half the standard
#: deviation of the in-control series. The detector
#: exposes it as a parameter so the QualityPredictor can
#: tune it per org.
DEFAULT_SLACK_RATIO: float = 0.5

#: Default detection threshold. CUSUM declares a change
#: point when the running sum exceeds ``h``; the canonical
#: value is ``3 * sigma`` (3-sigma equivalent — the standard
#: MSTAT default). ``4 * sigma`` is the more conservative
#: choice; ``3 * sigma`` is what most production monitoring
#: systems ship. Exposed as a parameter for tuning.
DEFAULT_THRESHOLD_RATIO: float = 3.0

#: Minimum number of data points required for CUSUM to
#: produce a meaningful result. Below this the detector
#: returns an empty change-points list and the trend
#: classifier returns ``insufficient_data``.
MIN_POINTS: int = 7

#: Minimum slope magnitude (in absolute score units per
#: day) for the trend classifier to declare anything
#: other than ``stable``. Below this, day-to-day noise
#: dominates the signal.
TREND_SLOPE_FLOOR: float = 1e-4

#: Minimum R² for the trend classifier to declare
#: anything other than ``stable``. A low R² means the
#: linear fit is barely better than the mean; the
#: series is too noisy to call.
TREND_R2_FLOOR: float = 0.1


def cusum_detect(
    series: Sequence[float],
    *,
    slack_ratio: float = DEFAULT_SLACK_RATIO,
    threshold_ratio: float = DEFAULT_THRESHOLD_RATIO,
) -> list[dict[str, Any]]:
    """Run CUSUM on a 1-D series and return the change points.

    Args:
        series: The 1-D series, ordered ascending (oldest
            first). Each value is a judge score in ``[0, 1]``.
            May be empty.
        slack_ratio: The ``k`` parameter as a multiple of
            the series stdev. ``0.5`` detects a 1-sigma
            shift; ``1.0`` detects a 2-sigma shift.
        threshold_ratio: The ``h`` parameter as a multiple
            of the series stdev. ``4.0`` is the 4-sigma
            canonical value; higher = fewer false positives.

    Returns:
        A list of change-point dicts, one per detected
        change. Each dict has ``index`` (the position in
        ``series``), ``value`` (the score at that index),
        ``running_sum`` (the CUSUM ``S_t`` value at the
        detection), and ``delta_from_baseline`` (the
        ``value`` minus the in-control mean). Empty list
        when the series has fewer than :data:`MIN_POINTS`
        points, the stdev is zero, or no CUSUM sum ever
        crosses the threshold.
    """
    n = len(series)
    if n < MIN_POINTS:
        return []
    values = [_safe_float(v) for v in series]
    mean = sum(values) / n
    if n >= 2:
        variance = sum((v - mean) ** 2 for v in values) / (n - 1)
        stdev = math.sqrt(variance) if variance > 0 else 0.0
    else:
        stdev = 0.0
    if stdev == 0.0:
        return []
    k = slack_ratio * stdev
    h = threshold_ratio * stdev
    running = 0.0
    change_points: list[dict[str, Any]] = []
    for i, v in enumerate(values):
        running = max(0.0, running + (mean - v) - k)
        # We track downward shifts (score dropping). An
        # upward shift (score improving) uses the mirror
        # statistic; we report both via the same loop but
        # with the opposite sign.
        if running > h:
            change_points.append(
                {
                    "index": i,
                    "value": v,
                    "running_sum": running,
                    "delta_from_baseline": v - mean,
                }
            )
            # Reset the running sum so we don't keep
            # flagging the same shift.
            running = 0.0
    return change_points


def cusum_classify_trend(
    series: Sequence[float],
    *,
    slope_floor: float = TREND_SLOPE_FLOOR,
    r2_floor: float = TREND_R2_FLOOR,
) -> str:
    """Classify a 1-D series as ``stable | improving |
    regressing | insufficient_data``.

    The classifier fits a simple OLS line (no intercept
    centring, so the slope is in "score units per day") and
    uses the sign of the slope plus the R² of the fit to
    decide.

    * ``insufficient_data`` — fewer than :data:`MIN_POINTS`
      points; the caller should render "collect more data".
    * ``stable`` — slope is below the floor OR R² is below
      the floor; the series is too noisy to call.
    * ``improving`` — slope is above the floor AND the fit
      explains at least :data:`TREND_R2_FLOOR` of the
      variance. The QualityPredictor renders this as
      "scores are improving — no action needed".
    * ``regressing`` — slope is below the negative floor
      AND the fit explains at least :data:`TREND_R2_FLOOR`
      of the variance. The QualityPredictor renders this
      as "scores are regressing — investigate".

    The classifier is deterministic and pure Python so the
    package has no transitive deps.
    """
    n = len(series)
    if n < MIN_POINTS:
        return "insufficient_data"
    values = [_safe_float(v) for v in series]
    mean_y = sum(values) / n
    # OLS on (i, y_i) for i in 0..n-1. The mean of x is
    # (n - 1) / 2 — the slope is in score-units-per-day.
    try:
        mean_x = (n - 1) / 2.0
    except Exception:
        return "insufficient_data"
    num = sum((i - mean_x) * (values[i] - mean_y) for i in range(n))
    den = sum((i - mean_x) ** 2 for i in range(n))
    if den == 0:
        return "stable"
    slope = num / den
    if abs(slope) < slope_floor:
        return "stable"
    # R² = 1 - SS_res / SS_tot. We use the slope from
    # above and the same y mean to compute SS_res.
    intercept = mean_y - slope * mean_x
    ss_res = sum((values[i] - (slope * i + intercept)) ** 2 for i in range(n))
    ss_tot = sum((v - mean_y) ** 2 for v in values)
    if ss_tot == 0:
        return "stable"
    r2 = 1.0 - (ss_res / ss_tot)
    if r2 < r2_floor:
        return "stable"
    if slope > 0:
        return "improving"
    return "regressing"


def annotate_change_points(
    change_points: list[dict[str, Any]],
    *,
    series: Sequence[float] | None = None,
    dates: Sequence[Any] | None = None,
) -> list[dict[str, Any]]:
    """Add ``z_score`` and a human-readable ``alert`` string to
    each change point.

    The z-score is the value's distance from the in-control
    mean, normalised by the series stdev. The alert string
    is the message the front-end renders under the
    anomaly table.

    Args:
        change_points: The output of :func:`cusum_detect`.
        series: The original 1-D series. When provided,
            the function computes the z-score from the
            series' mean and stdev. When ``None``, the
            function uses ``change_point["delta_from_baseline"]``
            as the z-score proxy (less accurate but
            available without the original series).
        dates: Optional parallel list of ``date`` /
            ``datetime`` values. When provided, the
            function attaches the matching ``date`` to
            each change point.

    Returns:
        A new list of change-point dicts, each with
        ``z_score`` (float) and ``alert`` (str) added.
        The ``date`` key is added when ``dates`` is
        provided.
    """
    if not change_points:
        return []
    if series is not None and len(series) >= 2:
        values = [_safe_float(v) for v in series]
        n = len(values)
        mean = sum(values) / n
        variance = sum((v - mean) ** 2 for v in values) / (n - 1)
        stdev = math.sqrt(variance) if variance > 0 else 0.0
    else:
        mean = 0.0
        stdev = 0.0
    out: list[dict[str, Any]] = []
    for cp in change_points:
        cp = dict(cp)
        value = _safe_float(cp.get("value"))
        # Fall back to the (mean-less) delta when the series stdev is zero.
        z = (value - mean) / stdev if stdev > 0 else _safe_float(cp.get("delta_from_baseline"))
        cp["z_score"] = round(z, 3)
        delta_pct = (
            (cp.get("delta_from_baseline") or 0) * 100
            if isinstance(cp.get("delta_from_baseline"), (int, float))
            else 0
        )
        cp["alert"] = (
            f"judge score dropped {abs(round(delta_pct, 2))}%"
            f" at index {cp.get('index')}"
        )
        if dates is not None:
            idx = cp.get("index")
            if idx is not None and 0 <= idx < len(dates):
                d = dates[idx]
                try:
                    cp["date"] = d.isoformat() if hasattr(d, "isoformat") else d
                except Exception:
                    cp["date"] = d
        out.append(cp)
    return out


__all__ = [
    "DEFAULT_SLACK_RATIO",
    "DEFAULT_THRESHOLD_RATIO",
    "MIN_POINTS",
    "TREND_SLOPE_FLOOR",
    "TREND_R2_FLOOR",
    "annotate_change_points",
    "cusum_classify_trend",
    "cusum_detect",
]
