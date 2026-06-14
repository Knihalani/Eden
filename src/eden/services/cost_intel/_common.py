"""Shared helpers for Cat 8 (Cost Intelligence) services.

Centralises:

* The data read path — :func:`_fetch_total_cost`,
  :func:`_fetch_total_value`, :func:`_fetch_cost_by_group`,
  :func:`_fetch_outcome_count_by_type`, :func:`_fetch_daily_costs`,
  :func:`_fetch_top_attribution_for_days`.
* The envelope shape used for live (non-stub) responses —
  :func:`_ok_envelope`, :func:`_bad_request_envelope`. Both use
  ``live=True``.
* The persistence pattern used by the 2 services that write to
  the 2 Cat 8 tables (``cost_efficiency_scores``,
  ``roi_analyses``). The migration
  (``020_intelligence_gap_tables.py``) does not declare a unique
  constraint on either table, so the only way to make the
  services re-runnable is to delete-then-insert.
* :func:`_parse_window` for the time-bounded queries the four
  services run. Accepts ``"Nh"``/``"Nd"``/``"Nm"``/``"Ns"`` and
  returns a Postgres interval literal; bad input returns
  ``None`` and the service turns it into a bad-request
  envelope.
* :func:`_linear_regression` — pure-Python OLS for the
  ``CostForecast`` service. Doesn't gate on Python 3.10+'s
  ``statistics.linear_regression``; falls back to ``(0.0,
  mean(y))`` on degenerate inputs.
* :func:`_fire_cost_anomaly_alert` — defensive
  :func:`PromotionHook.on_drift_alert` firing for each
  high-severity cost anomaly. Matches the Cat 2 clusterer
  pattern at
  ``src/eden/insights/incidents/clusterer.py:444-475``.

The helpers are intentionally local to the package — Cat 8 is a
self-contained unit and the package boundary is the right place
to hide the per-service glue. Mirrors the layout of
:mod:`eden.decision._common` (Cat 16) and
:mod:`eden.insights.rca._common` (Cat 2).
"""

from __future__ import annotations

import logging
import re
import statistics
import uuid
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ── Public constants ─────────────────────────────────────────────────


#: Whitelist of allowed ``group_by`` values for
#: :class:`CostEfficiencyScorer`. Prevents SQL-injection via
#: ``metadata->>$group_by`` (the value is interpolated into the
#: SQL string with ``$1`` bound as the actual value, so a
#: hostile string like ``"1; DROP TABLE"`` would corrupt the
#: query if it slipped through).
ALLOWED_GROUP_BY: frozenset[str] = frozenset(
    {
        "outcome_type",
        "model",
        "agent_id",
        "resource",
        "event_type",
    }
)

#: Z-score thresholds for the cost-anomaly detector. A day whose
#: cost is more than ``Z_THRESHOLD`` standard deviations from
#: the window mean is flagged; ``HIGH_Z_THRESHOLD`` is the
#: threshold above which the closed-loop drift hook fires.
Z_THRESHOLD: float = 2.5
HIGH_Z_THRESHOLD: float = 4.0

#: Minimum days of history required for
#: :class:`CostForecast` to use the linear-regression model.
#: Below this it falls back to the window mean with an
#: ``insufficient_history`` warning.
MIN_FORECAST_HISTORY_DAYS: int = 14

#: How many days of history the forecast service reads.
FORECAST_HISTORY_DAYS: int = 90

#: Confidence band scaling factors — the forecast confidence
#: band is ``[predicted * CONF_BAND_LOWER, predicted *
#: CONF_BAND_UPPER]`` so the band is symmetric around 1.0 in
#: relative terms.
CONF_BAND_LOWER: float = 0.8
CONF_BAND_UPPER: float = 1.2


# ── Window parsing ───────────────────────────────────────────────────


