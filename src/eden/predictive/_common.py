"""Shared helpers for Cat 13 (Predictive Intelligence) services.

Centralises:

* The data read path — :func:`_fetch_recent_judge_scores`,
  :func:`_fetch_recent_costs`, :func:`_fetch_daily_call_counts`,
  :func:`_fetch_daily_latencies`. Each degrades gracefully
  to ``[]`` / ``None`` on failure or empty.
* The envelope shape used for live responses —
  :func:`_ok_envelope`, :func:`_bad_request_envelope`. Same
  shape as the stub :mod:`eden.intelligence_envelope` so the
  front-end renders uniformly; ``live=True`` signals a real
  implementation.
* The math helpers — :func:`_linear_regression` (OLS slope +
  intercept), :func:`_safe_float`, :func:`_zscore`,
  :func:`_psi` (Population Stability Index for drift
  detection).
* The persistence helpers — one per Cat 13 table. The
  migration (``020_intelligence_gap_tables.py``) declares no
  unique constraint on the new tables, so the
  delete-then-insert pattern is the only way to make the
  services re-runnable.
* :func:`_fire_drift_alert` — defensive
  :func:`PromotionHook.on_drift_alert` firing for each
  high-severity drift alert. Mirrors the Cat 8 +
  Cat 2 pattern at
  ``src/eden/services/cost_intel/_common.py:566-613`` and
  ``src/eden/insights/incidents/clusterer.py``.

The helpers are intentionally local to the package — Cat 13
is a self-contained unit and the package boundary is the
right place to hide the per-service glue. Mirrors the layout
of :mod:`eden.services.cost_intel._common` (Cat 8) and
:mod:`eden.decision._common` (Cat 16).

See ``docs/observability-gap/13-predictive-intelligence.md``.
"""

from __future__ import annotations

import logging
import math
import re
import statistics
import uuid
from datetime import UTC, datetime
from typing import Any

from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

# Audit 2026-07-02 P-17 — 1 h Redis cache TTL on the
# _fetch_recent_judge_scores data path. Per-test contract.
_JUDGE_SCORES_CACHE_TTL_S: int = 3600


# ── Public constants ─────────────────────────────────────────────────


#: Window-parsing pattern. Accepts ``"Nh"`` (hours), ``"Nd"``
#: (days), ``"Nm"`` (minutes), ``"Ns"`` (seconds). Mirrors the
#: Cat 8 convention.
_WINDOW_RE = re.compile(r"^\s*(\d+)\s*(h|d|m|s)\s*$", re.IGNORECASE)

#: How many days of judge-score history the QualityPredictor
#: reads. The doc spec is "7 days"; we read a slightly larger
#: window so the confidence calculation has more samples.
QUALITY_HISTORY_DAYS: int = 7

#: How many days of usage-events history the CostPredictor
#: reads. 24h of history is enough for a per-request
#: prediction; 30d is enough for a horizon projection.
COST_HISTORY_DAYS: int = 30

#: How many days of call / token history the CapacityPredictor
#: reads. The doc spec is "30 days".
CAPACITY_HISTORY_DAYS: int = 30

#: Default risk-scoring window (in hours). The Cat 13
#: spec calls out 24h; the route accepts a ``window`` param
#: but defaults to this value.
RISK_HISTORY_HOURS_DEFAULT: int = 24

#: Minimum days of history required for the CapacityPredictor
#: to use the linear-regression model. Below this it falls
#: back to the window mean with an ``insufficient_history``
#: warning. Matches Cat 8's :data:`MIN_FORECAST_HISTORY_DAYS`.
MIN_FORECAST_HISTORY_DAYS: int = 14

#: How many buckets the PSI computation uses for the output-
#: drift detector. 10 buckets matches the industry default
#: (PSI is conventionally computed on deciles of the
#: baseline).
PSI_BUCKETS: int = 10

#: PSI threshold above which we surface an alert. The
#: industry rule of thumb: < 0.1 = no shift, 0.1..0.2 =
#: small shift, > 0.2 = significant shift.
PSI_THRESHOLD: float = 0.2

#: Confidence band scaling for the CapacityPredictor —
#: symmetric ±20% around the predicted value, like Cat 8.
CONF_BAND_LOWER: float = 0.8
CONF_BAND_UPPER: float = 1.2

