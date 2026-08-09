"""Unit tests for portal read-model contracts + router mount."""

from __future__ import annotations

import pytest
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
    assert "dev" in pc.PromptPinEnv.__args__
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
    # Phase 2a — single-trace detail route that populates ``steps``.
    assert "/orgs/{org_id}/portal/traces/{trace_id}" in paths
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


# ── Phase 2a — trace transcript step mapping ───────────────────────


def test_tree_node_to_step_parses_json_string_metrics() -> None:
    """Neon/asyncpg can hand back JSONB as a JSON string — must not drop tokens."""
    from eden.api.routes.portal import _tree_node_to_step

    node = {
        "span_id": "span_json_str",
        "parent_span_id": None,
        "name": "MiniMax-M3",
        "event_type": "llm_call",
        "timestamp": None,
        "duration_ms": 12,
        "metrics": '{"input_tokens": 198.0, "output_tokens": 50.0, "total_tokens": 248.0}',
        "attributes": "{}",
        "payload": '{"openai": {"model": "MiniMax-M3"}}',
        "outcome": "success",
        "request_body": '{"messages": [{"role": "user", "content": "hi"}]}',
        "response_body": '{"content": "hello"}',
        "model_version": "standard",
    }
    step = _tree_node_to_step(node)
    assert step.tokensIn == 198
    assert step.tokensOut == 50
    assert step.model == "MiniMax-M3"
    assert step.costUsd is not None and step.costUsd > 0
    assert step.inputPreview is not None
    assert "user: hi" in step.inputPreview
    assert "{" not in step.inputPreview
    assert step.outputPreview == "hello"


def test_humanize_io_preview_chat_completion() -> None:
    from eden.api.routes.portal import _humanize_io_preview

    req = {
        "model": "MiniMax-M3",
        "messages": [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": "What is observability?"},
        ],
    }
    resp = {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "<think>plan</think>LLM observability watches agent runs.",
                }
            }
        ]
    }
    assert _humanize_io_preview(req) == (
        "system: Be brief.\n\nuser: What is observability?"
    )
    assert _humanize_io_preview(resp) == "LLM observability watches agent runs."


def test_tree_node_to_step_maps_agent_id() -> None:
    from eden.api.routes.portal import _tree_node_to_step

    node = {
        "span_id": "span_agent",
        "parent_span_id": None,
        "name": "tool.search",
        "event_type": "tool_call",
        "duration_ms": 10,
        "metrics": {},
        "attributes": {},
        "payload": {},
        "outcome": "success",
        "agent_id": "researcher",
    }
    step = _tree_node_to_step(node)
    assert step.agentId == "researcher"


def test_tree_node_to_step_maps_llm_span() -> None:
    from datetime import UTC, datetime

    from eden.api.routes.portal import _tree_node_to_step

    node = {
        "span_id": "span_1",
        "parent_span_id": None,
        "name": "llm_call",
        "event_type": "llm_call",
        "timestamp": datetime(2026, 7, 23, 12, 0, 0, tzinfo=UTC),
        "duration_ms": 812.4,
        "metrics": {"input_tokens": 120, "output_tokens": 45, "cost_usd": 0.0032},
        "attributes": {"model": "gpt-4.1-mini", "provider": "openai"},
        "payload": {},
        "outcome": "success",
        "request_body": {"messages": [{"role": "user", "content": "hi"}]},
        "response_body": {"content": "hello there"},
    }
    step = _tree_node_to_step(node)

    assert step.id == "span_1"
    assert step.kind == "llm"
    assert step.status == "ok"
    assert step.spanId == "span_1"
    assert step.parentId is None
    assert step.model == "gpt-4.1-mini"
    assert step.provider == "openai"
    assert step.tokensIn == 120
    assert step.tokensOut == 45
    assert step.costUsd == 0.0032
    assert step.errorMessage is None
    assert step.inputPreview is not None
    assert step.outputPreview is not None


def test_tree_node_to_step_maps_tool_error() -> None:
    from eden.api.routes.portal import _tree_node_to_step

    node = {
        "span_id": "span_2",
        "parent_span_id": "span_1",
        "name": "tool.search",
        "event_type": "tool_call",
        "timestamp": None,
        "duration_ms": 50,
        "metrics": {},
        "attributes": {"error": "timeout after 30s"},
        "payload": {},
        "outcome": "failure",
        "request_body": None,
        "response_body": None,
    }
    step = _tree_node_to_step(node)

    assert step.kind == "tool"
    assert step.status == "error"
    assert step.parentId == "span_1"
    assert step.errorMessage == "timeout after 30s"


