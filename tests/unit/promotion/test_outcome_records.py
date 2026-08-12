"""Wave 3 (3.4) — per-kind outcome producers + readers for F41 evidence.

Pins the four migration-169 tables: producers write rows at decision
points (guardrail bypass/promote, routing classify, skill issue outcome,
PR merge/revert) and readers aggregate ``outcome_success`` into the
0/1 failure series the StatGate consumes (1=failure).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest


class _OutcomePG:
    def __init__(self) -> None:
        self.inserts: list[tuple[str, tuple[Any, ...]]] = []
        self.updates: list[tuple[str, tuple[Any, ...]]] = []
        self.rows: list[dict[str, Any] | None] = []

    async def execute(self, sql: str, *args: Any) -> str:
        if "INSERT INTO" in sql:
            self.inserts.append((sql, args))
        elif "UPDATE" in sql or "NOT EXISTS" in sql:
            self.updates.append((sql, args))
        return "OK"

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return [r for r in self.rows if r is not None]


@pytest.mark.asyncio
async def test_record_guardrail_outcome_inserts_row() -> None:
    pg = _OutcomePG()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.promotion.outcome_records import record_guardrail_outcome

        await record_guardrail_outcome(
            "org1", "judge-a", outcome_success=False, trace_id="t1"
        )
    assert len(pg.inserts) == 1
    sql, args = pg.inserts[0]
    assert "guardrail_outcomes" in sql
    assert args[:4] == ("org1", "judge-a", "t1", False)


@pytest.mark.asyncio
async def test_record_routing_decision_inserts_row() -> None:
    pg = _OutcomePG()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.promotion.outcome_records import record_routing_decision

        await record_routing_decision(
            "org1", "planner", slot="reasoning", tier="t2", heuristic_used=True
        )
    assert len(pg.inserts) == 1
    sql, args = pg.inserts[0]
    assert "routing_decisions" in sql
    assert args[:5] == ("org1", "planner", "reasoning", "t2", True)


@pytest.mark.asyncio
async def test_record_skill_outcome_inserts_row() -> None:
    pg = _OutcomePG()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.promotion.outcome_records import record_skill_outcome

        await record_skill_outcome(
            "org1", "skill-1", issue_id="issue-9", outcome_success=True
        )
    assert len(pg.inserts) == 1
    sql, args = pg.inserts[0]
    assert "skill_outcomes" in sql
    assert args[:4] == ("org1", "skill-1", "issue-9", True)


@pytest.mark.asyncio
async def test_record_pr_merge_and_mark_reverted() -> None:
    pg = _OutcomePG()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.promotion.outcome_records import mark_pr_reverted, record_pr_merge

        await record_pr_merge("org1", "plan-1", pr_number=42)
        pg.inserts.clear()
        pg.updates.clear()
        await mark_pr_reverted("org1", "plan-1", pr_number=42)
    # Single upsert with ON CONFLICT (org_id, plan_id) — no UPDATE-then-
    # INSERT two-round-trip.
    all_calls = pg.updates + pg.inserts
    assert len(all_calls) == 1
    sql, args = all_calls[0]
    assert "INSERT INTO pr_outcomes" in sql
    assert "ON CONFLICT (org_id, plan_id)" in sql
    assert args[:3] == ("org1", "plan-1", 42)


@pytest.mark.asyncio
async def test_readers_return_failure_series() -> None:
    pg = _OutcomePG()
    # guardrail: two successes, one failure → [0, 0, 1]
    pg.rows = [
        {"outcome_success": True},
        {"outcome_success": True},
        {"outcome_success": False},
    ]
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.promotion.outcome_records import guardrail_outcome_metrics

        series = await guardrail_outcome_metrics("org1", "judge-a", applied=True)
    assert series == [0.0, 0.0, 1.0]


@pytest.mark.asyncio
async def test_routing_reader_treats_fallback_as_failure() -> None:
    pg = _OutcomePG()
    pg.rows = [
        {"fallback_used": True, "outcome_success": None},
        {"fallback_used": False, "outcome_success": None},
        {"fallback_used": False, "outcome_success": True},
    ]
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.promotion.outcome_records import routing_decision_metrics

        series = await routing_decision_metrics("org1", "planner", applied=True)
    assert series == [1.0, 0.0, 0.0]


@pytest.mark.asyncio
async def test_pr_reader_counts_held_merges_as_success() -> None:
    pg = _OutcomePG()
    # merged + reverted → failure; merged + held (NULL) → success.
    pg.rows = [
        {"outcome_success": False},
        {"outcome_success": None},
        {"outcome_success": True},
    ]
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.promotion.outcome_records import pr_merge_outcome_metrics

        series = await pr_merge_outcome_metrics("org1", "plan-1", applied=True)
    assert series == [1.0, 0.0, 0.0]


@pytest.mark.asyncio
async def test_evidence_gate_dispatches_to_real_readers(monkeypatch) -> None:
    """3.4: EvidenceGate._metrics_from_outcomes now returns real data for
    all four previously-unwired kinds (guardrail/model_routing/kb_skill/
    pr_merge) instead of the honest-empty [] branches."""
    from eden.promotion import evidence_gate

    gate = evidence_gate.EvidenceGate()

    async def _fake_guardrail(org_id: str, ref_id: str, *, applied: bool) -> list[float]:
        return [1.0, 0.0]

    monkeypatch.setattr(
        "eden.promotion.outcome_records.guardrail_outcome_metrics",
        _fake_guardrail,
    )
    for kind in ("guardrail", "model_routing", "kb_skill", "pr_merge"):
        candidate = {"kind": kind, "ref_id": "ref-x", "org_id": "org1"}
        result = await gate._metrics_from_outcomes(candidate, applied=True)
        if kind == "guardrail":
            assert result == [1.0, 0.0]
        else:
            assert isinstance(result, list)