#: Default number of embedding-drift buckets. We hash the
#: response text into 64 buckets (mod 64 of a stable hash);
#: 64 buckets is granular enough to detect topic shifts
#: without being noisy on small samples.
EMBEDDING_BUCKETS: int = 64

#: Documented assumptions stamped on predictive envelopes when
#: aggregates are computed from Postgres rather than ClickHouse.
#: ClickHouse is the optional analytics substrate; Postgres is
#: always the durable source of truth for judge_scores /
#: usage_events / telemetry_events.
POSTGRES_FALLBACK_ASSUMPTIONS: tuple[str, ...] = (
    "ClickHouse analytics substrate unavailable or unused; "
    "aggregates computed from Postgres telemetry_events, "
    "usage_events, and judge_scores.",
    "Cost/capacity/risk heuristics use trailing-window "
    "median / OLS / PSI on org telemetry — not a trained "
    "forecasting model.",
    "Embedding drift uses a stable hash-bucket proxy over "
    "response_body text (64 buckets), not a learned embedding "
    "model.",
)


# ── Window parsing ───────────────────────────────────────────────────


def _parse_window(window: str | None) -> str | None:
    """Convert a human-friendly window string to a Postgres
    interval literal. Accepts ``"Nh"`` (hours), ``"Nd"`` (days),
    ``"Nm"`` (minutes), ``"Ns"`` (seconds). Returns ``None``
    on bad input; the service wraps that into a
    :func:`_bad_request_envelope`.

    ``None`` or empty input defaults to ``"24 hours"`` (matches
    the Cat 2 + Cat 8 convention).
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
    """Cat 13-prefixed trace id — distinguishes live responses
    from Cat 1/2/8/16 in the audit log."""
    return f"prd_{uuid.uuid4().hex[:12]}"


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


def _with_pg_assumptions(data: dict[str, Any]) -> dict[str, Any]:
    """Stamp Postgres-fallback assumptions onto a live payload.

    Predictive services always read Postgres today (ClickHouse
    is optional). Callers include the assumptions so portal /
    API consumers can surface the data-source caveat without
    treating the response as a stub.
    """
    out = dict(data)
    existing = out.get("assumptions")
    if isinstance(existing, list):
        merged = list(existing)
        for item in POSTGRES_FALLBACK_ASSUMPTIONS:
            if item not in merged:
                merged.append(item)
        out["assumptions"] = merged
    else:
        out["assumptions"] = list(POSTGRES_FALLBACK_ASSUMPTIONS)
    out.setdefault("data_source", "postgres")
    return out


def _bad_request_envelope(feature: str, message: str) -> dict[str, Any]:
    """Live envelope for an invalid request. Returns
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
    — fetchers check for ``None`` and no-op or return ``[]`` /
    ``None``. Mirrors the Cat 8 helper."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("predictive: postgres import failed: %s", exc)
        return None
    try:
        return await get_postgres_client()
    except Exception as exc:
        logger.debug("predictive: get_postgres_client failed: %s", exc)
        return None


