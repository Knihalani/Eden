"""N01 case-creation flywheel — replay enrichment tests.

``_enrich_cases_for_replay`` stamps the failure signature (shared M7
extraction via ``build_failure_pack``) and checkpoint availability onto
freshly created regression cases. Best-effort by contract: any failure
leaves the case unenriched (post-hoc verification only), never raises.
"""

from __future__ import annotations

import json

import pytest

from eden.closed_loop.orchestrator import ClosedLoopOrchestrator
from eden.improvement.replay_verify import extract_failure_signature

ORG = "org-1"
ISSUE = "11111111-1111-1111-1111-111111111111"
CASE_ID = "22222222-2222-2222-2222-222222222222"
TRACE = "trc-1"

SIG = extract_failure_signature(
    {"kind": "tool_error", "error": "division by zero in checkout step 7"},
    {"name": "tool.checkout"},
)
assert SIG is not None


class _FakePg:
    def __init__(self):
        self.executed: list[tuple] = []

    async def execute(self, query, *args):
        self.executed.append((query, args))
        return "UPDATE 1"


def _patch(monkeypatch, *, pg, pack, cp_available):
    import eden.improvement.evidence_plane as ep
    import eden.improvement.replay_verify as rv
    import eden.storage.postgres as storage

    async def _fake_pack(org_id, issue_id):
        return pack

    async def _fake_cp(org_id, trace_id):
        return cp_available

    async def _fake_pg():
        return pg

    monkeypatch.setattr(ep, "build_failure_pack", _fake_pack)
    monkeypatch.setattr(rv, "checkpoint_available", _fake_cp)
    monkeypatch.setattr(storage, "get_postgres_client", _fake_pg)


@pytest.mark.asyncio
async def test_enrichment_writes_signature_and_checkpoint(monkeypatch) -> None:
    pg = _FakePg()
    _patch(
        monkeypatch,
        pg=pg,
        pack={"status": "ok", "failure_signature": SIG.to_json()},
        cp_available=True,
    )
    case = {
        "id": CASE_ID,
        "source_trace_id": TRACE,
        "expected": {"no_stumble_kinds": ["tool_error"]},
    }
    await ClosedLoopOrchestrator()._enrich_cases_for_replay(ORG, ISSUE, [case])

    assert len(pg.executed) == 1
    query, args = pg.executed[0]
    assert "dataset_items" in query
    assert "expected_output" in query
    assert args[0] == CASE_ID
    assert args[1] == ORG
    enrichment = json.loads(args[2])
    assert enrichment["failure_signature"] == SIG.to_json()
    assert enrichment["replay"] == {
        "checkpoint_available": True,
        "checkpoint_trace_id": TRACE,
    }
    # The in-memory dict is kept coherent too.
    assert case["expected"]["failure_signature"] == SIG.to_json()
    assert case["expected"]["replay"]["checkpoint_available"] is True


@pytest.mark.asyncio
async def test_enrichment_without_signature_still_records_checkpoint(
    monkeypatch,
) -> None:
    pg = _FakePg()
    _patch(
        monkeypatch,
        pg=pg,
        pack={"status": "ok", "failure_signature": None},
        cp_available=False,
    )
    case = {"id": CASE_ID, "source_trace_id": TRACE, "expected": {}}
    await ClosedLoopOrchestrator()._enrich_cases_for_replay(ORG, ISSUE, [case])

    enrichment = json.loads(pg.executed[0][1][2])
    assert "failure_signature" not in enrichment
    assert enrichment["replay"]["checkpoint_available"] is False


@pytest.mark.asyncio
async def test_enrichment_failure_is_swallowed(monkeypatch) -> None:
    import eden.improvement.evidence_plane as ep

    async def _boom(org_id, issue_id):
        raise RuntimeError("pack build failed")

    monkeypatch.setattr(ep, "build_failure_pack", _boom)
    # Must not raise — an unenriched case keeps post-hoc verification.
    await ClosedLoopOrchestrator()._enrich_cases_for_replay(
        ORG, ISSUE, [{"id": CASE_ID, "source_trace_id": TRACE, "expected": {}}]
    )


@pytest.mark.asyncio
async def test_enrichment_skips_cases_without_id(monkeypatch) -> None:
    pg = _FakePg()
    _patch(
        monkeypatch,
        pg=pg,
        pack={"status": "ok", "failure_signature": SIG.to_json()},
        cp_available=True,
    )
    await ClosedLoopOrchestrator()._enrich_cases_for_replay(
        ORG, ISSUE, [{"source_trace_id": TRACE, "expected": {}}]
    )
    assert pg.executed == []
