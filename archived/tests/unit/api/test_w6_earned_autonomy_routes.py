"""Wave 6 pinning tests — 6.2 earnings route + 6.1 dogfood seed.

``GET /orgs/{org_id}/settings/autonomy/earnings`` publishes the earned
autonomy ledger (clean-merge streak + grantability posture); the N22
patch surface gains ``earned_autonomy_enabled``; and the org-create seed
flips the full loop on for the configured dogfood org only.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.mark.asyncio
async def test_get_earnings_returns_streak_and_policy() -> None:
    from eden.api.routes.autonomy import get_earnings
    from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy

    policy = AutonomousMaintenancePolicy(
        org_id="org-1",
        earned_autonomy_enabled=True,
        auto_code_patch_merge=False,
        maintenance_mode="assisted",
    )
    with (
        patch(
            "eden.improvement.earned_autonomy.clean_auto_merge_streak",
            AsyncMock(
                return_value={
                    "ok": True,
                    "streak": 5,
                    "threshold": 5,
                    "earned": True,
                    "total_auto_merged": 6,
                    "in_flight": 1,
                    "unproven": 0,
                    "breaking_plan_id": None,
                    "recent": [
                        {
                            "plan_id": "p-1",
                            "title": "fix flaky checkout",
                            "agent_id": "checkout-agent",
                            "merged_at": "2026-08-01T00:00:00Z",
                            "manual": True,
                            "status": "in_flight",
                            "window_summary": "1h:ok, 24h:ok, 168h:pending",
                        }
                    ],
                }
            ),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(return_value=policy),
        ),
    ):
        out = await get_earnings(org_id="org-1", current_user={})

    assert out["status"] == "ok"
    data = out["data"]
    assert data["streak"] == 5
    assert data["earned"] is True
    assert data["in_flight"] == 1
    assert data["recent"][0]["manual"] is True
    assert data["policy"]["earned_autonomy_enabled"] is True
    assert data["policy"]["auto_code_patch_merge"] is False
    assert data["policy"]["effective_mode"] == "assisted"


def test_autonomy_patch_accepts_earned_autonomy_enabled() -> None:
    from eden.api.routes.autonomy import AutonomyPatch

    patch_body = AutonomyPatch(earned_autonomy_enabled=True)
    assert patch_body.earned_autonomy_enabled is True

    # Unknown/absent fields stay None — the PATCH excludes them.
    patch_body = AutonomyPatch()
    assert patch_body.earned_autonomy_enabled is None


@pytest.mark.asyncio
async def test_dogfood_seed_flips_loop_and_opt_in_only_for_dogfood_org() -> None:
    from eden.api.routes.orgs import _maybe_seed_dogfood

    client = MagicMock()
    client.execute = AsyncMock(return_value="UPDATE 1")

    await _maybe_seed_dogfood(client, "org-9")

    assert client.execute.await_count == 2
    sql = client.execute.await_args_list[0].args[0]
    # First statement targets organizations.settings (evolution loop).
    assert "evolution_loop_enabled" in sql and "organizations" in sql
    sql2 = client.execute.await_args_list[1].args[0]
    # Second targets the org-default autonomy policy row (earned opt-in).
    assert "earned_autonomy_enabled" in sql2 and "autonomy_policies" in sql2
    # Both bound to the passed org id.
    assert client.execute.await_args_list[0].args[1] == "org-9"
    assert client.execute.await_args_list[1].args[1] == "org-9"