async def _fetch_recent_judge_scores(
    org_id: str, interval_sql: str, judge_name: str | None = None
) -> list[dict[str, Any]]:
    """Recent judge scores for the org. One row per score event,
    ``{judge_name, score, agent_id, created_at}``. Filtered to
    ``judge_scores.score IS NOT NULL`` so partial inserts
    don't poison the average.

    When ``judge_name`` is provided, the query is restricted
    to that judge. Used by the QualityPredictor when the
    caller wants a per-judge projection.

    Audit 2026-07-02 P-17 — wrap with a 1 h Redis cache keyed
    by ``(org_id, judge_name)`` so the dashboard doesn't
    re-query the same window 10×/min per tenant.
    """
    cache_key = (
        f"judge_scores_recent:{org_id}:{judge_name or '_all_'}"
    )
    try:
        from eden.storage.redis import get_redis_client
        redis = await get_redis_client()
    except Exception:
        redis = None
    if redis is not None:
        try:
            cached = await redis.get(cache_key)
            if cached:
                import json
                return json.loads(cached)
        except Exception:
            pass
    client = await _get_client()
    if client is None:
        return []
    try:
        if judge_name:
            rows = await client.fetch(
                """
                SELECT judge_name, score, agent_id, created_at
                  FROM judge_scores
                 WHERE org_id = $1
                   AND created_at > NOW() - $2::interval
                   AND score IS NOT NULL
                   AND judge_name = $3
                 ORDER BY created_at DESC
                """,
                org_id, interval_sql, judge_name,
            )
        else:
            rows = await client.fetch(
                """
                SELECT judge_name, score, agent_id, created_at
                  FROM judge_scores
                 WHERE org_id = $1
                   AND created_at > NOW() - $2::interval
                   AND score IS NOT NULL
                 ORDER BY created_at DESC
                """,
                org_id, interval_sql,
            )
    except Exception as exc:
        logger.debug("predictive: fetch_recent_judge_scores failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(
            {
                "judge_name": d.get("judge_name"),
                "score": _safe_float(d.get("score")),
                "agent_id": d.get("agent_id"),
                "created_at": d.get("created_at"),
            }
        )
    if redis is not None and out:
        try:
            import json
            await redis.setex(
                cache_key, _JUDGE_SCORES_CACHE_TTL_S,
                json.dumps(out, default=str),
            )
        except Exception:
            pass
    return out


async def _fetch_recent_costs(
    org_id: str, interval_sql: str
) -> list[float]:
    """Per-request cost in the window. Each value is the
    ``cost_usd`` of a single ``usage_events`` row, used by
    the CostPredictor to estimate the next request's cost.

    Returns ``[]`` on failure / empty.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT cost_usd
              FROM usage_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND cost_usd IS NOT NULL
             ORDER BY created_at DESC
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("predictive: fetch_recent_costs failed: %s", exc)
        return []
    return [_safe_float(r.get("cost_usd") if isinstance(r, dict) else r["cost_usd"]) for r in rows]


async def _fetch_daily_costs_by_agent(
    org_id: str, interval_sql: str
) -> list[dict[str, Any]]:
    """Daily per-agent cost totals from ``usage_events``.

    Returns one row per ``(day, agent_id)`` tuple with
    ``{day, agent_id, cost_usd, requests}``. Used by the
    CostPredictor to compute the per-agent breakdown and
    the WoW growth-rate alert.

    Returns ``[]`` on failure / empty. Rows with a NULL
    ``agent_id`` are bucketed under ``__org__`` so the
    per-agent shape stays consistent (the spec calls out
    a ``by_agent`` map keyed by agent name).
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT date_trunc('day', created_at) AS day,
                   COALESCE(agent_id, '__org__') AS agent_id,
                   COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
                   COUNT(*)::int AS requests
              FROM usage_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND cost_usd IS NOT NULL
             GROUP BY 1, 2
             ORDER BY 1, 2
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("predictive: fetch_daily_costs_by_agent failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append(
            {
                "day": d.get("day"),
                "agent_id": d.get("agent_id"),
                "cost_usd": _safe_float(d.get("cost_usd")),
                "requests": int(d.get("requests") or 0),
            }
        )
    return out


async def _fetch_daily_call_counts(
    org_id: str, interval_sql: str
) -> list[dict[str, Any]]:
    """Daily call count from ``telemetry_events``. One row per
    day, ``{day: date, calls: int}``. Used by the
    CapacityPredictor to forecast call volume.

    The query restricts to ``event_type = 'agent.step'`` (the
    canonical LLM call event) so non-call events (memory
    writes, retrieval fetches) don't inflate the count.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT date_trunc('day', created_at) AS day,
                   COUNT(*)::int                  AS calls
              FROM telemetry_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND event_type = 'agent.step'
             GROUP BY 1
             ORDER BY 1
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("predictive: fetch_daily_call_counts failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append({"day": d.get("day"), "calls": int(d.get("calls") or 0)})
    return out


async def _fetch_daily_token_totals(
    org_id: str, interval_sql: str
) -> list[dict[str, Any]]:
    """Daily total token count from ``usage_events``. One row
    per day, ``{day: date, tokens: int}`` (input + output
    summed). Used by the CapacityPredictor to project
    GPU-hours.

    Falls back to ``tokens = 0`` if the column is missing
    (some rows pre-date the token tracking).
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT date_trunc('day', created_at) AS day,
                   COALESCE(SUM(
                       COALESCE(input_tokens, 0) +
                       COALESCE(output_tokens, 0)
                   ), 0)::bigint AS tokens
              FROM usage_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
             GROUP BY 1
             ORDER BY 1
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("predictive: fetch_daily_token_totals failed: %s", redact_all(str(exc)))
        return []
    out: list[dict[str, Any]] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        out.append({"day": d.get("day"), "tokens": int(d.get("tokens") or 0)})
    return out


