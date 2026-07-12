"""N21/N20 remediation + verify loop (Wave 6) + G7/G11 hook fixes.

Covers the SelfHealer ``heal_from_issue`` mapping + autonomous execute,
the issue→patch trigger gating, the verify loop pass/fail/retry paths,
and the two ``on_drift_alert`` signature regressions (G7 scheduler, G11
SelfHealer approve/reweight).
"""

from __future__ import annotations

import inspect
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.issues.models import Issue


def _issue(**kw: Any) -> Issue:
    base: dict[str, Any] = {
        "id": "iss-1",
        "org_id": "org_test",
        "fingerprint": "fp-1",
        "kind": "tool_error",
        "title": "search failed",
        "status": "verifying",
        "severity": "p1",
    }
    base.update(kw)
    return Issue(**base)


# ── G11 / G7: on_drift_alert signature compliance ───────────────────


def test_on_drift_alert_signature_is_org_drift_severity() -> None:
    from eden.llmops.promotion_hooks import PromotionHook

    sig = inspect.signature(PromotionHook.on_drift_alert)
    params = list(sig.parameters)
    assert params == ["self", "org_id", "drift_type", "severity"]


@pytest.mark.asyncio
async def test_selfhealer_approve_fires_hook_without_context_kwarg() -> None:
    # G11: approve must call on_drift_alert with only (org_id, drift_type,
    # severity) — a context= kwarg used to TypeError (silently swallowed).
    from eden.autonomous.investigation import SelfHealer

    hook = MagicMock()
    hook.on_drift_alert = AsyncMock(return_value="a1")

    with patch(
        "eden.autonomous.investigation._load_self_heal_action",
        new=AsyncMock(
            return_value={
                "status": "pending_approval",
                "action_type": "rollback",
                "before_state": {},
            }
        ),
    ), patch(
        "eden.autonomous.investigation._upsert_self_heal", new=AsyncMock()
    ), patch("eden.llmops.promotion_hooks.PromotionHook", return_value=hook):
        await SelfHealer().approve("org_test", "a1", "user-1")

    hook.on_drift_alert.assert_awaited_once()
    _args, kwargs = hook.on_drift_alert.call_args
    assert "context" not in kwargs
    assert kwargs.get("severity") in ("low", "medium", "high", "critical")


@pytest.mark.asyncio
async def test_reweight_fires_hook_without_context_kwarg() -> None:
    from eden.autonomous.investigation import _execute_reweight

    hook = MagicMock()
    hook.on_drift_alert = AsyncMock(return_value="a1")
    with patch("eden.llmops.promotion_hooks.PromotionHook", return_value=hook):
        out = await _execute_reweight({"org_id": "org_test"})

    assert out["executed"] is True
    _args, kwargs = hook.on_drift_alert.call_args
    assert "context" not in kwargs


@pytest.mark.asyncio
async def test_scheduler_emit_drift_uses_instance_call() -> None:
    # G7: _emit_drift must instantiate the hook (class-level call left
    # self unbound) and must not pass payload= to on_drift_alert.
    import eden.code_change.scheduler as sched

    hook = MagicMock()
    hook.on_drift_alert = AsyncMock(return_value="a1")
    sched._tick_drift_count = 0
    with patch(
        "eden.llmops.promotion_hooks.PromotionHook", return_value=hook
    ):
        await sched._emit_drift(
            org_id="org_test",
            drift_type="cat23_test",
            severity="low",
            payload={"x": 1},
        )
    hook.on_drift_alert.assert_awaited_once()
    _args, kwargs = hook.on_drift_alert.call_args
    assert "payload" not in kwargs
    assert kwargs.get("drift_type") == "cat23_test"


