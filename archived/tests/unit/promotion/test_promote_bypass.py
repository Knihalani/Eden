"""Promote must not bypass EvidenceGate."""

import pytest

from eden.promotion.evidence_gate import EvidenceGate


@pytest.mark.asyncio
async def test_promote_requires_evaluation(monkeypatch):
    gate = EvidenceGate()
    calls: list[str] = []

    async def fake_evaluate(org_id, candidate_id):
        calls.append("evaluate")
        from uuid import UUID

        from eden.promotion.evidence_gate import EvidenceReport

        return EvidenceReport(
            candidate_id=UUID(candidate_id),
            passed=False,
            recommendation="hold",
            explanation="insufficient samples",
        )

    monkeypatch.setattr(gate, "evaluate", fake_evaluate)
    monkeypatch.setattr(
        gate,
        "get_candidate",
        lambda org_id, cid: {"id": cid, "kind": "nudge", "ref_id": "n1", "org_id": org_id},
    )
    report = await gate.promote_if_passed("org", "00000000-0000-0000-0000-000000000001")
    assert not report.passed
    assert "evaluate" in calls