async def _fetch_daily_latencies(
    org_id: str, interval_sql: str
) -> list[float]:
    """Per-request latency in ms, from ``telemetry_events``
    (the ``latency_ms`` attribute on ``agent.step`` events).
    Used by the RiskScorer.

    Returns ``[]`` on failure / empty.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT (attributes->>'latency_ms')::float8 AS latency_ms
              FROM telemetry_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND event_type = 'agent.step'
               AND attributes ? 'latency_ms'
            """,
            org_id, interval_sql,
        )
    except Exception as exc:
        logger.debug("predictive: fetch_daily_latencies failed: %s", exc)
        return []
    out: list[float] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        v = d.get("latency_ms")
        if v is None:
            continue
        out.append(_safe_float(v))
    return out


async def _fetch_response_text_samples(
    org_id: str, interval_sql: str, limit: int = 200
) -> list[str]:
    """Recent response texts (up to ``limit``) from
    ``telemetry_events`` (the ``response_body`` column). Used
    by the embedding-drift detector to build a hash-bucket
    histogram. We bound the read at ``limit`` rows so a busy
    org doesn't pull millions of rows for one drift check.
    """
    client = await _get_client()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT response_body
              FROM telemetry_events
             WHERE org_id = $1
               AND created_at > NOW() - $2::interval
               AND event_type = 'agent.step'
               AND response_body IS NOT NULL
             ORDER BY created_at DESC
             LIMIT $3
            """,
            org_id, interval_sql, int(limit),
        )
    except Exception as exc:
        logger.debug("predictive: fetch_response_text_samples failed: %s", exc)
        return []
    out: list[str] = []
    for r in rows:
        d = dict(r) if not isinstance(r, dict) else r
        body = d.get("response_body")
        if isinstance(body, str) and body:
            out.append(body)
    return out


# ── Math helpers ──────────────────────────────────────────────────────


def _safe_float(value: Any) -> float:
    """Coerce ``value`` to ``float``; return ``0.0`` for
    anything that isn't a number. Defensive belt-and-braces
    for the arithmetic across the 6 services."""
    if isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    if value is None:
        return 0.0
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _json_safe(obj: Any) -> Any:
    """Recursively coerce ``obj`` to a JSON-serialisable form.

    * ``datetime`` / ``date`` → ISO format string
    * ``set`` / ``tuple`` → ``list``
    * ``dict`` → recursive
    * ``list`` → recursive
    * everything else is returned unchanged

    Used by the persistence helpers that ``json.dumps`` the
    payload before writing to Postgres. Postgres JSONB columns
    accept ISO strings; the front-end parses them back to
    ``Date`` in JS.
    """
    # Imported lazily — :mod:`datetime` is part of stdlib but
    # importing it at module top would be wasted bytes for
    # services that never serialise a payload.
    from datetime import date as _date
    from datetime import datetime as _datetime

    if isinstance(obj, (_datetime, _date)):
        return obj.isoformat()
    if isinstance(obj, dict):
        return {str(k): _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set)):
        return [_json_safe(v) for v in obj]
    return obj


def _linear_regression(
    x: list[float], y: list[float]
) -> tuple[float, float]:
    """Ordinary-least-squares slope and intercept.

    Pure Python so we don't gate the package on Python 3.10+'s
    ``statistics.linear_regression``. Returns ``(0.0, mean(y))``
    for ``len(x) < 2`` or when the x-variance is zero
    (degenerate). Mirrors the Cat 8 helper at
    ``src/eden/services/cost_intel/_common.py:414-454``.
    """
    n = len(x)
    if n != len(y):
        raise ValueError(
            f"_linear_regression: x and y lengths differ ({n} vs {len(y)})"
        )
    if n < 1:
        return (0.0, 0.0)
    if n < 2:
        return (0.0, _safe_float(y[0]))
    try:
        mean_y = statistics.fmean(y) if hasattr(statistics, "fmean") else (sum(y) / n)
        mean_x = statistics.fmean(x) if hasattr(statistics, "fmean") else (sum(x) / n)
    except Exception:
        mean_y = sum(y) / n
        mean_x = sum(x) / n
    num = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(x, y, strict=False))
    den = sum((xi - mean_x) ** 2 for xi in x)
    if den == 0:
        return (0.0, mean_y)
    slope = num / den
    intercept = mean_y - slope * mean_x
    return (slope, intercept)


def _zscore(value: float, mean: float, stdev: float) -> float:
    """Z-score of ``value`` against a distribution with the
    given mean and stdev. Returns ``0.0`` if ``stdev`` is
    zero (degenerate)."""
    if stdev == 0:
        return 0.0
    return (value - mean) / stdev


def _histogram_buckets(
    values: list[float], bucket_edges: list[float]
) -> list[int]:
    """Bucket ``values`` into the bins defined by ``bucket_edges``
    (a sorted list of N+1 floats for N buckets). Each value
    falls into the first bin where ``edges[i] <= v < edges[i+1]``;
    values below the first edge or above the last are clamped
    to the boundary bins. Returns a list of N counts.

    Used by the PSI computation; the baseline histogram uses
    the *same* edges when bucketing the current window.
    """
    if not bucket_edges or len(bucket_edges) < 2:
        return []
    n_buckets = len(bucket_edges) - 1
    counts = [0] * n_buckets
    for v in values:
        placed = False
        for i in range(n_buckets):
            if bucket_edges[i] <= v < bucket_edges[i + 1]:
                counts[i] += 1
                placed = True
                break
        if not placed:
            # Clamp to the last bucket.
            counts[-1] += 1
    return counts


def _psi(
    baseline: list[float], current: list[float], n_buckets: int = PSI_BUCKETS
) -> tuple[float, list[float], list[float]]:
    """Population Stability Index between two samples.

    Returns ``(psi_value, baseline_pct, current_pct)``. The
    industry rule of thumb: < 0.1 = no shift, 0.1..0.2 =
    small shift, > 0.2 = significant shift. Returns ``0.0``
    for empty samples (no shift detectable).

    The bucket edges are derived from the *baseline* deciles
    (the standard convention). Both samples are bucketed with
    the same edges so the per-bucket percentage difference is
    apples-to-apples.

    A small ``epsilon`` is added to each percentage so a
    zero-count bucket doesn't produce a ``log(0)`` or
    division-by-zero.
    """
    if not baseline or not current:
        return (0.0, [], [])
    if n_buckets < 2:
        n_buckets = 2
    sorted_base = sorted(baseline)
    # Use the n_buckets-quantiles of the baseline as edges.
    edges: list[float] = []
    n_base = len(sorted_base)
    for i in range(n_buckets + 1):
        # ``i * n_base / n_buckets`` is the i-th quantile index.
        idx = min(max(0, int(i * n_base / n_buckets)), n_base - 1)
        edges.append(sorted_base[idx])
    # Ensure strictly increasing edges (degenerate samples
    # can produce ties).
    for i in range(1, len(edges)):
        if edges[i] <= edges[i - 1]:
            edges[i] = edges[i - 1] + 1e-9
    base_counts = _histogram_buckets(baseline, edges)
    curr_counts = _histogram_buckets(current, edges)
    base_total = max(1, sum(base_counts))
    curr_total = max(1, sum(curr_counts))
    epsilon = 1e-6
    base_pct = [c / base_total for c in base_counts]
    curr_pct = [c / curr_total for c in curr_counts]
    psi_val = 0.0
    for b, c in zip(base_pct, curr_pct, strict=False):
        b_adj = max(b, epsilon)
        c_adj = max(c, epsilon)
        psi_val += (c_adj - b_adj) * math.log(c_adj / b_adj)
    return (psi_val, base_pct, curr_pct)


def _hash_bucket(text: str, n_buckets: int = EMBEDDING_BUCKETS) -> int:
    """Stable hash of ``text`` into ``[0, n_buckets)``.

    Uses Python's built-in ``hash`` is process-local, so we
    use :func:`hashlib.blake2b` with a fixed digest_size
    instead. The result is a deterministic 8-byte digest; we
    take the first 8 bytes as a big-endian int and reduce
    modulo ``n_buckets``.

    The function is content-only — same text in / same
    bucket out, across processes and restarts. Stable enough
    for drift detection (a true production system would use
    a learned embedding model; for the v1 ship a hash bucket
    is a cheap, content-only topic-drift proxy).
    """
    if not text:
        return 0
    try:
        import hashlib

        digest = hashlib.blake2b(text.encode("utf-8"), digest_size=8).digest()
        return int.from_bytes(digest, "big") % n_buckets
    except Exception:
        return 0


# ── Persistence ──────────────────────────────────────────────────────


async def _upsert_quality_prediction(
    org_id: str,
    request_id: str,
    predicted_score: float | None,
    confidence: float | None,
    model_version: str,
) -> None:
    """Insert (or replace) a ``quality_predictions`` row for
    the ``(org_id, request_id)`` tuple. Best-effort: any
    exception is logged and swallowed so the live envelope
    is still returned.

    The table has no unique constraint per migration 020, so
    we delete then insert to make the service re-runnable.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("predictive: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                """
                    DELETE FROM quality_predictions
                     WHERE org_id = $1 AND request_id = $2
                    """,
                org_id, request_id,
            )
            await conn.execute(
                """
                    INSERT INTO quality_predictions
                        (id, org_id, request_id, predicted_score,
                         confidence, model_version)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                    """,
                org_id, request_id, predicted_score, confidence, model_version,
            )
    except Exception as exc:
        logger.debug("predictive: quality write failed: %s", exc)


async def _upsert_cost_prediction(
    org_id: str,
    request_id: str,
    predicted_cost_usd: float | None,
    model_version: str,
) -> None:
    """Insert (or replace) a ``cost_predictions`` row. Best-
    effort like :func:`_upsert_quality_prediction`."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("predictive: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM cost_predictions WHERE org_id = $1 AND request_id = $2",
                org_id, request_id,
            )
            await conn.execute(
                """
                    INSERT INTO cost_predictions
                        (id, org_id, request_id, predicted_cost_usd, model_version)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4)
                    """,
                org_id, request_id, predicted_cost_usd, model_version,
            )
    except Exception as exc:
        logger.debug("predictive: cost write failed: %s", exc)