# ── heal_from_issue ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_heal_from_issue_maps_and_executes() -> None:
    from eden.autonomous.investigation import SelfHealer

    issue = _issue(
        triage_result={
            "suggested_actions": [{"action_type": "cache_bust"}],
        }
    )
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)

    healer = SelfHealer()
    healer.heal = AsyncMock(  # type: ignore[method-assign]
        return_value={"data": {"action_id": "heal-1"}}
    )
    healer.execute_heal = AsyncMock(  # type: ignore[method-assign]
        return_value={"data": {"status": "executed", "action_type": "cache_bust"}}
    )

    with patch("eden.issues.repo.IssuesRepo", return_value=repo), patch(
        "eden.autonomous.investigation._load_self_heal_action",
        new=AsyncMock(return_value={"before_state": {}}),
    ), patch(
        "eden.autonomous.investigation._upsert_self_heal", new=AsyncMock()
    ):
        res = await healer.heal_from_issue("org_test", "iss-1")

    healer.heal.assert_awaited_once_with("org_test", action_type="cache_bust")
    healer.execute_heal.assert_awaited_once()
    assert res["data"]["status"] == "executed"
    assert res["data"]["issue_id"] == "iss-1"


@pytest.mark.asyncio
async def test_heal_from_issue_no_mapped_action() -> None:
    from eden.autonomous.investigation import SelfHealer

    issue = _issue(triage_result={"suggested_actions": [{"action_type": "email"}]})
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        res = await SelfHealer().heal_from_issue("org_test", "iss-1")
    # The autonomous envelope keeps status="ok" (the surface is live) but
    # carries a message explaining no heal was mapped.
    assert "no mapped heal action" in res.get("message", "")
    assert "action_id" not in res.get("data", {})


def test_heal_action_from_triage_prefers_suggested_heal() -> None:
    from eden.autonomous.investigation import _heal_action_from_triage

    assert _heal_action_from_triage({"suggested_heal": "rollback"}) == "rollback"
    assert (
        _heal_action_from_triage(
            {"suggested_actions": [{"type": "reweight"}]}
        )
        == "reweight"
    )
    assert _heal_action_from_triage({}) is None


# ── issue patch trigger ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_patch_trigger_disabled_when_flag_off() -> None:
    from eden.code_change import issue_patch_trigger as ipt

    with patch.object(ipt, "_code_change_enabled", return_value=False):
        res = await ipt.propose_patch_for_issue("org_test", "iss-1")
    assert res["status"] == "disabled"


@pytest.mark.asyncio
async def test_patch_trigger_generates_when_enabled() -> None:
    from eden.code_change import issue_patch_trigger as ipt

    issue = _issue(agent_id="agent-a")
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)
    repo.list_stumbles = AsyncMock(return_value=[])
    gen = MagicMock()
    gen.generate = AsyncMock(
        return_value={"data": {"patch_id": "patch-9", "status": "proposed"}}
    )
    linker = MagicMock()
    linker.link = AsyncMock(
        return_value={
            "data": {
                "primary_path": "src/foo.py",
                "links": [{"path": "src/foo.py", "confidence": 0.9}],
            }
        }
    )

    with patch.object(ipt, "_code_change_enabled", return_value=True), patch(
        "eden.issues.repo.IssuesRepo", return_value=repo
    ), patch(
        "eden.code_change.patch_generator.PatchGenerator", return_value=gen
    ), patch(
        "eden.code_change.rca_linker.CodeRootCauseLinker", return_value=linker
    ), patch(
        "eden.closed_loop.efficiency.AgentEfficiencyController.should_run_patch",
        AsyncMock(return_value=(True, "ok")),
    ), patch.object(
        ipt, "_find_open_patch", AsyncMock(return_value=None)
    ):
        res = await ipt.propose_patch_for_issue("org_test", "iss-1")

    gen.generate.assert_awaited_once()
    _args, kwargs = gen.generate.call_args
    assert kwargs["rca_id"] == "iss_iss-1"
    assert kwargs["repo_id"] == "agent-a"
    assert kwargs["linked_files"]
    assert kwargs["linked_files"][0]["path"] == "src/foo.py"
    assert res["status"] == "proposed"
    assert res["patch_id"] == "patch-9"


