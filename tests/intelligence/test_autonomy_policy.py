"""N22 — autonomy policy engine (Wave 5).

Covers policy resolution (agent override, config-derived defaults),
``decide``/``may`` verdicts across the three maintenance modes + the two
regulated compliance profiles, the daily budget downgrade, and the
settings API round-trip.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.autonomy_policy import (
    AutonomousMaintenancePolicy,
    decide,
    may,
)

# ── decide / may (pure) ─────────────────────────────────────────────


def _policy(**kw: Any) -> AutonomousMaintenancePolicy:
    base: dict[str, Any] = {"org_id": "org_test"}
    base.update(kw)
    return AutonomousMaintenancePolicy(**base)


def test_observe_tier_always_allowed() -> None:
    p = _policy(maintenance_mode="observe")
    assert may(p, "alert") is True
    assert may(p, "investigate") is True


def test_observe_mode_denies_heal_and_patch() -> None:
    p = _policy(maintenance_mode="observe")
    assert decide(p, "cache_bust")[0] == "deny"
    assert decide(p, "propose_patch")[0] == "deny"


def test_assisted_allows_heal_but_patch_needs_approval() -> None:
    p = _policy(maintenance_mode="assisted")
    assert decide(p, "rollback")[0] == "allow"
    assert decide(p, "cache_bust")[0] == "allow"
    # code patch → require_approval in assisted mode
    assert decide(p, "propose_patch")[0] == "require_approval"


def test_assisted_pr_first_flag_off_still_requires_approval_not_deny() -> None:
    """Soft Autonomy Phase 3: the legacy ``code_change_enabled=False``
    master switch (auto_code_patch_pr=False) must NOT silently deny code
    PRs in assisted mode — drafting a plan is side-effect-free and the
    human Approve is the gate."""
    p = _policy(maintenance_mode="assisted", auto_code_patch_pr=False)
    verdict, reason, _tier = decide(p, "propose_patch")
    assert verdict == "require_approval"
    assert "approval" in reason


def test_autonomous_flag_off_still_denies() -> None:
    """In fully-autonomous mode the fine-grained flag still gates —
    no silent auto-execution without the explicit opt-in."""
    p = _policy(maintenance_mode="autonomous", auto_code_patch_pr=False)
    assert decide(p, "propose_patch")[0] == "deny"


def test_autonomous_allows_patch_pr() -> None:
    p = _policy(maintenance_mode="autonomous", auto_code_patch_pr=True)
    assert decide(p, "propose_patch")[0] == "allow"


def test_fine_grained_bound_disabled_denies() -> None:
    p = _policy(maintenance_mode="autonomous", auto_runtime_heal=False)
    assert decide(p, "rollback")[0] == "deny"


def test_hipaa_forces_observe() -> None:
    p = _policy(maintenance_mode="autonomous", compliance_profile="hipaa")
    assert p.effective_mode() == "observe"
    assert decide(p, "rollback")[0] == "deny"
    assert decide(p, "propose_patch")[0] == "deny"


def test_soc2_strict_forbids_auto_merge() -> None:
    p = _policy(
        maintenance_mode="autonomous",
        auto_code_patch_merge=True,
        compliance_profile="soc2_strict",
    )
    assert decide(p, "auto_merge")[0] == "deny"


# ── resolve (DB + config fallback) ──────────────────────────────────


@pytest.mark.asyncio
async def test_resolve_falls_back_to_config_defaults() -> None:
    pg = MagicMock()
    pg.fetchrow = AsyncMock(return_value=None)  # no stored row

    settings = MagicMock()
    settings.default_maintenance_mode = "assisted"
    settings.default_compliance_profile = "standard"
    settings.autonomous_actions_v0 = True
    settings.code_change_enabled = False
    settings.auto_pr_enabled = False
    settings.daily_maintenance_budget_usd = 25.0
    settings.max_auto_rollbacks_per_day = 3

    from eden.closed_loop import autonomy_policy as ap

    with patch.object(ap, "_redis", new=AsyncMock(return_value=None)), patch(
        "eden.storage.postgres.get_postgres_client", return_value=pg
    ), patch("eden.config.get_settings", return_value=settings):
        policy = await ap.resolve("org_test", "agent-1")

    assert policy.maintenance_mode == "assisted"
    assert policy.auto_runtime_heal is True
    assert policy.auto_code_patch_pr is False


@pytest.mark.asyncio
async def test_resolve_agent_override_beats_org_default() -> None:
    pg = MagicMock()

    async def _fetchrow(sql: str, *args: Any) -> dict[str, Any] | None:
        # agent-level query carries a second arg
        if "agent_id = $2" in " ".join(sql.split()):
            return {
                "policy": {"maintenance_mode": "autonomous"},
                "compliance_profile": "standard",
            }
        return {
            "policy": {"maintenance_mode": "observe"},
            "compliance_profile": "standard",
        }

    pg.fetchrow = AsyncMock(side_effect=_fetchrow)

    from eden.closed_loop import autonomy_policy as ap

    with patch.object(ap, "_redis", new=AsyncMock(return_value=None)), patch(
        "eden.storage.postgres.get_postgres_client", return_value=pg
    ):
        policy = await ap.resolve("org_test", "agent-1")

    assert policy.maintenance_mode == "autonomous"


# ── budget downgrade ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_evaluate_mode_downgrades_when_budget_exhausted() -> None:
    from eden.closed_loop import autonomy_policy as ap

    policy = _policy(maintenance_mode="autonomous", daily_maintenance_budget_usd=25.0)

    with patch.object(
        ap, "resolve", new=AsyncMock(return_value=policy)
    ), patch.object(
        ap, "check_budget", new=AsyncMock(return_value=(False, 30.0, 25.0))
    ), patch.object(ap, "audit", new=AsyncMock()):
        mode = await ap.evaluate_mode("org_test", action_type="rollback")

    assert mode == "observe"


@pytest.mark.asyncio
async def test_evaluate_mode_ok_within_budget() -> None:
    from eden.closed_loop import autonomy_policy as ap

    policy = _policy(maintenance_mode="autonomous", daily_maintenance_budget_usd=25.0)

    with patch.object(
        ap, "resolve", new=AsyncMock(return_value=policy)
    ), patch.object(
        ap, "check_budget", new=AsyncMock(return_value=(True, 1.0, 25.0))
    ):
        mode = await ap.evaluate_mode("org_test", action_type="rollback")

    assert mode == "autonomous"


# ── settings API round-trip ─────────────────────────────────────────


def _client() -> Any:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from eden.api.deps import get_current_user, require_path_org_access

    app = FastAPI()
    app.dependency_overrides[get_current_user] = lambda: {
        "sub": "u1",
        "org_id": "org_test",
    }
    app.dependency_overrides[require_path_org_access] = lambda: "org_test"
    import eden.api.routes.autonomy as mod

    async def _flag_on() -> None:
        return None

    for r in mod.router.routes:
        if not hasattr(r, "dependant"):
            continue
        for d in r.dependant.dependencies:
            if d.call.__name__ == "_dependency":
                app.dependency_overrides[d.call] = _flag_on
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_test"
    app.include_router(mod.router)
    return TestClient(app)


def test_get_autonomy_returns_effective_policy() -> None:
    from eden.closed_loop import autonomy_policy as ap

    policy = _policy(maintenance_mode="assisted")

    with patch.object(
        ap, "resolve", new=AsyncMock(return_value=policy)
    ), patch.object(
        ap, "check_budget", new=AsyncMock(return_value=(True, 2.0, 25.0))
    ):
        client = _client()
        r = client.get("/orgs/org_test/settings/autonomy")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["data"]["maintenance_mode"] == "assisted"
    assert body["data"]["effective_mode"] == "assisted"
    assert body["data"]["budget"]["limit_usd"] == 25.0


def test_patch_autonomy_rejects_invalid_mode() -> None:
    client = _client()
    r = client.patch(
        "/orgs/org_test/settings/autonomy",
        json={"maintenance_mode": "bogus"},
    )
    assert r.status_code == 200
    assert r.json()["status"] == "invalid"


def test_patch_autonomy_persists() -> None:
    from eden.closed_loop import autonomy_policy as ap

    updated = _policy(maintenance_mode="autonomous")

    with patch.object(
        ap, "upsert_policy", new=AsyncMock(return_value=updated)
    ):
        client = _client()
        r = client.patch(
            "/orgs/org_test/settings/autonomy",
            json={"maintenance_mode": "autonomous"},
        )

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["data"]["maintenance_mode"] == "autonomous"
