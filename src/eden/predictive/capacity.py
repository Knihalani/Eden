"""Cat 13 — CapacityPredictor.

Multi-scenario resource-usage forecast over a horizon.
Reads the daily call count and token total from
``telemetry_events`` + ``usage_events`` and projects the
next N days of GPU-hours under four demand scenarios
(``baseline | 2x | 3x | 5x``).

The headline Cat 13 service from the spec:

    "based on the last 30 days, you'll need X GPUs by Y
    date"

Algorithm: OLS linear regression on the daily series, with
a per-day mean fallback when the history is shorter than
:data:`MIN_FORECAST_HISTORY_DAYS`. Mirrors the Cat 8
:class:`CostForecast` pattern. The capacity projection
differs from the cost forecast in two ways:

* It tracks *two* correlated series (call count + token
  total) and sums them into a single GPU-hour estimate.
* The "GPU-hour" unit is a rough proxy — we treat 1M
  tokens as 1 GPU-hour and the per-call overhead as a
  constant. v2 can swap in a real model (ML-perf-lab
  benchmarks or a per-model lookup); the v1 ship is the
  floor.

**Scenarios.** Each scenario multiplies the baseline
projection by a constant (2, 3, 5) and surfaces a
``peak_rpm``, ``max_gpu_needed``, and ``max_storage_gb``
estimate. The ``headroom_days`` map reports the days
remaining until the projected peak exceeds the current
fleet size (set via the ``current_fleet_size`` param,
default 8 GPUs).

The persistence target is ``capacity_forecasts`` (one row
per run; delete-then-insert to keep it re-runnable).

See ``docs/observability-gap/13-predictive-intelligence.md``.
"""

from __future__ import annotations

import json
import logging
from datetime import date as _date
from datetime import datetime, timedelta
from typing import Any

from ._common import (
    CAPACITY_HISTORY_DAYS,
    CONF_BAND_LOWER,
    CONF_BAND_UPPER,
    MIN_FORECAST_HISTORY_DAYS,
    _fetch_daily_call_counts,
    _fetch_daily_token_totals,
    _json_safe,
    _linear_regression,
    _ok_envelope,
    _safe_float,
    _upsert_capacity_forecast,
)

logger = logging.getLogger(__name__)


#: Identifies the algorithm in the response ``data.model``
#: and in the persisted ``model_version`` column.
MODEL_NAME: str = "linear_regression_v1"

#: Per-call overhead in GPU-hours. A v1 approximation —
#: real numbers come from per-model ML-perf-lab benchmarks
#: (out of scope for the v1 ship).
PER_CALL_GPU_HOURS: float = 1.0 / 1_000_000.0

#: Tokens per GPU-hour. Also a v1 approximation; v2 swaps
#: in a per-model lookup.
TOKENS_PER_GPU_HOUR: float = 1_000_000.0

#: Defensive bounds — the FastAPI route constrains
#: ``ge=1, le=90`` but the service should still be safe
#: if called directly.
MIN_HORIZON_DAYS: int = 1
MAX_HORIZON_DAYS: int = 90

#: Default current fleet size (GPUs) used by the
#: ``headroom_days`` projection. The route also accepts
#: an explicit ``current_fleet_size`` parameter.
DEFAULT_FLEET_SIZE: int = 8

#: Default storage headroom (GB) for the per-scenario
#: ``max_storage_gb`` estimate. 1 GPU-month of tokens
#: is ~5 GB; the constant is a v1 approximation.
STORAGE_GB_PER_GPU_MONTH: float = 5.0

#: Scenario multipliers — the canonical baseline / 2x /
#: 3x / 5x from the spec. The dict is preserved as
#: ordered so the response JSON keeps a stable shape.
SCENARIO_MULTIPLIERS: dict[str, int] = {
    "baseline": 1,
    "2x": 2,
    "3x": 3,
    "5x": 5,
}

#: Valid scenario keys the route accepts.
VALID_SCENARIOS: frozenset[str] = frozenset(SCENARIO_MULTIPLIERS.keys())


