"""FEAT-13 prompt regression gate — scorer CI merge gate."""

from __future__ import annotations

import pytest

from eden.evaluation.prompt_regression_gate import (
    PromptRegressionGateResult,
    evaluate_scorer_cases,
    run_prompt_regression_gate,
)
from eden.evaluation.regression_builder import RegressionCase


def _case(
    case_id: str,
    *,
    expected_data: dict | None = None,
    input_data: dict | None = None,
    metadata: dict | None = None,
) -> RegressionCase:
    return RegressionCase(
        id=case_id,
        org_id="org-1",
        dataset_id="agent-regressions",
        source_issue_id=None,
        source_trace_id=None,
        fingerprint=None,
        auto_generated=False,
        input_data=input_data or {},
        expected_data=expected_data or {},
        metadata=metadata or {},
    )


def test_disabled_gate_is_noop() -> None:
    result = evaluate_scorer_cases(
        [_case("c1", expected_data={"scorers": [{"type": "exact_match"}], "expected": "a", "output": "a"})],
        global_specs=None,
    )
    assert result.ran is True
    assert result.ok is True


def test_exact_match_passes() -> None:
    cases = [
        _case(
            "c1",
            expected_data={
                "scorers": [{"type": "exact_match"}],
                "expected": "hello",
                "output": "hello",
            },
        )
    ]
    result = evaluate_scorer_cases(cases)
    assert result.ok is True
    assert result.passed == 1
    assert result.mean_score == pytest.approx(1.0)


def test_exact_match_fails_gate() -> None:
    cases = [
        _case(
            "c1",
            expected_data={
                "scorers": [{"type": "exact_match"}],
                "expected": "hello",
                "output": "world",
            },
        )
    ]
    result = evaluate_scorer_cases(cases)
    assert result.ok is False
    assert result.failed == 1
    assert result.reason == "deterministic_scorer_failed"


def test_global_scorer_specs_apply_to_all_cases() -> None:
    cases = [
        _case("c1", expected_data={"expected": "ok", "output": "ok"}),
        _case("c2", expected_data={"expected": "no", "output": "yes"}),
    ]
    result = evaluate_scorer_cases(
        cases, global_specs=[{"type": "exact_match"}]
    )
    assert result.passed == 1
    assert result.failed == 1
    assert result.ok is False


def test_treatment_outputs_override_case_output() -> None:
    cases = [
        _case(
            "c1",
            expected_data={
                "scorers": [{"type": "exact_match"}],
                "expected": "fixed",
                "output": "wrong",
            },
        )
    ]
    result = evaluate_scorer_cases(
        cases, treatment_outputs={"c1": "fixed"}
    )
    assert result.ok is True


def test_missing_output_is_error_fail_closed() -> None:
    cases = [
        _case(
            "c1",
            expected_data={
                "scorers": [{"type": "exact_match"}],
                "expected": "hello",
            },
        )
    ]
    result = evaluate_scorer_cases(cases)
    assert result.ok is False
    assert result.errors == 1


def test_baseline_regression_blocks() -> None:
    cases = [
        _case(
            "c1",
            expected_data={
                "scorers": [{"type": "levenshtein_ratio", "min_score": 0.5}],
                "expected": "hello world",
                "output": "hello worlx",
            },
        )
    ]
    baseline = {"scorer_gate": {"mean_score": 1.0}}
    result = evaluate_scorer_cases(
        cases,
        baseline_row=baseline,
        regression_threshold=0.05,
    )
    assert result.passed == 1
    assert result.baseline_regression is True
    assert result.ok is False
    assert "baseline_regression" in (result.reason or "")


def test_no_scorer_cases_skips_cleanly() -> None:
    cases = [_case("c1", expected_data={"no_stumble_kinds": ["loop"]})]
    result = evaluate_scorer_cases(cases)
    assert result.ran is False
    assert result.ok is True
    assert result.reason == "no_scorer_cases"


def test_to_dict_roundtrip_shape() -> None:
    result = PromptRegressionGateResult(
        enabled=True, ok=True, ran=True, passed=1, mean_score=0.95
    )
    data = result.to_dict()
    assert data["enabled"] is True
    assert data["mean_score"] == 0.95
    assert "cases" in data


@pytest.mark.asyncio
async def test_run_prompt_regression_gate_disabled() -> None:
    result = await run_prompt_regression_gate("org-1", enable=False)
    assert result.enabled is False
    assert result.ok is True
    assert result.ran is False


@pytest.mark.asyncio
async def test_run_prompt_regression_gate_with_memory_builder() -> None:
    from eden.evaluation.regression_builder import RegressionCaseBuilder

    builder = RegressionCaseBuilder(memory_only=True)
    builder._memory.append(
        _case(
            "mem-1",
            expected_data={
                "scorers": [{"type": "contains"}],
                "expected": "world",
                "output": "hello world",
            },
        )
    )
    result = await run_prompt_regression_gate(
        "org-1", enable=True, builder=builder
    )
    assert result.ran is True
    assert result.ok is True
    assert result.passed == 1
