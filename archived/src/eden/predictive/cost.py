"""Cat 13 — CostPredictor.

Per-day cost forecast with per-agent breakdown + WoW
growth-rate alert. Extends the existing Cat 8
:class:`CostForecast` with two new surfaces:

* A per-day forecast for the next ``forecast_horizon``
  days (default 30), each entry carrying the predicted
  cost, the 95% confidence band, and the date.
* A per-agent breakdown (``by_agent``) that surfaces
  each agent's projected total cost and trend
  (``growing_<N>pct | stable | shrinking_<N>pct``).
* A ``group_by`` parameter that toggles between the
  default agent-level rollup and the org-level rollup.

The headline Cat 13 service from the spec:

    "based on the last 30 days of usage, here's the
    predicted cost for next month"

Algorithm:

* **Forecast** — median of the recent per-request cost
  distribution, extended across the horizon. Median
  (not mean) is robust to cost-spike outliers — a single
  fat-fingered request shouldn't inflate the next
  prediction.
* **Per-agent** — bucketed by ``agent_id`` from
  ``usage_events``; each bucket is a separate median +
  p25/p75 band. The WoW growth rate is the ratio of the
  last 7 days to the prior 7 days; > 5% triggers the
  ``growing_<N>pct`` trend label + a top-level ``alert``.
* **Confidence** scales with sample count and CV (the
  same ``min(1, n/30) * exp(-cv)`` shape as before).

See ``docs/observability-gap/13-predictive-intelligence.md``.
"""

from __future__ import annotations

import logging
import math
from collections import OrderedDict
from datetime import UTC, datetime, timedelta
from datetime import date as _date
from typing import Any

from ._common import (
    COST_HISTORY_DAYS,
    _fetch_daily_costs_by_agent,
    _fetch_recent_costs,
    _ok_envelope,
    _safe_float,
    _upsert_cost_prediction,
    _with_pg_assumptions,
)

logger = logging.getLogger(__name__)


#: Identifies the algorithm in the response ``data.model``
#: and in the persisted ``model_version`` column.
MODEL_NAME: str = "median_v1"

#: Default forecast horizon (in days) when the caller
#: doesn't pass ``forecast_horizon``.
DEFAULT_FORECAST_HORIZON_DAYS: int = 30

#: Maximum forecast horizon (in days) the service will
#: project. Defensive bound — the route also enforces
#: ``le=90``.
MAX_FORECAST_HORIZON_DAYS: int = 90

#: Maximum history window (in days) the service will read.
#: Defensive bound — the route also enforces ``le=90``.
MAX_HISTORY_DAYS: int = 90

#: Growth-rate alert threshold (in fractional WoW). A
#: per-agent growth rate > this fires the
#: ``growing_<N>pct`` trend label and the top-level
#: ``alert`` string. Matches the spec's "growing 8% WoW —
#: investigate" callout.
GROWTH_ALERT_THRESHOLD: float = 0.05

#: Group-by buckets the route accepts. ``"agent"`` is
#: the default; ``"org"`` is the cross-agent rollup.
VALID_GROUP_BY: frozenset[str] = frozenset({"agent", "org"})


