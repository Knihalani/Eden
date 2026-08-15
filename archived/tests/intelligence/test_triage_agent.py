"""F30 / N08 — StatGate scorer + TriageAgent (Wave 1 anti-spam)."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.models import Issue
from eden.issues.statgate_scorer import StatGateIncidentScorer


def _issue(**over: Any) -> Issue:
    base: dict[str, Any] = {
        "id": "iss-1",
        "org_id": "org_test",
        "fingerprint": "fp1",
        "kind": "tool_error",
        "title": "tool failed",
        "status": "open",
        "severity": "p1",
        "stumble_count": 2,
        "user_count": 1,
    }
    base.update(over)
    return Issue(**base)  # type: ignore[arg-type]


# ── StatGateIncidentScorer ──────────────────────────────────────────


def test_scorer_flags_etec_loop_p0() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "loop", "severity": "p2", "stumble_count": 2},
        [{"kind": "loop", "detail": {"repeat_count": 5}}],
    )
    assert s.auto_escalate is True
    assert "etec_loop" in s.p0_checks


def test_scorer_flags_statgate_p0_stumble() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "tool_error", "severity": "p1", "stumble_count": 1},
        [{"kind": "statgate_p0", "detail": {}}],
    )
    assert s.auto_escalate is True
    assert "statgate_p0" in s.p0_checks
    assert s.suggested_heal == "rollback"


def test_scorer_flags_cost_spike() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "tool_error", "severity": "p2", "stumble_count": 1},
        [{"kind": "tool_error", "detail": {"cost_z_score": 4.1}}],
    )
    assert "cost_spike" in s.p0_checks
    assert s.suggested_heal == "reweight"


def test_scorer_no_p0_for_benign_issue() -> None:
    s = StatGateIncidentScorer().score(
        {"kind": "tool_error", "severity": "p2", "stumble_count": 1},
        [{"kind": "tool_error", "detail": {"error": "boom"}}],
    )
    assert s.auto_escalate is False
    assert s.p0_checks == []


# ── TriageAgent ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_triage_statgate_first_no_llm() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="loop", severity="p1", stumble_count=6)
    )
    repo.list_stumbles = AsyncMock(
        return_value=[
            {
                "kind": "loop",
                "detail": {"repeat_count": 6},
                "span_id": "s1",
                "trace_id": "trace-loop-1",
            }
        ]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    agent = TriageAgent(repo=repo)
    with patch("eden.autonomous.InvestigationAgent") as inv_cls:
        res = await agent.triage("org_test", "iss-1")
        inv_cls.assert_not_called()

    tr = res["data"]["triage_result"]
    assert tr["source"] == "statgate"
    assert tr["auto_escalate"] is True
    assert tr["fingerprint"] == "fp1"
    assert tr["debugger_trace_id"] == "trace-loop-1"
    action_types = {a["type"] for a in tr["suggested_actions"]}
    assert "debugger_rerun" in action_types
    assert action_types & {
        "rollback",
        "reweight",
        "cache_bust",
        "propose_patch",
        "escalate",
    }
    repo.set_triage_result.assert_awaited_once()


@pytest.mark.asyncio
async def test_triage_falls_back_to_llm() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            kind="tool_error", severity="p2", stumble_count=1, agent_id="agent-1"
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[
            {
                "kind": "tool_error",
                "detail": {"error": "boom", "file_path": "src/api.py"},
                "span_id": "s9",
            }
        ]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    inv_result = {
        "status": "ok",
        "data": {
            "investigation_id": "inv-1",
            "findings": [{"summary": "API key expired", "confidence": 0.8}],
            "proposed_remediations": [
                {"action": "propose_patch", "summary": "patch the retry path"}
            ],
            "llm_used": True,
        },
    }
    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(return_value=inv_result)

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.issues.triage_agent.TriageAgent._debit_budget", AsyncMock()
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        res = await agent.triage("org_test", "iss-1")

    tr = res["data"]["triage_result"]
    assert tr["source"] == "llm"
    assert tr["source"] != "llm_error"
    assert tr["root_cause"] == "API key expired"
    assert tr["confidence"] == 0.8
    assert tr["suggested_actions"][0]["type"] == "propose_patch"
    assert tr["linked_files"] == ["src/api.py"]
    assert tr["evidence_span_ids"] == ["s9"]
    inv_instance.investigate.assert_awaited_once()
    _a, kwargs = inv_instance.investigate.call_args
    assert kwargs["trigger"] == "issue:iss-1"


@pytest.mark.asyncio
async def test_triage_llm_path_does_not_record_synthetic_spend() -> None:
    """OPT-19: no flat $0.02 CostEvent after LLM triage."""
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="tool_error", severity="p2", stumble_count=1)
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(
        return_value={
            "status": "ok",
            "data": {
                "findings": [{"summary": "x", "confidence": 0.5}],
                "proposed_remediations": [],
                "llm_used": True,
            },
        }
    )
    record_spend = AsyncMock()

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.closed_loop.autonomy_policy.record_spend", record_spend
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        await agent.triage("org_test", "iss-1")

    record_spend.assert_not_awaited()


@pytest.mark.asyncio
async def test_triage_budget_exceeded_skips_llm() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="tool_error", severity="p2", stumble_count=1)
    )
    repo.list_stumbles = AsyncMock(return_value=[{"kind": "tool_error", "detail": {}}])
    repo.set_triage_result = AsyncMock(return_value=True)

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=False)
    ), patch("eden.autonomous.InvestigationAgent") as inv_cls:
        res = await agent.triage("org_test", "iss-1")
        inv_cls.assert_not_called()

    assert res["status"] == "budget_exceeded"
    assert res["data"]["triage_result"]["source"] == "budget_exceeded"


@pytest.mark.asyncio
async def test_triage_returns_cached_unless_forced() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            severity="p2",
            triage_result={
                "source": "llm",
                "root_cause": "x",
                "auto_escalate": False,
                "severity_at_triage": "p2",
            },
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}}]
    )
    agent = TriageAgent(repo=repo)
    res = await agent.triage("org_test", "iss-1")
    assert res["data"]["cached"] is True
    repo.list_stumbles.assert_awaited()


@pytest.mark.asyncio
async def test_triage_active_work_suppresses() -> None:
    from eden.issues.triage_agent import TriageAgent

    prior = {"source": "llm", "root_cause": "cached-rc"}
    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(status="fix_pending", triage_result=prior)
    )
    agent = TriageAgent(repo=repo)
    with patch("eden.autonomous.InvestigationAgent") as inv_cls:
        res = await agent.triage("org_test", "iss-1")
        inv_cls.assert_not_called()

    assert res["data"]["suppressed"] == "active_work"
    assert res["data"]["cached"] is True
    assert res["data"]["triage_result"] == prior


@pytest.mark.asyncio
async def test_triage_force_overrides_active_work() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            status="verifying",
            kind="loop",
            severity="p1",
            stumble_count=6,
            triage_result={"source": "llm"},
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "loop", "detail": {"repeat_count": 6}}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    agent = TriageAgent(repo=repo)
    res = await agent.triage("org_test", "iss-1", force=True)
    assert res["data"].get("suppressed") is None
    assert res["data"]["triage_result"]["source"] == "statgate"


@pytest.mark.asyncio
async def test_triage_severity_escalate_reruns() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            severity="p0",
            kind="tool_error",
            stumble_count=1,
            triage_result={
                "source": "llm",
                "root_cause": "old",
                "auto_escalate": False,
                "severity_at_triage": "p2",
            },
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    agent = TriageAgent(repo=repo)
    with patch("eden.autonomous.InvestigationAgent") as inv_cls:
        res = await agent.triage("org_test", "iss-1")
        # p0 severity → StatGate path, no LLM
        inv_cls.assert_not_called()

    assert res["data"].get("cached") is not True
    assert res["data"]["triage_result"]["source"] == "statgate"
    assert res["data"]["triage_result"]["auto_escalate"] is True
    repo.set_triage_result.assert_awaited_once()


@pytest.mark.asyncio
async def test_triage_statgate_new_p0_invalidates_cache() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            severity="p2",
            triage_result={
                "source": "llm",
                "root_cause": "old",
                "auto_escalate": False,
                "severity_at_triage": "p2",
            },
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "statgate_p0", "detail": {}}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    agent = TriageAgent(repo=repo)
    res = await agent.triage("org_test", "iss-1")
    assert res["data"].get("cached") is not True
    assert res["data"]["triage_result"]["source"] == "statgate"
    assert res["data"]["triage_result"]["suggested_actions"][0]["type"] == "rollback"


@pytest.mark.asyncio
async def test_budget_unlimited_when_no_cap() -> None:
    from eden.issues.triage_agent import TriageAgent

    agent = TriageAgent(repo=MagicMock())
    with patch(
        "eden.issues.triage_agent.TriageAgent._resolve_budget_cap",
        AsyncMock(return_value=None),
    ):
        assert await agent._budget_ok("org_test") is True


@pytest.mark.asyncio
async def test_budget_capped_when_org_sets_cap() -> None:
    from eden.issues.triage_agent import TriageAgent

    agent = TriageAgent(repo=MagicMock())
    redis = AsyncMock()
    redis.get = AsyncMock(return_value="10.0")

    with patch(
        "eden.issues.triage_agent.TriageAgent._resolve_budget_cap",
        AsyncMock(return_value=5.0),
    ), patch(
        "eden.storage.redis.get_redis_client", AsyncMock(return_value=redis)
    ):
        assert await agent._budget_ok("org_test") is False


@pytest.mark.asyncio
async def test_resolve_budget_cap_prefers_org_policy_null() -> None:
    from eden.issues.triage_agent import TriageAgent

    agent = TriageAgent(repo=MagicMock())
    with patch(
        "eden.patches.policy.get_org_code_change_policy",
        AsyncMock(return_value={"max_triage_cost_usd_per_day": None}),
    ):
        assert await agent._resolve_budget_cap("org_test") is None


@pytest.mark.asyncio
async def test_resolve_budget_cap_uses_org_positive() -> None:
    from eden.issues.triage_agent import TriageAgent

    agent = TriageAgent(repo=MagicMock())
    with patch(
        "eden.patches.policy.get_org_code_change_policy",
        AsyncMock(return_value={"max_triage_cost_usd_per_day": 12.5}),
    ):
        assert await agent._resolve_budget_cap("org_test") == 12.5


@pytest.mark.asyncio
async def test_map_remediations_normalizes_to_f46_types() -> None:
    from eden.issues.triage_agent import _map_remediations

    mapped = _map_remediations(
        [
            {"action": "patch", "summary": "a"},
            {"action": "rotate_key", "summary": "b"},
            {"action_type": "reweight", "summary": "c"},
        ]
    )
    types = [a["type"] for a in mapped]
    assert types == ["propose_patch", "escalate", "reweight"]
    assert all(a["type"] == a["action_type"] for a in mapped)


@pytest.mark.asyncio
async def test_triage_llm_timeout_returns_partial() -> None:
    """F30 AC: LLM investigation exceeding 90s → partial source=timeout."""
    import asyncio

    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="tool_error", severity="p2", stumble_count=1)
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}, "span_id": "sp1"}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    async def _never(*a: Any, **k: Any) -> Any:
        await asyncio.sleep(3600)

    inv_instance = MagicMock()
    inv_instance.investigate = _never

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.issues.triage_agent._LLM_TIMEOUT_S", 0.05
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        res = await agent.triage("org_test", "iss-1")

    assert res["status"] == "timeout"
    tr = res["data"]["triage_result"]
    assert tr["source"] == "timeout"
    assert tr["evidence_span_ids"] == ["sp1"]
    repo.set_triage_result.assert_awaited_once()


@pytest.mark.asyncio
async def test_manual_triage_rate_limited() -> None:
    """F30 AC: >10 manual triages/hr/org → rate_limited."""
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(triage_result={"source": "llm"})
    )
    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._manual_rate_ok",
        AsyncMock(return_value=False),
    ):
        res = await agent.triage("org_test", "iss-1", force=True)
    assert res["status"] == "rate_limited"
    assert res["data"]["rate_limited"] is True


@pytest.mark.asyncio
async def test_manual_rate_limit_counter() -> None:
    from eden.issues.triage_agent import _MANUAL_TRIAGE_PER_HOUR, TriageAgent

    counter = {"n": 0}

    class _Pipe:
        def __init__(self, redis: _R) -> None:
            self._redis = redis
            self._ops: list[tuple[str, tuple]] = []

        def incr(self, key: str) -> _Pipe:
            self._ops.append(("incr", (key,)))
            return self

        def expire(self, key: str, ttl: int) -> _Pipe:
            self._ops.append(("expire", (key, ttl)))
            return self

        async def execute(self) -> list:
            out: list = []
            for op, args in self._ops:
                if op == "incr":
                    out.append(await self._redis.incr(args[0]))
                elif op == "expire":
                    await self._redis.expire(args[0], args[1])
                    out.append(True)
            return out

    class _R:
        async def incr(self, key: str) -> int:
            counter["n"] += 1
            return counter["n"]

        async def expire(self, key: str, ttl: int) -> None:
            return None

        def pipeline(self, transaction: bool = False) -> _Pipe:
            return _Pipe(self)

    agent = TriageAgent(repo=MagicMock())
    with patch("eden.storage.redis.get_redis_client", AsyncMock(return_value=_R())):
        oks = [await agent._manual_rate_ok("org") for _ in range(_MANUAL_TRIAGE_PER_HOUR + 2)]
    assert oks[:_MANUAL_TRIAGE_PER_HOUR] == [True] * _MANUAL_TRIAGE_PER_HOUR
    assert oks[_MANUAL_TRIAGE_PER_HOUR:] == [False, False]


def test_mcp_handoff_action_types_allowed() -> None:
    from eden.issues.triage_agent import _map_remediations

    mapped = _map_remediations(
        [
            {"action": "prompt", "summary": "tune the system prompt"},
            {"action": "nudge", "summary": "add a runtime nudge"},
            {"action": "handoff", "summary": "hand off to Cursor"},
        ]
    )
    assert [a["type"] for a in mapped] == ["prompt_fix", "nudge", "mcp_handoff"]


@pytest.mark.asyncio
async def test_triage_not_found() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=None)
    agent = TriageAgent(repo=repo)
    res = await agent.triage("org_test", "missing")
    assert res["status"] == "not_found"


@pytest.mark.asyncio
async def test_f46_issue_created_never_passes_force() -> None:
    """F46 auto-triage must not bypass cache/suppress with force=True."""
    from eden.closed_loop.events import EventType, LoopEvent
    from eden.closed_loop.orchestrator import ClosedLoopOrchestrator

    orch = ClosedLoopOrchestrator()
    orch.emit = AsyncMock()  # type: ignore[method-assign]

    triage = MagicMock()
    triage.triage = AsyncMock(
        return_value={"data": {"triage_result": {"source": "cached"}}}
    )

    with patch(
        "eden.issues.triage_agent.TriageAgent", return_value=triage
    ), patch(
        "eden.closed_loop.orchestrator.apply_transition", new=AsyncMock()
    ), patch.object(ClosedLoopOrchestrator, "_maybe_alert", new=AsyncMock()):
        await orch.on_event(
            LoopEvent(
                type=EventType.ISSUE_CREATED,
                org_id="org_test",
                issue_id="iss-1",
                ref="fp",
            )
        )

    triage.triage.assert_awaited_once_with("org_test", "iss-1")
    # Positional-only call — no force kwarg.
    assert triage.triage.call_args.kwargs.get("force") in (None, False)


# ── FEAT-144: Ledger integration ────────────────────────────────────


@pytest.mark.asyncio
async def test_triage_fetches_ledger_before_evidence() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            kind="tool_error", severity="p2", stumble_count=1, agent_id="agent-42"
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}, "span_id": "s1"}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    ledger_data = {
        "ledger_id": "led-1",
        "version": 3,
        "entries": [
            {
                "chapter": "do_not_repeat",
                "text": "Never call refund API without order_id",
                "citations": ["artifact:n1"],
                "weight": 10.0,
            }
        ],
    }
    get_latest = AsyncMock(return_value=ledger_data)

    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(
        return_value={
            "status": "ok",
            "data": {
                "findings": [{"summary": "known pattern", "confidence": 0.7}],
                "proposed_remediations": [],
                "llm_used": True,
            },
        }
    )

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.kb.ledger.generator.LedgerGenerator.get_latest", get_latest
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        res = await agent.triage("org_test", "iss-1")

    get_latest.assert_awaited_once_with("org_test", "agent-42")
    tr = res["data"]["triage_result"]
    assert tr["ledger_version"] == 3
    assert tr["source"] == "llm"


@pytest.mark.asyncio
async def test_triage_ledger_included_in_investigation_evidence() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            kind="tool_error", severity="p2", stumble_count=1, agent_id="agent-1"
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {"error": "boom"}}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(
        return_value={
            "status": "ok",
            "data": {
                "findings": [{"summary": "x", "confidence": 0.5}],
                "proposed_remediations": [],
                "llm_used": True,
            },
        }
    )

    ledger_data = {
        "version": 2,
        "entries": [{"chapter": "recent_failures", "text": "Prior timeout on checkout"}],
    }

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.kb.ledger.generator.LedgerGenerator.get_latest",
        AsyncMock(return_value=ledger_data),
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        await agent.triage("org_test", "iss-1")

    _a, kwargs = inv_instance.investigate.call_args
    evidence = kwargs["untrusted_evidence"]
    assert "Prior timeout on checkout" in evidence
    assert "Ledger v2" in evidence


@pytest.mark.asyncio
async def test_triage_ledger_missing_fails_soft() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            kind="tool_error", severity="p2", stumble_count=1, agent_id="agent-1"
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}, "span_id": "s1"}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(
        return_value={
            "status": "ok",
            "data": {
                "findings": [{"summary": "ok", "confidence": 0.6}],
                "proposed_remediations": [],
                "llm_used": True,
            },
        }
    )

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.kb.ledger.generator.LedgerGenerator.get_latest",
        AsyncMock(return_value=None),
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        res = await agent.triage("org_test", "iss-1")

    assert res["status"] == "ok"
    assert "ledger_version" not in res["data"]["triage_result"]
    inv_instance.investigate.assert_awaited_once()


@pytest.mark.asyncio
async def test_triage_ledger_error_fails_soft() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(
            kind="tool_error", severity="p2", stumble_count=1, agent_id="agent-1"
        )
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}, "span_id": "s1"}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(
        return_value={
            "status": "ok",
            "data": {
                "findings": [{"summary": "ok", "confidence": 0.6}],
                "proposed_remediations": [],
                "llm_used": True,
            },
        }
    )

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.kb.ledger.generator.LedgerGenerator.get_latest",
        AsyncMock(side_effect=RuntimeError("db down")),
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        res = await agent.triage("org_test", "iss-1")

    assert res["status"] == "ok"
    inv_instance.investigate.assert_awaited_once()


@pytest.mark.asyncio
async def test_triage_no_agent_id_skips_ledger() -> None:
    from eden.issues.triage_agent import TriageAgent

    repo = MagicMock()
    repo.get_issue = AsyncMock(
        return_value=_issue(kind="tool_error", severity="p2", stumble_count=1)
    )
    repo.list_stumbles = AsyncMock(
        return_value=[{"kind": "tool_error", "detail": {}, "span_id": "s1"}]
    )
    repo.set_triage_result = AsyncMock(return_value=True)

    inv_instance = MagicMock()
    inv_instance.investigate = AsyncMock(
        return_value={
            "status": "ok",
            "data": {
                "findings": [{"summary": "ok", "confidence": 0.6}],
                "proposed_remediations": [],
                "llm_used": True,
            },
        }
    )
    get_latest = AsyncMock()

    agent = TriageAgent(repo=repo)
    with patch(
        "eden.issues.triage_agent.TriageAgent._budget_ok", AsyncMock(return_value=True)
    ), patch(
        "eden.kb.ledger.generator.LedgerGenerator.get_latest", get_latest
    ), patch("eden.autonomous.InvestigationAgent", return_value=inv_instance):
        await agent.triage("org_test", "iss-1")

    get_latest.assert_not_awaited()


def test_ledger_context_for_prompt_empty_cases() -> None:
    from eden.issues.triage_agent import _ledger_context_for_prompt

    assert _ledger_context_for_prompt(None) == ""
    assert _ledger_context_for_prompt({}) == ""
    assert _ledger_context_for_prompt({"entries": []}) == ""
    assert _ledger_context_for_prompt({"entries": [{"text": ""}]}) == ""


def test_ledger_context_for_prompt_formats_entries() -> None:
    from eden.issues.triage_agent import _ledger_context_for_prompt

    out = _ledger_context_for_prompt(
        {
            "version": 5,
            "entries": [
                {
                    "chapter": "do_not_repeat",
                    "text": "Do not retry without backoff",
                    "citations": ["iss-99"],
                }
            ],
        }
    )
    assert "Ledger v5" in out
    assert "do_not_repeat" in out
    assert "Do not retry without backoff" in out
