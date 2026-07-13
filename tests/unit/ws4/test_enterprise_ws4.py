"""WS4 enterprise workstream unit tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.closed_loop.playbooks import resolve_playbook
from eden.experiments.issue_link import IssueExperimentWizard
from eden.fleet.service import FleetHealthService


def test_playbook_router_maps_loop_to_cache_bust() -> None:
    assert resolve_playbook("loop", {}) == "cache_bust"


def test_playbook_respects_triage_suggested_heal() -> None:
    assert resolve_playbook("loop", {"suggested_heal": "rollback"}) == "rollback"


@pytest.mark.asyncio
async def test_fleet_summary_empty_without_db() -> None:
    svc = FleetHealthService()
    with patch.object(svc, "_client", new=AsyncMock(return_value=None)):
        out = await svc.summary("org_test")
    assert out["agents"] == []
    assert out["count"] == 0


@pytest.mark.asyncio
async def test_issue_experiment_create_no_db() -> None:
    wiz = IssueExperimentWizard()
    with patch.object(wiz, "_client", new=AsyncMock(return_value=None)):
        res = await wiz.create("org", "iss-1", control_variant="a", treatment_variant="b")
    assert res["status"] == "error"
