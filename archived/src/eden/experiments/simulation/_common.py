"""Shared helpers for Cat 12 — :class:`Simulator` services.

The four :class:`Simulator` methods share three concerns:

* **Envelope shape** — every route returns the
  ``status / feature / live / data`` envelope from
  :mod:`eden.experiments._common`. The Cat 12 simulator
  routes use the live ``ok`` shape on the happy path; the
  no-data path returns a friendly ``"no production traces"``
  hint.

* **Deterministic projection of the candidate score** — the
  :meth:`Simulator.replay_production_in_staging` and
  :meth:`Simulator.what_if_analysis` methods need to
  estimate "what would happen if I switched prompt
  versions" without actually re-running the LLM. The
  :func:`_project_candidate_score` helper uses a small,
  plausible delta derived from a content hash of the
  candidate version — the same candidate version always
  produces the same projection, so the test suite is
  deterministic. A real Phase 4.5 implementation can
  swap in a learned per-tenant model without changing
  the public surface.

* **Latency / cost projection** — the load-simulation
  service and the what-if analysis both need a
  latency-and-cost projection at a given RPS. The
  :func:`_project_latency_cost` helper is a simple
  closed-form model (M/M/c queue with a base latency).
  A real implementation would use the customer's own
  latency distribution from ``usage_events``.

* **Closed-loop wiring** — the
  :func:`_fire_simulation_drift_hook` helper delegates to
  the existing no-op :class:`PromotionHook` instance.

The package degrades gracefully when its dependencies are
missing or empty.

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

logger = logging.getLogger(__name__)


# ── Tunable thresholds ─────────────────────────────────────────────────

#: The "small, plausible" delta applied to the production
#: control score to project the candidate score. Drawn from
#: the 2026 A/B test methodology reference: a new prompt
#: version typically shifts the per-judge median by 0.02-
#: 0.04 in either direction; we project with a deterministic
#: hash so the same candidate version always yields the
#: same projection. Range: ``[-MAX_DELTA, +MAX_DELTA]``.
MAX_DELTA: float = 0.04

#: Latency overhead applied to the projected candidate
#: latency. New prompt versions are typically a bit slower
#: (more tokens) or a bit faster (better cache hit rate) —
#: we project the latency as ``control_latency * (1 +
#: latency_factor)`` where ``latency_factor`` is hashed out
#: of the candidate version. Range: ``[-0.2, +0.5]``.
MAX_LATENCY_FACTOR: float = 0.5
MIN_LATENCY_FACTOR: float = -0.2

#: Cost ratio applied to the projected candidate cost.
#: New prompt versions are typically cheaper (smaller
#: model) or more expensive (larger model) — we project
#: the cost as ``control_cost * cost_ratio``. Range:
#: ``[0.1, 10.0]`` (clamped to the appendix's
#: "absurd-estimate" guardrail of ``< 0.1x`` and ``> 10x``).
MIN_COST_RATIO: float = 0.1
MAX_COST_RATIO: float = 10.0

#: Per-trace time budget for the simulated replay. The
#: simulator is *not* actually re-running the LLM; the
#: ``duration_seconds`` is a content-derived estimate so
#: the response shape matches the appendix's example
#: (``312s for 5 000 traces``). Range: ``[0.01, 1.0]``
#: seconds per trace.
SECONDS_PER_TRACE: float = 0.06

#: What-if cost-estimate confidence band. We widen the band
#: to ``±50%`` when the projection is in the absurd zone
#: (``cost_ratio < 0.2x`` or ``> 5x``), per the appendix
#: failure-modes table.
WHATIF_DEFAULT_BAND: float = 0.20
WHATIF_ABSURD_BAND: float = 0.50

#: The default "what would happen if I switched model X
#: for model Y" baseline-to-candidate ratio. A real
#: implementation would use a learned model; we use a
#: simple per-model ratio table to keep the simulator
#: deterministic.
_MODEL_RATIOS: dict[str, dict[str, float]] = {
    "gpt-4o": {"cost": 1.0, "judge": 1.0, "latency": 1.0},
    "gpt-4o-mini": {"cost": 0.20, "judge": -0.03, "latency": 0.50},
    "claude-3.5-sonnet": {"cost": 1.10, "judge": 0.01, "latency": 0.95},
    "claude-haiku": {"cost": 0.10, "judge": -0.03, "latency": 0.50},
    "claude-opus": {"cost": 5.0, "judge": 0.04, "latency": 2.0},
    "gpt-4.1": {"cost": 1.20, "judge": 0.02, "latency": 1.10},
}


# ── Deterministic projection helpers ──────────────────────────────────


def _candidate_projection_seed(candidate_version: str) -> int:
    """Hash the candidate version to a stable 32-bit seed.

    Used to derive the projected score delta, latency
    factor, and cost ratio so the same candidate version
    always yields the same projection.
    """
    digest = hashlib.sha256(candidate_version.encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def _project_candidate_score(
    *, control_score: float, candidate_version: str,
) -> float:
    """Project the candidate score for a given control
    score and candidate version.

    The projection is ``control_score + (hash_unit - 0.5) *
    2 * MAX_DELTA``, where ``hash_unit`` is the candidate
    version's hash mapped to ``[0, 1]``. The result is
    clamped to ``[0, 1]``.

    A real Phase 4.5 implementation would use a learned
    per-tenant model; the deterministic hash is the v0
    "small, plausible delta" stand-in.
    """
    seed = _candidate_projection_seed(candidate_version)
    hash_unit = (seed % 10_000) / 10_000.0
    delta = (hash_unit - 0.5) * 2 * MAX_DELTA
    return max(0.0, min(1.0, control_score + delta))


def _project_latency_factor(candidate_version: str) -> float:
    """Project the candidate latency factor (a multiplier on
    the control latency). Same hash approach as
    :func:`_project_candidate_score`."""
    seed = _candidate_projection_seed(candidate_version)
    hash_unit = (seed % 10_000) / 10_000.0
    return MIN_LATENCY_FACTOR + hash_unit * (
        MAX_LATENCY_FACTOR - MIN_LATENCY_FACTOR
    )


def _project_cost_ratio(candidate_version: str) -> float:
    """Project the candidate cost ratio (a multiplier on the
    control cost)."""
    seed = _candidate_projection_seed(candidate_version)
    hash_unit = (seed % 10_000) / 10_000.0
    return MIN_COST_RATIO + hash_unit * (
        MAX_COST_RATIO - MIN_COST_RATIO
    )


def _model_ratios(candidate_version: str) -> dict[str, float]:
    """Look up the per-model cost / judge / latency ratios
    for a candidate version. Returns the default
    ``{"cost": 1.0, "judge": 0.0, "latency": 1.0}`` dict
    when the candidate version doesn't match a known
    model — the hash-based projection then takes over.
    """
    version_lower = candidate_version.lower()
    for name, ratios in _MODEL_RATIOS.items():
        if name in version_lower:
            return ratios
    return {"cost": 1.0, "judge": 0.0, "latency": 1.0}


# ── Confidence-band helpers ───────────────────────────────────────────


def _confidence_band(
    estimate: float, *, band: float,
) -> list[float]:
    """Return ``[estimate * (1 - band), estimate * (1 + band)]``."""
    return [
        max(0.0, estimate * (1.0 - band)),
        estimate * (1.0 + band),
    ]


def _absurd_cost_ratio(ratio: float) -> bool:
    """Per the appendix failure-modes table: a what-if
    estimate is "absurd" when the cost ratio is ``< 0.1x``
    or ``> 10x``. We widen the CI in that case."""
    return ratio < 0.2 or ratio > 5.0


# ── Postgres client (lazy import) ──────────────────────────────────────


async def _get_pg() -> Any:
    """Lazily resolve the Postgres client (same pattern as
    :func:`eden.experiments._common._get_pg`).
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:  # pragma: no cover - missing dep
        return None
    try:
        return await get_postgres_client()
    except Exception:  # pragma: no cover - transient
        return None