@pytest.mark.asyncio
async def test_patch_trigger_suppresses_duplicate_open() -> None:
    from eden.code_change import issue_patch_trigger as ipt

    issue = _issue(agent_id="agent-a")
    repo = MagicMock()
    repo.get_issue = AsyncMock(return_value=issue)

    with patch.object(ipt, "_code_change_enabled", return_value=True), patch(
        "eden.issues.repo.IssuesRepo", return_value=repo
    ), patch(
        "eden.closed_loop.efficiency.AgentEfficiencyController.should_run_patch",
        AsyncMock(return_value=(False, "duplicate_open_patch")),
    ), patch.object(
        ipt,
        "_find_open_patch",
        AsyncMock(return_value={"id": "patch_existing"}),
    ):
        res = await ipt.propose_patch_for_issue("org_test", "iss-1")

    assert res["status"] == "suppressed"
    assert res["reason"] == "duplicate_open_patch"
    assert res["patch_id"] == "patch_existing"


# ── verify loop ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_verify_passes_when_quiet_and_no_p0() -> None:
    from eden.closed_loop import verify

    repo = MagicMock()
    repo.count_recent_stumbles = AsyncMock(return_value=0)
    repo.get_issue = AsyncMock(return_value=_issue())
    repo.list_stumbles = AsyncMock(return_value=[])
    scorer = MagicMock()
    scorer.score = MagicMock(return_value=MagicMock(p0=False))

    with patch("eden.issues.repo.IssuesRepo", return_value=repo), patch(
        "eden.issues.statgate_scorer.StatGateIncidentScorer", return_value=scorer
    ):
        passed, detail = await verify._verify_issue("org_test", "iss-1", "fp-1")

    assert passed is True
    assert detail["recent_stumbles"] == 0


@pytest.mark.asyncio
async def test_verify_fails_when_stumbles_recur() -> None:
    from eden.closed_loop import verify

    repo = MagicMock()
    repo.count_recent_stumbles = AsyncMock(return_value=5)

    with patch("eden.issues.repo.IssuesRepo", return_value=repo):
        passed, detail = await verify._verify_issue("org_test", "iss-1", "fp-1")

    assert passed is False
    assert detail["recent_stumbles"] == 5


@pytest.mark.asyncio
async def test_run_due_verifications_passes_and_emits() -> None:
    from eden.closed_loop import verify

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "v1",
                "org_id": "org_test",
                "issue_id": "iss-1",
                "fingerprint": "fp-1",
                "ref": "fp-1",
                "attempts": 0,
            }
        ]
    )
    client.execute = AsyncMock()
    emitted: list[Any] = []

    with patch.object(verify, "_pg", new=AsyncMock(return_value=client)), patch.object(
        verify, "_verify_issue", new=AsyncMock(return_value=(True, {"ok": 1}))
    ), patch("eden.closed_loop.event_bus.publish", new=AsyncMock(side_effect=lambda e: emitted.append(e))):
        summary = await verify.run_due_verifications()

    assert summary["passed"] == 1
    assert emitted and emitted[0].type == "verify_passed"


@pytest.mark.asyncio
async def test_run_due_verifications_retries_before_failing() -> None:
    from eden.closed_loop import verify

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "v1",
                "org_id": "org_test",
                "issue_id": "iss-1",
                "fingerprint": "fp-1",
                "ref": "fp-1",
                "attempts": 0,  # first attempt → retry, not fail
            }
        ]
    )
    client.execute = AsyncMock()

    with patch.object(verify, "_pg", new=AsyncMock(return_value=client)), patch.object(
        verify, "_verify_issue", new=AsyncMock(return_value=(False, {"reason": "noisy"}))
    ), patch("eden.closed_loop.event_bus.publish", new=AsyncMock()):
        summary = await verify.run_due_verifications()

    assert summary["retried"] == 1
    assert summary["failed"] == 0
