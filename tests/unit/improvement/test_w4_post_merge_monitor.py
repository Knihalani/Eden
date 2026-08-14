"""Wave 4 pinning tests — post-merge guard (4.1 producer, 4.2 comparator, 4.3 surface).

The post-merge watch closes the ship→verify gap: ``mark_merged`` (the
choke point every merge path funnels through) opens 1h/24h/7d windows
via ``PostMergeMonitor.schedule_for_plan``, and the cron-hosted
``run_due`` compares the agent's post-merge issue rate against the
pre-merge snapshot — closing clean windows ``ok`` and filing an
``advisory`` follow-up (linked via ``parent_plan_id``) on a material
regression.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.improvement import plans_repo
from eden.improvement.post_merge_monitor import PostMergeMonitor

ORG_ID = "00000000-0000-0000-0000-000000000001"
AGENT_ID = "checkout-agent"
PLAN_ID = "11111111-1111-1111-1111-111111111111"


def _mock_client() -> MagicMock:
    client = MagicMock()
    client.execute = AsyncMock(return_value="UPDATE 1")
    client.fetch = AsyncMock(return_value=[])
    client.fetchval = AsyncMock(return_value=0)
    client.fetchrow = AsyncMock(return_value=None)
    return client


def _plan_row(**overrides: object) -> dict[str, object]:
    row: dict[str, object] = {
        "id": PLAN_ID,
        "org_id": ORG_ID,
        "agent_id": AGENT_ID,
        "status": "merged",
        "files_changed": [],
        "evidence": {},
    }
    row.update(overrides)
    return row


# ── 4.1 producer ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_schedule_for_plan_opens_1h_24h_7d_windows() -> None:
    client = _mock_client()
    # INSERT ... RETURNING id — one row per window insert.
    client.fetch = AsyncMock(return_value=[{"id": "w1"}])
    client.fetchval = AsyncMock(return_value=48.0)  # baseline issues / 168h

    monitor = PostMergeMonitor()
    with patch(
        "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=client)
    ):
        opened = await monitor.schedule_for_plan(ORG_ID, _plan_row())

    assert opened == 3
    # Baseline rate: 48 issues / 168h lookback.
    baseline_args = client.fetchval.await_args.args
    assert baseline_args[1] == ORG_ID
    assert baseline_args[2] == AGENT_ID
    assert baseline_args[3] == 168

    # Three inserts, one per window, sharing the pre-merge snapshot.
    inserts = [c.args for c in client.fetch.await_args_list]
    assert len(inserts) == 3
    hours = [i[4] for i in inserts]
    assert hours == [1, 24, 168]
    for i in inserts:
        assert i[1] == ORG_ID
        assert i[2] == PLAN_ID
        assert i[3] == AGENT_ID
        assert i[6] == pytest.approx(48.0 / 168.0)


@pytest.mark.asyncio
async def test_schedule_for_plan_is_idempotent_on_remerge() -> None:
    client = _mock_client()
    # Second delivery: every INSERT conflicts → zero rows returned.
    client.fetch = AsyncMock(return_value=[])

    monitor = PostMergeMonitor()
    with patch(
        "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=client)
    ):
        opened = await monitor.schedule_for_plan(ORG_ID, _plan_row())

    assert opened == 0


@pytest.mark.asyncio
async def test_schedule_for_plan_skips_without_agent() -> None:
    monitor = PostMergeMonitor()
    with patch(
        "eden.storage.postgres.get_postgres_client", AsyncMock(side_effect=AssertionError("no db calls"))
    ):
        assert await monitor.schedule_for_plan(ORG_ID, _plan_row(agent_id=None)) == 0


# ── 4.2 comparator ──────────────────────────────────────────────────


def _due_window(*, hours: int = 24, pre_rate: float = 0.3) -> dict[str, object]:
    opened = datetime(2026, 8, 1, tzinfo=UTC)
    return {
        "id": f"pmw_{hours}",
        "org_id": ORG_ID,
        "plan_id": PLAN_ID,
        "agent_id": AGENT_ID,
        "window_hours": hours,
        "opened_at": opened,
        "closes_at": opened + timedelta(hours=hours),
        "pre_issue_rate": pre_rate,
    }


@pytest.mark.asyncio
async def test_run_due_closes_clean_window_ok() -> None:
    """Issue-rate quiet is not a leftover SHIP. Thin leftover n stays pending."""
    client = _mock_client()
    client.fetch = AsyncMock(return_value=[_due_window(hours=24, pre_rate=0.3)])
    client.fetchval = AsyncMock(return_value=1)  # 1 issue in window

    monitor = PostMergeMonitor()
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(
            monitor, "_threshold_pct", AsyncMock(return_value=10.0)
        ),
        patch("eden.improvement.plans_repo.emit_event", AsyncMock()) as emit,
    ):
        summary = await monitor.run_due()

    assert summary == {
        "inspected": 1,
        "ok": 0,
        "degrading": 0,
        "follow_ups": 0,
        "earned_grants": 0,  # Wave 6 — no streak re-eval grants here
    }
    # Leftover n missing → pending, not a clean ship. No ok event.
    update = client.execute.await_args.args
    assert update[3] == "pending"
    assert update[6] is None
    emit.assert_not_awaited()


@pytest.mark.asyncio
async def test_run_due_flags_material_regression_and_files_follow_up() -> None:
    client = _mock_client()
    client.fetch = AsyncMock(return_value=[_due_window(hours=24, pre_rate=0.1)])
    # 10 issues over 24h = 0.42/h vs 0.1/h baseline → +316% ≫ 10%.
    client.fetchval = AsyncMock(return_value=10)
    follow_up = _plan_row(id="22222222-2222-2222-2222-222222222222")
    created: list[dict[str, object]] = []

    async def fake_create_plan(org_id: str, **kwargs: object) -> dict[str, object]:
        created.append(kwargs)
        return follow_up

    monitor = PostMergeMonitor()
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(
            monitor, "_threshold_pct", AsyncMock(return_value=10.0)
        ),
        patch("eden.improvement.plans_repo.emit_event", AsyncMock()) as emit,
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(side_effect=fake_create_plan),
        ),
    ):
        summary = await monitor.run_due()

    assert summary == {
        "inspected": 1,
        "ok": 0,
        "degrading": 1,
        "follow_ups": 1,
        "earned_grants": 0,  # Wave 6 — no streak re-eval grants here
    }
    # Advisory follow-up linked via parent_plan_id (D9-safe, no code patch).
    assert created and created[0]["plan_kind"] == "advisory"
    assert created[0]["parent_plan_id"] == PLAN_ID
    assert created[0]["agent_id"] == AGENT_ID
    # Window marked degrading with the follow-up wired in.
    update = client.execute.await_args.args
    assert update[3] == "degrading"
    assert update[6] == follow_up["id"]
    # Regression event trails for the portal.
    event_args = emit.await_args.args
    assert event_args[2] == "post_merge_degrading"


@pytest.mark.asyncio
async def test_run_due_flags_zero_baseline_regression() -> None:
    """0 pre-merge issues → N post-merge = brand-new failure mode.

    The most important regression to catch: no baseline means no % delta,
    but a material issue count with a clean history is still degrading
    (and the window must not show a misleading 0% delta).
    """
    client = _mock_client()
    client.fetch = AsyncMock(return_value=[_due_window(hours=24, pre_rate=0.0)])
    client.fetchval = AsyncMock(return_value=5)  # 5 new issues, clean baseline
    follow_up = _plan_row(id="33333333-3333-3333-3333-333333333333")

    monitor = PostMergeMonitor()
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(
            monitor, "_threshold_pct", AsyncMock(return_value=10.0)
        ),
        patch("eden.improvement.plans_repo.emit_event", AsyncMock()),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(return_value=follow_up),
        ),
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=None),
        ),
    ):
        summary = await monitor.run_due()

    assert summary == {
        "inspected": 1,
        "ok": 0,
        "degrading": 1,
        "follow_ups": 1,
        "earned_grants": 0,  # Wave 6 — no streak re-eval grants here
    }
    update = client.execute.await_args.args
    assert update[3] == "degrading"
    # No baseline → delta stays null (portal renders no misleading %).
    assert update[5] is None


@pytest.mark.asyncio
async def test_run_due_does_not_duplicate_follow_up_on_retry() -> None:
    """A retried evaluation reuses the open advisory instead of re-filing."""
    client = _mock_client()
    client.fetch = AsyncMock(return_value=[_due_window(hours=24, pre_rate=0.1)])
    client.fetchval = AsyncMock(return_value=10)
    existing = _plan_row(id="44444444-4444-4444-4444-444444444444")

    monitor = PostMergeMonitor()
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=client),
        ),
        patch.object(
            monitor, "_threshold_pct", AsyncMock(return_value=10.0)
        ),
        patch("eden.improvement.plans_repo.emit_event", AsyncMock()),
        patch(
            "eden.improvement.plans_repo.find_open_by_fingerprint",
            AsyncMock(return_value=existing),
        ),
        patch(
            "eden.improvement.plans_repo.create_plan",
            AsyncMock(side_effect=AssertionError("must not re-file")),
        ),
    ):
        summary = await monitor.run_due()

    assert summary == {
        "inspected": 1,
        "ok": 0,
        "degrading": 1,
        "follow_ups": 1,
        "earned_grants": 0,  # Wave 6 — no streak re-eval grants here
    }
    # Reuses the existing advisory id instead of creating a duplicate.
    update = client.execute.await_args.args
    assert update[6] == existing["id"]


@pytest.mark.asyncio
async def test_run_due_skips_when_postgres_unavailable() -> None:
    monitor = PostMergeMonitor()
    with patch(
        "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=None)
    ):
        summary = await monitor.run_due()
    assert summary == {"skipped": True, "reason": "postgres_unavailable"}


# ── 4.1 choke-point wiring (mark_merged → schedule_for_plan) ────────


@pytest.mark.asyncio
async def test_mark_merged_opens_post_merge_watch() -> None:
    client = _mock_client()
    client.fetchrow = AsyncMock(
        return_value=_plan_row(status="merged", files_changed=[], evidence={})
    )
    schedule = AsyncMock(return_value=3)

    with (
        patch.object(
            plans_repo, "get_postgres_client", AsyncMock(return_value=client)
        ),
        patch(
            "eden.patches.knowledge_graph.record_plan_outcome", AsyncMock()
        ),
        patch("eden.improvement.plans_repo.emit_event", AsyncMock()),
        patch(
            "eden.improvement.post_merge_monitor.PostMergeMonitor",
            MagicMock(return_value=MagicMock(schedule_for_plan=schedule)),
        ),
    ):
        plan = await plans_repo.mark_merged(ORG_ID, PLAN_ID)

    assert plan is not None
    assert plan["status"] == "merged"
    schedule.assert_awaited_once_with(ORG_ID, plan)


# ── 4.3 portal surface ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_post_merge_windows_serializes_route_shape() -> None:
    from eden.api.routes.improve import _list_post_merge_windows

    client = _mock_client()
    client.fetch = AsyncMock(
        return_value=[
            {
                "id": "pmw-1",
                "plan_id": PLAN_ID,
                "agent_id": AGENT_ID,
                "window_hours": 24,
                "status": "degrading",
                "opened_at": datetime(2026, 8, 1, tzinfo=UTC),
                "closes_at": datetime(2026, 8, 2, tzinfo=UTC),
                "pre_issue_rate": 0.1,
                "post_issue_rate": 0.42,
                "delta_pct": 316.0,
                "follow_up_plan_id": "22222222-2222-2222-2222-222222222222",
                "evaluated_at": datetime(2026, 8, 2, tzinfo=UTC),
            }
        ]
    )
    with patch(
        "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=client)
    ):
        windows = await _list_post_merge_windows(ORG_ID, PLAN_ID)

    assert len(windows) == 1
    w = windows[0]
    assert w["status"] == "degrading"
    assert w["delta_pct"] == 316.0
    assert w["follow_up_plan_id"] == "22222222-2222-2222-2222-222222222222"
    # Query is org-scoped (tenant confinement without RLS).
    assert client.fetch.await_args.args[1] == ORG_ID
    assert client.fetch.await_args.args[2] == PLAN_ID
