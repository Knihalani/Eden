"""Tests for closed-loop verify claim + attempt accounting."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_run_due_verifications_claims_with_skip_locked():
    from eden.closed_loop import verify

    claimed = [
        {
            "id": "v1",
            "org_id": "org-1",
            "issue_id": "00000000-0000-0000-0000-000000000001",
            "fingerprint": "fp1",
            "ref": "ref1",
            "attempts": 0,
        }
    ]
    client = MagicMock()
    client.fetch = AsyncMock(return_value=claimed)
    client.execute = AsyncMock()

    with (
        patch.object(verify, "_pg", AsyncMock(return_value=client)),
        patch.object(
            verify, "_verify_issue", AsyncMock(return_value=(True, {"ok": True}))
        ),
        patch.object(verify, "_emit", AsyncMock()),
    ):
        summary = await verify.run_due_verifications(limit=10)

    assert summary["checked"] == 1
    assert summary["passed"] == 1
    sql = client.fetch.await_args.args[0]
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert "UPDATE issue_verifications" in sql
    # attempts set explicitly (not attempts + 1) to avoid double-count
    complete_sql = client.execute.await_args.args[0]
    assert "attempts = $4" in complete_sql
    assert client.execute.await_args.args[4] == 1


@pytest.mark.asyncio
async def test_subscription_deleted_reverts_to_org_free():
    from eden.api.routes import billing

    client = MagicMock()
    client.fetchrow = AsyncMock(
        side_effect=[
            {"id": "org-1"},  # org lookup
            {"id": "plan-1"},  # get_org_plan after update
        ]
    )
    client.execute = AsyncMock()
    calls: list[str] = []

    async def _create(org_id: str, plan_name: str) -> None:
        calls.append(plan_name)

    with (
        patch.object(billing, "get_postgres_client", AsyncMock(return_value=client)),
        patch.object(billing, "create_or_update_plan", AsyncMock(side_effect=_create)),
        patch.object(
            billing, "get_org_plan", AsyncMock(return_value={"id": "plan-1"})
        ),
    ):
        await billing.handle_subscription_event(
            {
                "type": "customer.subscription.deleted",
                "data": {
                    "object": {
                        "id": "sub_1",
                        "customer": "cus_1",
                        "status": "canceled",
                    }
                },
            }
        )

    assert calls == ["org_free"]
