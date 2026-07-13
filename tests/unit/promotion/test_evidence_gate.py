"""Unit tests for F41 EvidenceGate."""

from __future__ import annotations

import asyncio
from uuid import uuid4

import pytest

from eden.promotion.evidence_gate import EvidenceGate, EvidenceReport


class _FakeRow(dict):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)


class _FakeClient:
    def __init__(self):
        self.candidates: dict[str, dict] = {}
        self.nudge_modes: dict[str, str] = {}

    async def execute(self, query: str, *args):
        q = query.strip().lower()
        if "insert into promotion_candidates" in q:
            cid, org_id, kind, ref_id, status = args[:5]
            self.candidates[str(cid)] = {
                "id": cid,
                "org_id": org_id,
                "kind": kind,
                "ref_id": ref_id,
                "status": status,
                "evidence": {},
            }
        elif "update promotion_candidates" in q and "promoted" in q:
            org_id, candidate_id = args[0], str(args[1])
            cand = self.candidates.get(candidate_id)
            if cand and str(cand["org_id"]) == str(org_id):
                cand["status"] = "promoted"
        elif "update promotion_candidates" in q and "evidence" in q:
            org_id, candidate_id, patch = args[0], str(args[1]), args[2]
            cand = self.candidates.get(candidate_id)
            if cand:
                import json

                extra = json.loads(patch) if isinstance(patch, str) else patch
                cand["evidence"] = {**cand.get("evidence", {}), **extra}
        elif "update nudges set mode" in q:
            org_id, nudge_id, mode = args[0], str(args[1]), args[2]
            self.nudge_modes[nudge_id] = mode

    async def fetchrow(self, query: str, *args):
        q = query.strip().lower()
        if "from promotion_candidates" in q and "where org_id" in q:
            org_id, candidate_id = args[0], str(args[1])
            cand = self.candidates.get(candidate_id)
            if cand and str(cand["org_id"]) == str(org_id):
                return _FakeRow(**cand)
        if "update nudges" in q and "returning agent_id" in q:
            nudge_id = str(args[1])
            self.nudge_modes[nudge_id] = args[2]
            return _FakeRow(agent_id="agent-1")
        return None

    async def fetch(self, query: str, *args):
        q = query.strip().lower()
        if "from promotion_candidates" in q:
            org_id = args[0]
            status = args[1] if "status =" in q else None
            rows = [
                c for c in self.candidates.values() if str(c["org_id"]) == str(org_id)
            ]
            if status:
                rows = [c for c in rows if c["status"] == status]
            return [_FakeRow(**c) for c in rows]
        return []


@pytest.fixture
def fake_pg(monkeypatch):
    client = _FakeClient()

    async def _get():
        return client

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client",
        _get,
    )
    return client


def test_evidence_gate_hold_on_insufficient_samples(fake_pg):
    gate = EvidenceGate()
    org_id = str(uuid4())
    cid = str(uuid4())
    fake_pg.candidates[cid] = {
        "id": cid,
        "org_id": org_id,
        "kind": "nudge",
        "ref_id": str(uuid4()),
        "status": "shadow",
        "evidence": {"control": [0.5] * 5, "treatment": [0.4] * 5},
    }

    report = asyncio.run(gate.evaluate(org_id, cid))
    assert report.passed is False
    assert report.recommendation == "hold"
    assert "insufficient" in report.explanation.lower()


def test_evidence_gate_promote_with_improved_treatment(fake_pg, monkeypatch):
    gate = EvidenceGate()
    org_id = str(uuid4())
    nudge_id = str(uuid4())
    cid = str(uuid4())
    fake_pg.candidates[cid] = {
        "id": cid,
        "org_id": org_id,
        "kind": "nudge",
        "ref_id": nudge_id,
        "status": "shadow",
        "evidence": {
            "control": [0.8] * 35,
            "treatment": [0.3] * 35,
        },
    }

    async def _set_mode(org_id: str, nid: str, mode: str) -> bool:
        fake_pg.nudge_modes[nid] = mode
        return True

    monkeypatch.setattr(
        "eden.nudges.engine.NudgeEngine.set_mode",
        _set_mode,
    )

    report = asyncio.run(gate.promote_if_passed(org_id, cid))
    assert isinstance(report, EvidenceReport)
    if report.passed:
        assert fake_pg.candidates[cid]["status"] == "promoted"
        assert fake_pg.nudge_modes.get(nudge_id) == "promoted"


def test_evidence_gate_enqueue(fake_pg):
    gate = EvidenceGate()
    org_id = str(uuid4())

    cid = asyncio.run(gate.enqueue(org_id, kind="nudge", ref_id=str(uuid4())))
    assert cid is not None
    assert cid in fake_pg.candidates
