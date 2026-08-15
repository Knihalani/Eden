"""FEAT-101 — EQL triage payloads carry fingerprint/issue_id for dedupe."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.dsl import alerts as dsl_alerts


@pytest.mark.asyncio
async def test_trigger_triage_payload_includes_stable_fingerprint() -> None:
    async def _fake_create(**kwargs: object) -> dict[str, object]:
        return {"id": "evt-fp", "payload": kwargs["payload"]}

    create_event = AsyncMock(side_effect=_fake_create)
    run_for_event = AsyncMock(return_value={"verdict": "benign"})

    with (
        patch("eden.alerts.repo.create_alert_event", create_event),
        patch(
            "eden.alerts.triage_judge.AlertTriageJudge.run_for_event",
            run_for_event,
        ),
        patch.object(
            dsl_alerts,
            "_resolve_open_issue_id",
            new=AsyncMock(return_value=None),
        ),
    ):
        await dsl_alerts._trigger_triage(
            org_id="org-1",
            alert_id="eql_alert_abc123",
            name="High errors",
            eql_query="SELECT 1",
            severity="high",
            firing_id="fire-1",
            n_rows=1,
            sample_rows=[],
            data_source="postgres",
        )

    payload = create_event.call_args.kwargs["payload"]
    assert payload["fingerprint"] == "eql_alert:org-1:eql_alert_abc123"
    assert "issue_id" not in payload

    run_payload = run_for_event.call_args.kwargs["payload"]
    assert run_payload["fingerprint"] == payload["fingerprint"]


@pytest.mark.asyncio
async def test_trigger_triage_payload_includes_resolved_issue_id() -> None:
    async def _fake_create(**kwargs: object) -> dict[str, object]:
        return {"id": "evt-issue", "payload": kwargs["payload"]}

    create_event = AsyncMock(side_effect=_fake_create)
    run_for_event = AsyncMock(return_value={"verdict": "duplicate"})

    with (
        patch("eden.alerts.repo.create_alert_event", create_event),
        patch(
            "eden.alerts.triage_judge.AlertTriageJudge.run_for_event",
            run_for_event,
        ),
        patch.object(
            dsl_alerts,
            "_resolve_open_issue_id",
            new=AsyncMock(return_value="iss-open-9"),
        ),
    ):
        await dsl_alerts._trigger_triage(
            org_id="org-1",
            alert_id="eql_alert_dup",
            name="Dup rule",
            eql_query="SELECT 1",
            severity="warning",
            firing_id="fire-2",
            n_rows=2,
            sample_rows=[{"x": 1}],
            data_source="postgres",
        )

    payload = create_event.call_args.kwargs["payload"]
    assert payload["issue_id"] == "iss-open-9"
    assert payload["fingerprint"] == "eql_alert:org-1:eql_alert_dup"


def test_eql_alert_fingerprint_is_stable_for_org_and_alert() -> None:
    fp = dsl_alerts._eql_alert_fingerprint("org_x", "eql_alert_deadbeef")
    assert fp == "eql_alert:org_x:eql_alert_deadbeef"
    assert dsl_alerts._eql_alert_fingerprint("org_x", "eql_alert_deadbeef") == fp
