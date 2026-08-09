"""N01 CI webhook — run regression suite on prompt/config changes.

F56 productization: the returned payload is versioned (``response_version``)
and additive. It carries the tri-state breakdown (skipped/errors + per-case
reasons) from ``RegressionRunResult`` and a per-metric score table vs a
baseline run, reusing the compare grading in ``eden.experiments.compare``.

FEAT-13: when ``enable_playground_scorers`` is set (or the deployment flag
``ci_eval_playground_scorers_v1`` is on), dataset cases with scorer specs
are also evaluated via :mod:`eden.evaluation.prompt_regression_gate`, which
calls :func:`eden.playground.scorers.run_scorers`. The overall ``ok`` /
``gate`` verdict requires both the trace-based suite and the scorer gate
to pass.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.evaluation.ci_eval_history import CIEvalHistoryStore
from eden.evaluation.prompt_regression_gate import run_prompt_regression_gate
from eden.evaluation.regression_runner import RegressionRunner, _skip_policy
from eden.experiments.compare import build_case_grade_row, grade_datapoint

logger = logging.getLogger(__name__)

RESPONSE_VERSION = "v1"

# Metrics rendered in the score table. ``higher_is_better`` drives verdict
# direction so a rising fail_rate reads as a regression, not an improvement.
_METRICS: tuple[tuple[str, bool], ...] = (
    ("pass_rate", True),
    ("fail_rate", False),
    ("skip_rate", False),
    ("error_rate", False),
)


def _rates(counts: dict[str, Any]) -> dict[str, float]:
    total = int(counts.get("total") or 0)
    if total <= 0:
        return {"pass_rate": 0.0, "fail_rate": 0.0, "skip_rate": 0.0, "error_rate": 0.0}
    return {
        "pass_rate": float(counts.get("passed") or 0) / total,
        "fail_rate": float(counts.get("failed") or 0) / total,
        "skip_rate": float(counts.get("skipped") or 0) / total,
        "error_rate": float(counts.get("errors") or 0) / total,
    }


def _metric_row(
    name: str, baseline: float | None, current: float, higher_is_better: bool
) -> dict[str, Any]:
    if baseline is None:
        return {
            "metric": name,
            "baseline": None,
            "current": round(current, 4),
            "delta": None,
            "verdict": "new",
        }
    delta = round(current - baseline, 4)
    # Reuse the offline-compare grader (0.01 tie threshold + direction). For
    # lower-is-better metrics we swap control/treatment so "improvement"
    # still means "moved the right way".
    if higher_is_better:
        grade, _ = grade_datapoint({"score": baseline}, {"score": current})
    else:
        grade, _ = grade_datapoint({"score": current}, {"score": baseline})
    verdict = "improvement" if grade in ("improvement", "tradeoff") else grade
    return {
        "metric": name,
        "baseline": round(baseline, 4),
        "current": round(current, 4),
        "delta": delta,
        "verdict": verdict,
    }


def build_score_table(
    current_counts: dict[str, Any],
    baseline_counts: dict[str, Any] | None,
    *,
    f51_grades: list[dict[str, Any]] | None = None,
    baseline_f51_grades: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    cur = _rates(current_counts)
    base = _rates(baseline_counts) if baseline_counts else None
    rows = [
        _metric_row(name, base[name] if base else None, cur[name], hib)
        for name, hib in _METRICS
    ]
    if not f51_grades:
        return rows
    baseline_by_case = {
        str(row.get("case_id")): row for row in (baseline_f51_grades or [])
    }
    for grade in f51_grades:
        case_id = str(grade.get("case_id") or "")
        if not case_id:
            continue
        baseline_row = baseline_by_case.get(case_id)
        baseline_score = (
            baseline_row.get("current_score") if baseline_row else None
        )
        rows.append(
            build_case_grade_row(
                case_id,
                baseline_score=baseline_score,
                current_score=grade.get("current_score"),
                fingerprint=grade.get("fingerprint"),
                reason=grade.get("reason"),
            )
        )
    return rows


def render_summary_md(data: dict[str, Any]) -> str:
    """Compact markdown used as the check-run summary (and reusable in docs)."""
    summary = data["summary"]
    verdict = "pass" if summary["ok"] else "block"
    lines = [
        f"Regression gate: **{verdict}**",
        "",
        f"passed {summary['passed']} · failed {summary['failed']} · "
        f"skipped {summary['skipped']} · errors {summary['errors']} "
        f"(total {summary['total']})",
        "",
        "| metric | baseline | current | delta | verdict |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in data["score_table"]:
        b = "—" if row["baseline"] is None else f"{row['baseline']:.3f}"
        d = "—" if row["delta"] is None else f"{row['delta']:+.3f}"
        lines.append(
            f"| {row['metric']} | {b} | {row['current']:.3f} | {d} | {row['verdict']} |"
        )
    scorer = data.get("scorer_gate") or {}
    if scorer.get("ran"):
        lines.extend(
            [
                "",
                f"Scorer gate: **{'pass' if scorer.get('ok') else 'block'}** "
                f"(mean {scorer.get('mean_score', '—')} vs baseline "
                f"{scorer.get('baseline_mean_score', '—')})",
                f"passed {scorer.get('passed', 0)} · failed {scorer.get('failed', 0)} · "
                f"errors {scorer.get('errors', 0)}",
            ]
        )
    return "\n".join(lines)


class CIWebhookHandler:
    """Trigger regression eval when agent config files change (F56 / N01)."""

    def __init__(
        self,
        runner: RegressionRunner | None = None,
        history: CIEvalHistoryStore | None = None,
    ) -> None:
        self._runner = runner
        self._history = history

    async def on_prompt_change(
        self,
        org_id: str,
        *,
        changed_files: list[str],
        change_id: str,
        agent_id: str | None = None,
        baseline_experiment_id: str | None = None,
        ref: str | None = None,
        commit_sha: str | None = None,
        pr_number: int | None = None,
        enable_playground_scorers: bool = False,
        scorer_specs: list[dict[str, Any]] | None = None,
        treatment_outputs: dict[str, str] | None = None,
        scorer_regression_threshold: float | None = None,
    ) -> dict[str, Any]:
        runner = self._runner or RegressionRunner()
        history = self._history or CIEvalHistoryStore()

        result = await runner.run_suite(org_id, agent_id=agent_id, change_id=change_id)
        reg = result.to_dict()
        counts = {
            "passed": reg["passed"],
            "failed": reg["failed"],
            "skipped": reg["skipped"],
            "errors": reg["errors"],
            "total": reg["passed"] + reg["failed"] + reg["skipped"] + reg["errors"],
        }
        summary = {**counts, "ok": result.ok}

        baseline_row, baseline_source = await history.resolve_baseline(
            org_id,
            agent_id=agent_id,
            explicit_id=baseline_experiment_id,
            exclude_id=reg["id"],
        )
        baseline_counts = baseline_row.get("counts") if baseline_row else None
        baseline_f51 = (baseline_row or {}).get("f51_grades")
        score_table = build_score_table(
            counts,
            baseline_counts,
            f51_grades=reg.get("f51_grades"),
            baseline_f51_grades=baseline_f51,
        )

        scorer_gate = await run_prompt_regression_gate(
            org_id,
            agent_id=agent_id,
            enable=enable_playground_scorers,
            global_specs=scorer_specs,
            treatment_outputs=treatment_outputs,
            baseline_row=baseline_row,
            regression_threshold=scorer_regression_threshold,
        )
        scorer_gate_dict = scorer_gate.to_dict()
        gate_ok = result.ok and scorer_gate_dict["ok"]

        # Enrich persisted row with tri-state + CI context (base row was
        # written by the runner; we never touch its INSERT).
        await history.enrich(
            reg["id"],
            skipped=reg["skipped"],
            errors=reg["errors"],
            cases=reg["cases"],
            f51_grades=reg.get("f51_grades"),
            ref=ref,
            commit_sha=commit_sha,
            pr_number=pr_number,
            changed_files=changed_files,
            scorer_gate=scorer_gate_dict,
        )

        skip_cases = [
            {"case_id": c.get("case_id"), "reason": c.get("reason")}
            for c in reg["cases"]
            if c.get("status") == "skipped"
        ]
        error_cases = [
            {"case_id": c.get("case_id"), "reason": c.get("reason")}
            for c in reg["cases"]
            if c.get("status") == "error"
        ]

        data: dict[str, Any] = {
            "response_version": RESPONSE_VERSION,
            "change_id": change_id,
            "changed_files": changed_files,
            "ref": ref,
            "commit_sha": commit_sha,
            "pr_number": pr_number,
            "run_id": reg["id"],
            "ok": gate_ok,
            "gate": "pass" if gate_ok else "block",
            "regression": reg,
            "scorer_gate": scorer_gate_dict,
            "summary": {**summary, "ok": gate_ok},
            "score_table": score_table,
            "skips": {
                "count": reg["skipped"],
                "policy": _skip_policy(),
                "cases": skip_cases,
            },
            "errors_detail": error_cases,
            "baseline": {
                "run_id": baseline_row.get("id") if baseline_row else None,
                "source": baseline_source,
            },
            "commit_status": None,
            "runs_url": f"/orgs/{org_id}/ci-eval/runs",
        }
        return data


__all__ = [
    "CIWebhookHandler",
    "build_score_table",
    "render_summary_md",
    "RESPONSE_VERSION",
]