_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None`` on
    bad input; the service wraps that into a
    ``_bad_request_envelope``.

    ``None`` or empty input defaults to ``"24 hours"`` (matches
    the Cat 2 ``_parse_window`` convention).
    """
    if window is None:
        return "24 hours"
    s = window.strip()
    if not s:
        return "24 hours"
    m = _WINDOW_RE.match(s)
    if m is None:
        return None
    n, unit = m.group(1), m.group(2).lower()
    unit_long = {"h": "hours", "d": "days", "m": "minutes", "s": "seconds"}[unit]
    return f"{n} {unit_long}"


# ── Envelope helpers ─────────────────────────────────────────────────


def _new_trace_id() -> str:
    """Cat 8-prefixed trace id — distinguishes live responses
    from Cat 1/2/16 in the audit log."""
    return f"ci_{uuid.uuid4().hex[:12]}"


def _ok_envelope(feature: str, data: dict[str, Any]) -> dict[str, Any]:
    """Live response envelope — same shape as the stub
    :class:`eden.intelligence_envelope.IntelligenceStubResponse`
    so the front-end renders uniformly. ``live=True`` signals
    a real implementation."""
    return {
        "status": "ok",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": data,
    }


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for an invalid request (e.g. malformed
    window string or unknown group_by key). Returns
    ``status="bad_request"`` so the front-end can render a
    4xx-class message without falling back to the stub
    envelope."""
    return {
        "status": "bad_request",
        "feature": feature,
        "live": True,
        "trace_id": _new_trace_id(),
        "timestamp": datetime.now(UTC).isoformat(),
        "data": {"message": message},
    }


# ── Data read paths ──────────────────────────────────────────────────


async def _get_client() -> Any:
    """Best-effort :func:`eden.storage.postgres.get_postgres_client`
    import + await. Returns ``None`` if Postgres isn't available
    — persistence helpers and fetchers check for ``None`` and
    no-op or return ``[]``/``None``."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("cost_intel: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("cost_intel: get_postgres_client failed: %s", exc)
        return None


async def _fetch_total_cost(org_id: str, interval_sql: str) -> float:
    """Sum of ``cost_usd`` on ``usage_events`` for the org in the
    given window. Returns 0.0 on failure (so the ROI
    computation falls into the ``spend=0`` branch)."""
    client = await _get_client()
    if client is None:
        return 0.0
    try:
        row = await client.fetchrow(
            """
            SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend
              FROM usage_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND cost_usd IS NOT NULL
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("cost_intel: fetch_total_cost failed: %s", exc)
        return 0.0
    if row is None:
        return 0.0
    spend = row.get("spend") if isinstance(row, dict) else row["spend"]
    return float(spend or 0.0)


