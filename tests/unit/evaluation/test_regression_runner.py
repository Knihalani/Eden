"""Unit tests for N01 regression runner."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from eden.evaluation.regression_builder import RegressionCase
from eden.evaluation.regression_runner import RegressionRunner


@pytest.mark.asyncio
async def test_run_suite_empty_passes() -> None:
    runner = RegressionRunner(memory_only=True)

    async def _empty(*args, **kwargs):
        return []

    runner._builder.list_cases = _empty  # type: ignore[method-assign]
    result = await runner.run_suite("org-1")
    assert result.ok
    assert result.failed == 0


@pytest.mark.asyncio
async def test_evaluate_case_no_constraints() -> None:
    runner = RegressionRunner(memory_only=True)
    case = RegressionCase(
        id="c1",
        org_id="org-1",
        dataset_id="ds",
        source_issue_id=None,
        source_trace_id=None,
        fingerprint=None,
        auto_generated=True,
        expected_data={},
    )
    ok, reason = await runner._evaluate_case(case)
    assert ok
    assert reason == "no constraints"


@pytest.mark.asyncio
async def test_canary_gate_skips_low_traffic() -> None:
    runner = RegressionRunner(memory_only=True)
    assert await runner.require_pass_for_canary("org-1", agent_id="a", traffic_pct=5) is None
