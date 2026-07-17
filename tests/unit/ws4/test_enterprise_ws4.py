"""WS4 enterprise workstream unit tests (N05 + N06)."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest

from eden.closed_loop.playbooks import resolve_playbook
from eden.experiments.issue_link import IssueExperimentWizard
from eden.fleet.service import FleetHealthService, _delegation_trust_score
from eden.governance.compliance_pack import AgentAuditLedgerWriter


def test_playbook_router_maps_loop_to_nudge_shadow() -> None:
    assert resolve_playbook("loop", {}) == "nudge_shadow"


def test_playbook_respects_triage_suggested_heal() -> None:
    assert resolve_playbook("loop", {"suggested_heal": "rollback"}) == "rollback"


def test_delegation_trust_score_bounds() -> None:
    assert _delegation_trust_score(0.0, 100) == 0.99
    assert _delegation_trust_score(0.0, 10_000) == 0.8


@pytest.mark.asyncio
async def test_fleet_summary_empty_without_db() -> None:
    svc = FleetHealthService()
    with patch.object(svc, "_client", new=AsyncMock(return_value=None)):
        out = await svc.summary("org_test")
    assert out["agents"] == []
    assert out["count"] == 0


@pytest.mark.asyncio
async def test_fleet_sla_breaches_from_summary() -> None:
    svc = FleetHealthService()
    with patch.object(
        svc,
        "summary",
        new=AsyncMock(
            return_value={
                "agents": [
                    {"agent_id": "a1", "slo_breach": True},
                    {"agent_id": "a2", "slo_breach": False},
                ],
                "count": 2,
            }
        ),
    ):
        out = await svc.sla_breaches("org_test")
    assert out["count"] == 1
    assert out["breaches"][0]["agent_id"] == "a1"


@pytest.mark.asyncio
async def test_issue_experiment_create_no_db() -> None:
    wiz = IssueExperimentWizard()
    with patch.object(wiz, "_client", new=AsyncMock(return_value=None)):
        res = await wiz.create("org", "iss-1", control_variant="a", treatment_variant="b")
    assert res["status"] == "error"


@pytest.mark.asyncio
async def test_agent_audit_verify_chain_empty() -> None:
    writer = AgentAuditLedgerWriter()
    with patch.object(writer, "query", new=AsyncMock(return_value=[])):
        report = await writer.verify_chain("org_x")
    assert report["total_rows"] == 0
    assert report["verified"] is False


@pytest.mark.asyncio
async def test_agent_audit_verify_chain_valid() -> None:
    writer = AgentAuditLedgerWriter()
    payload = {"action": "heal"}
    created_at = datetime.now(UTC).isoformat()
    canonical = json.dumps(payload, sort_keys=True, default=str)
    entry_hash = hashlib.sha256(f":{canonical}:{created_at}".encode()).hexdigest()
    events = [
        {
            "id": "e1",
            "payload": payload,
            "created_at": created_at,
            "prev_hash": None,
            "entry_hash": entry_hash,
        }
    ]
    with patch.object(writer, "query", new=AsyncMock(return_value=events)):
        report = await writer.verify_chain("org_x")
    assert report["total_rows"] == 1
    assert report["ok_rows"] == 1
    assert report["verified"] is True


@pytest.mark.asyncio
async def test_agent_audit_verify_chain_detects_tamper() -> None:
    writer = AgentAuditLedgerWriter()
    events = [
        {
            "id": "e1",
            "payload": {"x": 1},
            "created_at": "2026-01-01T00:00:00+00:00",
            "prev_hash": None,
            "entry_hash": "deadbeef",
        }
    ]
    with patch.object(writer, "query", new=AsyncMock(return_value=events)):
        report = await writer.verify_chain("org_x")
    assert report["broken_rows"] == 1
    assert report["verified"] is False
