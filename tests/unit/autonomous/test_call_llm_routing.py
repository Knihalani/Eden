"""OPT-17: ``_call_llm`` threads org_id and feature into ``route_async``."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.autonomous._common import _call_llm


@pytest.mark.asyncio
async def test_call_llm_forwards_org_id_and_feature() -> None:
    resp = MagicMock()
    resp.content = '{"ok": true}'
    route_async = AsyncMock(return_value=resp)

    with patch("eden.llm.internal_router.route_async", route_async):
        out = await _call_llm(
            "prompt",
            agent="autonomous_investigation",
            org_id="org_abc",
            feature="autonomous_investigation",
        )

    assert out == '{"ok": true}'
    route_async.assert_awaited_once_with(
        "autonomous_investigation",
        "prompt",
        slot="fast",
        system_prompt=None,
        max_tokens=600,
        output_type="json",
        requires_quality_check=False,
        org_id="org_abc",
        feature="autonomous_investigation",
    )


@pytest.mark.asyncio
async def test_investigate_call_llm_passes_org_id() -> None:
    from eden.autonomous import InvestigationAgent

    call_llm = AsyncMock(return_value='{"findings": [], "proposed_remediations": []}')
    trigger_row = {
        "id": "drift-123",
        "drift_type": "judge_score_drift",
        "severity": "high",
        "created_at": None,
    }
    pg = MagicMock()
    pg.fetchrow = AsyncMock(return_value=trigger_row)
    pg.fetch = AsyncMock(return_value=[])
    pg.execute = AsyncMock()

    with patch(
        "eden.autonomous.investigation._call_llm",
        call_llm,
    ), patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=pg),
    ):
        await InvestigationAgent().investigate(
            "org_test",
            trigger="drift_alert:drift-123",
        )

    call_llm.assert_awaited_once()
    assert call_llm.await_args.kwargs["org_id"] == "org_test"
    assert call_llm.await_args.kwargs["feature"] == "autonomous_investigation"


@pytest.mark.asyncio
async def test_nl_query_call_llm_passes_org_id() -> None:
    from eden.autonomous import NLQueryEngine

    call_llm = AsyncMock(side_effect=['{"sql": null}', '{"summary": "ok"}'])

    with patch(
        "eden.autonomous.nl_interface.query._call_llm",
        call_llm,
    ):
        await NLQueryEngine().query("org_nl", question="How many errors?")

    assert call_llm.await_count == 2
    for call in call_llm.await_args_list:
        assert call.kwargs["org_id"] == "org_nl"
    assert call_llm.await_args_list[0].kwargs["feature"] == "autonomous_nl_to_sql"
    assert call_llm.await_args_list[1].kwargs["feature"] == "autonomous_nl_summariser"