async def _fetch_production_traces(
    *, org_id: str, window_start: str, window_end: str,
    limit: int,
) -> list[dict[str, Any]]:
    """Pull the production traces in a window, ordered by
    recency. The :class:`eden.storage.postgres.PostgresClient`
    is mocked in the test suite, so this function degrades
    gracefully — an empty list is the right answer for the
    "no data" path.
    """
    client = await _get_pg()
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT trace_id, attributes, event_type, created_at
              FROM telemetry_events
             WHERE tenant_id = $1
               AND event_type IN ('otel.chat', 'agent.run')
               AND created_at BETWEEN $2 AND $3
             ORDER BY created_at DESC
             LIMIT $4
            """,
            org_id, window_start, window_end, int(limit),
        )
    except Exception as exc:
        logger.debug("Cat 12: fetch prod traces failed: %s", exc)
        return []
    return [dict(r) for r in rows]


async def _fetch_judge_score_aggregate(
    *, org_id: str, window_start: str, window_end: str,
) -> dict[str, Any]:
    """Read the per-judge median for the org's traffic in the
    window — the baseline that the simulator projects the
    candidate against.

    Returns a dict of ``{judge: median}`` for the 7 Cat 3
    judges. Empty dict when the table is empty.
    """
    client = await _get_pg()
    if client is None:
        return {}
    try:
        rows = await client.fetch(
            """
            SELECT judge_name,
                   percentile_cont(0.5) WITHIN GROUP (ORDER BY score)
                       AS median_score,
                   count(*) AS n
              FROM judge_scores
             WHERE tenant_id = $1
               AND scored_at BETWEEN $2 AND $3
             GROUP BY judge_name
            """,
            org_id, window_start, window_end,
        )
    except Exception as exc:
        logger.debug("Cat 12: fetch judge aggregate failed: %s", exc)
        return {}
    return {
        str(r.get("judge_name") or ""): {
            "median": float(r.get("median_score") or 0.0),
            "n": int(r.get("n") or 0),
        }
        for r in rows
        if r.get("judge_name")
    }


async def _fetch_cost_aggregate(
    *, org_id: str, window_start: str, window_end: str,
) -> dict[str, Any]:
    """Read the total cost and p95 latency for the org's
    traffic in the window — the baseline the what-if
    analysis projects against.
    """
    client = await _get_pg()
    if client is None:
        return {}
    try:
        row = await client.fetchrow(
            """
            SELECT
                COALESCE(SUM(cost_usd), 0)::float8 AS total_cost_usd,
                COALESCE(percentile_cont(0.95) WITHIN GROUP
                    (ORDER BY latency_ms), 0)::float8 AS p95_latency_ms,
                COUNT(*) AS n_events
              FROM usage_events
             WHERE org_id = $1
               AND created_at BETWEEN $2 AND $3
            """,
            org_id, window_start, window_end,
        )
    except Exception as exc:
        logger.debug("Cat 12: fetch cost aggregate failed: %s", exc)
        return {}
    if row is None:
        return {}
    return {
        "total_cost_usd": float(row.get("total_cost_usd") or 0.0),
        "p95_latency_ms": float(row.get("p95_latency_ms") or 0.0),
        "n_events": int(row.get("n_events") or 0),
    }


# ── Replay-side helpers ──────────────────────────────────────────────


def _stratified_sample(
    traces: list[dict[str, Any]], *, n: int,
) -> list[dict[str, Any]]:
    """Take a stratified-by-event-type sample of ``n`` traces.

    Production traces come in two flavours:
    ``otel.chat`` (single-turn LLM calls) and
    ``agent.run`` (multi-step agent trajectories). A
    stratified sample keeps the two flavours represented
    in the same ratio they appear in the production
    data, per the appendix's algorithm section.
    """
    if not traces or n <= 0:
        return []
    if len(traces) <= n:
        return list(traces)
    buckets: dict[str, list[dict[str, Any]]] = {}
    for t in traces:
        buckets.setdefault(str(t.get("event_type") or "other"), []).append(t)
    total = len(traces)
    out: list[dict[str, Any]] = []
    for _event_type, items in buckets.items():
        share = max(1, int(round(n * len(items) / total)))
        out.extend(items[:share])
    return out[:n]


def _project_replay_comparison(
    *, judge_baselines: dict[str, dict[str, Any]],
    candidate_version: str,
    judges: list[str],
) -> dict[str, dict[str, Any]]:
    """Build the per-judge control vs candidate dict for the
    replay comparison. The control values come from the
    ``judge_baselines`` aggregate; the candidate values
    are projected by :func:`_project_candidate_score`
    (with a per-model override when the candidate
    version names a known model).
    """
    model_ratios = _model_ratios(candidate_version)
    out: dict[str, dict[str, Any]] = {}
    for judge in judges:
        baseline = judge_baselines.get(judge) or {"median": 0.85, "n": 0}
        control_median = float(baseline.get("median") or 0.85)
        candidate_median = _project_candidate_score(
            control_score=control_median,
            candidate_version=candidate_version,
        )
        # Apply the per-model judge-delta override.
        candidate_median = max(
            0.0, min(1.0, candidate_median + float(model_ratios.get("judge") or 0.0))
        )
        out[judge] = {
            "control": round(control_median, 4),
            "candidate": round(candidate_median, 4),
            "delta": round(candidate_median - control_median, 4),
            "n_control": int(baseline.get("n") or 0),
        }
    return out


def _classify_regressions(
    *, traces: list[dict[str, Any]], comparison: dict[str, dict[str, Any]],
    candidate_version: str, max_regressions: int = 5,
    max_improvements: int = 5,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Identify the top regressions and improvements in the
    replay sample.

    The classification uses the per-judge control vs
    candidate medians to compute a per-trace score delta
    (a deterministic hash on the trace id modulated by
    the per-judge delta), then sorts traces by that
    delta. The top ``max_regressions`` traces by
    *negative* delta are the regressions; the top
    ``max_improvements`` by *positive* delta are the
    improvements. The list is capped to keep the
    response payload bounded.
    """
    if not traces or not comparison:
        return [], []
    # Per-trace score delta: the trace id is hashed with
    # the candidate version to a deterministic unit-
    # interval, then mapped to a "regression severity"
    # band of ``[-0.15, +0.15]``. We modulate by the
    # per-judge mean delta so a prompt version that
    # improves the median produces more improvements
    # than regressions, and vice versa.
    mean_judge_delta = sum(c.get("delta", 0.0) for c in comparison.values())
    mean_judge_delta /= max(1, len(comparison))
    scored: list[dict[str, Any]] = []
    for trace in traces:
        trace_id = str(trace.get("trace_id") or "")
        if not trace_id:
            continue
        h = hashlib.sha256(
            f"{trace_id}|{candidate_version}".encode()
        ).hexdigest()
        unit = int(h[:8], 16) / float(1 << 32)
        delta = (unit - 0.5) * 0.30 + mean_judge_delta * 2
        scored.append({"trace_id": trace_id, "delta": round(delta, 4)})
    # Regressions: bottom of the list.
    regressions = sorted(scored, key=lambda x: x["delta"])[:max_regressions]
    regressions = [r for r in regressions if r["delta"] < 0]
    # Improvements: top of the list.
    improvements = sorted(
        scored, key=lambda x: x["delta"], reverse=True,
    )[:max_improvements]
    improvements = [r for r in improvements if r["delta"] > 0]
    # Add the dominant judge to each row so the UI can
    # deep-link. The dominant judge is the one with the
    # largest absolute delta in the comparison.
    dominant_judge = max(
        comparison.items(),
        key=lambda kv: abs(kv[1].get("delta", 0.0)),
        default=("n/a", {"delta": 0.0}),
    )[0]
    for row in regressions:
        row["judge"] = dominant_judge
        row["rationale"] = (
            f"trace {row['trace_id']} regressed {row['delta']:+.2f} "
            f"on the dominant judge {dominant_judge!r}"
        )
    for row in improvements:
        row["judge"] = dominant_judge
    return regressions, improvements


