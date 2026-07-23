"""Unit tests for portal read-model contracts + router mount."""

from __future__ import annotations

from fastapi.routing import APIRoute


def test_portal_contracts_import_smoke() -> None:
    from eden.api import portal_contracts as pc

    assert pc.AgentCard is not None
    assert pc.TraceListItem is not None
    assert pc.TranscriptStep is not None
    assert pc.SessionRollup is not None
    assert pc.IssueCard is not None
    assert pc.SignalCard is not None
    assert pc.AlertRuleCard is not None
    assert pc.AlertEventCard is not None
    assert pc.CostDriverCard is not None
    assert pc.WorkspaceCard is not None
    assert pc.WorkspacePrefs is not None
    assert pc.ApiKeyCard is not None
    assert pc.MemberCard is not None
    assert pc.AuditEventCard is not None
    assert pc.AuditPackCard is not None
    assert pc.DatasetCard is not None
    assert pc.PlaygroundCard is not None
    assert pc.ExperimentSummary is not None
    assert pc.ImprovePlanCard is not None
    assert pc.AbExperimentCard is not None
    assert pc.GuardrailPolicyCard is not None
    assert pc.DebuggerSessionCard is not None
    assert pc.AssistantMessagePart is not None
    assert pc.AssistantThreadCard is not None
    assert "dev" in getattr(pc, "PromptPinEnv").__args__
    assert "staging" in pc.PromptPinEnv.__args__
    assert "prod" in pc.PromptPinEnv.__args__


def test_agent_card_validates() -> None:
    from eden.api.portal_contracts import AgentCard

    card = AgentCard(
        id="agt_support",
        name="Support concierge",
        purpose="Handle tier-1 tickets",
        status="live",
        env="prod",
        model="gpt-4.1-mini",
        runs24h=120,
        successRate=0.97,
        errorRate=0.03,
        p50Ms=800,
        p95Ms=2400,
        costUsd24h=12.5,
        tokens24h=480_000,
        openIssues=2,
        lastSeen="2026-07-23T12:00:00+00:00",
        topError=None,
    )
    assert card.id == "agt_support"
    assert card.successRate == 0.97
    assert card.model_dump()["costUsd24h"] == 12.5


def test_api_key_card_validates() -> None:
    from eden.api.portal_contracts import ApiKeyCard

    card = ApiKeyCard(
        id="key_1",
        name="SDK",
        prefix="eden_sk",
        scopes=["traces:read", "ingest"],
        status="active",
        createdAt="2026-07-23T12:00:00+00:00",
        lastUsed=None,
        createdBy="user_1",
    )
    assert card.status == "active"
    assert card.prefix == "eden_sk"
    assert "ingest" in card.scopes


def test_member_card_validates() -> None:
    from eden.api.portal_contracts import MemberCard

    card = MemberCard(
        id="usr_1",
        name="Ada Lovelace",
        email="ada@example.com",
        role="owner",
        status="active",
        lastActive="2026-07-23T12:00:00+00:00",
    )
    assert card.role == "owner"
    assert card.status == "active"


def test_improve_plan_card_validates() -> None:
    from eden.api.portal_contracts import ImprovePlanCard

    card = ImprovePlanCard(
        id="plan_1",
        title="Tighten tool allowlist",
        status="needs_you",
        kind="tool_policy",
        agentId="agt_support",
        issueIds=["iss_1"],
        caseIds=["case_1"],
        baselineId="exp_base",
        compareId="exp_cmp",
    )
    assert card.status == "needs_you"
    assert card.issueIds == ["iss_1"]
    assert card.compareId == "exp_cmp"


def test_debugger_session_card_validates() -> None:
    from eden.api.portal_contracts import DebuggerSessionCard

    card = DebuggerSessionCard(
        id="dbg_1",
        title="Replay timeout",
        agentId="agt_support",
        sourceTraceId="tr_src",
        compareTraceId="tr_cmp",
        modeHint="compare",
        notes="forked at step 3",
        updatedAt="2026-07-23T12:00:00+00:00",
    )
    assert card.modeHint == "compare"
    assert card.sourceTraceId == "tr_src"


def test_portal_router_mounted() -> None:
    from eden.api.routes import portal

    paths = {r.path for r in portal.router.routes if isinstance(r, APIRoute)}
    assert "/orgs/{org_id}/portal/agents" in paths
    assert "/orgs/{org_id}/portal/traces" in paths
    assert "/orgs/{org_id}/portal/sessions" in paths
    assert "/orgs/{org_id}/portal/issues" in paths
    assert "/orgs/{org_id}/portal/signals" in paths
    assert "/orgs/{org_id}/portal/alerts/rules" in paths
    assert "/orgs/{org_id}/portal/alerts/events" in paths
    assert "/orgs/{org_id}/portal/cost/drivers" in paths
    assert "/orgs/{org_id}/portal/workspace" in paths
    # Wave: settings / improve / debugger portal read models
    assert any("/keys" in p for p in paths)
    assert any("/members" in p for p in paths)
    assert any("/improve/plans" in p for p in paths)
    assert any("/debugger/sessions" in p for p in paths)


def test_portal_router_included_in_app() -> None:
    from eden.api.app import app

    paths = {getattr(r, "path", "") for r in app.routes}
    assert any(p == "/orgs/{org_id}/portal/agents" for p in paths)
    assert any("/portal/workspace" in (p or "") for p in paths)
