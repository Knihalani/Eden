"""The scheduled self-obs tick must be bounded, concurrent and batched.

It used to list up to 500 orgs and ``await probe_org`` for each one
serially, at >=3 Postgres writes per org. That is >=1,500 sequential
round trips per tick — long enough that Postgres never goes idle at all,
regardless of how well the loop is aligned to the shared grid. Since this
is telemetry about ourselves rather than a user-facing guarantee, the tick
now probes a small rotating subset.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

import eden.self_obs.scheduler as scheduler_module


class _FakeClient:
    """Returns ``total`` synthetic org ids, honouring LIMIT and the cursor."""

    def __init__(self, total: int) -> None:
        self.all = [f"org-{i:04d}" for i in range(total)]
        self.limits: list[int] = []

    async def fetch(self, sql, *params):
        if "FROM organizations" not in sql:
            return []
        if "WHERE id > $1" in sql:
            cursor, limit = params[0], int(params[1])
            self.limits.append(limit)
            return [{"id": o} for o in self.all if o > cursor][:limit]
        limit = int(params[0])
        self.limits.append(limit)
        return [{"id": o} for o in self.all[:limit]]


def _install(monkeypatch, client):
    import eden.storage.postgres as pg

    async def _get_client():
        return client

    monkeypatch.setattr(pg, "get_postgres_client", _get_client)


@pytest.mark.asyncio
async def test_list_org_ids_respects_the_per_tick_budget(monkeypatch):
    from eden.config import get_settings

    scheduler_module._reset_rotation_for_tests()
    client = _FakeClient(total=500)
    _install(monkeypatch, client)

    budget = int(get_settings().self_obs_probe_org_budget)
    orgs = await scheduler_module._list_org_ids()

    assert len(orgs) == budget
    assert client.limits and all(limit == budget for limit in client.limits)
    assert budget < 500, "budget must actually bound a large fleet"


@pytest.mark.asyncio
async def test_successive_ticks_rotate_through_disjoint_windows(monkeypatch):
    scheduler_module._reset_rotation_for_tests()
    client = _FakeClient(total=500)
    _install(monkeypatch, client)

    first = await scheduler_module._list_org_ids()
    second = await scheduler_module._list_org_ids()
    third = await scheduler_module._list_org_ids()

    assert first and second and third
    assert set(first).isdisjoint(second), "a tick must not re-probe the previous set"
    assert set(second).isdisjoint(third)


@pytest.mark.asyncio
async def test_rotation_wraps_around_at_the_end_of_the_fleet(monkeypatch):
    scheduler_module._reset_rotation_for_tests()
    client = _FakeClient(total=3)
    _install(monkeypatch, client)

    first = await scheduler_module._list_org_ids()
    assert first == ["org-0000", "org-0001", "org-0002"]
    # Cursor is past the last org -> must wrap rather than return nothing
    # forever (which would silently stop all self-observability).
    second = await scheduler_module._list_org_ids()
    assert second == first


@pytest.mark.asyncio
async def test_tick_probes_at_most_the_budget_and_batches_heartbeats(monkeypatch):
    """The tick must not fan out beyond its budget, and must write once."""
    scheduler_module._reset_rotation_for_tests()
    client = _FakeClient(total=500)
    _install(monkeypatch, client)

    probed: list[str] = []

    async def _fake_probe_org(org_id, **kwargs):
        probed.append(org_id)
        sink = kwargs.get("heartbeat_sink")
        if sink is not None:
            sink.append(("background_workers", org_id, "healthy", {}))
        return {"degraded": False}

    batch = AsyncMock(return_value=True)
    with (
        patch.object(scheduler_module, "probe_org", side_effect=_fake_probe_org),
        patch.object(
            scheduler_module, "_previous_statuses_batch", AsyncMock(return_value={})
        ),
        patch(
            "eden.self_obs.synthetics.run_org_independent_probes",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "eden.self_obs.heartbeats.snapshot_worker_liveness",
            new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
        ),
        patch("eden.self_obs.heartbeats.record_heartbeats_batch", new=batch),
    ):
        result = await scheduler_module.run_scheduled_probes()

    from eden.config import get_settings

    budget = int(get_settings().self_obs_probe_org_budget)
    assert len(probed) <= budget
    assert result["orgs_scanned"] <= budget
    # One multi-row INSERT for the whole tick, not one per org.
    assert batch.await_count == 1
    rows = batch.await_args.args[0]
    assert len(rows) == len(probed)


@pytest.mark.asyncio
async def test_tick_is_concurrent_not_serial(monkeypatch):
    """Overlapping probes prove the sweep is not awaited one at a time."""
    import asyncio

    scheduler_module._reset_rotation_for_tests()
    _install(monkeypatch, _FakeClient(total=500))

    in_flight = 0
    peak = 0

    async def _fake_probe_org(org_id, **kwargs):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return {"degraded": False}

    with (
        patch.object(scheduler_module, "probe_org", side_effect=_fake_probe_org),
        patch.object(
            scheduler_module, "_previous_statuses_batch", AsyncMock(return_value={})
        ),
        patch(
            "eden.self_obs.synthetics.run_org_independent_probes",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "eden.self_obs.heartbeats.snapshot_worker_liveness",
            new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
        ),
    ):
        await scheduler_module.run_scheduled_probes()

    assert peak > 1, "probes ran serially; the tick holds Postgres open"


@pytest.mark.asyncio
async def test_one_org_failure_still_does_not_stop_the_sweep(monkeypatch):
    scheduler_module._reset_rotation_for_tests()
    _install(monkeypatch, _FakeClient(total=5))

    async def _fake_probe_org(org_id, **kwargs):
        if org_id == "org-0002":
            raise RuntimeError("boom")
        return {"degraded": org_id == "org-0003"}

    with (
        patch.object(scheduler_module, "probe_org", side_effect=_fake_probe_org),
        patch.object(
            scheduler_module, "_previous_statuses_batch", AsyncMock(return_value={})
        ),
        patch(
            "eden.self_obs.synthetics.run_org_independent_probes",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "eden.self_obs.heartbeats.snapshot_worker_liveness",
            new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
        ),
    ):
        result = await scheduler_module.run_scheduled_probes()

    assert result["orgs_scanned"] == 5
    assert result["degraded_orgs"] == ["org-0003"]


def test_heartbeat_batch_builds_one_statement_for_many_rows():
    """The batch writer must emit a single multi-row INSERT."""
    import asyncio

    from eden.self_obs import heartbeats

    captured: dict = {}

    class _C:
        async def execute(self, sql, *params):
            captured["sql"] = sql
            captured["params"] = params

    import eden.storage.postgres as pg

    original = pg.get_postgres_client

    async def _get():
        return _C()

    pg.get_postgres_client = _get  # type: ignore[assignment]
    try:
        rows = [("api", f"org-{i}", "healthy", {"i": i}) for i in range(4)]
        assert asyncio.run(heartbeats.record_heartbeats_batch(rows)) is True
    finally:
        pg.get_postgres_client = original  # type: ignore[assignment]

    assert captured["sql"].upper().count("INSERT INTO") == 1
    assert captured["sql"].count("(") >= 4
    assert len(captured["params"]) == 4 * 4
