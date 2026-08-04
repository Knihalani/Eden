"""Chaos — Postgres down under closed-loop write paths.

Two representative writes:

1. The durable-outbox insert (Redis already down, now PG dies too —
   total outage). Contract: the loss is EXPLICIT — ``publish`` returns
   ``False`` and logs at ERROR. Never a silent success.

2. The issue state-transition audit row
   (``state_machine._record_transition``). Today a PG failure there is
   swallowed at DEBUG while ``apply_transition`` still returns the new
   status — a silent audit-row loss. Documented as ``xfail(strict)``
   below rather than changed (src/eden is read-only for this suite);
   see the reason string for the exact location.
"""

from __future__ import annotations

import logging
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.events import LoopEvent


def _event() -> LoopEvent:
    return LoopEvent.from_fields(
        {
            "type": "verify_passed",
            "org_id": "org-chaos",
            "issue_id": "00000000-0000-0000-0000-000000000002",
            "ref": "pg-down",
        }
    )


@pytest.fixture(autouse=True)
def _reset_bus_state():
    import eden.closed_loop.event_bus as eb

    eb.last_publish_failure_ts = None
    yield
    eb.last_publish_failure_ts = None


@pytest.mark.asyncio
async def test_total_outage_outbox_insert_fails_loud_not_silent(caplog):
    """Redis dead AND Postgres dead: publish must say so.

    ``publish`` returns False (the event is lost) and both legs log at
    ERROR — the failure is visible to operators, not swallowed.
    """
    import eden.closed_loop.event_bus as eb

    dead_pg = MagicMock()
    dead_pg.execute = AsyncMock(
        side_effect=ConnectionError("chaos: postgres down")
    )

    class _DeadRedis:
        async def xadd(self, *a, **k):
            raise ConnectionError("chaos: redis down")

    with (
        patch.object(eb, "_pg", AsyncMock(return_value=dead_pg)),
        caplog.at_level(logging.ERROR, logger="eden.closed_loop.event_bus"),
    ):
        ok = await eb.publish(_event(), redis=_DeadRedis())

    assert ok is False  # explicit loss — the caller can react
    assert eb.last_publish_failure_ts is not None  # probe stamped
    messages = [r.getMessage() for r in caplog.records]
    assert any("publish failed" in m for m in messages)
    assert any("outbox insert failed" in m for m in messages)


@pytest.mark.asyncio
# Fixed: state_machine._record_transition now logs the audit-row loss at
# ERROR with full transition identity + bumps eden_loop_audit_row_loss_total,
# instead of swallowing the Postgres failure at DEBUG. The status row still
# moves (that write already succeeded) but the loss is no longer silent.
async def test_pg_down_during_transition_audit_row_is_not_silent(
    monkeypatch, caplog
):
    """Status write succeeds, then PG dies before the audit insert.

    The transition claims success ('learning') — asserted below and
    true today — but nothing above DEBUG records that the audit row
    was lost. This test encodes the DESIRED loudness and xfails until
    the swallow is fixed.
    """
    from eden.closed_loop import state_machine as sm
    from eden.issues.repo import IssuesRepo

    issue = SimpleNamespace(status="resolved")
    monkeypatch.setattr(IssuesRepo, "get_issue", AsyncMock(return_value=issue))
    monkeypatch.setattr(IssuesRepo, "set_status", AsyncMock(return_value=True))

    dead_pg = MagicMock()
    dead_pg.execute = AsyncMock(
        side_effect=ConnectionError("chaos: postgres died mid-transition")
    )
    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=dead_pg),
    )

    with caplog.at_level(
        logging.WARNING, logger="eden.closed_loop.state_machine"
    ):
        new_status = await sm.apply_transition(
            "org-chaos",
            str(uuid.uuid4()),
            event_type="learning_started",
        )

    # The transition itself proceeds (resolved -> learning)...
    assert new_status == "learning"
    dead_pg.execute.assert_awaited()  # the audit insert WAS attempted

    # ...but the lost audit row must be loud. Today: DEBUG-only swallow.
    assert any(
        r.levelno >= logging.WARNING for r in caplog.records
    ), "PG failure during the audit insert produced no WARNING+ signal"
