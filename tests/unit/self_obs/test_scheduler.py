"""F84 — regression tests for scheduled self-obs probes + degraded alerts.

``probe_and_record_workers`` / ``run_golden_probes`` used to only run
on-demand with no notification on failure. ``eden.self_obs.scheduler``
adds the periodic orchestration + transition-only alerting that
``eden.workers.main``'s new leader-gated loop calls.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


# ── _is_new_degradation: the anti-spam core ─────────────────────────


def test_is_new_degradation_transition_from_healthy():
    from eden.self_obs.scheduler import _is_new_degradation

    assert _is_new_degradation("healthy", "degraded") is True
    assert _is_new_degradation("ok", "fail") is True
    assert _is_new_degradation(None, "degraded") is True


def test_is_new_degradation_false_while_already_degraded():
    """Must not re-fire every tick while the outage is ongoing."""
    from eden.self_obs.scheduler import _is_new_degradation

    assert _is_new_degradation("degraded", "degraded") is False
    assert _is_new_degradation("fail", "fail") is False
    assert _is_new_degradation("degraded", "fail") is False


def test_is_new_degradation_false_when_staying_healthy():
    from eden.self_obs.scheduler import _is_new_degradation

    assert _is_new_degradation("healthy", "healthy") is False
    assert _is_new_degradation("ok", "ok") is False


# ── probe_org: transition detection wired to the real probe fns ────


@pytest.mark.asyncio
async def test_probe_org_notifies_on_new_degradation():
    from eden.self_obs import scheduler as scheduler_module

    with patch(
        "eden.self_obs.scheduler._previous_status",
        new=AsyncMock(return_value="healthy"),
    ), patch(
        "eden.self_obs.heartbeats.probe_and_record_workers",
        new=AsyncMock(return_value={"status": "degraded", "meta": {"x": 1}}),
    ), patch(
        "eden.self_obs.synthetics.run_golden_probes",
        new=AsyncMock(return_value={"failed": 0, "probes": {}}),
    ), patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ), patch(
        "eden.services.alert_email.send_self_obs_degraded_email",
        new=AsyncMock(),
    ) as notify_mock:
        result = await scheduler_module.probe_org("org-1")

    assert result["degraded"] is True
    notify_mock.assert_awaited_once()
    kwargs = notify_mock.await_args.kwargs
    assert kwargs["org_id"] == "org-1"
    assert kwargs["component"] == "background_workers"
    assert kwargs["status"] == "degraded"


@pytest.mark.asyncio
async def test_probe_org_does_not_notify_while_already_degraded():
    """No new transition → no email, even though the status is bad."""
    from eden.self_obs import scheduler as scheduler_module

    with patch(
        "eden.self_obs.scheduler._previous_status",
        new=AsyncMock(return_value="degraded"),
    ), patch(
        "eden.self_obs.heartbeats.probe_and_record_workers",
        new=AsyncMock(return_value={"status": "degraded", "meta": {}}),
    ), patch(
        "eden.self_obs.synthetics.run_golden_probes",
        new=AsyncMock(return_value={"failed": 0, "probes": {}}),
    ), patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ), patch(
        "eden.services.alert_email.send_self_obs_degraded_email",
        new=AsyncMock(),
    ) as notify_mock:
        result = await scheduler_module.probe_org("org-1")

    assert result["degraded"] is True
    notify_mock.assert_not_awaited()


@pytest.mark.asyncio
async def test_probe_org_notifies_for_golden_probe_failure():
    from eden.self_obs import scheduler as scheduler_module

    with patch(
        "eden.self_obs.scheduler._previous_status",
        new=AsyncMock(return_value="ok"),
    ), patch(
        "eden.self_obs.heartbeats.probe_and_record_workers",
        new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
    ), patch(
        "eden.self_obs.synthetics.run_golden_probes",
        new=AsyncMock(
            return_value={"failed": 1, "probes": {"traces_list": {"status": "fail"}}}
        ),
    ), patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ), patch(
        "eden.services.alert_email.send_self_obs_degraded_email",
        new=AsyncMock(),
    ) as notify_mock:
        result = await scheduler_module.probe_org("org-2")

    assert result["degraded"] is True
    notify_mock.assert_awaited_once()
    assert notify_mock.await_args.kwargs["component"] == "golden_probes"


# ── run_scheduled_probes: per-org aggregation + isolation ───────────


@pytest.mark.asyncio
async def test_run_scheduled_probes_aggregates_degraded_orgs():
    from eden.self_obs import scheduler as scheduler_module

    async def _fake_probe_org(org_id: str, **_kwargs):
        return {"degraded": org_id == "org-bad"}

    with patch.object(
        scheduler_module, "probe_org", side_effect=_fake_probe_org
    ), patch(
        "eden.self_obs.synthetics.run_org_independent_probes",
        new=AsyncMock(return_value={}),
    ), patch(
        "eden.self_obs.heartbeats.snapshot_worker_liveness",
        new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
    ), patch(
        "eden.self_obs.scheduler._previous_statuses_batch",
        new=AsyncMock(return_value={}),
    ):
        result = await scheduler_module.run_scheduled_probes(
            org_ids=["org-good", "org-bad"]
        )

    assert result["orgs_scanned"] == 2
    assert result["degraded_orgs"] == ["org-bad"]


@pytest.mark.asyncio
async def test_run_scheduled_probes_runs_org_independent_probes_once_per_tick():
    """sign_in_home/gateway_health must run once per tick, not once per
    org — the up-to-500x-per-tick load regression this guards against.
    Worker liveness is process-scoped and must also snapshot once.
    """
    from eden.self_obs import scheduler as scheduler_module

    shared_result = {
        "sign_in_home": {"status": "ok"},
        "gateway_health": {"status": "ok"},
    }
    golden_calls: list[tuple[str, dict | None]] = []

    async def _fake_run_golden_probes(org_id, probes=None, *, shared_results=None):
        golden_calls.append((org_id, shared_results))
        return {"org_id": org_id, "probes": {}, "failed": 0}

    org_ids = [f"org-{i}" for i in range(5)]

    with patch(
        "eden.self_obs.synthetics.run_org_independent_probes",
        new=AsyncMock(return_value=shared_result),
    ) as shared_mock, patch(
        "eden.self_obs.heartbeats.snapshot_worker_liveness",
        new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
    ) as snap_mock, patch(
        "eden.self_obs.scheduler._previous_statuses_batch",
        new=AsyncMock(
            return_value={
                oid: {"background_workers": "healthy", "golden_probes": "ok"}
                for oid in org_ids
            }
        ),
    ), patch(
        "eden.self_obs.synthetics.run_golden_probes",
        new=AsyncMock(side_effect=_fake_run_golden_probes),
    ), patch(
        "eden.self_obs.heartbeats.record_worker_heartbeats", new=AsyncMock()
    ), patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ):
        result = await scheduler_module.run_scheduled_probes(org_ids=org_ids)

    assert result["orgs_scanned"] == 5
    # Exactly once regardless of org count — this is the regression check.
    shared_mock.assert_awaited_once()
    snap_mock.assert_awaited_once()
    assert len(golden_calls) == 5
    for _, shared in golden_calls:
        assert shared == shared_result


@pytest.mark.asyncio
async def test_run_scheduled_probes_snapshots_workers_once_not_per_org():
    from eden.self_obs import scheduler as scheduler_module

    org_ids = ["org-a", "org-b", "org-c"]
    with patch(
        "eden.self_obs.synthetics.run_org_independent_probes",
        new=AsyncMock(return_value={}),
    ), patch(
        "eden.self_obs.heartbeats.snapshot_worker_liveness",
        new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
    ) as snap_mock, patch(
        "eden.self_obs.heartbeats.probe_and_record_workers",
        new=AsyncMock(),
    ) as probe_mock, patch(
        "eden.self_obs.scheduler._previous_statuses_batch",
        new=AsyncMock(
            return_value={
                oid: {"background_workers": "healthy", "golden_probes": "ok"}
                for oid in org_ids
            }
        ),
    ), patch(
        "eden.self_obs.synthetics.run_golden_probes",
        new=AsyncMock(return_value={"failed": 0, "probes": {}}),
    ), patch(
        "eden.self_obs.heartbeats.record_worker_heartbeats", new=AsyncMock()
    ) as fanout_mock, patch(
        "eden.self_obs.heartbeats.record_heartbeat", new=AsyncMock()
    ):
        await scheduler_module.run_scheduled_probes(org_ids=org_ids)

    snap_mock.assert_awaited_once()
    probe_mock.assert_not_awaited()
    assert fanout_mock.await_count == 3


@pytest.mark.asyncio
async def test_run_scheduled_probes_one_org_failure_does_not_stop_the_sweep():
    from eden.self_obs import scheduler as scheduler_module

    async def _fake_probe_org(org_id: str, **_kwargs):
        if org_id == "org-boom":
            raise RuntimeError("db exploded")
        return {"degraded": False}

    with patch.object(
        scheduler_module, "probe_org", side_effect=_fake_probe_org
    ), patch(
        "eden.self_obs.synthetics.run_org_independent_probes",
        new=AsyncMock(return_value={}),
    ), patch(
        "eden.self_obs.heartbeats.snapshot_worker_liveness",
        new=AsyncMock(return_value={"status": "healthy", "meta": {}}),
    ), patch(
        "eden.self_obs.scheduler._previous_statuses_batch",
        new=AsyncMock(return_value={}),
    ):
        result = await scheduler_module.run_scheduled_probes(
            org_ids=["org-boom", "org-fine"]
        )

    assert result["orgs_scanned"] == 2
    assert result["degraded_orgs"] == []