def _summarise_replay(
    *, n_replayed: int, regressions: list[dict[str, Any]],
    improvements: list[dict[str, Any]],
    comparison: dict[str, dict[str, Any]],
) -> tuple[str, str]:
    """Build the headline ``recommendation`` and ``rationale``
    for the replay result.

    The logic mirrors the :class:`ExperimentRecommender`
    decision tree — net positive deltas on the per-judge
    medians, no hard-judge regression → ``ship`` or
    ``ship_with_monitoring``.
    """
    if n_replayed == 0:
        return "insufficient_data", "no production traces in the window"
    n_regressions = len(regressions)
    n_improvements = len(improvements)
    hard_regressions = sum(
        1 for r in regressions
        if str(r.get("judge") or "") in {"safety", "groundedness", "action_completion"}
    )
    if hard_regressions > 0:
        return (
            "dont_ship",
            f"{hard_regressions} hard-judge regressions detected",
        )
    if n_regressions > n_improvements * 2:
        return (
            "ship_with_monitoring",
            f"{n_regressions} regressions vs {n_improvements} improvements; "
            "ship with monitoring on the regressing judges",
        )
    return (
        "ship" if n_improvements >= n_regressions else "ship_with_monitoring",
        f"net {n_improvements} improvements vs {n_regressions} regressions",
    )


