"""FEAT-13 prompt regression gate — playground scorers in CI-eval.

Folded into ``POST /orgs/{org}/ci-eval/run`` via
:meth:`eden.evaluation.ci_webhook.CIWebhookHandler.on_prompt_change`.
When enabled, dataset regression cases that carry scorer specs are scored
with :func:`eden.playground.scorers.run_scorers` (no duplicate scorer logic).

Gate semantics (fail closed):

1. **Per-case deterministic pass** — every configured scorer must meet its
   ``min_score`` (default ``1.0`` for bool/0-1 scorers). A ``score`` of
   ``None``, ``0``, or ``False`` fails the case.
2. **Baseline regression** — when a prior run stored
   ``metadata.scorer_gate.mean_score``, the current mean aggregate score
   must not drop more than ``scorer_regression_threshold`` (default
   ``0.05``). No baseline → only rule (1) applies.

Cases are selected from the org's regression dataset items (same source as
``RegressionRunner``). Each case may define ``scorers`` in
``expected_data`` or ``metadata``; request-level ``scorer_specs`` apply as
a fallback. Treatment ``output`` text is resolved from the request
``treatment_outputs`` map (``case_id`` → text) or from
``expected_data.output`` / ``treatment_output`` on the case.

The overall CI ``ok`` / ``gate`` verdict is the AND of the trace-based
regression suite and this scorer gate when the scorer gate runs.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from eden.evaluation.regression_builder import RegressionCase, RegressionCaseBuilder
from eden.experiments.compare import grade_datapoint
from eden.playground.scorers import aggregate_score, run_scorers

logger = logging.getLogger(__name__)

_DEFAULT_REGRESSION_THRESHOLD = 0.05


def _scorer_gate_enabled(request_flag: bool) -> bool:
    if request_flag:
        return True
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "ci_eval_playground_scorers_v1", False))
    except Exception:
        return False


def _regression_threshold(override: float | None) -> float:
    if override is not None:
        return max(0.0, float(override))
    try:
        from eden.config import get_settings

        raw = getattr(get_settings(), "ci_eval_scorer_regression_threshold", None)
        if raw is not None:
            return max(0.0, float(raw))
    except Exception:
        pass
    return _DEFAULT_REGRESSION_THRESHOLD


def _case_scorer_specs(
    case: RegressionCase, global_specs: list[dict[str, Any]] | None
) -> list[dict[str, Any]]:
    expected = case.expected_data or {}
    meta = case.metadata or {}
    specs = expected.get("scorers") or meta.get("scorers") or global_specs or []
    return [s for s in specs if isinstance(s, dict)]


def _resolve_expected(case: RegressionCase) -> str | None:
    expected = case.expected_data or {}
    for key in ("expected", "expected_text", "expected_output"):
        val = expected.get(key)
        if val is None or isinstance(val, (dict, list)):
            continue
        text = str(val).strip()
        if text:
            return text
    return None


def _resolve_output(
    case: RegressionCase, treatment_outputs: dict[str, str] | None
) -> str | None:
    if treatment_outputs and case.id in treatment_outputs:
        return str(treatment_outputs[case.id])
    expected = case.expected_data or {}
    for key in ("output", "treatment_output", "actual_output"):
        val = expected.get(key)
        if val is not None:
            return str(val)
    inp = case.input_data or {}
    for key in ("output", "treatment_output"):
        val = inp.get(key)
        if val is not None:
            return str(val)
    return None


def _min_score_for(spec: dict[str, Any]) -> float:
    raw = spec.get("min_score")
    if raw is not None:
        try:
            return float(raw)
        except (TypeError, ValueError):
            pass
    stype = str(spec.get("type") or spec.get("name") or "")
    if stype == "levenshtein_ratio":
        return 0.0
    return 1.0


def _scorer_result_passes(spec: dict[str, Any], result: dict[str, Any]) -> bool:
    score = result.get("score")
    if score is None:
        return False
    minimum = _min_score_for(spec)
    if isinstance(score, bool):
        return score and minimum <= 1.0
    try:
        return float(score) >= minimum
    except (TypeError, ValueError):
        return False


def _evaluate_case(
    case: RegressionCase,
    *,
    global_specs: list[dict[str, Any]] | None,
    treatment_outputs: dict[str, str] | None,
) -> dict[str, Any]:
    specs = _case_scorer_specs(case, global_specs)
    output = _resolve_output(case, treatment_outputs)
    expected = _resolve_expected(case)
    entry: dict[str, Any] = {
        "case_id": case.id,
        "fingerprint": case.fingerprint,
        "status": "skipped",
        "reason": "no_scorers",
        "scores": [],
        "aggregate_score": None,
    }
    if not specs:
        return entry
    if output is None:
        entry["status"] = "error"
        entry["reason"] = "missing_output"
        return entry
    results = run_scorers(specs, output=output, expected=expected)
    entry["scores"] = results
    entry["aggregate_score"] = aggregate_score(results)
    for spec, result in zip(specs, results, strict=False):
        if not _scorer_result_passes(spec, result):
            entry["status"] = "failed"
            entry["reason"] = result.get("detail") or f"scorer {result.get('name')} failed"
            return entry
    if entry["aggregate_score"] is None:
        entry["status"] = "error"
        entry["reason"] = "unscored"
        return entry
    entry["status"] = "passed"
    entry["reason"] = "ok"
    return entry


def _mean_case_score(cases: list[dict[str, Any]]) -> float | None:
    vals = [
        float(c["aggregate_score"])
        for c in cases
        if c.get("status") == "passed" and c.get("aggregate_score") is not None
    ]
    if not vals:
        return None
    return sum(vals) / len(vals)


def _baseline_mean_score(baseline_row: dict[str, Any] | None) -> float | None:
    if not baseline_row:
        return None
    gate = baseline_row.get("scorer_gate") or {}
    raw = gate.get("mean_score")
    if raw is None:
        meta = baseline_row.get("metadata") or {}
        if isinstance(meta, dict):
            gate = meta.get("scorer_gate") or {}
            raw = gate.get("mean_score")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


@dataclass
class PromptRegressionGateResult:
    enabled: bool
    ok: bool
    ran: bool
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    errors: int = 0
    mean_score: float | None = None
    baseline_mean_score: float | None = None
    regression_threshold: float = _DEFAULT_REGRESSION_THRESHOLD
    baseline_regression: bool = False
    cases: list[dict[str, Any]] = field(default_factory=list)
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "ok": self.ok,
            "ran": self.ran,
            "passed": self.passed,
            "failed": self.failed,
            "skipped": self.skipped,
            "errors": self.errors,
            "mean_score": (
                round(self.mean_score, 4) if self.mean_score is not None else None
            ),
            "baseline_mean_score": (
                round(self.baseline_mean_score, 4)
                if self.baseline_mean_score is not None
                else None
            ),
            "regression_threshold": self.regression_threshold,
            "baseline_regression": self.baseline_regression,
            "cases": list(self.cases),
            "reason": self.reason,
        }


def evaluate_scorer_cases(
    cases: list[RegressionCase],
    *,
    global_specs: list[dict[str, Any]] | None = None,
    treatment_outputs: dict[str, str] | None = None,
    baseline_row: dict[str, Any] | None = None,
    regression_threshold: float | None = None,
) -> PromptRegressionGateResult:
    """Score regression cases and apply deterministic + baseline rules."""
    threshold = _regression_threshold(regression_threshold)
    evaluated: list[dict[str, Any]] = []
    for case in cases:
        specs = _case_scorer_specs(case, global_specs)
        if not specs and not global_specs:
            continue
        evaluated.append(
            _evaluate_case(
                case,
                global_specs=global_specs,
                treatment_outputs=treatment_outputs,
            )
        )

    if not evaluated:
        return PromptRegressionGateResult(
            enabled=True,
            ok=True,
            ran=False,
            reason="no_scorer_cases",
            regression_threshold=threshold,
        )

    counts = {"passed": 0, "failed": 0, "skipped": 0, "error": 0}
    for row in evaluated:
        status = str(row.get("status") or "error")
        key = status if status in counts else "error"
        counts[key] += 1

    mean_score = _mean_case_score(evaluated)
    baseline_mean = _baseline_mean_score(baseline_row)
    baseline_regression = False
    if (
        mean_score is not None
        and baseline_mean is not None
        and (baseline_mean - mean_score) > threshold
    ):
        baseline_regression = True

    ok = (
        counts["failed"] == 0
        and counts["error"] == 0
        and not baseline_regression
    )
    reason = None
    if baseline_regression:
        grade, delta = grade_datapoint(
            {"score": baseline_mean}, {"score": mean_score}
        )
        reason = f"baseline_regression ({grade}, delta={delta:+.4f})"
    elif counts["failed"] > 0:
        reason = "deterministic_scorer_failed"
    elif counts["error"] > 0:
        reason = "scorer_errors"

    return PromptRegressionGateResult(
        enabled=True,
        ok=ok,
        ran=True,
        passed=counts["passed"],
        failed=counts["failed"],
        skipped=counts["skipped"],
        errors=counts["error"],
        mean_score=mean_score,
        baseline_mean_score=baseline_mean,
        regression_threshold=threshold,
        baseline_regression=baseline_regression,
        cases=evaluated,
        reason=reason,
    )


async def run_prompt_regression_gate(
    org_id: str,
    *,
    agent_id: str | None = None,
    enable: bool = False,
    global_specs: list[dict[str, Any]] | None = None,
    treatment_outputs: dict[str, str] | None = None,
    baseline_row: dict[str, Any] | None = None,
    regression_threshold: float | None = None,
    builder: RegressionCaseBuilder | None = None,
) -> PromptRegressionGateResult:
    """Load regression cases and run the scorer gate when enabled."""
    if not _scorer_gate_enabled(enable):
        return PromptRegressionGateResult(
            enabled=False, ok=True, ran=False, reason="disabled"
        )
    case_builder = builder or RegressionCaseBuilder(memory_only=True)
    cases = await case_builder.list_cases(org_id, agent_id=agent_id, limit=100)
    return evaluate_scorer_cases(
        cases,
        global_specs=global_specs,
        treatment_outputs=treatment_outputs,
        baseline_row=baseline_row,
        regression_threshold=regression_threshold,
    )


__all__ = [
    "PromptRegressionGateResult",
    "evaluate_scorer_cases",
    "run_prompt_regression_gate",
]
