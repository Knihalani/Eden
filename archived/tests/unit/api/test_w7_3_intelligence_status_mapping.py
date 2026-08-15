"""W7.3 — intelligence/improve/insights/judges status mapping (no unintended 500s).

Client/validation failures → 4xx; Postgres/infra unavailable → 503.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

ORG = "00000000-0000-0000-0000-000000000001"


@pytest.mark.asyncio
async def test_improve_snooze_bad_iso_is_422():
    from eden.api.routes import improve as mod

    with (
        patch.object(mod, "_require_agent_v1_async", AsyncMock(return_value=None)),
        patch.object(mod, "require_org_admin", AsyncMock(return_value=None)),
    ):
        body = mod.SnoozePlanRequest(snoozed_until="not-a-date")
        with pytest.raises(HTTPException) as ei:
            await mod.snooze_plan_route(
                org_id=ORG, plan_id="plan_1", body=body, payload={"sub": "u1"}
            )
        assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_improve_autofix_missing_issue_is_404():
    from eden.api.routes import improve as mod

    with patch(
        "eden.issues.repo.IssuesRepo.get_issue",
        new=AsyncMock(return_value=None),
    ):
        body = mod.AutofixRequest(dry_run=True)
        with pytest.raises(HTTPException) as ei:
            await mod.autofix(org_id=ORG, issue_id="missing", body=body)
        assert ei.value.status_code == 404


@pytest.mark.asyncio
async def test_insights_run_detectors_invalid_realm_is_422():
    from eden.api.routes import insights as mod

    req = mod.RunDetectorsRequest(realm="not-a-realm")
    member = MagicMock()
    member.org_id = ORG
    with pytest.raises(HTTPException) as ei:
        await mod.run_detectors(org_id=ORG, req=req, member=member)
    assert ei.value.status_code == 422


@pytest.mark.asyncio
async def test_replay_create_session_postgres_none_is_503():
    from eden.api.routes import intelligence_replay as mod

    body = mod.CreateReplaySessionRequest(trace_id="tr_1", name="s1")
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.create_replay_session(org_id=ORG, body=body)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_replay_create_session_bad_uuid_is_400():
    from eden.api.routes import intelligence_replay as mod

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=Exception('invalid input syntax for type uuid: "org_bad"')
    )
    body = mod.CreateReplaySessionRequest(trace_id="tr_1", name="s1")
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.create_replay_session(org_id="org_bad", body=body)
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_time_travel_record_postgres_none_is_503():
    from eden.api.routes import intelligence_time_travel as mod

    body = mod.RecordSnapshotRequest(trace_id="tr_1", label="snap")
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.record_snapshot(org_id=ORG, body=body)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_time_travel_list_forks_postgres_none_is_503():
    from eden.api.routes import intelligence_time_travel as mod

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.list_forks(org_id=ORG, parent_trace_id="tr_1")
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_time_travel_list_steps_postgres_none_is_503():
    from eden.api.routes import intelligence_time_travel as mod

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.list_parent_steps(org_id=ORG, parent_trace_id="tr_1")
        assert ei.value.status_code == 503


def test_map_debugger_mode_preserves_time_travel():
    from eden.api.routes.portal import _map_debugger_mode

    assert _map_debugger_mode("time-travel") == "time-travel"
    assert _map_debugger_mode("time_travel") == "time-travel"
    assert _map_debugger_mode("replay") == "replay"
    assert _map_debugger_mode("inspect") == "inspect"


@pytest.mark.asyncio
async def test_judges_list_postgres_none_is_503():
    from eden.api.routes import judges as mod

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.list_judge_scores(org_id=ORG)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_judges_fetch_events_postgres_none_is_503():
    from eden.api.routes import judges as mod

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod._fetch_events_for_trace(ORG, "tr_1")
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_autonomous_investigate_postgres_none_is_503():
    from eden.api.routes import intelligence_autonomous as mod

    body = mod.InvestigateRequest(trace_id="tr_1")
    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.investigate(org_id=ORG, body=body)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_guardrails_scan_history_postgres_none_is_503():
    from eden.api.routes import intelligence_guardrails as mod

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.scan_history(org_id=ORG)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_agent_issues_invalid_detection_profile_is_400():
    from eden.api.routes import agent_issues as mod

    body = mod.DetectionSettingsRequest(detection_profile="nope")
    with patch(
        "eden.issues.detection_settings.set_detection_settings",
        new=AsyncMock(side_effect=ValueError("invalid detection_profile")),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.patch_detection_settings_route(org_id=ORG, body=body)
        assert ei.value.status_code == 400


@pytest.mark.asyncio
async def test_agent_issues_list_postgres_none_is_503():
    from eden.api.routes import agent_issues as mod

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.list_issues(org_id=ORG)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_agent_issues_experiment_db_unavailable_is_503():
    from eden.api.routes import agent_issues as mod

    with patch(
        "eden.experiments.issue_link.IssueExperimentWizard.create",
        new=AsyncMock(
            return_value={
                "status": "error",
                "feature": "IssueExperimentWizard",
                "message": "database unavailable",
            }
        ),
    ):
        body = mod.CreateExperimentRequest()
        with pytest.raises(HTTPException) as ei:
            await mod.create_issue_experiment(org_id=ORG, issue_id="iss_1", body=body)
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_change_impact_get_postgres_none_is_503():
    from eden.api.routes import change_impact as mod

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=None),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.get_impact_report(org_id=ORG, change_id="chg_1")
        assert ei.value.status_code == 503


@pytest.mark.asyncio
async def test_change_impact_get_missing_is_404():
    from eden.api.routes import change_impact as mod

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=MagicMock()),
        ),
        patch.object(mod._orchestrator, "get_report", new=AsyncMock(return_value=None)),
    ):
        with pytest.raises(HTTPException) as ei:
            await mod.get_impact_report(org_id=ORG, change_id="missing")
        assert ei.value.status_code == 404