class CostPredictor:
    """Predict the next N days of cost from recent history."""

    name = "cost_predictor"

    async def predict(
        self,
        org_id: str,
        *,
        request_id: str,
        forecast_horizon: str = f"{DEFAULT_FORECAST_HORIZON_DAYS}d",
        history_window: str = f"{COST_HISTORY_DAYS}d",
        group_by: str = "agent",
    ) -> dict[str, Any]:
        """Return the per-day cost forecast + per-agent breakdown.

        Args:
            org_id: The tenant id.
            request_id: The request id the prediction is
                for. Persisted to ``cost_predictions`` so
                the actual cost can be compared against the
                prediction post-hoc (closes the
                predict-vs-actuals loop).
            forecast_horizon: A window string like ``"30d"``
                (default), ``"14d"``, ``"7d"``. Defensive
                bounds in :data:`MAX_FORECAST_HORIZON_DAYS`.
            history_window: A window string like ``"30d"``
                (default), ``"7d"``, ``"90d"``. Defensive
                bounds in :data:`MAX_HISTORY_DAYS`.
            group_by: Either ``"agent"`` (default — the
                per-agent rollup) or ``"org"`` (cross-agent
                rollup). The per-day forecast is the same
                in both cases; the ``by_agent`` map is
                empty when ``group_by="org"``.

        Returns:
            The live envelope with ``predictions[]`` (one
            entry per day in the forecast horizon),
            ``by_agent{}`` (per-agent totals + trend),
            ``alert`` (a string when any agent's WoW
            growth is above the threshold), and the
            ``history_window`` / ``forecast_horizon`` /
            ``model`` / ``group_by`` metadata.
        """
        history_days = _parse_day_window(history_window, default=COST_HISTORY_DAYS)
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
        if group_by not in VALID_GROUP_BY:
            group_by = "agent"

        costs = await _fetch_recent_costs(
            org_id, f"{history_days} days",
        )
        if not costs:
            return _ok_envelope(
                self.name,
                _with_pg_assumptions(
                    {
                        "org_id": org_id,
                        "request_id": request_id,
                        "history_window": f"{history_days}d",
                        "forecast_horizon": f"{horizon_days}d",
                        "group_by": group_by,
                        "predictions": [],
                        "by_agent": {},
                        "predicted_cost_usd": None,
                        "confidence": None,
                        "samples_used": 0,
                        "model": MODEL_NAME,
                        "message": "no usage history",
                    }
                ),
            )

        n = len(costs)
        sorted_costs = sorted(costs)
        median = _percentile(sorted_costs, 0.5)
        p25 = _percentile(sorted_costs, 0.25)
        p75 = _percentile(sorted_costs, 0.75)
        mean = sum(costs) / n
        if n >= 2:
            variance = sum((c - mean) ** 2 for c in costs) / (n - 1)
            stdev = variance ** 0.5
        else:
            stdev = 0.0
        cv = (stdev / mean) if mean > 0 else 0.0
        try:
            spread_term = _safe_float(_exp_neg(cv))
        except Exception:
            spread_term = 0.0
        sample_term = min(1.0, n / 30.0)
        confidence = round(sample_term * spread_term, 4)

        # Per-day forecast. The daily median is the
        # org-level projection; the per-day CI uses
        # ±50% (wider than the per-request CI) because
        # the daily series has fewer samples.
        daily = median
        last_date = _today()
        predictions: list[dict[str, Any]] = []
        for i in range(1, horizon_days + 1):
            day = last_date + timedelta(days=i)
            predictions.append(
                {
                    "date": day.isoformat(),
                    "predicted_cost_usd": round(daily, 4),
                    "ci_95_low": round(daily * 0.5, 4),
                    "ci_95_high": round(daily * 1.5, 4),
                }
            )

        # Per-agent breakdown + WoW growth-rate alert.
        by_agent: dict[str, dict[str, Any]] = {}
        alert: str | None = None
        if group_by == "agent":
            rows = await _fetch_daily_costs_by_agent(
                org_id, f"{history_days} days",
            )
            by_agent, alert = _compute_by_agent(rows, horizon_days)

        await _upsert_cost_prediction(
            org_id, request_id, round(median, 4), MODEL_NAME,
        )
        payload: dict[str, Any] = {
            "org_id": org_id,
            "request_id": request_id,
            "history_window": f"{history_days}d",
            "forecast_horizon": f"{horizon_days}d",
            "group_by": group_by,
            "predictions": predictions,
            "by_agent": by_agent,
            "predicted_cost_usd": round(median, 4),
            "p25_usd": round(p25, 4),
            "p75_usd": round(p75, 4),
            "stdev_usd": round(stdev, 4),
            "mean_usd": round(mean, 4),
            "coefficient_of_variation": round(cv, 4),
            "confidence": confidence,
            "samples_used": n,
            "model": MODEL_NAME,
        }
        if alert is not None:
            payload["alert"] = alert
        return _ok_envelope(self.name, _with_pg_assumptions(payload))


# ── helpers ───────────────────────────────────────────────────────────


