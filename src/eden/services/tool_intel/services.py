"""Tool Intelligence services (Cat 7) — real implementations.

Four services:

* :class:`ToolAttributionScorer` — for a given ``(org,
  tool_name)`` pair, read the tool events from
  ``telemetry_events`` and compute the per-tool score:
  ``{n_calls, success_rate, p50/p95 latency,
  contribution_score, drift_alerts}``. Persists one row
  per ``(org, trace, tool)`` to ``tool_attributions``.

* :class:`ToolComparator` — compare two tools in the same
  window: ``success_rate``, ``p95_latency``, ``cost_per_call``;
  declare a winner with confidence (or a tie below the
  non-inferiority margin). Persists to ``tool_comparisons``.

* :class:`ToolRecommender` — given a task type + agent,
  score the available tools and return the top K. The
  scoring combines success rate (40%), material rate (30%),
  latency (20%), and cost (10%) — matches the appendix
  pseudo-code.

* :class:`ToolRegistryTaxonomy` — the org's tool catalog:
  distinct tools with their version, success rate, and
  call count, plus the co-occurrence matrix (which tools
  tend to be called together). Pure read; no persistence.

All four services degrade gracefully when their
dependencies are missing or empty:

* No ``telemetry_events`` rows for the tool → attribution
  returns ``"no tool telemetry"`` with zero-default
  metrics.
* Empty window for both tools → comparator returns a
  ``"no tool telemetry"`` envelope with ``winner="tie"``.
* No tools in the agent's history → recommender returns
  an empty list with the ``"no tool telemetry"`` message.
* No tool events at all → taxonomy returns an empty
  ``tools`` list + empty ``co_occurrence`` dict.

The :class:`ToolAttributionScorer` and :class:`ToolComparator`
fire the closed-loop
:func:`PromotionHook.on_drift_alert` hook on a material
drop in success rate (Cat 17 wiring). The hook is a no-op
logger in stub mode; a real implementation would let the
canary auto-rollback.

See ``docs/observability-gap/07-tool-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import (
    COMPARATOR_MARGIN,
    COST_REFERENCE_USD,
    DRIFT_MIN_CALLS,
    LATENCY_REFERENCE_MS,
    MAX_COOCCURRENCE_PAIRS,
    MAX_RECOMMENDATIONS,
    MAX_TOOLS_RETURNED,
    RECOMMENDER_MIN_CALLS,
    _bad_request_envelope,
    _clamp,
    _delete_then_insert_attribution,
    _delete_then_insert_comparison,
    _extract_tool_name,
    _fetch_distinct_tools_for_org,
    _fetch_tool_aggregates,
    _fetch_tool_events_for_trace,
    _fetch_tool_pairs_in_trace,
    _fetch_tool_success_rate_in_prev_window,
    _fire_tool_drift_hook,
    _ok_envelope,
    _parse_window,
    _round6,
    _safe_float_or_none,
    _tool_is_success,
)

logger = logging.getLogger(__name__)


# ── 1. ToolAttributionScorer ─────────────────────────────────────────


class ToolAttributionScorer:
    """Per-tool attribution scorer.

    For a given ``(org, tool_name)`` pair, reads the tool
    events from ``telemetry_events`` (filtered by
    ``event_type IN (tool.*)``) and computes:

    * ``n_calls`` — total invocations in the window
    * ``success_rate`` — fraction with ``outcome='success'``
      (or no error signal)
    * ``p50_ms`` / ``p95_ms`` — duration percentiles
    * ``contribution_score`` — 0..1 score combining
      success_rate, latency, and (when available) the
      per-trace utilisation signal
    * ``drift_alerts`` — list of detected regressions
      (current-window vs. previous-window)

    When ``trace_id`` is provided, the per-trace
    attribution is computed: the rows in
    ``tool_attributions`` are scoped to that trace. The
    service is re-runnable (delete-then-insert on
    ``(org, trace, tool)``).

    The :attr:`name` is ``"tool_attribution"`` and matches
    the ``feature`` field in the response envelope.
    """

    name = "tool_attribution"

    async def score(
        self,
        org_id: str,
        *,
        trace_id: str | None = None,
        tool_id: str,
        agent_id: str | None = None,
        window: str = "30d",
    ) -> dict[str, Any]:
        if not tool_id or not str(tool_id).strip():
            return _bad_request_envelope(
                self.name, "tool_id must be a non-empty string"
            )
        tool_id = str(tool_id).strip()[:128]
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '24h'",
            )

        # 1. Read the per-trace events when a trace_id is
        # given (so the response can carry the per-trace
        # events even if the window is empty).
        per_trace_events: list[dict[str, Any]] = []
        if trace_id:
            per_trace_events = await _fetch_tool_events_for_trace(
                org_id, str(trace_id)
            )
            per_trace_events = [
                r for r in per_trace_events
                if _extract_tool_name(r) == tool_id
            ]

        # 2. Aggregate over the window.
        agg = await _fetch_tool_aggregates(
            org_id, tool_id, interval, agent_id=agent_id
        )

        # 3. Compute the contribution score.
        #   score = 0.6 * success_rate
        #         + 0.2 * (1 - p95 / 5000)   (latency term, capped at 1)
        #         + 0.2 * util_signal         (per-trace utilisation, 0
        #                                       if no trace events)
        sr = _safe_float_or_none(agg["success_rate"])
        p95 = _safe_float_or_none(agg["p95_ms"])
        util_signal: float | None = None
        if per_trace_events:
            n_used = sum(
                1 for r in per_trace_events
                if _tool_is_success(r)
            )
            util_signal = n_used / len(per_trace_events)
        if sr is None:
            contribution = None
        else:
            latency_term = 0.0
            if p95 is not None and p95 >= 0:
                latency_term = _clamp(1.0 - (p95 / LATENCY_REFERENCE_MS), 0.0, 1.0)
            util_term = util_signal if util_signal is not None else 0.0
            contribution = _clamp(
                0.6 * sr + 0.2 * latency_term + 0.2 * util_term, 0.0, 1.0
            )

        # 4. Drift detection: current window vs. the
        # previous window of the same length.
        drift_alerts: list[dict[str, Any]] = []
        n_prev, sr_prev = await _fetch_tool_success_rate_in_prev_window(
            org_id, tool_id, interval
        )
        if (
            agg["n_calls"] >= DRIFT_MIN_CALLS
            and sr is not None
            and n_prev >= DRIFT_MIN_CALLS
        ):
            delta = sr - sr_prev
            if delta <= -0.10:
                drift_alerts.append(
                    {
                        "type": "success_rate_drop",
                        "window": window,
                        "delta": round(delta, 4),
                        "previous_success_rate": round(sr_prev, 4),
                    }
                )
                # Fire the closed-loop hook for a high-
                # severity drop (the helper checks its own
                # thresholds so we always call it on the
                # observed numbers).
                _fire_tool_drift_hook(
                    org_id,
                    tool_name=tool_id,
                    n_calls=int(agg["n_calls"]),
                    success_rate_now=sr,
                    success_rate_prev=sr_prev,
                )

        # 5. Persist per-trace rows (best-effort).
        if trace_id and per_trace_events:
            await _delete_then_insert_attribution(
                org_id,
                str(trace_id),
                tool_id,
                [
                    {
                        "trace_id": str(trace_id),
                        "tool_id": tool_id,
                        "impact_score": (
                            _safe_float_or_none(contribution)
                        ),
                    }
                ],
            )
        elif not trace_id and agg["n_calls"] > 0:
            # Aggregate-only attribution: write one row per
            # distinct trace the tool appears in. We use the
            # agent_id filter as the trace fan-out hint.
            await _delete_then_insert_attribution(
                org_id,
                None,
                tool_id,
                [
                    {
                        "trace_id": trace_id or f"agg-{tool_id}",
                        "tool_id": tool_id,
                        "impact_score": (
                            _safe_float_or_none(contribution)
                        ),
                    }
                ],
            )

        # 6. Build the response.
        if agg["n_calls"] == 0 and not per_trace_events:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "tool_name": tool_id,
                    "trace_id": trace_id,
                    "agent_id": agent_id,
                    "window": window,
                    "n_calls": 0,
                    "success_rate": None,
                    "p50_ms": None,
                    "p95_ms": None,
                    "contribution_score": None,
                    "drift_alerts": [],
                    "per_trace": [],
                    "message": "no tool telemetry",
                },
            )

        per_trace_resp: list[dict[str, Any]] = []
        for r in per_trace_events:
            per_trace_resp.append(
                {
                    "trace_id": str(r.get("trace_id", trace_id) or ""),
                    "event_type": str(r.get("event_type", "")),
                    "duration_ms": _safe_float_or_none(r.get("duration_ms")),
                    "success": _tool_is_success(r),
                }
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "tool_name": tool_id,
                "trace_id": trace_id,
                "agent_id": agent_id,
                "window": window,
                "n_calls": agg["n_calls"],
                "n_success": agg["n_success"],
                "success_rate": _round6(sr),
                "p50_ms": _safe_float_or_none(agg["p50_ms"]),
                "p95_ms": _safe_float_or_none(agg["p95_ms"]),
                "cost_per_call_usd": _round6(
                    _safe_float_or_none(agg["cost_per_call_usd"])
                ),
                "agent_ids": agg["agent_ids"],
                "contribution_score": _round6(contribution),
                "drift_alerts": drift_alerts,
                "per_trace": per_trace_resp,
                "message": None,
            },
        )


# ── 2. ToolComparator ────────────────────────────────────────────────


class ToolComparator:
    """Compare two tools in the same window.

    For the given ``(org, tool_a, tool_b)``, reads the tool
    events for both, computes per-tool ``{n_calls,
    success_rate, p95_latency, cost_per_call}``, and returns
    a diff envelope:

    * ``success_rate_diff`` = ``sr_a - sr_b``
    * ``p95_latency_diff_ms`` = ``p95_a - p95_b``
    * ``cost_per_call_diff_usd`` = ``cost_a - cost_b``
    * ``winner`` = ``tool_a`` / ``tool_b`` / ``"tie"``
    * ``confidence`` = 1.0 when winner is clear, 0.5 on tie
    * ``drift_alert`` = True if the success-rate gap is
      large enough to fire the Cat 17 hook

    Persists one row per ``(org, tool_a, tool_b, window)``
    to ``tool_comparisons`` (the table is unordered; the
    helper normalises ``tool_a < tool_b``).

    The :attr:`name` is ``"tool_compare"``.
    """

    name = "tool_compare"

    async def compare(
        self,
        org_id: str,
        *,
        tool_a: str,
        tool_b: str,
        window: str = "7d",
    ) -> dict[str, Any]:
        if not tool_a or not str(tool_a).strip():
            return _bad_request_envelope(
                self.name, "tool_a must be a non-empty string"
            )
        if not tool_b or not str(tool_b).strip():
            return _bad_request_envelope(
                self.name, "tool_b must be a non-empty string"
            )
        if tool_a == tool_b:
            return _bad_request_envelope(
                self.name,
                f"tool_a and tool_b must differ (both are {tool_a!r})",
            )
        tool_a = str(tool_a).strip()[:128]
        tool_b = str(tool_b).strip()[:128]
        interval = _parse_window(window)
        if interval is None:
            return _bad_request_envelope(
                self.name,
                f"invalid window {window!r}; expected e.g. '7d', '24h'",
            )

        # 1. Aggregate both tools.
        agg_a = await _fetch_tool_aggregates(org_id, tool_a, interval)
        agg_b = await _fetch_tool_aggregates(org_id, tool_b, interval)
        if agg_a["n_calls"] == 0 and agg_b["n_calls"] == 0:
            payload = {
                "org_id": org_id,
                "tool_a": tool_a,
                "tool_b": tool_b,
                "window": window,
                "tools": [
                    _tool_summary(tool_a, agg_a),
                    _tool_summary(tool_b, agg_b),
                ],
                "success_rate_diff": None,
                "p95_latency_diff_ms": None,
                "cost_per_call_diff_usd": None,
                "winner": "tie",
                "confidence": 0.5,
                "drift_alert": False,
                "message": "no tool telemetry",
            }
            return _ok_envelope(self.name, payload)

        # 2. Compute diffs.
        sr_a = _safe_float_or_none(agg_a["success_rate"])
        sr_b = _safe_float_or_none(agg_b["success_rate"])
        sr_diff: float | None = None
        if sr_a is not None and sr_b is not None:
            sr_diff = sr_a - sr_b
        p95_a = _safe_float_or_none(agg_a["p95_ms"])
        p95_b = _safe_float_or_none(agg_b["p95_ms"])
        p95_diff: float | None = None
        if p95_a is not None and p95_b is not None:
            p95_diff = p95_a - p95_b
        cost_a = _safe_float_or_none(agg_a["cost_per_call_usd"])
        cost_b = _safe_float_or_none(agg_b["cost_per_call_usd"])
        cost_diff: float | None = None
        if cost_a is not None and cost_b is not None:
            cost_diff = cost_a - cost_b

        # 3. Pick the winner via the non-inferiority
        # margin. A success-rate difference of |sr_diff| <
        # MARGIN is "about the same" → tie.
        if sr_diff is not None and sr_diff > COMPARATOR_MARGIN:
            winner = tool_a
            confidence = _clamp(0.5 + 0.5 * abs(sr_diff), 0.5, 0.99)
        elif sr_diff is not None and sr_diff < -COMPARATOR_MARGIN:
            winner = tool_b
            confidence = _clamp(0.5 + 0.5 * abs(sr_diff), 0.5, 0.99)
        else:
            winner = "tie"
            confidence = 0.5

        # 4. Drift alert when the gap is large enough to
        # warrant attention (≥ 0.20 absolute success-rate
        # difference with both tools having ≥ DRIFT_MIN_CALLS
        # samples). This is independent of the
        # _fire_tool_drift_hook threshold — the comparator's
        # alert is about the *gap* between tools, not the
        # absolute drop of either one.
        drift_alert = (
            sr_diff is not None
            and abs(sr_diff) >= 0.20
            and agg_a["n_calls"] >= DRIFT_MIN_CALLS
            and agg_b["n_calls"] >= DRIFT_MIN_CALLS
        )

        # 5. Persist (best-effort).
        payload = {
            "org_id": org_id,
            "tool_a": tool_a,
            "tool_b": tool_b,
            "window": window,
            "tools": [
                _tool_summary(tool_a, agg_a),
                _tool_summary(tool_b, agg_b),
            ],
            "success_rate_diff": _round6(sr_diff),
            "p95_latency_diff_ms": _round6(p95_diff),
            "cost_per_call_diff_usd": _round6(cost_diff),
            "winner": winner,
            "confidence": _round6(confidence),
            "drift_alert": drift_alert,
            "message": None,
        }
        await _delete_then_insert_comparison(
            org_id, tool_a, tool_b, window, payload
        )

        return _ok_envelope(self.name, payload)


# ── 3. ToolRecommender ───────────────────────────────────────────────


class ToolRecommender:
    """Recommend the top K tools for a given task type.

    For an ``(org, task_type, agent_id)`` triple:

    1. List the org's known tools (with per-tool aggregates
       in the window).
    2. Filter by ``n_calls >= RECOMMENDER_MIN_CALLS`` (so
       the success_rate is meaningful).
    3. Score each tool on a weighted aggregate:

       * ``0.4 * success_rate`` (the most important signal)
       * ``0.3 * material_rate`` (the fraction of the
         org's tool calls that this tool accounts for — a
         proxy for "this tool matters for your workload")
       * ``0.2 * (1 - p95 / 5000)`` (latency term)
       * ``0.1 * (1 - cost / 0.05)`` (cost term)

    4. Return the top K (capped at ``MAX_RECOMMENDATIONS``)
       with rationales.

    Tools with ``n_calls < RECOMMENDER_MIN_CALLS`` are
    excluded from the ranking. ``task_type`` is included
    in the rationale but doesn't filter the pool (v1 — the
    task-type-conditioned recommender is a v2 path).

    The :attr:`name` is ``"tool_recommend"``.
    """

    name = "tool_recommend"

    async def recommend(
        self,
        org_id: str,
        *,
        task_type: str | None = None,
        agent_id: str | None = None,
        k: int = 3,
    ) -> dict[str, Any]:
        if not isinstance(k, int) or k < 1:
            k = 3
        if k > MAX_RECOMMENDATIONS:
            k = MAX_RECOMMENDATIONS
        interval = "30 days"
        tools = await _fetch_distinct_tools_for_org(
            org_id, interval, limit=MAX_TOOLS_RETURNED
        )
        if not tools:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "task_type": task_type,
                    "agent_id": agent_id,
                    "k": k,
                    "recommendations": [],
                    "message": "no tool telemetry",
                },
            )

        # Total calls (for material_rate).
        total_calls = sum(int(t.get("n_calls") or 0) for t in tools) or 1
        scored: list[dict[str, Any]] = []
        for t in tools:
            n = int(t.get("n_calls") or 0)
            if n < RECOMMENDER_MIN_CALLS:
                continue
            sr = _safe_float_or_none(t.get("success_rate"))
            if sr is None:
                continue
            p95 = _safe_float_or_none(t.get("p95_ms"))
            cost = _safe_float_or_none(t.get("cost_per_call_usd"))
            material = n / total_calls
            latency_term = 0.0
            if p95 is not None and p95 >= 0:
                latency_term = _clamp(1.0 - (p95 / LATENCY_REFERENCE_MS), 0.0, 1.0)
            cost_term = 0.0
            if cost is not None and cost >= 0:
                cost_term = _clamp(1.0 - (cost / COST_REFERENCE_USD), 0.0, 1.0)
            score = _clamp(
                0.4 * sr
                + 0.3 * material
                + 0.2 * latency_term
                + 0.1 * cost_term,
                0.0,
                1.0,
            )
            rationale = _build_rationale(
                tname=str(t.get("tool_name", "")),
                n_calls=n,
                sr=sr,
                material=material,
                p95=p95,
                cost=cost,
            )
            scored.append(
                {
                    "tool_name": str(t.get("tool_name", "")),
                    "tool_version": str(t.get("tool_version", "unknown")),
                    "score": _round6(score),
                    "n_calls": n,
                    "success_rate": _round6(sr),
                    "p95_ms": _safe_float_or_none(p95),
                    "cost_per_call_usd": _round6(cost),
                    "rationale": rationale,
                }
            )
        # Sort by score desc, then n_calls desc, then
        # tool_name asc (deterministic tiebreak).
        scored.sort(key=lambda t: (-float(t["score"] or 0.0), -int(t["n_calls"]), t["tool_name"]))
        top = scored[:k]
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "task_type": task_type,
                "agent_id": agent_id,
                "k": k,
                "tools_observed": len(tools),
                "tools_scored": len(scored),
                "recommendations": top,
                "message": None,
            },
        )


# ── 4. ToolRegistryTaxonomy ──────────────────────────────────────────


class ToolRegistryTaxonomy:
    """The org's tool catalog + co-occurrence matrix.

    Pure read: lists the org's distinct tools with their
    version, success rate, and call count, plus the
    co-occurrence matrix (which tools tend to be called
    together in the same trace). The co-occurrence
    frequency is normalised by the number of traces in the
    window so the values are a proxy for "fraction of
    traces that call both tools".

    The :attr:`name` is ``"tool_taxonomy"``.
    """

    name = "tool_taxonomy"

    async def taxonomy(
        self,
        org_id: str,
    ) -> dict[str, Any]:
        interval = "30 days"
        tools = await _fetch_distinct_tools_for_org(
            org_id, interval, limit=MAX_TOOLS_RETURNED
        )
        if not tools:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "tools": [],
                    "co_occurrence": {},
                    "message": "no tool telemetry",
                },
            )

        # Co-occurrence matrix. We normalise by the
        # per-tool-pair trace count divided by the smaller
        # of the two tools' trace counts — the result is in
        # [0, 1] and represents "fraction of the rarer
        # tool's traces that also called the other tool".
        pairs = await _fetch_tool_pairs_in_trace(org_id, interval)
        by_tool_calls: dict[str, int] = {
            str(t.get("tool_name", "")): int(t.get("n_calls") or 0)
            for t in tools
        }
        co_occurrence: dict[str, float] = {}
        if pairs:
            # Sort by frequency desc, then pair asc, to
            # make the matrix deterministic.
            sorted_pairs = sorted(
                pairs.items(),
                key=lambda kv: (-int(kv[1]), kv[0][0], kv[0][1]),
            )
            for (a, b), n_traces in sorted_pairs[
                :MAX_COOCCURRENCE_PAIRS
            ]:
                denom = min(
                    max(1, by_tool_calls.get(a, 1)),
                    max(1, by_tool_calls.get(b, 1)),
                )
                co_occurrence[f"{a},{b}"] = round(n_traces / denom, 6)

        # Tool catalog.
        catalog: list[dict[str, Any]] = []
        for t in tools:
            catalog.append(
                {
                    "tool_name": str(t.get("tool_name", "")),
                    "tool_version": str(t.get("tool_version", "unknown")),
                    "n_calls_30d": int(t.get("n_calls") or 0),
                    "n_success_30d": int(t.get("n_success") or 0),
                    "success_rate": _round6(
                        _safe_float_or_none(t.get("success_rate"))
                    ),
                    "p50_ms": _safe_float_or_none(t.get("p50_ms")),
                    "p95_ms": _safe_float_or_none(t.get("p95_ms")),
                    "cost_per_call_usd": _round6(
                        _safe_float_or_none(t.get("cost_per_call_usd"))
                    ),
                }
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "tools": catalog,
                "co_occurrence": co_occurrence,
                "message": None,
            },
        )


# ── Local helpers ────────────────────────────────────────────────────


def _tool_summary(tool_name: str, agg: dict[str, Any]) -> dict[str, Any]:
    """Build the per-tool summary dict used by the
    comparator response."""
    return {
        "tool_name": tool_name,
        "n_calls": int(agg.get("n_calls") or 0),
        "n_success": int(agg.get("n_success") or 0),
        "success_rate": _round6(_safe_float_or_none(agg.get("success_rate"))),
        "p50_ms": _safe_float_or_none(agg.get("p50_ms")),
        "p95_ms": _safe_float_or_none(agg.get("p95_ms")),
        "cost_per_call_usd": _round6(
            _safe_float_or_none(agg.get("cost_per_call_usd"))
        ),
    }


def _build_rationale(
    *,
    tname: str,
    n_calls: int,
    sr: float,
    material: float,
    p95: float | None,
    cost: float | None,
) -> str:
    """One-line human-readable rationale for the
    recommender's top-K list."""
    bits: list[str] = []
    bits.append(
        f"{sr*100:.0f}% success over {n_calls} calls"
    )
    if material >= 0.20:
        bits.append(f"high material ({material*100:.0f}% of org calls)")
    elif material >= 0.05:
        bits.append(f"moderate material ({material*100:.0f}%)")
    else:
        bits.append(f"low material ({material*100:.1f}%)")
    if p95 is not None and p95 > 0:
        bits.append(f"p95 {p95:.0f}ms")
    if cost is not None and cost > 0:
        bits.append(f"~${cost*1000:.1f}/1k calls")
    return "; ".join(bits)
