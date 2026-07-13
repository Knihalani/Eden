"""D1 — StatGate P0 rail tests."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.statgate_p0_rail import (
    apply_statgate_p0_rail,
    collect_issue_ids_from_scan,
)
from eden.issues.statgate_scorer import StatGateScore


def test_collect_issue_ids_from_scan() -> None:
    issue = SimpleNamespace(id="iss_1")
    rows = [{"issue": issue}, {"issue": None}, {"issue": SimpleNamespace(id="iss_1")}]
    assert collect_issue_ids_from_scan(rows) == {"iss_1"}


@pytest.mark.asyncio
async def test_apply_statgate_p0_rail_persists_triage() -> None:
    issue = SimpleNamespace(
        id="iss_1",
        org_id="org_1",
        fingerprint="fp1",
        kind="loop",
        severity="p1",
        title="loop",
        stumble_count=4,
        user_count=1,
        triage_result=None,
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.list_stumbles = AsyncMock(return_value=[{"kind": "statgate_p0", "detail": {}}])
    repo.set_triage_result = AsyncMock()

    score = StatGateScore(
        auto_escalate=True,
        p0=True,
        p0_checks=["statgate_p0"],
        suggested_heal="rollback",
    )

    with (
        patch("eden.issues.statgate_p0_rail.IssuesRepo", return_value=repo),
        patch(
            "eden.issues.statgate_p0_rail.StatGateIncidentScorer"
        ) as scorer_cls,
    ):
        scorer_cls.return_value.score.return_value = score
        escalated = await apply_statgate_p0_rail("org_1", {"iss_1"})

    assert escalated == ["iss_1"]
    repo.set_triage_result.assert_awaited_once()
    triage = repo.set_triage_result.await_args.args[2]
    assert triage["source"] == "statgate"
    assert triage["rail"] == "trace_finalized"
    assert triage["auto_escalate"] is True


@pytest.mark.asyncio
async def test_apply_statgate_p0_rail_skips_cached_statgate() -> None:
    issue = SimpleNamespace(
        id="iss_1",
        org_id="org_1",
        fingerprint="fp1",
        kind="loop",
        severity="p1",
        title="loop",
        stumble_count=1,
        user_count=1,
        triage_result={"source": "statgate"},
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.set_triage_result = AsyncMock()

    with patch("eden.issues.statgate_p0_rail.IssuesRepo", return_value=repo):
        escalated = await apply_statgate_p0_rail("org_1", {"iss_1"})

    assert escalated == []
    repo.set_triage_result.assert_not_awaited()