class CapacityPredictor:
    """Forecast the next N days of GPU-hour demand under
    four demand scenarios."""

    name = "capacity_predictor"

    async def predict(
        self,
        org_id: str,
        *,
        horizon_days: int = 7,
        forecast_horizon: str | None = None,
        scenario: str = "baseline",
        current_fleet_size: int = DEFAULT_FLEET_SIZE,
    ) -> dict[str, Any]:
        """Return the projected GPU-hour demand for the next
        ``horizon_days`` days.

        Args:
            org_id: The tenant id.
            horizon_days: The projection window in days.
                Default 7. The FastAPI route constrains this
                to ``[1, 90]``; the service clamps too.
            forecast_horizon: Optional ``"30d"`` / ``"90d"``
                style string. When provided, ``horizon_days``
                is overridden (the route exposes both shapes
                for back-compat with the v1 clients).
            scenario: One of ``"baseline"`` (default),
                ``"2x"``, ``"3x"``, ``"5x"``. The response
                includes the per-scenario breakdown in
                ``scenarios{}``; the per-day forecast is
                always the baseline projection.
            current_fleet_size: The customer's current GPU
                fleet size. Used by the ``headroom_days``
                map and the ``recommendation`` string.

        Returns:
            The live envelope with ``scenarios{}`` (per-
            scenario ``peak_rpm``, ``max_gpu_needed``,
            ``max_storage_gb``), ``headroom_days{}`` (days
            remaining until the projected peak exceeds the
            current fleet, per scenario), ``recommendation``
            (a single human-readable sentence), and the
            per-day ``gpu_hours_per_day`` forecast.
        """
        if forecast_horizon:
            horizon_days = _parse_day_window(
                forecast_horizon, default=horizon_days,
            )
        if horizon_days < MIN_HORIZON_DAYS:
            horizon_days = MIN_HORIZON_DAYS
        if horizon_days > MAX_HORIZON_DAYS:
            horizon_days = MAX_HORIZON_DAYS
        if scenario not in VALID_SCENARIOS:
            scenario = "baseline"
        if current_fleet_size < 1:
            current_fleet_size = 1

        calls = await _fetch_daily_call_counts(
            org_id, f"{CAPACITY_HISTORY_DAYS} days",
        )
        tokens = await _fetch_daily_token_totals(
            org_id, f"{CAPACITY_HISTORY_DAYS} days",
        )

        if not calls and not tokens:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "horizon_days": horizon_days,
                    "scenario": scenario,
                    "current_fleet_size": current_fleet_size,
                    "scenarios": {},
                    "headroom_days": {},
                    "recommendation": (
                        "no telemetry / usage history — cannot project"
                    ),
                    "gpu_hours_per_day": [],
                    "total_gpu_hours": 0.0,
                    "message": "no telemetry / usage history",
                    "model": MODEL_NAME,
                    "days_observed": 0,
                },
            )

        per_day = _merge_daily_series(calls, tokens)
        days_observed = len(per_day)
        last_day = per_day[-1]["day"]
        last_gpu_hours = per_day[-1]["gpu_hours"]

        if days_observed < MIN_FORECAST_HISTORY_DAYS:
            mean_gpu = sum(_safe_float(d["gpu_hours"]) for d in per_day) / days_observed
            forecast_rows: list[dict[str, Any]] = []
            for i in range(1, horizon_days + 1):
                day = (
                    last_day + timedelta(days=i)
                    if last_day is not None
                    else None
                )
                forecast_rows.append(
                    {
                        "day": day,
                        "predicted_gpu_hours": mean_gpu,
                        "lower": mean_gpu * CONF_BAND_LOWER,
                        "upper": mean_gpu * CONF_BAND_UPPER,
                    }
                )
            total = mean_gpu * horizon_days
            scenarios, headroom, recommendation = _build_scenarios(
                forecast_rows, current_fleet_size,
            )
            payload = {
                "org_id": org_id,
                "horizon_days": horizon_days,
                "scenario": scenario,
                "current_fleet_size": current_fleet_size,
                "scenarios": scenarios,
                "headroom_days": headroom,
                "recommendation": recommendation,
                "gpu_hours_per_day": forecast_rows,
                "total_gpu_hours": total,
                "warning": "insufficient_history",
                "model": "mean_fallback",
                "days_observed": days_observed,
            }
            await _upsert_capacity_forecast(
                org_id,
                forecast_rows[0]["day"] if forecast_rows else None,
                forecast_rows[-1]["day"] if forecast_rows else None,
                json.dumps(_json_safe(payload)),
                MODEL_NAME,
            )
            return _ok_envelope(self.name, payload)

        # Linear regression on (day_index, gpu_hours).
        n = days_observed
        x = [float(i) for i in range(n)]
        y = [_safe_float(d["gpu_hours"]) for d in per_day]
        slope, intercept = _linear_regression(x, y)
        forecast_rows = []
        for i in range(1, horizon_days + 1):
            predicted = slope * (n + i - 1) + intercept
            day = (
                last_day + timedelta(days=i)
                if last_day is not None
                else None
            )
            forecast_rows.append(
                {
                    "day": day,
                    "predicted_gpu_hours": predicted,
                    "lower": predicted * CONF_BAND_LOWER,
                    "upper": predicted * CONF_BAND_UPPER,
                }
            )
        total = sum(_safe_float(r["predicted_gpu_hours"]) for r in forecast_rows)
        scenarios, headroom, recommendation = _build_scenarios(
            forecast_rows, current_fleet_size,
        )
        payload = {
            "org_id": org_id,
            "horizon_days": horizon_days,
            "scenario": scenario,
            "current_fleet_size": current_fleet_size,
            "scenarios": scenarios,
            "headroom_days": headroom,
            "recommendation": recommendation,
            "gpu_hours_per_day": forecast_rows,
            "total_gpu_hours": total,
            "last_observed_gpu_hours": last_gpu_hours,
            "last_observed_day": last_day,
            "model": MODEL_NAME,
            "days_observed": n,
        }
        await _upsert_capacity_forecast(
            org_id,
            forecast_rows[0]["day"] if forecast_rows else None,
            forecast_rows[-1]["day"] if forecast_rows else None,
            json.dumps(_json_safe(payload)),
            MODEL_NAME,
        )
        return _ok_envelope(self.name, payload)


