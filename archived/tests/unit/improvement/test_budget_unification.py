"""M4 (D12) — one maintenance budget ledger, fail-closed reads.

The propose path used to read a *different* ledger (``cost_ledger``
feature sums) than the one ``record_spend`` wrote (Redis
``autonomy:spend:``), and swallowed budget-check errors as "ok". Triage
kept a third private counter that ``evaluate_mode`` never saw. Now:

* ``_budget_ok`` reads ``autonomy_policy.check_budget`` +
  ``patch_max_per_day`` and ANY error → ``(False, "budget_check_error")``.
* Triage LLM spend is metered via ``cost_context`` on the investigation
  path (OPT-17/OPT-19). ``TriageAgent._debit_budget`` only maintains the
  optional ``triage_spend:`` Redis counter — it does not write synthetic
  CostEvents.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement import issue_patch_trigger as ipt

ORG = "org-d12"


class FakeRedis:
    """Just enough redis for autonomy_policy spend + policy cache."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    async def get(self, key: str) -> str | None:
        return self.store.get(key)

    async def set(self, key: str, value: str, ex: int | None = None) -> bool:
        self.store[key] = value
        return True

    async def delete(self, key: str) -> int:
        return 1 if self.store.pop(key, None) is not None else 0

    def pipeline(self, transaction: bool = False) -> FakeRedis._Pipe:
        return FakeRedis._Pipe(self)

    class _Pipe:
        def __init__(self, outer: FakeRedis) -> None:
            self.outer = outer
            self.results: list[Any] = []

        def incrbyfloat(self, key: str, amount: float) -> None:
            new = float(self.outer.store.get(key) or 0.0) + float(amount)
            self.outer.store[key] = str(new)
            self.results.append(new)

        def expire(self, key: str, ttl: int) -> None:
            self.results.append(True)

        async def execute(self) -> list[Any]:
            out, self.results = self.results, []
            return out


@pytest.fixture
def fake_redis():
    r = FakeRedis()
    with patch(
        "eden.storage.redis.get_redis_client", AsyncMock(return_value=r)
    ):
        yield r


# ── _budget_ok reads the unified ledger and fails closed ────────────


@pytest.mark.asyncio
async def test_budget_ok_fails_closed_on_any_exception() -> None:
    with patch(
        "eden.closed_loop.autonomy_policy.check_budget",
        AsyncMock(side_effect=RuntimeError("redis exploded")),
    ):
        ok, reason = await ipt._budget_ok(ORG)
    assert ok is False
    assert reason == "budget_check_error"


@pytest.mark.asyncio
async def test_budget_ok_suppresses_when_ledger_exhausted() -> None:
    with patch(
        "eden.closed_loop.autonomy_policy.check_budget",
        AsyncMock(return_value=(False, 30.0, 25.0)),
    ):
        ok, reason = await ipt._budget_ok(ORG)
    assert ok is False
    assert reason.startswith("budget_exhausted:")


@pytest.mark.asyncio
async def test_budget_ok_enforces_patch_max_per_day() -> None:
    with (
        patch(
            "eden.closed_loop.autonomy_policy.check_budget",
            AsyncMock(return_value=(True, 1.0, 25.0)),
        ),
        patch.object(
            ipt.plans_repo,
            "count_code_patches_today",
            AsyncMock(return_value=10),
        ),
    ):
        ok, reason = await ipt._budget_ok(ORG)
    assert ok is False
    assert reason.startswith("patch_max_per_day:")


@pytest.mark.asyncio
async def test_budget_ok_no_longer_reads_cost_ledger() -> None:
    """The parallel ``sum_feature_spend_today`` read is deleted."""
    import inspect

    src = inspect.getsource(ipt._budget_ok)
    assert "sum_feature_spend_today" not in src
    assert "check_budget" in src


@pytest.mark.asyncio
async def test_propose_stamps_blocker_on_budget_check_error(monkeypatch) -> None:
    """budget_check_error → issue stamped via _stamp_patch_blocked."""
    stamped: list[dict[str, Any]] = []

    async def _stamp(org_id, issue_id, *, reason, message):
        stamped.append({"issue_id": issue_id, "reason": reason})

    class _Issue:
        stumble_count = 9
        severity = "high"
        title = "t"
        fingerprint = "fp"
        triage_result = {
            "confidence": 0.9,
            "recommended_action": "code_change",
        }

    monkeypatch.setattr(ipt, "_stamp_patch_blocked", _stamp)
    monkeypatch.setattr(
        ipt, "_improvement_enabled", AsyncMock(return_value=True)
    )
    monkeypatch.setattr(
        ipt,
        "_issue_context",
        AsyncMock(
            return_value={
                "issue": _Issue(),
                "agent_id": "a",
                "kind": "tool_error",
                "fingerprint": "fp",
                "triage": _Issue.triage_result,
                "rca_summary": "s",
            }
        ),
    )
    monkeypatch.setattr(
        ipt, "_n22_may_propose", AsyncMock(return_value=(True, "ok"))
    )
    monkeypatch.setattr(
        ipt, "_budget_ok", AsyncMock(return_value=(False, "budget_check_error"))
    )

    result = await ipt.propose_plan_for_issue(ORG, "iss-1")
    assert result["status"] == "suppressed"
    assert result["reason"] == "budget_check_error"
    assert stamped and stamped[0]["reason"] == "budget_check_error"


# ── one spend, one ledger ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_record_spend_visible_via_check_budget(fake_redis) -> None:
    from eden.closed_loop.autonomy_policy import check_budget, record_spend

    await record_spend(ORG, 5.0, feature="patches")
    ok, spent, limit = await check_budget(ORG)
    assert spent == pytest.approx(5.0)
    assert ok is True
    assert limit == pytest.approx(25.0)


@pytest.mark.asyncio
async def test_triage_debit_updates_triage_redis_only(fake_redis) -> None:
    """OPT-19: triage budget counter is separate from customer CostEvents."""
    from eden.issues.triage_agent import TriageAgent

    agent = TriageAgent()
    with patch(
        "eden.issues.triage_agent.TriageAgent._resolve_budget_cap",
        AsyncMock(return_value=10.0),
    ):
        await agent._debit_budget(ORG, 3.0)

    triage_keys = [k for k in fake_redis.store if k.startswith("triage_spend:")]
    assert triage_keys
    assert float(fake_redis.store[triage_keys[0]]) == pytest.approx(3.0)


@pytest.mark.asyncio
async def test_triage_debit_does_not_call_record_spend(fake_redis) -> None:
    from eden.issues.triage_agent import TriageAgent

    record = AsyncMock()
    with patch(
        "eden.closed_loop.autonomy_policy.record_spend",
        record,
    ), patch(
        "eden.issues.triage_agent.TriageAgent._resolve_budget_cap",
        AsyncMock(return_value=10.0),
    ):
        await TriageAgent()._debit_budget(ORG, 2.0)

    record.assert_not_awaited()


def test_budgeted_tiers_constant_deleted() -> None:
    from eden.closed_loop import autonomy_policy

    assert not hasattr(autonomy_policy, "_BUDGETED_TIERS")
