"""FEAT-103: AlertAsCode triage prefers NL text over raw EQL."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_trigger_triage_prefers_passed_nl_text() -> None:
    from eden.dsl import alerts as dsl_alerts

    create_event = AsyncMock(
        return_value={"id": "evt-1", "payload": {"alert_id": "a1"}}
    )
    run_for_event = AsyncMock(return_value={"verdict": "benign"})

    with (
        patch("eden.alerts.repo.create_alert_event", create_event),
        patch(
            "eden.alerts.triage_judge.AlertTriageJudge.run_for_event",
            run_for_event,
        ),
        patch.object(
            dsl_alerts,
            "_nl_text_for_eql_alert",
            new=AsyncMock(return_value="should not be used"),
        ),
    ):
        await dsl_alerts._trigger_triage(
            org_id="org-1",
            alert_id="eql_alert_1",
            name="High errors",
            eql_query="SELECT 1 FROM traces",
            nl_text="alert me when error rate exceeds 5%",
            severity="high",
            firing_id="fire-1",
            n_rows=2,
            sample_rows=[{"trace_id": "t1"}],
            data_source="postgres",
        )

    create_event.assert_awaited_once()
    payload = create_event.call_args.kwargs["payload"]
    assert payload["nl_text"] == "alert me when error rate exceeds 5%"
    assert payload["eql_query"] == "SELECT 1 FROM traces"

    run_for_event.assert_awaited_once()
    assert run_for_event.call_args.kwargs["nl_text"] == (
        "alert me when error rate exceeds 5%"
    )


@pytest.mark.asyncio
async def test_trigger_triage_looks_up_nl_text_by_name() -> None:
    from eden.dsl import alerts as dsl_alerts

    create_event = AsyncMock(
        return_value={"id": "evt-2", "payload": {}}
    )
    run_for_event = AsyncMock(return_value={"verdict": "benign"})

    with (
        patch("eden.alerts.repo.create_alert_event", create_event),
        patch(
            "eden.alerts.triage_judge.AlertTriageJudge.run_for_event",
            run_for_event,
        ),
        patch.object(
            dsl_alerts,
            "_nl_text_for_eql_alert",
            new=AsyncMock(return_value="bridged NL sentence"),
        ),
    ):
        await dsl_alerts._trigger_triage(
            org_id="org-1",
            alert_id="eql_alert_2",
            name="High errors",
            eql_query="SELECT 1 FROM traces",
            severity="high",
            firing_id="fire-2",
            n_rows=1,
            sample_rows=[],
            data_source="postgres",
        )

    assert run_for_event.call_args.kwargs["nl_text"] == "bridged NL sentence"
    assert create_event.call_args.kwargs["payload"]["nl_text"] == (
        "bridged NL sentence"
    )


@pytest.mark.asyncio
async def test_trigger_triage_falls_back_to_eql_query() -> None:
    from eden.dsl import alerts as dsl_alerts

    create_event = AsyncMock(
        return_value={"id": "evt-3", "payload": {}}
    )
    run_for_event = AsyncMock(return_value={"verdict": "benign"})

    with (
        patch("eden.alerts.repo.create_alert_event", create_event),
        patch(
            "eden.alerts.triage_judge.AlertTriageJudge.run_for_event",
            run_for_event,
        ),
        patch.object(
            dsl_alerts,
            "_nl_text_for_eql_alert",
            new=AsyncMock(return_value=None),
        ),
    ):
        await dsl_alerts._trigger_triage(
            org_id="org-1",
            alert_id="eql_alert_3",
            name="Pure EQL",
            eql_query="SELECT 99",
            severity="warning",
            firing_id="fire-3",
            n_rows=1,
            sample_rows=[],
            data_source="postgres",
        )

    assert run_for_event.call_args.kwargs["nl_text"] == "SELECT 99"


@pytest.mark.asyncio
async def test_nl_text_for_eql_alert_queries_bridge() -> None:
    from eden.dsl import alerts as dsl_alerts

    client = MagicMock()
    client.fetchrow = AsyncMock(
        return_value={"nl_text": "  alert on latency  "}
    )

    with patch(
        "eden.storage.postgres.get_postgres_client",
        new=AsyncMock(return_value=client),
    ):
        text = await dsl_alerts._nl_text_for_eql_alert("org-1", "Latency")

    assert text == "alert on latency"
    client.fetchrow.assert_awaited_once()
    sql = client.fetchrow.call_args.args[0]
    assert "nl_alert_rules" in sql
    assert "name = $2" in sql