# ── helpers ───────────────────────────────────────────────────────────


def _build_scenarios(
    forecast_rows: list[dict[str, Any]],
    current_fleet_size: int,
) -> tuple[dict[str, dict[str, Any]], dict[str, int], str]:
    """Build the per-scenario rollup, the headroom map, and
    a one-sentence recommendation.

    Args:
        forecast_rows: The per-day baseline forecast from
            the linear-regression or mean-fallback path.
        current_fleet_size: The customer's current GPU
            fleet size.

    Returns:
        ``(scenarios, headroom_days, recommendation)``.
        ``scenarios`` is a dict keyed by scenario name
        (e.g. ``"baseline"``, ``"2x"``) with
        ``peak_rpm``, ``max_gpu_needed``, ``max_storage_gb``.
        ``headroom_days`` is a dict keyed by scenario name
        with the days remaining until the projected peak
        exceeds the current fleet. ``recommendation`` is
        a single sentence the front-end renders as a
        banner (e.g. ``"For Black Friday 3x scenario, you
        need 24 GPUs by 2026-11-15. Current fleet is 8
        GPUs. Add 16 GPUs in the next 30 days."``).
    """
    if not forecast_rows:
        return ({}, {}, "no forecast available — collect more data")
    # Peak GPU-hours per day across the forecast window.
    peak_baseline = max(
        _safe_float(r.get("predicted_gpu_hours"))
        for r in forecast_rows
    )
    # RPM = requests-per-minute. We approximate by
    # calls-per-day / 1440 (minutes per day). The
    # ``calls`` count comes from the daily series; for
    # the scenario rollup we use the peak day's calls.
    # When we only have the per-day ``gpu_hours`` we
    # back-convert to calls via PER_CALL_GPU_HOURS.
    peak_calls = peak_baseline / PER_CALL_GPU_HOURS
    peak_rpm = peak_calls / 1440.0
    scenarios: dict[str, dict[str, Any]] = {}
    headroom: dict[str, int] = {}
    target_date: _date | None = None
    target_needed: int | None = None
    for name, multiplier in SCENARIO_MULTIPLIERS.items():
        peak_gpu = peak_baseline * multiplier
        max_gpu_needed = max(1, int(math.ceil(peak_gpu * 24.0)))
        # 1 GPU-month ≈ 30 GPU-days; storage scales with
        # the projected GPU-days.
        gpu_months = (peak_gpu * len(forecast_rows)) / 30.0
        max_storage_gb = round(gpu_months * STORAGE_GB_PER_GPU_MONTH, 2)
        scenarios[name] = {
            "peak_rpm": round(peak_rpm * multiplier, 2),
            "max_gpu_needed": max_gpu_needed,
            "max_storage_gb": max_storage_gb,
        }
        if multiplier == 1:
            headroom[name] = _days_until_overflow(
                forecast_rows, current_fleet_size, multiplier=1,
            )
        else:
            headroom[name] = _days_until_overflow(
                forecast_rows, current_fleet_size, multiplier=multiplier,
            )
        if (
            target_date is None
            and max_gpu_needed > current_fleet_size
        ):
            # First scenario that overflows the fleet.
            target_date = _coerce_to_date(forecast_rows[0].get("day"))
            target_needed = max_gpu_needed
    recommendation = _build_recommendation(
        target_date, target_needed, current_fleet_size, scenarios,
    )
    return (scenarios, headroom, recommendation)


