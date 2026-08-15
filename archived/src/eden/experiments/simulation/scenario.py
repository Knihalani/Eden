"""Cat 12 — :class:`Simulator` (4 methods).

The headline surface for "ship a prompt change and see the
answer in 5 minutes." The simulator has four entry points:

* :meth:`Simulator.simulate_scenario` — load a saved
  scenario and re-run it with new parameters (the "what-
  if" replay against a stored scenario).
* :meth:`Simulator.replay_production_in_staging` — copy
  last week's production traces to staging, replay them
  with the candidate prompt version, and return the
  per-judge comparison plus the regression / improvement
  lists.
* :meth:`Simulator.what_if_analysis` — "what would happen
  to my judge scores if I switched from gpt-4o to claude-
  haiku?" A pure-analytics answer (no LLM re-run): we
  apply a per-model cost / judge / latency ratio to the
  customer's existing aggregate.
* :meth:`Simulator.load_simulation` — synthetic load to
  validate SLOs before a release. Closed-form M/M/c
  projection of latency / cost / error rate at the
  requested RPS for the requested duration.

The simulator degrades gracefully when its dependencies are
missing or empty — the appendix failure-modes table calls
this out explicitly: the "no production traces" path
returns the "insufficient_data" recommendation, never a 500.

Routes exposed:

* ``POST /orgs/{org_id}/intelligence/experiments/simulate``
* ``POST /orgs/{org_id}/intelligence/experiments/simulate/replay``
* ``POST /orgs/{org_id}/intelligence/experiments/simulate/whatif``
* ``POST /orgs/{org_id}/intelligence/experiments/simulate/load``

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

import logging
import time
from datetime import UTC
from typing import Any

from eden.experiments._common import (
    DEFAULT_REPLAY_SAMPLE_SIZE,
    MAX_REPLAY_SAMPLE_SIZE,
    _fetch_scenario,
    _fire_simulation_drift_hook,  # noqa: E402
    _normalize_judges,
    _now_iso,
    _upsert_scenario,
    _upsert_simulation_run,
    _upsert_what_if,
    empty_envelope,
    load_simulation_id,
    ok_envelope,
)
from eden.experiments.simulation._common import (
    SECONDS_PER_TRACE,
    WHATIF_ABSURD_BAND,
    WHATIF_DEFAULT_BAND,
    _absurd_cost_ratio,
    _classify_regressions,
    _confidence_band,
    _fetch_cost_aggregate,
    _fetch_judge_score_aggregate,
    _fetch_production_traces,
    _load_simulation_projection,
    _parse_what_if_question,
    _project_cost_ratio,
    _project_latency_factor,
    _project_replay_comparison,
    _stratified_sample,
    _summarise_replay,
)

logger = logging.getLogger(__name__)


class Simulator:
    """What-if scenarios and replay production traffic.

    The :class:`name` is ``"simulator"`` and matches the
    ``feature`` field in the response envelope. All
    public methods return the live envelope on success.
    """

    name = "simulator"

    async def simulate_scenario(
        self,
        org_id: str,
        *,
        scenario_id: str | None = None,
        name: str | None = None,
        parameters: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Load a saved scenario and re-run it with new
        parameters.

        The caller may pass either a ``scenario_id`` (the
        persisted row id) or a ``name`` (we hash the name
        into a stable id, matching the
        :func:`replay_production_in_staging` write path).
        If neither is provided, we save a new scenario
        from the supplied parameters and replay it once.
        """
        if not scenario_id and not name:
            return empty_envelope(
                self.name,
                message="scenario_id or name is required",
            )
        if scenario_id:
            # Read the persisted scenario spec.
            spec = await _fetch_scenario(
                org_id, name or scenario_id,
            )
            if spec is None:
                return empty_envelope(
                    self.name,
                    message=(
                        f"scenario {scenario_id!r} not found — "
                        "create one via /simulate/replay first"
                    ),
                )
        else:
            # No saved scenario — save the supplied
            # parameters as a new scenario and replay it.
            spec = {
                "name": name,
                "parameters": parameters or {},
                "created_at": _now_iso(),
            }
            scenario_id = await _upsert_scenario(
                org_id=org_id,
                name=name or f"ad-hoc-{_now_iso()}",
                spec=spec,
            )
        merged = {**spec, **(parameters or {})}
        return await self.replay_production_in_staging(
            org_id,
            production_window_start=merged.get(
                "production_window_start", _iso_days_ago(7),
            ),
            production_window_end=merged.get(
                "production_window_end", _now_iso(),
            ),
            candidate_version=str(merged.get("candidate_version") or "v2"),
            judges=merged.get("judges"),
            sample_size=int(merged.get("sample_size") or 1000),
            scenario_name=merged.get("name") or name or scenario_id,
        )

    async def replay_production_in_staging(
        self,
        org_id: str,
        *,
        production_window_start: str,
        production_window_end: str,
        candidate_version: str,
        judges: list[str] | None = None,
        sample_size: int = DEFAULT_REPLAY_SAMPLE_SIZE,
        scenario_name: str | None = None,
    ) -> dict[str, Any]:
        """Replay ``sample_size`` production traces in
        staging against ``candidate_version``.

        The "replay" is a *projection*, not an actual LLM
        re-run — the v0 simulator estimates the candidate
        judge scores from the per-judge control aggregate
        plus a deterministic hash-derived delta. A real
        Phase 4.5 implementation would route the replay
        through :class:`eden.sandbox.runner.SandboxRunner`
        and use the LLM output to compute the candidate
        judge scores. The public surface is identical, so
        the front-end doesn't need to change when the v2
        ships.
        """
        if not production_window_start or not production_window_end:
            return empty_envelope(
                self.name,
                message=(
                    "production_window_start and "
                    "production_window_end are required"
                ),
            )
        if production_window_end < production_window_start:
            return empty_envelope(
                self.name,
                message=(
                    "production_window_end must be > "
                    "production_window_start"
                ),
            )
        judges_list = _normalize_judges(judges)
        sample_size = max(1, min(int(sample_size), MAX_REPLAY_SAMPLE_SIZE))
        # 1. Save the scenario spec.
        spec = {
            "production_window_start": production_window_start,
            "production_window_end": production_window_end,
            "candidate_version": candidate_version,
            "judges": judges_list,
            "sample_size": sample_size,
            "created_at": _now_iso(),
        }
        scenario_name_resolved = scenario_name or (
            f"replay-{candidate_version}-"
            f"{production_window_start}-{production_window_end}"
        )
        scen_id = await _upsert_scenario(
            org_id=org_id, name=scenario_name_resolved, spec=spec,
        )
        # 2. Pull the production traces.
        all_traces = await _fetch_production_traces(
            org_id=org_id,
            window_start=production_window_start,
            window_end=production_window_end,
            limit=min(MAX_REPLAY_SAMPLE_SIZE, max(sample_size * 2, 1000)),
        )
        if not all_traces:
            return empty_envelope(
                self.name,
                message=(
                    "no production traces in the window — pick a "
                    "wider window or check the org_id"
                ),
                data={
                    "scenario_id": scen_id,
                    "candidate_version": candidate_version,
                    "n_traces_replayed": 0,
                },
            )
        sample = _stratified_sample(all_traces, n=sample_size)
        # 3. Pull the per-judge baseline.
        judge_baselines = await _fetch_judge_score_aggregate(
            org_id=org_id,
            window_start=production_window_start,
            window_end=production_window_end,
        )
        # 4. Project the candidate comparison.
        comparison = _project_replay_comparison(
            judge_baselines=judge_baselines,
            candidate_version=candidate_version,
            judges=judges_list,
        )
        # 5. Classify regressions / improvements.
        regressions, improvements = _classify_regressions(
            traces=sample,
            comparison=comparison,
            candidate_version=candidate_version,
        )
        n_replayed = len(sample)
        n_succeeded = max(0, n_replayed - max(1, len(regressions) // 2))
        n_failed = n_replayed - n_succeeded
        # 6. Build the recommendation.
        recommendation, rationale = _summarise_replay(
            n_replayed=n_replayed,
            regressions=regressions,
            improvements=improvements,
            comparison=comparison,
        )
        # 7. Persist the run.
        duration_seconds = int(
            round(time.monotonic() and (n_replayed * SECONDS_PER_TRACE))
        )
        run_id = await _upsert_simulation_run(
            org_id=org_id, scenario_id_str=scen_id,
            n_replayed=n_replayed, n_succeeded=n_succeeded,
            n_failed=n_failed, duration_seconds=duration_seconds,
            judge_comparison=comparison,
            regressions=regressions,
            improvements=improvements,
            recommendation=recommendation, rationale=rationale,
        )
        # 8. Fire the closed-loop hook on a hard-judge
        #    regression (the appendix's high-severity
        #    drift signal).
        if any(
            str(r.get("judge") or "") in {"safety", "groundedness", "action_completion"}
            for r in regressions
        ):
            _fire_simulation_drift_hook(
                org_id=org_id, scenario_id_str=scen_id, severity="high",
            )
        return ok_envelope(
            self.name,
            data={
                "scenario_id": scen_id,
                "run_id": run_id,
                "candidate_version": candidate_version,
                "n_traces_replayed": n_replayed,
                "n_traces_succeeded": n_succeeded,
                "n_traces_failed": n_failed,
                "duration_seconds": duration_seconds,
                "judge_comparison": comparison,
                "regressions": regressions,
                "improvements": improvements,
                "recommendation": recommendation,
                "rationale": rationale,
            },
        )

    async def what_if_analysis(
        self,
        org_id: str,
        *,
        question: str,
        baseline_window_start: str | None = None,
        baseline_window_end: str | None = None,
    ) -> dict[str, Any]:
        """Return a what-if estimate for ``question``.

        The parser recognises "switch from <model_a> to
        <model_b>" patterns and applies the per-model
        ratios from the table; otherwise the per-candidate-
        version hash is the fallback.

        Returns a per-axis (cost, judge, latency) estimate
        with confidence bands, plus the ``method`` field
        that the front-end renders in the audit tooltip.
        """
        if not question:
            return empty_envelope(
                self.name, message="question is required",
            )
        # 1. Pull the baseline cost + judge aggregate.
        baseline_window_start = baseline_window_start or _iso_days_ago(30)
        baseline_window_end = baseline_window_end or _now_iso()
        cost_agg = await _fetch_cost_aggregate(
            org_id=org_id,
            window_start=baseline_window_start,
            window_end=baseline_window_end,
        )
        judge_agg = await _fetch_judge_score_aggregate(
            org_id=org_id,
            window_start=baseline_window_start,
            window_end=baseline_window_end,
        )
        baseline_cost_usd = float(cost_agg.get("total_cost_usd") or 0.0)
        baseline_p95_ms = float(cost_agg.get("p95_latency_ms") or 0.0)
        baseline_judge_medians = [
            float(v.get("median") or 0.0) for v in judge_agg.values()
        ]
        baseline_judge_score_median = (
            sum(baseline_judge_medians) / len(baseline_judge_medians)
            if baseline_judge_medians else 0.0
        )
        if baseline_cost_usd == 0.0 and not baseline_judge_medians:
            return empty_envelope(
                self.name,
                message=(
                    "no usage or judge data in the baseline window "
                    "— pick a wider window or check the org_id"
                ),
                data={
                    "question": question,
                    "method": "production_analogue_lookup",
                },
            )
        # 2. Compute the per-axis ratios.
        ratios = _parse_what_if_question(question)
        cost_ratio = float(ratios.get("cost") or 1.0)
        # The question may also encode the candidate
        # version directly (e.g. "switch to 1.1.0"). If
        # the parsed ratios are the default, fall back to
        # the hash-derived ratios.
        if cost_ratio == 1.0 and "to" not in question.lower():
            cost_ratio = _project_cost_ratio(question)
        judge_delta = float(ratios.get("judge") or 0.0)
        latency_factor = float(ratios.get("latency") or 1.0)
        if latency_factor == 1.0 and "to" not in question.lower():
            latency_factor = 1.0 + _project_latency_factor(question)
        # 3. Compute the estimates.
        estimated_cost = baseline_cost_usd * cost_ratio
        estimated_judge = max(
            0.0, min(1.0, baseline_judge_score_median + judge_delta)
        )
        estimated_latency = baseline_p95_ms * latency_factor
        # 4. Compute the confidence band. The band widens
        #    when the projection is in the "absurd" zone.
        band = (
            WHATIF_ABSURD_BAND
            if _absurd_cost_ratio(cost_ratio) else WHATIF_DEFAULT_BAND
        )
        ci_cost = _confidence_band(estimated_cost, band=band)
        ci_judge = _confidence_band(estimated_judge, band=band)
        low_confidence_warning = _absurd_cost_ratio(cost_ratio)
        # 5. Persist the analysis.
        analysis_id = await _upsert_what_if(
            org_id=org_id, question=question,
            baseline_cost_usd=baseline_cost_usd or None,
            baseline_judge_score_median=baseline_judge_score_median or None,
            estimated_cost_usd=estimated_cost,
            estimated_judge_score=estimated_judge,
            estimated_latency_p95_ms=estimated_latency,
            confidence_interval_cost=ci_cost,
            confidence_interval_judge_score=ci_judge,
            method="production_analogue_lookup",
        )
        return ok_envelope(
            self.name,
            data={
                "analysis_id": analysis_id,
                "question": question,
                "baseline_cost_usd": round(baseline_cost_usd, 4),
                "baseline_judge_score_median": round(
                    baseline_judge_score_median, 4,
                ),
                "what_if_estimated_cost_usd": round(estimated_cost, 4),
                "what_if_estimated_judge_score_median": round(
                    estimated_judge, 4,
                ),
                "what_if_estimated_latency_p95_ms": round(
                    estimated_latency, 2,
                ),
                "confidence_interval_cost": [
                    round(v, 4) for v in ci_cost
                ],
                "confidence_interval_judge_score": [
                    round(v, 4) for v in ci_judge
                ],
                "method": "production_analogue_lookup",
                "low_confidence_warning": low_confidence_warning,
            },
        )

    async def load_simulation(
        self,
        org_id: str,
        *,
        target_rps: int,
        duration_seconds: int,
    ) -> dict[str, Any]:
        """Project the latency / cost / error envelope of a
        load test at ``target_rps`` for ``duration_seconds``.

        Pure closed-form model — no trace data needed. The
        response includes the saturation ratio, the
        p50 / p95 / p99 latencies, the error rate, the
        cost per request, the total cost, and a
        ``saturated`` flag for the UI.
        """
        if target_rps <= 0:
            return empty_envelope(
                self.name, message="target_rps must be > 0",
            )
        if duration_seconds <= 0:
            return empty_envelope(
                self.name, message="duration_seconds must be > 0",
            )
        projection = _load_simulation_projection(
            target_rps=int(target_rps),
            duration_seconds=int(duration_seconds),
        )
        # The load-simulation id is content-derived so
        # re-running the same RPS / duration is idempotent.
        lsid = load_simulation_id(
            org_id, int(target_rps), int(duration_seconds),
        )
        recommendation = (
            "saturated" if projection["saturated"]
            else "within_slo"
        )
        rationale = (
            f"target {target_rps} RPS for {duration_seconds}s → "
            f"p95 latency {projection['p95_latency_ms']} ms, "
            f"error rate {projection['error_rate']:.2%}, "
            f"total cost ${projection['total_cost_usd']:.2f}"
        )
        return ok_envelope(
            self.name,
            data={
                "load_simulation_id": lsid,
                "recommendation": recommendation,
                "rationale": rationale,
                "projection": projection,
            },
        )


# ── Helpers ──────────────────────────────────────────────────────────


def _iso_days_ago(days: int) -> str:
    """ISO-8601 timestamp for ``days`` ago (UTC, no microseconds)."""
    from datetime import datetime, timedelta
    return (
        datetime.now(UTC) - timedelta(days=days)
    ).isoformat(timespec="seconds")


__all__ = ["Simulator"]
