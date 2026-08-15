"""Cost Intelligence services (Cat 8) — real implementations.

Four services:
* :class:`CostEfficiencyScorer` — cost per ticket, per report,
  per goal.
* :class:`ROIAnalyzer` — spend vs value.
* :class:`CostAnomalyDetector` — spikes, regressions, drift.
* :class:`CostForecast` — next-N-days projection.

The services read from the production-grade ``usage_events``
table (populated by ``src/eden/services/usage_service.py``) and
the ``outcomes`` table (Cat 11, currently empty). Both
dependencies degrade gracefully — an empty ``outcomes`` table
gives ``null`` cost_per_outcome and ``null`` ROI; an empty
``usage_events`` table gives an empty result with a ``"no
usage data"`` message.

The ``CostAnomalyDetector`` fires the Cat 17 closed-loop
:func:`PromotionHook.on_drift_alert` hook for each
high-severity (|z| > 4) anomaly. The hook is a no-op logger
in stub mode; a real implementation would let the canary
auto-rollback on a high-severity drift alert.

See ``docs/observability-gap/08-cost-intelligence.md``.
"""

from __future__ import annotations

import asyncio  # Audit 2026-07-02 P-8 (gather on cost + outcomes)
import logging
from datetime import timedelta
from typing import Any

from ._common import (
    ALLOWED_GROUP_BY,
    CONF_BAND_LOWER,
    CONF_BAND_UPPER,
    FORECAST_HISTORY_DAYS,
    HIGH_Z_THRESHOLD,
    MIN_FORECAST_HISTORY_DAYS,
    Z_THRESHOLD,
    _bad_request_envelope,
    _delete_then_insert_efficiency,
    _delete_then_insert_roi,
    _fetch_cost_by_group,
    _fetch_daily_costs,
    _fetch_outcome_count_by_type,
    _fetch_top_attribution_for_days,
    _fetch_total_cost,
    _fetch_total_value,
    _fire_cost_anomaly_alert,
    _format_likely_cause,
    _linear_regression,
    _ok_envelope,
    _parse_window,
    _safe_float,
)

logger = logging.getLogger(__name__)


# ── 1. CostEfficiencyScorer ──────────────────────────────────────────


class CostEfficiencyScorer:
    """Cost per outcome, broken down by group_by dimension.

    The :class:`name` is ``"cost_efficiency"`` and matches the
    ``feature`` field in the response envelope. Public method
    :meth:`score` returns the live envelope on success, the
    bad-request envelope on invalid input, or the live
    "no usage data" envelope when the window is empty.
    """

    name = "cost_efficiency"

    async def score(
        self,
        org_id: str,
        *,
        group_by: str = "outcome_type",
        window: str = "7d",
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '24h', '60m'",
            )
        if group_by not in ALLOWED_GROUP_BY:
            return _bad_request_envelope(
                self.name,
                f"invalid group_by {group_by!r}; "
                f"allowed: {sorted(ALLOWED_GROUP_BY)}",
            )

        # Audit 2026-07-02 P-8: cost + outcomes fetched via
        # asyncio.gather (collapse 2 round-trips into 1).
        if group_by == "outcome_type":
            cost_by_group, outcomes_by_type = await asyncio.gather(
                _fetch_cost_by_group(org_id, interval, group_by),
                _fetch_outcome_count_by_type(org_id, interval),
            )
        else:
            cost_by_group = await _fetch_cost_by_group(
                org_id, interval, group_by
            )
            outcomes_by_type = {}

        # No usage data at all → return the empty-envelope
        # shape so the front-end can render a clean
        # "no data" message.
        if not cost_by_group and not outcomes_by_type:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "group_by": group_by,
                    "window": window,
                    "per_outcome": [],
                    "message": "no usage data",
                },
            )

        per_outcome: list[dict[str, Any]] = []
        persist_rows: list[dict[str, Any]] = []
        for row in cost_by_group:
            gv = row.get("group_value")
            total_cost = _safe_float(row.get("total_cost"))
            if group_by == "outcome_type":
                oc = int(outcomes_by_type.get(gv, 0))
                if oc > 0:
                    cpo: float | None = total_cost / oc
                    warning: str | None = None
                else:
                    cpo = None
                    warning = "no_outcomes_in_window"
                per_outcome.append(
                    {
                        "outcome_type": gv,
                        "cost_per_outcome": cpo,
                        "sample_size": oc,
                        "total_cost_usd": total_cost,
                        "warning": warning,
                    }
                )
                persist_rows.append(
                    {
                        "group_by_value": gv,
                        "cost_per_outcome": cpo,
                        "sample_size": oc,
                    }
                )
            else:
                # Non-outcome group_by — we have the cost, but
                # the outcomes table isn't bucketed by this
                # dimension, so cost_per_outcome is null and
                # sample_size is 0.
                per_outcome.append(
                    {
                        "dimension": gv,
                        "cost_per_outcome": None,
                        "sample_size": 0,
                        "total_cost_usd": total_cost,
                        "warning": "outcomes_not_bucketed_by_group",
                    }
                )
                persist_rows.append(
                    {
                        "group_by_value": gv,
                        "cost_per_outcome": None,
                        "sample_size": 0,
                    }
                )

        # Persist per-group rows (best-effort).
        await _delete_then_insert_efficiency(
            org_id, group_by, persist_rows
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "group_by": group_by,
                "window": window,
                "per_outcome": per_outcome,
            },
        )