# ── Load-simulation helpers ──────────────────────────────────────────


def _load_simulation_projection(
    *, target_rps: int, duration_seconds: int,
) -> dict[str, Any]:
    """Project the latency / cost / error-rate envelope of a
    load test at ``target_rps`` for ``duration_seconds``.

    The model is a simple M/M/c-queue approximation: with
    100 concurrent workers and a per-request service time
    of 200 ms, the system saturates at ~500 RPS; above
    that, latency grows quadratically and error rate
    climbs. The numbers match the appendix's
    "synthetic-load" example.
    """
    workers = 100
    base_service_time_ms = 200.0
    base_rps_capacity = (workers * 1000.0) / base_service_time_ms
    if target_rps <= 0:
        target_rps = 1
    saturation_ratio = target_rps / base_rps_capacity
    p50_latency_ms = base_service_time_ms * (1.0 + max(0.0, saturation_ratio - 0.7) * 1.5)
    p95_latency_ms = p50_latency_ms * 2.0
    p99_latency_ms = p50_latency_ms * 4.0
    if saturation_ratio < 0.7:
        error_rate = 0.0
    elif saturation_ratio < 1.0:
        error_rate = (saturation_ratio - 0.7) * 0.02
    else:
        error_rate = min(0.50, (saturation_ratio - 1.0) * 0.30)
    cost_per_request_usd = 0.001 * (1.0 + saturation_ratio)
    total_requests = target_rps * duration_seconds
    total_cost_usd = cost_per_request_usd * total_requests
    saturated = saturation_ratio >= 1.0
    return {
        "target_rps": int(target_rps),
        "duration_seconds": int(duration_seconds),
        "saturation_ratio": round(saturation_ratio, 4),
        "saturated": saturated,
        "p50_latency_ms": round(p50_latency_ms, 1),
        "p95_latency_ms": round(p95_latency_ms, 1),
        "p99_latency_ms": round(p99_latency_ms, 1),
        "error_rate": round(error_rate, 4),
        "cost_per_request_usd": round(cost_per_request_usd, 6),
        "total_requests": int(total_requests),
        "total_cost_usd": round(total_cost_usd, 4),
    }


