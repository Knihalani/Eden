"""D7 — regression memory list tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.evaluation.regression_builder import RegressionCase, RegressionCaseBuilder


@pytest.mark.asyncio
async def test_list_for_issue_from_memory() -> None:
    builder = RegressionCaseBuilder(pg=None)
    case = RegressionCase(
        id="case_1",
        org_id="org_1",
        dataset_id="agent/regressions",
        source_issue_id="iss_1",
        source_trace_id="trc_1",
        fingerprint="fp",
        auto_generated=True,
    )
    builder._memory.append(case)
    cases = await builder.list_for_issue("org_1", "iss_1")
    assert len(cases) == 1
    assert cases[0].id == "case_1"


@pytest.mark.asyncio
async def test_list_for_issue_empty() -> None:
    with patch.object(RegressionCaseBuilder, "_client", AsyncMock(return_value=None)):
        cases = await RegressionCaseBuilder().list_for_issue("org_1", "missing")
    assert cases == []
