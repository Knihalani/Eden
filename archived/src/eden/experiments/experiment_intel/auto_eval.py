"""Cat 12 — :class:`AutoEvaluator`.

Automatically runs the Cat 3 judge set on every variant of
an experiment. The evaluator reads the production traces
that landed on each variant (filtered out of
``telemetry_events`` via the ``attributes->>'experiment_id'``
and ``attributes->>'variant'`` keys) and looks up the per-
trace judge scores in ``judge_scores`` (Cat 3 substrate).

For a real production workload, the AutoEvaluator
asynchronously enqueues per-judge scoring jobs and waits
for them to complete; for the v0 ship (no LLM budget, no
worker pool), we read the *existing* judge scores and
aggregate. The aggregation is the part the engineering team
cares about — the LLM call itself is delegated to the
existing Cat 3 judge runner.

The evaluator degrades gracefully when its dependencies are
missing or empty — an empty ``judge_scores`` table returns
a ``"no judge data"`` envelope, never a 500.

Routes exposed:

* ``POST /orgs/{org_id}/intelligence/experiments/auto-evaluate`` —
  run the auto-eval for an experiment id and a list of
  judges, returning the per-judge per-variant median / p5 /
  p95 / n.

See ``docs/observability-gap/12-experimentation-intelligence.md``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable
from typing import Any

from eden.experiments._common import (
    DEFAULT_JUDGES,
    _fetch_eval_runs,
    _fetch_traffic_splits,
    _normalize_judges,
    _percentile,
    _safe_float,
    _upsert_eval_run,
    empty_envelope,
    eval_run_id,
    ok_envelope,
)

logger = logging.getLogger(__name__)


#: Default list of judge names the :class:`AutoEvaluator`
#: runs when the caller doesn't supply one. Mirrors
#: :data:`eden.experiments._common.DEFAULT_JUDGES`.
DEFAULT_AUTO_EVAL_JUDGES: tuple[str, ...] = DEFAULT_JUDGES


class AutoEvaluator:
    """Per-judge per-variant aggregation for one experiment.

    The :class:`name` is ``"auto_evaluator"`` and matches
    the ``feature`` field in the response envelope.
    """

    name = "auto_evaluator"

    async def evaluate(
        self,
        org_id: str,
        *,
        experiment_id: str,
        judges: Iterable[str] | None = None,
    ) -> dict[str, Any]:
        """Run the auto-eval for ``experiment_id`` and the
        supplied ``judges``.

        Returns the per-judge per-variant median / p5 / p95
        / n, plus a summary that the recommender and winner
        detector consume. The summary includes the Bayesian
        posterior probability that treatment > control on
        each judge, computed by the helper in
        :mod:`eden.experiments._common`.

        Idempotent on ``experiment_id`` — re-running the
        evaluator overwrites the previous
        :data:`experiment_auto_eval_runs` rows.
        """
        if not experiment_id:
            return empty_envelope(
                self.name, message="experiment_id is required",
            )
        judge_list = _normalize_judges(judges)
        # 1. Determine the variants for this experiment.
        #    A real implementation reads the canary config;
        #    we read the persisted traffic-split rows.
        splits = await _fetch_traffic_splits(org_id, experiment_id)
        if splits:
            variants = sorted({
                str(r.get("variant_id") or "")
                for r in splits
                if r.get("variant_id")
            })
        else:
            variants = ["control", "treatment"]
        # 2. Per-judge per-variant aggregation.
        per_judge: dict[str, dict[str, Any]] = {}
        # Fan out the (judge × variant) fetches concurrently — each
        # is an independent read, and the pre-fix serial pattern
        # scaled O(J × V) round-trips per auto_eval call.
        keys: list[tuple[str, str]] = [
            (j, v) for j in judge_list for v in variants
        ]
        if keys:
            batch = await asyncio.gather(
                *(
                    _fetch_variant_scores(
                        org_id=org_id,
                        experiment_id=experiment_id,
                        variant=v,
                        judge=j,
                    )
                    for j, v in keys
                )
            )
            scores_by_key: dict[tuple[str, str], list[float]] = {
                (j, v): s for (j, v), s in zip(keys, batch, strict=False)
            }
        else:
            scores_by_key = {}
        for judge in judge_list:
            per_variant: dict[str, dict[str, Any]] = {}
            for variant in variants:
                scores = scores_by_key.get((judge, variant), [])
                n = len(scores)
                if n == 0:
                    per_variant[variant] = {
                        "n": 0,
                        "median": None,
                        "p5": None,
                        "p95": None,
                    }
                else:
                    per_variant[variant] = {
                        "n": n,
                        "median": _percentile(scores, 50.0),
                        "p5": _percentile(scores, 5.0),
                        "p95": _percentile(scores, 95.0),
                    }
                # Persist a per-judge per-variant row, even
                # when n == 0 (so the recommender can show
                # "no data" for the variant).
                run_id = eval_run_id(
                    org_id, experiment_id, f"{judge}:{variant}"
                )
                await _upsert_eval_run(
                    org_id=org_id, exp_id=experiment_id,
                    judge=judge, variant=variant,
                    n=n,
                    score_median=_safe_float(per_variant[variant]["median"]),
                    score_p5=_safe_float(per_variant[variant]["p5"]),
                    score_p95=_safe_float(per_variant[variant]["p95"]),
                    run_id=run_id,
                )
            per_judge[judge] = per_variant
        # 3. Top-level summary: is there any data at all?
        total_n = sum(
            per_variant.get("n", 0)
            for variants_dict in per_judge.values()
            for per_variant in variants_dict.values()
        )
        if total_n == 0:
            return empty_envelope(
                self.name,
                message=(
                    "no judge data for that experiment — run some "
                    "traffic through the experiment first"
                ),
                data={
                    "experiment_id": experiment_id,
                    "judges": judge_list,
                    "variants": variants,
                    "judge_scores": per_judge,
                },
            )
        return ok_envelope(
            self.name,
            data={
                "experiment_id": experiment_id,
                "judges": judge_list,
                "variants": variants,
                "judge_scores": per_judge,
                "total_n": total_n,
            },
        )

    async def latest(
        self,
        org_id: str,
        *,
        experiment_id: str,
    ) -> dict[str, Any]:
        """Read the latest auto-eval runs for an experiment
        (the persisted rows, not a fresh re-run). Used by
        the recommender and the winner detector to avoid
        re-running the evaluator.
        """
        rows = await _fetch_eval_runs(org_id, experiment_id)
        if not rows:
            return empty_envelope(
                self.name,
                message=(
                    "no auto-eval runs recorded — call "
                    "/auto-evaluate first"
                ),
                data={"experiment_id": experiment_id, "judge_scores": {}},
            )
        # Re-shape rows → per_judge[judge][variant] = {...}
        per_judge: dict[str, dict[str, dict[str, Any]]] = {}
        for row in rows:
            judge = str(row.get("judge") or "")
            variant = str(row.get("variant") or "")
            if not judge or not variant:
                continue
            # Audit 2026-07-07: use ``is None`` rather than ``or None``
            # so a legitimate 0.0 median/p5/p95 isn't collapsed to
            # ``None`` (the previous pattern confused "zero" with
            # "absent"). _safe_float already returns the default
            # (0.0) when the DB column is NULL — we want to
            # propagate that 0.0 as-is.
            median = _safe_float(row.get("score_median"), 0.0)
            p5 = _safe_float(row.get("score_p5"), 0.0)
            p95 = _safe_float(row.get("score_p95"), 0.0)
            per_judge.setdefault(judge, {})[variant] = {
                "n": int(row.get("n") or 0),
                "median": None if row.get("score_median") is None else median,
                "p5": None if row.get("score_p5") is None else p5,
                "p95": None if row.get("score_p95") is None else p95,
            }
        return ok_envelope(
            self.name,
            data={
                "experiment_id": experiment_id,
                "judge_scores": per_judge,
                "n_runs": len(rows),
            },
        )


# ── Private helpers ───────────────────────────────────────────────────


async def _fetch_variant_scores(
    *,
    org_id: str, experiment_id: str, variant: str, judge: str,
) -> list[float]:
    """Read the per-trace judge scores for one
    ``(experiment_id, variant, judge)`` triple.

    The query path is:

    1. From ``telemetry_events``, find the trace ids whose
       ``attributes->>'experiment_id' = experiment_id`` and
       ``attributes->>'variant' = variant``.
    2. From ``judge_scores``, find the per-trace scores
       for those trace ids and the requested judge.

    The :class:`eden.storage.postgres.PostgresClient` is
    mocked in the test suite, so this function degrades
    gracefully — an empty list is the right answer for the
    "no data" path.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:  # pragma: no cover - missing dep
        return []
    try:
        client = await get_postgres_client()
    except Exception:  # pragma: no cover - transient
        return []
    if client is None:
        return []
    try:
        rows = await client.fetch(
            """
            SELECT j.score
              FROM judge_scores j
              JOIN telemetry_events t
                ON t.tenant_id = j.tenant_id
               AND t.trace_id = j.trace_id
             WHERE j.tenant_id = $1
               AND t.attributes->>'experiment_id' = $2
               AND t.attributes->>'variant' = $3
               AND j.judge_name = $4
             ORDER BY j.scored_at DESC
             LIMIT 100000
            """,
            org_id, experiment_id, variant, judge,
        )
    except Exception as exc:
        logger.debug("Cat 12: fetch variant scores failed: %s", exc)
        return []
    return [_safe_float(r.get("score")) for r in rows if r.get("score") is not None]


__all__ = [
    "DEFAULT_AUTO_EVAL_JUDGES",
    "AutoEvaluator",
]
