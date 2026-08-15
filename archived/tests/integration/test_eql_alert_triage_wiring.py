"""EQL alert firing -> NL-alert triage + paging wiring (dead safety pipeline).

Prior to this fix, ``AlertAsCode.fire_due()``/``_evaluate_rule()``
(src/eden/dsl/alerts.py) wrote firings only to ``eql_alert_firings``
and never touched ``alert_events`` or :class:`AlertTriageJudge` —
meaning a configured NL alert rule never paged anyone, regardless of
severity, because the whole F81 triage/paging pipeline had zero
callers.

This test exercises :func:`eden.dsl.alerts._evaluate_rule` end to
end for a firing rule and asserts:

1. An ``alert_events`` row is created (``repo.create_alert_event``
   is invoked with the fired rule's data).
2. :class:`AlertTriageJudge` actually ran (a real, unmocked judge —
   it is pure regex + a Postgres duplicate-issue lookup per the
   audit notes, so only Postgres is mocked, not the judge itself).
3. For a scenario with no benign/duplicate signal, the verdict is
   ``real_incident`` and the mocked ``send_nl_incident_email`` paging
   call fires exactly once.
4. For a scenario whose rule name/query matches a known benign
   pattern (a marketing campaign spike), the verdict is ``benign``
   and the paging call does NOT fire.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_rule(
    *,
    alert_id: str,
    org_id: str,
    name: str,
    eql_query: str,
    severity: str = "high",
) -> dict[str, Any]:
    return {
        "alert_id": alert_id,
        "org_id": org_id,
        "name": name,
        "eql_query": eql_query,
        "clickhouse_sql": eql_query,
        "shape": "traces",
        "interval_seconds": 300,
        "severity": severity,
        "next_fire_at": None,
        "enabled": True,
        "lifecycle_status": "active",
        "n_fired": 0,
    }


def _install_alert_event_fetch(
    mock_postgres_client: MagicMock, *, event_id: str, org_id: str
) -> None:
    """Queue the ``SELECT * FROM alert_events WHERE id = $1`` row that
    ``repo.create_alert_event`` fetches back after its INSERT — the
    conftest's default fetchrow side effect returns ``None`` for
    unrecognised queries, which would blow up ``_event_row``."""
    mock_postgres_client._fetchrow_overrides.append(
        (
            "FROM alert_events WHERE id",
            {
                "id": event_id,
                "org_id": org_id,
                "rule_id": None,
                "title": "Alert fired",
                "severity": "high",
                "payload": {},
                "triage_verdict": "pending",
                "triage_reason": None,
                "triage_confidence": None,
                "incident_id": None,
                "acknowledged": False,
                "created_at": None,
                "updated_at": None,
            },
        )
    )


@pytest.mark.asyncio
async def test_fired_rule_creates_alert_event_and_pages_real_incident(
    mock_postgres_client: MagicMock,
) -> None:
    """A fired rule with no benign/duplicate signal creates an
    alert_events row, runs real triage, and pages via email."""
    from eden.alerts import repo
    from eden.dsl import alerts as dsl_alerts

    rule = _make_rule(
        alert_id="eql_alert_real_1",
        org_id="org_wiring_test",
        name="Sustained 5xx error rate breach",
        eql_query=(
            "SELECT trace_id FROM telemetry_events "
            "WHERE error = true AND org_id = 'org_wiring_test'"
        ),
        severity="high",
    )
    _install_alert_event_fetch(
        mock_postgres_client, event_id="evt-real-1", org_id="org_wiring_test"
    )

    fired_rows = [{"trace_id": "t1", "error": True}]

    with (
        patch.object(
            dsl_alerts,
            "_run_alert_sql",
            new=AsyncMock(return_value=(fired_rows, "postgres_fallback")),
        ),
        patch.object(
            repo, "create_alert_event", new=AsyncMock(wraps=repo.create_alert_event)
        ) as mock_create_event,
        patch(
            "eden.services.alert_email.send_nl_incident_email",
            new=AsyncMock(),
        ) as mock_send_email,
    ):
        result = await dsl_alerts._evaluate_rule(rule, force=True)

    assert result["fired"] is True

    # (1) alert_events row was created for the firing.
    mock_create_event.assert_awaited_once()
    _, kwargs = mock_create_event.call_args
    assert kwargs["org_id"] == "org_wiring_test"
    assert kwargs["severity"] == "high"
    assert kwargs["payload"]["alert_id"] == "eql_alert_real_1"

    # (2) + (3) real (unmocked) AlertTriageJudge ran and produced a
    # real_incident verdict, which paged exactly once.
    mock_send_email.assert_awaited_once()
    _, email_kwargs = mock_send_email.call_args
    assert email_kwargs["org_id"] == "org_wiring_test"
    assert email_kwargs["alert_event_id"] == "evt-real-1"
    assert email_kwargs["rule_name"] == "Sustained 5xx error rate breach"


@pytest.mark.asyncio
async def test_fired_benign_rule_creates_alert_event_but_does_not_page(
    mock_postgres_client: MagicMock,
) -> None:
    """A fired rule whose content matches a known benign pattern
    (marketing campaign traffic spike) still creates an alert_events
    row and runs triage, but must NOT page."""
    from eden.alerts import repo
    from eden.dsl import alerts as dsl_alerts

    rule = _make_rule(
        alert_id="eql_alert_benign_1",
        org_id="org_wiring_test",
        name="Traffic spike — marketing campaign",
        eql_query=(
            "SELECT trace_id FROM telemetry_events "
            "WHERE org_id = 'org_wiring_test'"
        ),
        severity="warning",
    )
    _install_alert_event_fetch(
        mock_postgres_client, event_id="evt-benign-1", org_id="org_wiring_test"
    )

    fired_rows = [{"trace_id": "t2"}]

    with (
        patch.object(
            dsl_alerts,
            "_run_alert_sql",
            new=AsyncMock(return_value=(fired_rows, "postgres_fallback")),
        ),
        patch.object(
            repo, "create_alert_event", new=AsyncMock(wraps=repo.create_alert_event)
        ) as mock_create_event,
        patch(
            "eden.services.alert_email.send_nl_incident_email",
            new=AsyncMock(),
        ) as mock_send_email,
    ):
        result = await dsl_alerts._evaluate_rule(rule, force=True)

    assert result["fired"] is True
    mock_create_event.assert_awaited_once()
    # Benign verdict must never page.
    mock_send_email.assert_not_awaited()