async def _fetch_total_value(org_id: str, interval_sql: str) -> float:
    """Sum of ``value`` on ``outcomes`` for the org in the given
    window. Returns 0.0 on failure. Note that ``outcomes`` may
    be empty (Cat 11 hasn't shipped); the ROI service handles
    ``value=0`` cleanly (``roi: None`` if ``spend > 0``)."""
    client = await _get_client()
    if client is None:
        return 0.0
    try:
        row = await client.fetchrow(
            """
            SELECT COALESCE(SUM(value), 0)::float8 AS value
              FROM outcomes
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("cost_intel: fetch_total_value failed: %s", exc)
        return 0.0
    if row is None:
        return 0.0
    val = row.get("value") if isinstance(row, dict) else row["value"]
    return float(val or 0.0)


async def _fetch_cost_by_group(
    org_id: str, interval_sql: str, group_by: str
) -> list[dict[str, Any]]:
    """Cost-by-group from ``usage_events`` for the given window.
    The ``group_by`` value is whitelisted before this is called,
    so it's safe to interpolate as a JSONB key name. ``NULL``
    values in the JSONB extract are bucketed as the literal
    string ``"__missing__"`` so the response is always
    well-formed."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT COALESCE(metadata->>$3, '__missing__') AS group_value,
                   SUM(cost_usd)::float8              AS total_cost
              FROM usage_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND cost_usd IS NOT NULL
             GROUP BY 1
             ORDER BY 1
            """,
            org_id,
            interval_sql,
            group_by,
        )
    except Exception as exc:
        logger.debug("cost_intel: fetch_cost_by_group failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(
            {
                "group_value": d.get("group_value"),
                "total_cost": float(d.get("total_cost") or 0.0),
            }
        )
    return out


async def _fetch_outcome_count_by_type(
    org_id: str, interval_sql: str
) -> dict[str, int]:
    """Outcome counts grouped by ``type`` from the ``outcomes``
    table. Returns ``{}`` on failure / empty. The mapping is
    ``{outcome_type: count}`` — used by the efficiency scorer
    when ``group_by="outcome_type"`` to compute
    ``cost_per_outcome``."""
    client = await _get_client()
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            SELECT type AS outcome_type, COUNT(*)::int AS outcome_count
              FROM outcomes
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
             GROUP BY 1
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug(
            "cost_intel: fetch_outcome_count_by_type failed: %s", exc
        )
        return {}
    return {
        (r["outcome_type"] if not isinstance(r, dict) else r.get("outcome_type")): int(
            r["outcome_count"] if not isinstance(r, dict) else r.get("outcome_count") or 0
        )
        for r in rows
    }


async def _fetch_daily_costs(
    org_id: str, interval_sql: str
) -> list[dict[str, Any]]:
    """Daily cost series from ``usage_events``. Each row is
    ``{day: datetime, cost: float}``. Used by the anomaly
    detector and the forecast service. Returns ``[]`` on
    failure / empty."""
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT date_trunc('day', created_at) AS day,
                   SUM(cost_usd)::float8        AS cost
              FROM usage_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND cost_usd IS NOT NULL
             GROUP BY 1
             ORDER BY 1
            """,
            org_id,
            interval_sql,
        )
    except Exception as exc:
        logger.debug("cost_intel: fetch_daily_costs failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append({"day": d.get("day"), "cost": float(d.get("cost") or 0.0)})
    return out


async def _fetch_top_attribution_for_days(
    org_id: str, days: list[Any]
) -> dict[Any, dict[str, Any]]:
    """For each anomalous day, return the ``(model, agent_id)``
    pair with the highest ``SUM(cost_usd)`` for that day. One
    batched call (not one per day) — uses ``unnest`` to expand
    the day list.

    Returns ``{day: {model, agent_id, cost}}``. Days with no
    events are absent from the result. Best-effort: returns
    ``{}`` on any failure.
    """
    if not days:
        return {}
    client = await _get_client()
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            WITH anomaly_days AS (
              SELECT unnest($2::timestamptz[]) AS day
            )
            SELECT date_trunc('day', e.created_at) AS day,
                   e.model,
                   e.agent_id,
                   SUM(e.cost_usd)::float8        AS cost
              FROM usage_events e
              JOIN anomaly_days a
                ON date_trunc('day', e.created_at) = a.day
             WHERE e.org_id = $1
             GROUP BY 1, 2, 3
             ORDER BY 1, cost DESC
            """,
            org_id,
            list(days),
        )
    except Exception as exc:
        logger.debug(
            "cost_intel: fetch_top_attribution_for_days failed: %s", exc
        )
        return {}
    # For each day, take the first row (highest cost).
    by_day: dict[Any, dict[str, Any]] = {}
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        day = d.get("day")
        if day in by_day:
            continue
        by_day[day] = {
            "model": d.get("model"),
            "agent_id": d.get("agent_id"),
            "cost": float(d.get("cost") or 0.0),
        }
    return by_day


# ── Linear regression (used by CostForecast) ─────────────────────────


def _linear_regression(
    x: list[float], y: list[float]
) -> tuple[float, float]:
    """Ordinary-least-squares slope and intercept.

    Pure Python so we don't gate the package on Python 3.10+'s
    ``statistics.linear_regression`` (which was added in 3.10).
    Returns ``(0.0, mean(y))`` for ``len(x) < 2`` or when the
    x-variance is zero (degenerate) — callers must pre-check
    length for the forecast to do anything useful, but the
    defensive fallback prevents a divide-by-zero.

    The :mod:`statistics` module is imported lazily so the
    helper is testable in isolation without pulling in any
    dependencies.
    """
    n = len(x)
    if n != len(y):
        # Length mismatch is a programmer error, not a data
        # condition; raise so it doesn't silently mis-behave.
        raise ValueError(
            f"_linear_regression: x and y lengths differ ({n} vs {len(y)})"
        )
    if n < 2:
        mean_y = (sum(y) / n) if n else 0.0
        return (0.0, mean_y)
    try:
        # statistics.mean is safe for n >= 1
        mean_y = statistics.fmean(y) if hasattr(statistics, "fmean") else (sum(y) / n)
        mean_x = statistics.fmean(x) if hasattr(statistics, "fmean") else (sum(x) / n)
    except Exception:
        mean_y = sum(y) / n
        mean_x = sum(x) / n
    num = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(x, y, strict=False))
    den = sum((xi - mean_x) ** 2 for xi in x)
    if den == 0:
        # All x are identical (degenerate); fall back to mean.
        return (0.0, mean_y)
    slope = num / den
    intercept = mean_y - slope * mean_x
    return (slope, intercept)


# ── Persistence ──────────────────────────────────────────────────────


async def _delete_then_insert_efficiency(
    org_id: str,
    group_by_key: str,
    rows: list[dict[str, Any]],
) -> None:
    """Replace the ``cost_efficiency_scores`` rows for this
    ``(org_id, group_by_key)`` tuple. ``rows`` is a list of
    ``{group_by_value, cost_per_outcome, sample_size}`` dicts;
    each becomes one row. The service is re-runnable because
    we clear the prior tuple first.

    The migration has no unique constraint, so the
    clear-then-insert pattern is the only way to make the
    service re-runnable. Best-effort: any exception is logged
    and swallowed so the caller can still return the live
    envelope with the in-memory data.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("cost_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM cost_efficiency_scores
                     WHERE org_id = $1 AND group_by_key = $2
                    """,
                org_id,
                group_by_key,
            )
            for r in rows:
                gv = str(r.get("group_by_value", ""))[:128]
                cpo = r.get("cost_per_outcome")
                sample_size = int(r.get("sample_size", 0))
                # ``cost_per_outcome`` may be None when the
                # group has no matching outcomes — the
                # column is nullable.
                await conn.execute(
                    """
                        INSERT INTO cost_efficiency_scores
                            (id, org_id, group_by_key, group_by_value,
                             cost_per_outcome, sample_size)
                        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                        """,
                    org_id, group_by_key, gv, cpo, sample_size,
                )
    except Exception as exc:
        logger.debug(
            "cost_intel: efficiency write failed: %s", exc
        )


async def _delete_then_insert_roi(
    org_id: str,
    window: str,
    spend_usd: float,
    value_usd: float,
    roi: float | None,
) -> None:
    """Write a single ``roi_analyses`` row for the
    ``(org_id, window)`` tuple. Re-runnable via
    DELETE+INSERT (the table has no unique constraint).

    Best-effort like :func:`_delete_then_insert_efficiency`.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("cost_intel: postgres import failed: %s", exc)
        return

    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM roi_analyses WHERE org_id = $1 AND window = $2",
                org_id,
                window,
            )
            await conn.execute(
                """
                    INSERT INTO roi_analyses
                        (id, org_id, window, spend_usd, value_usd, roi)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                    """,
                org_id, window, spend_usd, value_usd, roi,
            )
    except Exception as exc:
        logger.debug(
            "cost_intel: roi write failed: %s", exc
        )


# ── Closed-loop hook firing ──────────────────────────────────────────


def _fire_cost_anomaly_alert(
    org_id: str, anomalies: list[dict[str, Any]]
) -> None:
    """Fire :func:`PromotionHook.on_drift_alert` for each
    high-severity cost anomaly.

    Mirrors the pattern at
    ``src/eden/insights/incidents/clusterer.py:444-475``
    (``IncidentClusterer._fire_drift_alerts``). The hook is a
    no-op logger in stub mode; a real implementation would let
    the canary auto-rollback on a high-severity drift alert.

    Severity threshold: only ``"high"`` anomalies (|z| > 4)
    trigger the hook. ``"medium"`` anomalies are surfaced in
    the response data but don't fire — matches the clusterer
    behaviour, where only ``critical/high`` + size threshold
    fire.

    Drift type is ``"cost_anomaly"`` so the front-end / audit
    log can grep for it.

    Wrapped in try/except — the hook is best-effort and must
    never break the response.
    """
    high = [a for a in anomalies if a.get("severity") == "high"]
    if not high:
        return
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("cost_intel: hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug("cost_intel: get_promotion_hook failed: %s", exc)
        return
    for a in high:
        try:
            hook.on_drift_alert(
                org_id,
                drift_type="cost_anomaly",
                severity=a["severity"],
            )
        except Exception as exc:
            logger.debug(
                "cost_intel: on_drift_alert failed: %s", exc
            )


# ── Misc small helpers ───────────────────────────────────────────────


def _format_likely_cause(top: dict[str, Any] | None) -> str | None:
    """Format the top-attr (model, agent_id) tuple as a
    one-line human-readable string for the anomaly's
    ``likely_cause`` field. Returns ``None`` when no
    attribution is available so the JSON response cleanly
    omits the field."""
    if not top:
        return None
    model = top.get("model")
    agent = top.get("agent_id")
    parts: list[str] = []
    if model:
        parts.append(f"model={model}")
    if agent:
        parts.append(f"agent={agent}")
    if not parts:
        return None
    return ", ".join(parts)


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic in :class:`ROIAnalyzer` /
    :class:`CostAnomalyDetector`."""
    if isinstance(value, bool):
        # ``True``/``False`` would coerce to 1/0 — guard against it.
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    return 0.0