def test_tree_node_to_step_reads_sdk_eden_error() -> None:
    """Python SDK stamps exceptions on attributes['eden.error']."""
    from eden.api.routes.portal import _tree_node_to_step

    node = {
        "span_id": "span_err",
        "name": "agent.run",
        "event_type": "agent.run",
        "duration_ms": 12,
        "metrics": {},
        "attributes": {"eden.error": "ZeroDivisionError('division by zero')"},
        "payload": {},
        "outcome": "error",
        "request_body": None,
        "response_body": None,
    }
    step = _tree_node_to_step(node)
    assert step.status == "error"
    assert "ZeroDivisionError" in (step.errorMessage or "")
    assert step.errorMessage != "error"


def test_trace_signal_summary_includes_error_detail() -> None:
    from eden.api.routes.portal import _trace_signal_summary

    summary = _trace_signal_summary(
        name="testagent",
        severity="error",
        status="error",
        error_detail="ZeroDivisionError('division by zero')",
    )
    assert summary.title == "Run failed"
    assert "ZeroDivisionError" in summary.body


def test_tree_node_to_step_maps_a2a_handoff() -> None:
    """FEAT-64/100: nested ``a2a`` sub-document surfaces as labeled handoff."""
    from eden.api.routes.portal import _tree_node_to_step

    node = {
        "span_id": "span_handoff",
        "parent_span_id": "span_parent",
        "name": "invoke_agent",
        "event_type": "invoke_agent",
        "duration_ms": 120,
        "metrics": {},
        "attributes": {
            "parent_agent_span_id": "span_parent",
            "child_agent_trace_id": "trace-child-1",
            "a2a": {
                "invocation_type": "a2a.send_message",
                "parent_agent_id": "planner",
                "child_agent_id": "researcher",
                "response_status": "ok",
            },
        },
        "payload": {},
        "outcome": "success",
    }
    step = _tree_node_to_step(node)

    assert step.kind == "handoff"
    assert step.title == "planner → researcher (a2a.send_message)"
    assert step.agentId == "researcher"
    assert step.outputPreview == "status: ok"
    assert step.attributes is not None
    assert step.attributes["a2a.invocation_type"] == "a2a.send_message"
    assert step.attributes["a2a.parent_agent_id"] == "planner"
    assert step.attributes["a2a.child_agent_id"] == "researcher"
    assert step.attributes["a2a.response_status"] == "ok"
    assert step.attributes["parent_agent_span_id"] == "span_parent"
    assert step.attributes["child_agent_trace_id"] == "trace-child-1"


def test_step_kind_maps_invoke_agent_without_a2a() -> None:
    from eden.api.routes.portal import _step_kind

    assert _step_kind("invoke_agent", "delegate") == "agent"
    assert _step_kind("agent_run", "agent.run") == "agent"
    assert _step_kind("task", "run") == "task"


def test_transcript_kind_includes_agent_and_handoff() -> None:
    from eden.api.portal_contracts import TranscriptKind, TranscriptStep

    assert "agent" in TranscriptKind.__args__
    assert "handoff" in TranscriptKind.__args__
    step = TranscriptStep(id="s1", kind="handoff", title="planner → researcher")
    assert step.kind == "handoff"


def test_flatten_tree_preserves_depth_first_order() -> None:
    from eden.api.routes.portal import _flatten_tree

    tree = [
        {
            "span_id": "root",
            "name": "task",
            "event_type": "task",
            "duration_ms": 100,
            "outcome": "success",
            "children": [
                {
                    "span_id": "child",
                    "parent_span_id": "root",
                    "name": "llm_call",
                    "event_type": "llm_call",
                    "duration_ms": 40,
                    "outcome": "success",
                    "children": [],
                },
            ],
        },
    ]
    steps = _flatten_tree(tree)

    assert [s.id for s in steps] == ["root", "child"]
    assert steps[1].parentId == "root"


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [
        ("error", ("error", "error")),
        ("failed", ("error", "error")),
        ("crash", ("error", "error")),
        ("timeout", ("error", "error")),
        ("warn", ("ok", "warn")),
        ("success", ("ok", "none")),
        (None, ("ok", "none")),
    ],
)
def test_map_trace_outcome_uses_error_outcomes_set(outcome, expected) -> None:
    """BUG-2: timeout/crash must map to error like other failure outcomes."""
    from eden.api.routes.portal import _map_trace_outcome

    assert _map_trace_outcome(outcome) == expected