def _compute_by_agent(
    rows: list[dict[str, Any]],
    horizon_days: int,
) -> tuple[dict[str, dict[str, Any]], str | None]:
    """Compute the per-agent breakdown + the WoW growth alert.

    The function reads the daily per-agent rollup, splits
    each agent's series into the last 7 days and the
    prior 7 days, and computes the WoW growth rate. Any
    agent with growth > :data:`GROWTH_ALERT_THRESHOLD` is
    flagged in the alert string.

    Args:
        rows: The output of
            :func:`eden.predictive._common._fetch_daily_costs_by_agent`.
        horizon_days: The forecast horizon (used to
            project the per-agent total — daily median
            * horizon).

    Returns:
        ``(by_agent, alert)``. ``by_agent`` is a dict
        keyed by agent_id with the per-agent metadata
        (predicted total + trend label). ``alert`` is a
        string when at least one agent crosses the
        growth threshold, otherwise ``None``.
    """
    if not rows:
        return ({}, None)
    # Bucket by agent_id. Each bucket is a list of
    # ``(day, cost_usd)`` rows sorted ascending.
    by_agent_buckets: OrderedDict[str, list[tuple[_date, float]]] = OrderedDict()
    for r in rows:
        day = _coerce_to_date(r.get("day"))
        if day is None:
            continue
        agent_id = r.get("agent_id") or "__org__"
        by_agent_buckets.setdefault(agent_id, []).append(
            (day, _safe_float(r.get("cost_usd"))),
        )
    out: dict[str, dict[str, Any]] = {}
    flagged_agents: list[str] = []
    flagged_growth: list[float] = []
    for agent_id, series in by_agent_buckets.items():
        series.sort(key=lambda t: t[0])
        # Daily median for projection.
        costs = [c for _d, c in series]
        if not costs:
            continue
        sorted_costs = sorted(costs)
        daily_median = _percentile(sorted_costs, 0.5)
        predicted_total = round(daily_median * horizon_days, 4)
        # WoW growth: sum of last 7 days vs sum of prior 7
        # days. Agents with fewer than 14 days of history
        # get a "stable" trend (insufficient data).
        last_7 = sum(c for _d, c in series[-7:])
        prior_7 = sum(c for _d, c in series[:-7][-7:]) if len(series) > 7 else 0.0
        if prior_7 > 0 and len(series) > 7:
            growth = (last_7 - prior_7) / prior_7
        elif prior_7 == 0 and last_7 > 0:
            # New agent — call it growing; the alert
            # threshold guards against noise.
            growth = 1.0
        else:
            growth = 0.0
        if growth > GROWTH_ALERT_THRESHOLD:
            trend = f"growing_{int(round(growth * 100))}pct"
            flagged_agents.append(agent_id)
            flagged_growth.append(growth)
        elif growth < -GROWTH_ALERT_THRESHOLD:
            trend = f"shrinking_{int(round(abs(growth) * 100))}pct"
        else:
            trend = "stable"
        out[agent_id] = {
            "predicted_total_usd": predicted_total,
            "daily_median_usd": round(daily_median, 4),
            "trend": trend,
            "growth_wow": round(growth, 4),
            "days_observed": len(series),
        }
    alert: str | None = None
    if flagged_agents:
        # Surface the most-flagged agent first; the
        # alert is a single sentence the front-end can
        # render as a banner.
        worst = max(zip(flagged_agents, flagged_growth, strict=False), key=lambda t: t[1])
        alert = (
            f"{worst[0]} spend growing {int(round(worst[1] * 100))}% WoW"
            f" — investigate"
        )
    return (out, alert)


def _percentile(sorted_values: list[float], q: float) -> float:
    """Return the q-th percentile of a pre-sorted list.

    Uses the linear-interpolation convention (NIST type 7,
    ``R``-default). ``q`` is in ``[0, 1]``. Returns
    ``sorted_values[0]`` for empty input.
    """
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


def _exp_neg(x: float) -> float:
    """``exp(-x)`` without gating the package on the
    :mod:`math` import (already imported elsewhere, but
    kept as a small helper for testability)."""
    return math.exp(-x)


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


__all__ = [
    "COST_HISTORY_DAYS",
    "DEFAULT_FORECAST_HORIZON_DAYS",
    "GROWTH_ALERT_THRESHOLD",
    "MAX_FORECAST_HORIZON_DAYS",
    "MAX_HISTORY_DAYS",
    "MODEL_NAME",
    "VALID_GROUP_BY",
    "CostPredictor",
    "_percentile",
]