# ── 2. ROIAnalyzer ───────────────────────────────────────────────────


class ROIAnalyzer:
    """Spend vs value, with a derived ROI multiplier.

    ROI is ``(value - spend) / spend``; when ``spend == 0`` the
    ROI is null (division by zero is undefined). Negative ROI
    is rendered as a negative multiplier (e.g. ``-0.5`` for
    "lost 50%"). The :attr:`name` is ``"roi_analyzer"``.
    """

    name = "roi_analyzer"

    async def roi(
        self,
        org_id: str,
        *,
        window: str = "30d",
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '30d', '24h'",
            )

        # Audit 2026-07-02 P-8: parallel fetch total cost + value.
        spend_usd, value_usd = await asyncio.gather(
            _fetch_total_cost(org_id, interval),
            _fetch_total_value(org_id, interval),
        )
        net_return_usd = value_usd - spend_usd
        if spend_usd > 0:
            roi: float | None = net_return_usd / spend_usd
        else:
            roi = None

        # Persist (best-effort).
        await _delete_then_insert_roi(
            org_id, window, spend_usd, value_usd, roi
        )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": window,
                "spend_usd": spend_usd,
                "value_generated_usd": value_usd,
                "net_return_usd": net_return_usd,
                "roi": roi,
            },
        )


# ── 3. CostAnomalyDetector ───────────────────────────────────────────


class CostAnomalyDetector:
    """Z-score on the daily cost series, with closed-loop hook
    firing for high-severity anomalies.

    Anomaly if ``|z| > 2.5``; severity ``"high"`` if ``|z| > 4``,
    else ``"medium"``. Direction: positive z → ``"cost_spike"``,
    negative z → ``"cost_drop"``. For each anomalous day, the
    top ``(model, agent_id)`` is attributed via a batched
    follow-up query. The :func:`PromotionHook.on_drift_alert`
    closed-loop hook fires for each high-severity anomaly.
    """

    name = "cost_anomaly"

    async def detect(
        self,
        org_id: str,
        *,
        window: str = "7d",
    ) -> dict[str, Any]:
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '30d'",
            )

        daily = await _fetch_daily_costs(org_id, interval)

        if not daily:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "anomalies": [],
                    "message": "no usage data",
                    "days_observed": 0,
                },
            )
        if len(daily) < 2:
            # Z-score needs ≥ 2 points to compute a variance.
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "anomalies": [],
                    "message": "insufficient history for z-score",
                    "days_observed": len(daily),
                },
            )

        costs = [_safe_float(d.get("cost")) for d in daily]
        mean = sum(costs) / len(costs)
        # Sample stdev (n-1 denominator) — matches the appendix's
        # `statistics.stdev(costs)` call. Falls back to 0.0 for
        # an all-equal series, which is handled below.
        if len(costs) < 2:
            stdev = 0.0
        else:
            sq = sum((c - mean) ** 2 for c in costs)
            stdev = (sq / (len(costs) - 1)) ** 0.5

        if stdev == 0:
            # Every day is the same — no anomalies by definition.
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "window": window,
                    "anomalies": [],
                    "message": "no variance in window",
                    "mean_usd": mean,
                    "days_observed": len(daily),
                },
            )

        anomalies: list[dict[str, Any]] = []
        anomalous_days: list[Any] = []
        for row, cost in zip(daily, costs, strict=False):
            z = (cost - mean) / stdev
            if abs(z) <= Z_THRESHOLD:
                continue
            atype = "cost_spike" if z > 0 else "cost_drop"
            severity = "high" if abs(z) > HIGH_Z_THRESHOLD else "medium"
            lower = mean - 2 * stdev
            upper = mean + 2 * stdev
            if mean == 0:
                deviation_pct: float | None = None
            else:
                deviation_pct = (cost - mean) / mean * 100.0
            anomalies.append(
                {
                    "type": atype,
                    "severity": severity,
                    "observed_usd": cost,
                    "expected_range_usd": [lower, upper],
                    "deviation_percent": deviation_pct,
                    "z_score": z,
                    "day": row.get("day"),
                    "likely_cause": None,  # filled below
                }
            )
            anomalous_days.append(row.get("day"))

        # Attribute the top (model, agent_id) per anomalous day.
        # Best-effort: missing attribution leaves likely_cause=None.
        if anomalous_days:
            try:
                top_by_day = await _fetch_top_attribution_for_days(
                    org_id, anomalous_days
                )
            except Exception as exc:
                logger.debug(
                    "cost_anomaly: attribution query failed: %s", exc
                )
                top_by_day = {}
            for a in anomalies:
                top = top_by_day.get(a.get("day"))
                a["likely_cause"] = _format_likely_cause(top)

        # Fire the closed-loop hook for high-severity anomalies.
        _fire_cost_anomaly_alert(org_id, anomalies)

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window": window,
                "anomalies": anomalies,
                "mean_usd": mean,
                "stdev_usd": stdev,
                "days_observed": len(daily),
            },
        )