# ── BUG-9 / FEAT-11 — issue status + sort contracts ──────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("open", "open"),
        ("ignored", "ignored"),
        ("resolved", "resolved"),
        ("triaged", "acknowledged"),
        ("escalated", "acknowledged"),
        (None, "open"),
    ],
)
def test_map_issue_status_preserves_ignored(raw, expected) -> None:
    """BUG-9: dismissed (ignored) issues must not collapse into resolved."""
    from eden.api.routes.portal import _map_issue_status

    assert _map_issue_status(raw) == expected


def test_issue_card_ignored_status_validates() -> None:
    from eden.api.portal_contracts import IssueCard

    card = IssueCard(
        id="iss_ignored",
        title="False positive",
        status="ignored",
    )
    assert card.status == "ignored"


@pytest.mark.asyncio
async def test_list_portal_issues_passes_sort_rank() -> None:
    from unittest.mock import AsyncMock, patch

    from eden.api.routes import portal as portal_mod

    list_mock = AsyncMock(return_value=[])
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=None),
        ),
        patch("eden.api.routes.portal._require_pg", AsyncMock()),
        patch("eden.issues.repo.IssuesRepo.list_issues", list_mock),
        patch(
            "eden.api.routes.portal._resolve_stumble_refs",
            AsyncMock(return_value=({}, {}, {})),
        ),
        patch(
            "eden.api.routes.portal._nl_signal_ids_for_defs",
            AsyncMock(return_value={}),
        ),
    ):
        await portal_mod.list_portal_issues(
            org_id="org_1", limit=50, offset=0, sort="rank", _user={"sub": "u1"}
        )

    list_mock.assert_awaited_once_with("org_1", limit=50, offset=0, sort="rank")


@pytest.mark.asyncio
async def test_list_portal_issues_rejects_invalid_sort() -> None:
    from eden.api.routes import portal as portal_mod

    with pytest.raises(Exception) as ei:
        await portal_mod.list_portal_issues(
            org_id="org_1",
            limit=50,
            offset=0,
            sort="bogus",
            _user={"sub": "u1"},
        )
    assert getattr(ei.value, "status_code", None) == 400


@pytest.mark.asyncio
async def test_agent_issues_list_defaults_sort_rank() -> None:
    from unittest.mock import AsyncMock, patch

    from eden.api.routes import agent_issues as mod

    list_mock = AsyncMock(return_value=[])
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=object()),
        ),
        patch.object(mod._repo, "list_issues", list_mock),
    ):
        await mod.list_issues(
            org_id="org_1",
            status=None,
            severity=None,
            agent_id=None,
            sort="rank",
            limit=50,
            offset=0,
        )

    list_mock.assert_awaited_once_with(
        "org_1",
        status=None,
        severity=None,
        agent_id=None,
        sort="rank",
        limit=50,
        offset=0,
    )


@pytest.mark.asyncio
async def test_agent_issues_list_passes_sort_rank() -> None:
    from unittest.mock import AsyncMock, patch

    from eden.api.routes import agent_issues as mod

    list_mock = AsyncMock(return_value=[])
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=object()),
        ),
        patch.object(mod._repo, "list_issues", list_mock),
    ):
        result = await mod.list_issues(
            org_id="org_1",
            status=None,
            severity=None,
            agent_id=None,
            sort="rank",
            limit=50,
            offset=0,
        )

    list_mock.assert_awaited_once_with(
        "org_1",
        status=None,
        severity=None,
        agent_id=None,
        sort="rank",
        limit=50,
        offset=0,
    )
    assert result["data"]["count"] == 0


@pytest.mark.asyncio
async def test_agent_issues_list_rejects_invalid_sort() -> None:
    from eden.api.routes import agent_issues as mod

    with pytest.raises(Exception) as ei:
        await mod.list_issues(org_id="org_1", sort="bogus", limit=50, offset=0)
    assert getattr(ei.value, "status_code", None) == 400
