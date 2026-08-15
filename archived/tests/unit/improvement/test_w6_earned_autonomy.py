"""Wave 6 pinning tests — earned autonomy (6.2 metric, 6.3 grant, 6.1 dogfood).

The documented acceptance criterion (``auto_merge.py`` +
``auto-merge-rollout.md``) is "5 consecutive clean auto-merges with zero
guardian regressions". These tests pin the streak computation (post-merge
watch all-ok = clean; pending = in flight; degrading = break) and the
automatic T4 grant that fires when the streak clears the threshold for
an opted-in org.
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.closed_loop.autonomy_policy import AutonomousMaintenancePolicy
from eden.improvement import earned_autonomy

ORG_ID = "00000000-0000-0000-0000-000000000001"


def _merged_evidence(*, manual: bool = True) -> dict:
    return {"auto_merge": {"merged": True, "manual": manual}}


def _plan(
    plan_id: str,
    *,
    windows: list[tuple[str, int]] | None = None,
    merged_at: datetime | None = None,
) -> dict:
    """One auto-merged plan row shape; ``windows`` = [(status, hours), ...]."""
    rows: list[dict] = []
    merged_at = merged_at or datetime(2026, 8, 1, tzinfo=UTC)
    if not windows:
        return [
            {
                "plan_id": plan_id,
                "title": f"plan-{plan_id}",
                "agent_id": "checkout-agent",
                "updated_at": merged_at,
                "evidence": _merged_evidence(),
                "window_status": None,
                "window_hours": None,
            }
        ]
    for status, hours in windows:
        rows.append(
            {
                "plan_id": plan_id,
                "title": f"plan-{plan_id}",
                "agent_id": "checkout-agent",
                "updated_at": merged_at,
                "evidence": _merged_evidence(),
                "window_status": status,
                "window_hours": hours,
            }
        )
    return rows


def _client(
    plan_rows: list[dict], *, fetchrow_value: dict | None = None
) -> MagicMock:
    client = MagicMock()
    client.fetch = AsyncMock(return_value=plan_rows)
    client.fetchrow = AsyncMock(return_value=fetchrow_value)
    return client


# ── 6.2 streak ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_streak_counts_consecutive_clean() -> None:
    rows: list[dict] = []
    for i in range(5):
        rows += _plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    client = _client(rows)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
    ):
        out = await earned_autonomy.clean_auto_merge_streak(ORG_ID)

    assert out["ok"] is True
    assert out["streak"] == 5
    assert out["earned"] is True
    assert out["total_auto_merged"] == 5
    assert out["in_flight"] == 0
    assert out["breaking_plan_id"] is None


@pytest.mark.asyncio
async def test_streak_skips_in_flight_head_but_counts_proven() -> None:
    # Newest plan still being watched; 5 older ones fully judged clean.
    rows = _plan("newest", windows=[("ok", 1), ("ok", 24), ("pending", 168)])
    for i in range(5):
        rows += _plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    client = _client(rows)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
    ):
        out = await earned_autonomy.clean_auto_merge_streak(ORG_ID)

    assert out["streak"] == 5  # proven clean only
    assert out["in_flight"] == 1
    assert out["earned"] is True


@pytest.mark.asyncio
async def test_streak_breaks_on_degrading_window() -> None:
    rows = _plan("good-1", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    rows += _plan("good-2", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    rows += _plan("bad", windows=[("ok", 1), ("degrading", 24), ("ok", 168)])
    client = _client(rows)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
    ):
        out = await earned_autonomy.clean_auto_merge_streak(ORG_ID)

    assert out["streak"] == 2
    assert out["breaking_plan_id"] == "bad"
    assert out["earned"] is False


@pytest.mark.asyncio
async def test_streak_stops_at_unproven_plan_without_windows() -> None:
    # Pre-Wave-4 merge (no windows) breaks the proven count conservatively.
    rows = _plan("clean-1", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    rows += _plan("clean-2", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    rows += _plan("legacy", windows=None)
    client = _client(rows)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
    ):
        out = await earned_autonomy.clean_auto_merge_streak(ORG_ID)

    assert out["streak"] == 2
    assert out["unproven"] == 1
    assert out["earned"] is False


@pytest.mark.asyncio
async def test_streak_empty_org() -> None:
    client = _client([])
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
    ):
        out = await earned_autonomy.clean_auto_merge_streak(ORG_ID)

    assert out["streak"] == 0
    assert out["total_auto_merged"] == 0
    assert out["earned"] is False


@pytest.mark.asyncio
async def test_streak_manual_merges_count_toward_the_ladder() -> None:
    """Manual merges of Eden PRs build the track record that earns T4."""
    rows = _plan("manual-1", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    rows += _plan("manual-2", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
    client = _client(rows)
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=2),
    ):
        out = await earned_autonomy.clean_auto_merge_streak(ORG_ID)

    assert out["streak"] == 2
    assert out["earned"] is True
    assert all(p["manual"] for p in out["recent"])


# ── 6.3 grant ───────────────────────────────────────────────────────


def _policy(**overrides: object) -> AutonomousMaintenancePolicy:
    base: dict[str, object] = {
        "org_id": ORG_ID,
        "maintenance_mode": "assisted",
        "auto_runtime_heal": True,
        "auto_code_patch_merge": False,
        "earned_autonomy_enabled": True,
        "compliance_profile": "standard",
    }
    base.update(overrides)
    return AutonomousMaintenancePolicy(**base)


@pytest.mark.asyncio
async def test_grant_flips_policy_and_audits() -> None:
    upsert = AsyncMock()
    audit = AsyncMock()
    rows = [
        r
        for sub in [
            _plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)])
            for i in range(5)
        ]
        for r in sub
    ]
    # Read-back check: the org-default row now holds T4 on disk.
    client = _client(rows, fetchrow_value={"policy": {"auto_code_patch_merge": True}})
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
        patch("eden.closed_loop.autonomy_policy.resolve", AsyncMock(return_value=_policy())),
        patch("eden.closed_loop.autonomy_policy.upsert_policy", upsert),
        patch("eden.closed_loop.autonomy_policy.audit", audit),
    ):
        out = await earned_autonomy.grant_if_earned(ORG_ID)

    assert out["granted"] is True
    assert out["streak"] == 5
    upsert.assert_awaited_once()
    # The flip targets the org default (agent_id=None) and nothing else.
    kwargs = upsert.await_args.kwargs
    assert kwargs["patch"] == {"auto_code_patch_merge": True}
    assert kwargs["agent_id"] is None
    assert kwargs["updated_by"] == "eden:earned_autonomy"
    audit.assert_awaited_once()
    assert audit.await_args.kwargs["action"] == "earned_autonomy_grant"


@pytest.mark.asyncio
async def test_grant_requires_opt_in() -> None:
    upsert = AsyncMock()
    rows = [r for sub in [_plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)]) for i in range(5)] for r in sub]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=_client(rows, fetchrow_value={"policy": {}})),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(return_value=_policy(earned_autonomy_enabled=False)),
        ),
        patch("eden.closed_loop.autonomy_policy.upsert_policy", upsert),
    ):
        out = await earned_autonomy.grant_if_earned(ORG_ID)

    assert out["granted"] is False
    assert out["reason"] == "not_opted_in"
    upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_grant_idempotent_when_already_granted() -> None:
    upsert = AsyncMock()
    rows = [r for sub in [_plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)]) for i in range(5)] for r in sub]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=_client(rows)),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(return_value=_policy(auto_code_patch_merge=True)),
        ),
        patch("eden.closed_loop.autonomy_policy.upsert_policy", upsert),
    ):
        out = await earned_autonomy.grant_if_earned(ORG_ID)

    assert out["granted"] is False
    assert out["reason"] == "already_granted"
    upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_grant_requires_streak() -> None:
    upsert = AsyncMock()
    rows = [r for sub in [_plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)]) for i in range(3)] for r in sub]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=_client(rows)),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
        patch("eden.closed_loop.autonomy_policy.resolve", AsyncMock(return_value=_policy())),
        patch("eden.closed_loop.autonomy_policy.upsert_policy", upsert),
    ):
        out = await earned_autonomy.grant_if_earned(ORG_ID)

    assert out["granted"] is False
    assert out["reason"] == "streak_not_earned"
    upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_grant_blocked_by_compliance() -> None:
    upsert = AsyncMock()
    rows = [r for sub in [_plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)]) for i in range(5)] for r in sub]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=_client(rows)),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
        patch(
            "eden.closed_loop.autonomy_policy.resolve",
            AsyncMock(return_value=_policy(compliance_profile="soc2_strict")),
        ),
        patch("eden.closed_loop.autonomy_policy.upsert_policy", upsert),
    ):
        out = await earned_autonomy.grant_if_earned(ORG_ID)

    assert out["granted"] is False
    assert out["reason"] == "compliance:soc2_strict"
    upsert.assert_not_awaited()


@pytest.mark.asyncio
async def test_grant_dry_run_does_not_write() -> None:
    upsert = AsyncMock()
    rows = [r for sub in [_plan(f"p-{i}", windows=[("ok", 1), ("ok", 24), ("ok", 168)]) for i in range(5)] for r in sub]
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=_client(rows)),
        ),
        patch.object(earned_autonomy, "_streak_threshold", return_value=5),
        patch("eden.closed_loop.autonomy_policy.resolve", AsyncMock(return_value=_policy())),
        patch("eden.closed_loop.autonomy_policy.upsert_policy", upsert),
    ):
        out = await earned_autonomy.grant_if_earned(ORG_ID, dry_run=True)

    assert out["granted"] == "would"
    upsert.assert_not_awaited()


# ── pre-existing fix: upsert must match migration 086 partial indexes ──


@pytest.mark.asyncio
async def test_upsert_policy_uses_predicate_conflict_targets() -> None:
    """``ON CONFLICT (org_id, agent_id)`` cannot infer against migration
    086's *partial* unique indexes — every policy PATCH silently failed
    to persist until the conflict targets carried the matching predicate.
    """
    from eden.closed_loop import autonomy_policy as ap

    client = MagicMock()
    client.execute = AsyncMock(return_value="INSERT 0 1")
    redis = AsyncMock()
    with (
        patch.object(ap, "_pg", AsyncMock(return_value=client)),
        patch.object(ap, "_redis", AsyncMock(return_value=redis)),
    ):
        await ap.upsert_policy(
            ORG_ID,
            agent_id=None,
            patch={"auto_runtime_heal": False},
            updated_by="test",
        )
        await ap.upsert_policy(
            ORG_ID,
            agent_id="checkout-agent",
            patch={"auto_runtime_heal": False},
            updated_by="test",
        )

    # upsert_policy also writes an audit row per call — filter the
    # policy upserts by table so the two conflict targets are compared.
    executes = [c.args[0] for c in client.execute.await_args_list]
    upserts = [s for s in executes if "INSERT INTO autonomy_policies" in s]
    assert len(upserts) == 2
    org_sql, agent_sql = upserts
    assert "ON CONFLICT (org_id) WHERE agent_id IS NULL" in org_sql
    assert "ON CONFLICT (org_id, agent_id) WHERE agent_id IS NOT NULL" in agent_sql


# ── trigger: post-merge monitor re-evaluates affected orgs ──────────


@pytest.mark.asyncio
async def test_run_due_grants_earned_orgs() -> None:
    from eden.improvement.post_merge_monitor import PostMergeMonitor

    client = MagicMock()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "w-1",
                "org_id": ORG_ID,
                "plan_id": "p-1",
                "agent_id": "checkout-agent",
                "window_hours": 168,
                "opened_at": datetime(2026, 7, 1, tzinfo=UTC),
                "closes_at": datetime(2026, 7, 8, tzinfo=UTC),
                "pre_issue_rate": 0.0,
            }
        ]
    )
    grant = AsyncMock(
        return_value={"granted": True, "streak": 5, "threshold": 5, "earned": True}
    )
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(PostMergeMonitor, "_evaluate_window", AsyncMock(return_value=("ok", None))),
        patch("eden.improvement.earned_autonomy.grant_if_earned", grant),
    ):
        out = await PostMergeMonitor().run_due()

    assert out["inspected"] == 1
    assert out["ok"] == 1
    assert out["earned_grants"] == 1
    grant.assert_awaited_once_with(ORG_ID)