def _days_until_overflow(
    forecast_rows: list[dict[str, Any]],
    current_fleet_size: int,
    *,
    multiplier: int,
) -> int:
    """Number of days from the start of the forecast window
    until the projected GPU-hours * 24 (per day) * ``multiplier``
    exceeds the current fleet size. Returns the full
    horizon when the fleet never overflows (defensive:
    the front-end renders this as "you have headroom")."""
    if multiplier <= 0:
        multiplier = 1
    for i, r in enumerate(forecast_rows, start=1):
        gpu_per_day = _safe_float(r.get("predicted_gpu_hours")) * multiplier
        if gpu_per_day * 24.0 > current_fleet_size:
            return i
    return len(forecast_rows)


def _build_recommendation(
    target_date: _date | None,
    target_needed: int | None,
    current_fleet_size: int,
    scenarios: dict[str, dict[str, Any]],
) -> str:
    """Build a one-sentence recommendation string.

    When the baseline scenario is fine, returns
    ``"baseline scenario: no GPU additions needed in the
    next 30 days"``. When a scenario overflows, returns
    the canonical ``"For <scenario> scenario, you need N
    GPUs by YYYY-MM-DD. Current fleet is X GPUs. Add M
    GPUs in the next 30 days."`` shape.
    """
    if not scenarios:
        return "no forecast available"
    baseline_gpu = scenarios.get("baseline", {}).get("max_gpu_needed", 0)
    if baseline_gpu <= current_fleet_size:
        return (
            "baseline scenario: no GPU additions needed in the "
            "next 30 days"
        )
    needed = target_needed or baseline_gpu
    add = max(0, needed - current_fleet_size)
    date_str = target_date.isoformat() if target_date is not None else "soon"
    return (
        f"For the projected demand you need {needed} GPUs by {date_str}. "
        f"Current fleet is {current_fleet_size} GPUs. "
        f"Add {add} GPUs in the next 30 days."
    )


def _merge_daily_series(
    calls: list[dict[str, Any]], tokens: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Merge the calls-per-day and tokens-per-day series
    into a single ascending-by-day series of
    ``{day, calls, tokens, gpu_hours}`` rows.

    Days present in one series but not the other are
    zero-filled (a 0-call day is a real data point; the
    GPU-hour estimate is 0).
    """
    by_day: dict[Any, dict[str, Any]] = {}
    for r in calls:
        d = dict(r) if not isinstance(r, dict) else r
        day = d.get("day")
        by_day[day] = {
            "day": day,
            "calls": int(d.get("calls") or 0),
            "tokens": 0,
        }
    for r in tokens:
        d = dict(r) if not isinstance(r, dict) else r
        day = d.get("day")
        slot = by_day.setdefault(day, {"day": day, "calls": 0, "tokens": 0})
        slot["tokens"] = int(d.get("tokens") or 0)
    series = sorted(by_day.values(), key=lambda r: r["day"] or 0)
    for row in series:
        row["gpu_hours"] = (
            row["calls"] * PER_CALL_GPU_HOURS
            + row["tokens"] / TOKENS_PER_GPU_HOUR
        )
    return series


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


def _parse_day_window(value: str, default: int) -> int:
    """Parse a day-window string like ``"30d"`` or ``"90d"``."""
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


# Late import so the module loads even when math is
# shadowed by a test fixture.
import math  # noqa: E402

__all__ = [
    "CAPACITY_HISTORY_DAYS",
    "DEFAULT_FLEET_SIZE",
    "MAX_HORIZON_DAYS",
    "MIN_HORIZON_DAYS",
    "MODEL_NAME",
    "SCENARIO_MULTIPLIERS",
    "STORAGE_GB_PER_GPU_MONTH",
    "VALID_SCENARIOS",
    "CapacityPredictor",
    "_merge_daily_series",
]