async def _upsert_capacity_forecast(
    org_id: str,
    window_start: Any,
    window_end: Any,
    forecast_json: str,
    model_version: str,
) -> None:
    """Insert (or replace) a ``capacity_forecasts`` row. The
    table has no unique constraint per migration 020, so we
    delete all prior rows for the org (one forecast per run,
    not per day) then insert.

    The Cat 13 spec calls for the "next 30 days" capacity
    forecast — the row's ``window_start`` / ``window_end``
    are the bounding timestamps of the projected window.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("predictive: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            # Scope the delete to the specific (org, window) being
            # replaced — the pre-fix query wiped ALL capacity_forecasts
            # for the org before inserting the new row, losing every
            # other window's forecast in the process. capacity_forecasts
            # has no unique constraint on (org_id, window_start), so
            # multiple rows can co-exist per window.
            await conn.execute(
                "DELETE FROM capacity_forecasts "
                "WHERE org_id = $1 AND window_start = $2 AND window_end = $3",
                org_id, window_start, window_end,
            )
            await conn.execute(
                """
                    INSERT INTO capacity_forecasts
                        (id, org_id, window_start, window_end,
                         forecast_json, model_version)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
                    """,
                org_id, window_start, window_end, forecast_json, model_version,
            )
    except Exception as exc:
        logger.debug("predictive: capacity write failed: %s", exc)


async def _upsert_risk_score(
    org_id: str,
    request_id: str,
    composite_risk: float | None,
    components_json: str,
) -> None:
    """Insert (or replace) a ``risk_scores`` row. Best-effort
    like the other upsert helpers."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("predictive: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn, conn.transaction():
            await conn.execute(
                "DELETE FROM risk_scores WHERE org_id = $1 AND request_id = $2",
                org_id, request_id,
            )
            await conn.execute(
                """
                    INSERT INTO risk_scores
                        (id, org_id, request_id, composite_risk, components_json)
                    VALUES (gen_random_uuid(), $1, $2, $3, $4)
                    """,
                org_id, request_id, composite_risk, components_json,
            )
    except Exception as exc:
        logger.debug("predictive: risk write failed: %s", exc)


