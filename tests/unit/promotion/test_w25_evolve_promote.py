"""Wave 25 — Evolution + promote flywheel (EvidenceGate non-optional).

Covers: canary assign; promote blocked under min_n; demote → Ledger DNR;
Bayesian honesty; warm-cache proof; N15 guardrail activate via gate.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from eden.agents.prompt_canary import pick_canary_version
from eden.promotion.evidence_gate import EvidenceGate, EvidenceReport


class _FakeRow(dict):
    def __init__(self, **kwargs: Any):
        super().__init__(**kwargs)
        for k, v in kwargs.items():
            setattr(self, k, v)

    def __getitem__(self, key: str) -> Any:
        return dict.__getitem__(self, key)


class _FakeClient:
    def __init__(self) -> None:
        self.candidates: dict[str, dict] = {}
        self.nudge_modes: dict[str, str] = {}
        self.executed: list[tuple[str, tuple]] = []

    async def execute(self, query: str, *args: Any) -> None:
        q = query.strip().lower()
        self.executed.append((q, args))
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
        elif "update promotion_candidates" in q and "demoted" in q:
            org_id, candidate_id = args[0], str(args[1])
            cand = self.candidates.get(candidate_id)
            if cand and str(cand["org_id"]) == str(org_id):
                cand["status"] = "demoted"
        elif "update promotion_candidates" in q and "evidence" in q:
            org_id, candidate_id, patch = args[0], str(args[1]), args[2]
            cand = self.candidates.get(candidate_id)
            if cand:
                import json

                extra = json.loads(patch) if isinstance(patch, str) else patch
                cand["evidence"] = {**(cand.get("evidence") or {}), **extra}
        elif "update nudges set mode" in q:
            self.nudge_modes[str(args[1])] = args[2]

    async def fetchrow(self, query: str, *args: Any) -> _FakeRow | None:
        q = query.strip().lower()
        if "from promotion_candidates" in q and "where org_id" in q:
            org_id, candidate_id = args[0], str(args[1])
            cand = self.candidates.get(candidate_id)
            if cand and str(cand["org_id"]) == str(org_id):
                return _FakeRow(**cand)
        if "update promotion_candidates" in q and "returning" in q:
            org_id, candidate_id = args[0], str(args[1])
            cand = self.candidates.get(candidate_id)
            if cand and str(cand["org_id"]) == str(org_id):
                cand["status"] = "demoted"
                return _FakeRow(kind=cand["kind"], ref_id=cand["ref_id"])
        if "from nudges" in q:
            return _FakeRow(agent_id="agent-1", name="fix-a", content="do x")
        return None

    async def fetchval(self, query: str, *args: Any) -> Any:
        q = query.strip().lower()
        if "agent_id from nudges" in q:
            return "agent-1"
        return None

    async def fetch(self, query: str, *args: Any) -> list[_FakeRow]:
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
def fake_pg(monkeypatch: pytest.MonkeyPatch) -> _FakeClient:
    client = _FakeClient()

    async def _get() -> _FakeClient:
        return client

    monkeypatch.setattr("eden.storage.postgres.get_postgres_client", _get)
    return client


# ── Canary assign ────────────────────────────────────────────────────


def test_canary_assign_respects_traffic_pct() -> None:
    assignments = [
        {"version": 2, "traffic_pct": 5, "status": "active"},
        {"version": 1, "traffic_pct": 95, "status": "active"},
    ]
    # Stable roll for a fixed minute — just assert we get a dict with version.
    chosen = pick_canary_version(assignments, "tenant-a", "agent-x")
    assert chosen is not None
    assert chosen["version"] in (1, 2)
    assert 0 <= float(chosen["traffic_pct"]) <= 100


# ── Promote blocked under min_n ──────────────────────────────────────


def test_promote_blocked_under_min_n(fake_pg: _FakeClient) -> None:
    gate = EvidenceGate()
    org_id = str(uuid4())
    cid = str(uuid4())
    fake_pg.candidates[cid] = {
        "id": cid,
        "org_id": org_id,
        "kind": "nudge",
        "ref_id": str(uuid4()),
        "status": "shadow",
        "evidence": {"control": [0.5] * 10, "treatment": [0.2] * 10},
    }

    report = asyncio.run(gate.promote_if_passed(org_id, cid))
    assert report.passed is False
    assert report.recommendation == "hold"
    assert "insufficient" in report.explanation.lower()
    assert fake_pg.candidates[cid]["status"] == "shadow"


def test_bayesian_respects_min_n(fake_pg: _FakeClient, monkeypatch: pytest.MonkeyPatch) -> None:
    gate = EvidenceGate()
    org_id = str(uuid4())
    cid = str(uuid4())
    # Strong treatment signal but under nudge min_n=50.
    fake_pg.candidates[cid] = {
        "id": cid,
        "org_id": org_id,
        "kind": "nudge",
        "ref_id": str(uuid4()),
        "status": "shadow",
        "evidence": {"control": [0.9] * 20, "treatment": [0.1] * 20},
    }

    monkeypatch.setattr(
        "eden.experiments._common._prob_treatment_better",
        lambda c, t: 0.99,
    )

    report = asyncio.run(gate.evaluate_bayesian(org_id, cid))
    assert report.passed is False
    assert report.recommendation == "hold"
    assert report.metrics.get("bayesian_respects_min_n") is True
    assert report.metrics.get("bayesian_advisory_only") is True
    assert report.metrics.get("prob_treatment_better") == pytest.approx(0.99)


# ── Demote path → Ledger DNR ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_demote_writes_ledger_dnr(fake_pg: _FakeClient) -> None:
    gate = EvidenceGate()
    org_id = str(uuid4())
    nudge_id = str(uuid4())
    cid = str(uuid4())
    fake_pg.candidates[cid] = {
        "id": cid,
        "org_id": org_id,
        "kind": "nudge",
        "ref_id": nudge_id,
        "status": "promoted",
        "evidence": {},
    }

    with patch(
        "eden.nudges.engine.NudgeEngine.set_mode",
        new=AsyncMock(return_value=True),
    ) as set_mode, patch(
        "eden.kb.ledger.generator.LedgerGenerator.upsert_do_not_repeat",
        new=AsyncMock(),
    ) as dnr:
        ok = await gate.demote(org_id, cid, reason="7d_regression")

    assert ok is True
    assert fake_pg.candidates[cid]["status"] == "demoted"
    set_mode.assert_awaited()
    dnr.assert_awaited()
    call_kwargs = dnr.await_args
    assert "7d_regression" in str(call_kwargs)


# ── Artifact demotion worker ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_demotion_worker_calls_gate_and_dnr() -> None:
    from eden.nudges.demotion_worker import ArtifactDemotionWorker

    row = {
        "id": uuid4(),
        "org_id": "org-1",
        "agent_id": "agent-1",
        "name": "bad-fix",
        "content": "x" * 20,
        "stumble_rate": 0.8,
        "first_applied": None,
    }
    client = MagicMock()
    client.fetch = AsyncMock(return_value=[row])

    gate = MagicMock()
    gate.list_queue = AsyncMock(
        return_value=[{"id": "cand-1", "ref_id": str(row["id"])}]
    )
    gate.demote = AsyncMock(return_value=True)

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=client),
    ), patch(
        "eden.promotion.evidence_gate.EvidenceGate",
        return_value=gate,
    ), patch(
        "eden.kb.ledger.generator.LedgerGenerator.upsert_do_not_repeat",
        new=AsyncMock(),
    ) as dnr, patch(
        "eden.nudges.cost_estimator.CostEstimator.estimate",
        return_value=MagicMock(value_score=0.0),
    ), patch(
        "eden.nudges.cost_estimator.CostEstimator.passes_value_floor",
        return_value=False,
    ):
        result = await ArtifactDemotionWorker().run_once()

    assert result["demoted"] == 1
    gate.demote.assert_awaited()
    dnr.assert_awaited()


# ── Warm cache proof ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_warm_learn_caches_returns_proof() -> None:
    from eden.llmops.warm_learn import warm_learn_caches

    with patch(
        "eden.preview.gates.warm_org_flags", new=AsyncMock()
    ), patch(
        "eden.nudges.engine.NudgeEngine.warm_cache", new=AsyncMock()
    ), patch(
        "eden.kb.ledger.retrieve.LedgerRetriever.pack_for_request",
        new=AsyncMock(),
    ):
        proof = await warm_learn_caches("org", "agent")
    assert proof == {"flags": True, "nudges": True, "ledger": True}


# ── N15 guardrail activate on EvidenceGate promote ───────────────────


@pytest.mark.asyncio
async def test_guardrail_promote_activates_block(fake_pg: _FakeClient) -> None:
    gate = EvidenceGate()
    org_id = str(uuid4())
    policy_id = str(uuid4())
    cid = str(uuid4())
    fake_pg.candidates[cid] = {
        "id": cid,
        "org_id": org_id,
        "kind": "guardrail",
        "ref_id": policy_id,
        "status": "shadow",
        "evidence": {
            "control": [0.8] * 100,
            "treatment": [0.2] * 100,
        },
    }

    filt = MagicMock()
    filt._policies = {org_id: [{"judge_id": policy_id, "enforcement_level": "log"}]}
    filt.load_policies = MagicMock()

    with patch.object(
        EvidenceGate,
        "evaluate",
        new=AsyncMock(
            return_value=EvidenceReport(
                candidate_id=uuid4(),
                passed=True,
                recommendation="promote",
            )
        ),
    ), patch(
        "eden.llmops.filters.guardrail.get_guardrail_filter",
        return_value=filt,
    ), patch(
        "eden.llmops.learn_wiring.install_learn_filters",
        return_value=None,
    ), patch(
        "eden.llmops.cost_ledger.record_cost_event",
        new=AsyncMock(return_value=True),
    ):
        report = await gate.promote_if_passed(org_id, cid)

    assert report.passed is True
    filt.load_policies.assert_called()
    loaded = filt.load_policies.call_args[0][1]
    assert any(p.get("enforcement_level") == "block" for p in loaded)


# ── Staging contract: draft → promote → inject ───────────────────────


def test_staging_flywheel_contract_surfaces() -> None:
    """Contract: artifact draft→EvidenceGate→gateway inject path exists."""
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    learn = (root / "src/eden/api/routes/learn.py").read_text()
    gate = (root / "src/eden/promotion/evidence_gate.py").read_text()
    nudge = (root / "src/eden/llmops/filters/nudge.py").read_text()
    wiring = (root / "src/eden/llmops/learn_wiring.py").read_text()

    assert "EvidenceGate().enqueue" in learn or "EvidenceGate()" in learn
    assert "promote_if_passed" in learn
    assert "warm_learn_caches" in gate
    assert "runtime_nudge" in wiring or "NudgeGatewayFilter" in nudge
    assert "install_learn_filters" in wiring