# ── 4. CostForecast ──────────────────────────────────────────────────


class CostForecast:
    """Next-N-days projection of cost.

    Uses OLS linear regression on the 90-day daily cost series
    (from ``usage_events``). If fewer than 14 days of history
    are available, falls back to the window mean with an
    ``insufficient_history`` warning. The
    :func:`_linear_regression` helper handles the
    arithmetic.
    """

    name = "cost_forecast"

    #: Identifier in the response ``data.model`` so the
    #: front-end / audit log can tell which algorithm
    #: produced the projection.
    MODEL_NAME: str = "linear_regression_v1"

    async def forecast(
        self,
        org_id: str,
        *,
        horizon_days: int = 7,
    ) -> dict[str, Any]:
        # Defensive bounds — the FastAPI route already
        # constrains ``ge=1, le=90`` but the service should
        # still be safe if called directly.
        if horizon_days < 1:
            horizon_days = 1
        if horizon_days > 365:
            horizon_days = 365

        # Read 90 days of history regardless of horizon_days.
        daily = await _fetch_daily_costs(
            org_id, f"{FORECAST_HISTORY_DAYS} days"
        )

        if not daily:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "horizon_days": horizon_days,
                    "forecast": [],
                    "message": "no usage data",
                    "model": self.MODEL_NAME,
                    "days_observed": 0,
                },
            )

        if len(daily) < MIN_FORECAST_HISTORY_DAYS:
            # Mean fallback — emit horizon_days rows of the
            # mean with a symmetric ±20% band.
            mean_cost = sum(_safe_float(d.get("cost")) for d in daily) / len(daily)
            last_day = daily[-1].get("day")
            forecast_rows: list[dict[str, Any]] = []
            for i in range(1, horizon_days + 1):
                day = last_day + timedelta(days=i) if last_day is not None else None
                forecast_rows.append(
                    {
                        "day": day,
                        "predicted_cost_usd": mean_cost,
                        "lower": mean_cost * CONF_BAND_LOWER,
                        "upper": mean_cost * CONF_BAND_UPPER,
                    }
                )
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "horizon_days": horizon_days,
                    "forecast": forecast_rows,
                    "warning": "insufficient_history",
                    "model": "mean_fallback",
                    "days_observed": len(daily),
                },
            )

        # Linear regression on (day_index, daily_cost).
        n = len(daily)
        x = [float(i) for i in range(n)]
        y = [_safe_float(d.get("cost")) for d in daily]
        slope, intercept = _linear_regression(x, y)
        last_day = daily[-1].get("day")
        forecast_rows = []
        for i in range(1, horizon_days + 1):
            predicted = slope * (n + i - 1) + intercept
            day = last_day + timedelta(days=i) if last_day is not None else None
            forecast_rows.append(
                {
                    "day": day,
                    "predicted_cost_usd": predicted,
                    "lower": predicted * CONF_BAND_LOWER,
                    "upper": predicted * CONF_BAND_UPPER,
                }
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "horizon_days": horizon_days,
                "forecast": forecast_rows,
                "warning": None,
                "model": self.MODEL_NAME,
                "slope": slope,
                "intercept": intercept,
                "days_observed": n,
            },
        )