async def _insert_drift_alert(
    org_id: str,
    drift_type: str,
    severity: str,
    baseline_value: float | None,
    current_value: float | None,
    details_json: str,
) -> None:
    """Insert a ``drift_alerts`` row. Unlike the other tables
    we *append* — drift alerts are an event log, not a
    replaceable summary. Best-effort."""
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("predictive: postgres import failed: %s", exc)
        return
    client = await get_postgres_client()
    if client is None:
        return
    try:
        async with client.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO drift_alerts
                    (id, org_id, drift_type, severity,
                     baseline_value, current_value, details_json)
                VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
                """,
                org_id, drift_type, severity, baseline_value,
                current_value, details_json,
            )
    except Exception as exc:
        logger.debug("predictive: drift write failed: %s", exc)


# ── Closed-loop hook firing ──────────────────────────────────────────


def _fire_drift_alert(
    org_id: str,
    drift_type: str,
    severity: str,
    details: dict[str, Any] | None = None,
) -> None:
    """Fire :func:`PromotionHook.on_drift_alert` for a high-
    severity drift alert.

    Mirrors the Cat 2 clusterer pattern at
    ``src/eden/insights/incidents/clusterer.py:444-475`` and
    the Cat 8 cost-anomaly pattern at
    ``src/eden/services/cost_intel/_common.py:566-613``. The
    hook is a no-op logger in stub mode; a real implementation
    would let the canary auto-rollback on a high-severity
    drift alert.

    Severity threshold: ``"high"`` fires the hook. ``"warning"``
    is surfaced in the response and persisted to ``drift_alerts``
    but doesn't fire the hook. Matches the clusterer's
    ``critical/high`` + size threshold convention.

    Wrapped in try/except — the hook is best-effort and must
    never break the response.
    """
    if severity not in ("high", "critical"):
        return
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
    except Exception as exc:
        logger.debug("predictive: hook import failed: %s", exc)
        return
    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.debug("predictive: get_promotion_hook failed: %s", exc)
        return
    try:
        # ``on_drift_alert`` is an ``async def`` method. We can't
        # ``await`` here (the helper is sync) and we don't want to
        # block the response — schedule on the running loop, or close
        # the coroutine cleanly when there is none.
        from eden.async_tasks import fire_and_forget

        fire_and_forget(
            hook.on_drift_alert(
                org_id,
                drift_type=drift_type,
                severity=severity,
            ),
            name="predictive-drift-alert",
        )
    except Exception as exc:
        logger.debug("predictive: on_drift_alert failed: %s", exc)


__all__ = [
    "CAPACITY_HISTORY_DAYS",
    "CONF_BAND_LOWER",
    "CONF_BAND_UPPER",
    "COST_HISTORY_DAYS",
    "EMBEDDING_BUCKETS",
    "MIN_FORECAST_HISTORY_DAYS",
    "POSTGRES_FALLBACK_ASSUMPTIONS",
    "PSI_BUCKETS",
    "PSI_THRESHOLD",
    "QUALITY_HISTORY_DAYS",
    "RISK_HISTORY_HOURS_DEFAULT",
    "_bad_request_envelope",
    "_fire_drift_alert",
    "_fetch_daily_call_counts",
    "_fetch_daily_costs_by_agent",
    "_fetch_daily_latencies",
    "_fetch_daily_token_totals",
    "_fetch_recent_costs",
    "_fetch_recent_judge_scores",
    "_fetch_response_text_samples",
    "_get_client",
    "_hash_bucket",
    "_histogram_buckets",
    "_insert_drift_alert",
    "_json_safe",
    "_linear_regression",
    "_ok_envelope",
    "_parse_window",
    "_psi",
    "_safe_float",
    "_upsert_capacity_forecast",
    "_upsert_cost_prediction",
    "_upsert_quality_prediction",
    "_upsert_risk_score",
    "_with_pg_assumptions",
    "_zscore",
]