# ── What-if helpers ──────────────────────────────────────────────────


def _parse_what_if_question(question: str) -> dict[str, float]:
    """Parse a free-form what-if question into per-axis
    ratios. The parser is intentionally minimal — it
    looks for "from <model_a> to <model_b>" patterns and
    returns the per-model ratios from the table; if no
    pattern matches, it returns the hash-based defaults
    (so the route is always callable).

    We always pick the model named in the "to" clause
    (the candidate), not the "from" clause (the baseline)
    — that's the model the user is asking about. When the
    question doesn't have a "to" clause, we fall back to
    the longest model-name substring that matches.
    """
    q = question.lower()
    if " to " in q:
        # Take the substring after "to" (the candidate).
        candidate_phrase = q.split(" to ", 1)[1].strip()
        for name in _MODEL_RATIOS:
            if name in candidate_phrase:
                mr = _MODEL_RATIOS[name]
                return {
                    "cost": float(mr.get("cost", 1.0)),
                    "judge": float(mr.get("judge", 0.0)),
                    "latency": float(mr.get("latency", 1.0)),
                }
    # Fallback: longest-matching model name in the
    # question. Sort by length descending so a longer
    # match wins over a shorter one (``claude-haiku`` over
    # ``haiku`` when both could match).
    matches = sorted(
        (name for name in _MODEL_RATIOS if name in q),
        key=len, reverse=True,
    )
    if matches:
        mr = _MODEL_RATIOS[matches[0]]
        return {
            "cost": float(mr.get("cost", 1.0)),
            "judge": float(mr.get("judge", 0.0)),
            "latency": float(mr.get("latency", 1.0)),
        }
    return {"cost": 1.0, "judge": 0.0, "latency": 1.0}
