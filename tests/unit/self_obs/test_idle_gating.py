"""Idle-load gating — synthetics activity gate + heartbeat write gate.

(a) ``run_golden_probes`` (scheduled path only, i.e. when
    ``shared_results`` is supplied) skips org-scoped probes for orgs
    with no real telemetry in the last 24h, cached per org for 1h,
    failing OPEN when the activity signal is unavailable.

(b) ``record_heartbeats_batch`` / ``record_worker_heartbeats`` write a
    row only when its status CHANGED since the last written value, plus
    a keepalive rewrite every ``EDEN_HEARTBEAT_KEEPALIVE_S`` (default
    6h) so ``checked_at`` still proves liveness.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


# ── (a) synthetics: per-org activity gate ───────────────────────────


def _install_pg(monkeypatch, client):
    import eden.storage.postgres as pg_mod

    async def _pg():
        return client

    monkeypatch.setattr(pg_mod, "get_postgres_client", _pg)


class _ActivityClient:
    """fetchval answers the activity probe; records every query."""

    def __init__(self, active: bool):
        self.active = active
        self.fetchval_queries: list[str] = []

    async def fetchval(self, query: str, *args: object):
        self.fetchval_queries.append(query)
        if "telemetry_events" in query and "interval '24 hours'" in query:
            return 1 if self.active else None
        return 0  # issue/trace counts for org-scoped probes


@pytest.mark.asyncio
async def test_scheduled_probes_skip_org_scoped_probes_for_idle_org(monkeypatch):
    """No telemetry in 24h + scheduled path => org-scoped probes are
    neither invoked nor persisted; shared results still flow through."""
    from eden.self_obs import synthetics as syn

    syn._reset_activity_cache_for_tests()
    _install_pg(monkeypatch, _ActivityClient(active=False))

    async def _boom(org_id: str):
        raise AssertionError("org-scoped probe must not run for an idle org")

    persisted: list[tuple[str, str]] = []

    async def _fake_persist(org_id, probe, status, detail):
        persisted.append((org_id, probe))

    monkeypatch.setattr(
        syn, "_PROBE_FNS", {**syn._PROBE_FNS, "issues_list": _boom}
    )
    monkeypatch.setattr(syn, "_persist_run", _fake_persist)

    result = await syn.run_golden_probes(
        "org-idle",
        probes=["sign_in_home", "issues_list"],
        shared_results={"sign_in_home": {"status": "ok"}},
    )

    assert result["skipped_idle"] is True
    assert result["probes"] == {"sign_in_home": {"status": "ok"}}
    assert result["failed"] == 0
    assert persisted == []


@pytest.mark.asyncio
async def test_scheduled_probes_run_for_active_org(monkeypatch):
    from eden.self_obs import synthetics as syn

    syn._reset_activity_cache_for_tests()
    _install_pg(monkeypatch, _ActivityClient(active=True))

    persisted: list[tuple[str, str]] = []

    async def _fake_persist(org_id, probe, status, detail):
        persisted.append((org_id, probe))

    monkeypatch.setattr(syn, "_persist_run", _fake_persist)

    result = await syn.run_golden_probes(
        "org-active",
        probes=["sign_in_home", "issues_list"],
        shared_results={"sign_in_home": {"status": "ok"}},
    )

    assert "skipped_idle" not in result
    assert result["probes"]["issues_list"]["status"] == "ok"
    assert ("org-active", "issues_list") in persisted


@pytest.mark.asyncio
async def test_activity_verdict_cached_per_org_for_an_hour(monkeypatch):
    from eden.self_obs import synthetics as syn

    syn._reset_activity_cache_for_tests()
    client = _ActivityClient(active=False)
    _install_pg(monkeypatch, client)

    clock = {"t": 1000.0}
    monkeypatch.setattr(syn, "_monotonic", lambda: clock["t"])

    assert await syn._org_had_recent_events("org-x") is False
    assert await syn._org_had_recent_events("org-x") is False
    assert len(client.fetchval_queries) == 1  # second hit served from cache

    clock["t"] += syn._ACTIVITY_CACHE_TTL_S + 1
    assert await syn._org_had_recent_events("org-x") is False
    assert len(client.fetchval_queries) == 2  # expired -> re-asked

    # A different org gets its own entry.
    assert await syn._org_had_recent_events("org-y") is False
    assert len(client.fetchval_queries) == 3


@pytest.mark.asyncio
async def test_activity_check_fails_open_and_does_not_cache(monkeypatch):
    """Any error => probes run as before, and the failure is not cached
    so the next call re-asks."""
    from eden.self_obs import synthetics as syn

    syn._reset_activity_cache_for_tests()
    import eden.storage.postgres as pg_mod

    calls = {"n": 0}

    async def _broken():
        calls["n"] += 1
        raise RuntimeError("pg down")

    monkeypatch.setattr(pg_mod, "get_postgres_client", _broken)

    assert await syn._org_had_recent_events("org-x") is True
    assert await syn._org_had_recent_events("org-x") is True
    assert calls["n"] == 2  # fail-open verdicts are never cached
    assert syn._org_activity_cache == {}


@pytest.mark.asyncio
async def test_on_demand_calls_are_never_gated(monkeypatch):
    """Without ``shared_results`` (admin route / MCP tool) the activity
    gate must not even be consulted."""
    from eden.self_obs import synthetics as syn

    syn._reset_activity_cache_for_tests()
    _install_pg(monkeypatch, _ActivityClient(active=False))

    async def _gate_must_not_run(org_id: str) -> bool:
        raise AssertionError("activity gate must not run on-demand")

    monkeypatch.setattr(syn, "_org_had_recent_events", _gate_must_not_run)

    async def _noop_persist(*_a, **_k):
        return None

    monkeypatch.setattr(syn, "_persist_run", _noop_persist)

    result = await syn.run_golden_probes("org-idle", probes=["issues_list"])
    assert result["probes"]["issues_list"]["status"] == "ok"


# ── (b) heartbeats: status-change write gate + keepalive ────────────


class _ExecClient:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.executed: list[tuple[str, tuple]] = []

    async def execute(self, sql: str, *params: object):
        if self.fail:
            raise RuntimeError("pg down")
        self.executed.append((sql, params))


@pytest.mark.asyncio
async def test_batch_writes_everything_once_then_nothing_while_unchanged(
    monkeypatch,
):
    from eden.self_obs import heartbeats as hb

    hb._reset_write_gate_for_tests()
    client = _ExecClient()
    _install_pg(monkeypatch, client)

    clock = {"t": 1000.0}
    monkeypatch.setattr(hb, "_monotonic", lambda: clock["t"])

    rows = [
        ("background_workers", "org-1", "healthy", {}),
        ("api", "org-1", "healthy", {}),
    ]
    assert await hb.record_heartbeats_batch(list(rows)) is True
    assert len(client.executed) == 1
    assert len(client.executed[0][1]) == 4 * 2  # both rows written

    # Same statuses next tick: nothing written, still True.
    clock["t"] += 600
    assert await hb.record_heartbeats_batch(list(rows)) is True
    assert len(client.executed) == 1


@pytest.mark.asyncio
async def test_batch_writes_only_the_changed_row(monkeypatch):
    from eden.self_obs import heartbeats as hb

    hb._reset_write_gate_for_tests()
    client = _ExecClient()
    _install_pg(monkeypatch, client)

    clock = {"t": 1000.0}
    monkeypatch.setattr(hb, "_monotonic", lambda: clock["t"])

    await hb.record_heartbeats_batch(
        [
            ("background_workers", "org-1", "healthy", {}),
            ("api", "org-1", "healthy", {}),
        ]
    )
    clock["t"] += 600
    assert (
        await hb.record_heartbeats_batch(
            [
                ("background_workers", "org-1", "degraded", {}),
                ("api", "org-1", "healthy", {}),
            ]
        )
        is True
    )
    assert len(client.executed) == 2
    _sql, params = client.executed[1]
    assert len(params) == 4  # only the changed background_workers row
    assert params[0] == "background_workers"
    assert params[2] == "degraded"


@pytest.mark.asyncio
async def test_keepalive_rewrites_unchanged_rows(monkeypatch):
    from eden.self_obs import heartbeats as hb

    hb._reset_write_gate_for_tests()
    client = _ExecClient()
    _install_pg(monkeypatch, client)

    clock = {"t": 1000.0}
    monkeypatch.setattr(hb, "_monotonic", lambda: clock["t"])

    rows = [("api", "org-1", "healthy", {})]
    await hb.record_heartbeats_batch(list(rows))
    assert len(client.executed) == 1

    clock["t"] += 21600 - 1  # just under the default keepalive
    await hb.record_heartbeats_batch(list(rows))
    assert len(client.executed) == 1

    clock["t"] += 2  # crosses the 6h default
    await hb.record_heartbeats_batch(list(rows))
    assert len(client.executed) == 2


@pytest.mark.asyncio
async def test_keepalive_interval_configurable_via_env(monkeypatch):
    from eden.self_obs import heartbeats as hb

    hb._reset_write_gate_for_tests()
    client = _ExecClient()
    _install_pg(monkeypatch, client)
    monkeypatch.setenv("EDEN_HEARTBEAT_KEEPALIVE_S", "100")

    clock = {"t": 1000.0}
    monkeypatch.setattr(hb, "_monotonic", lambda: clock["t"])

    rows = [("api", "org-1", "healthy", {})]
    await hb.record_heartbeats_batch(list(rows))
    clock["t"] += 101
    await hb.record_heartbeats_batch(list(rows))
    assert len(client.executed) == 2


@pytest.mark.asyncio
async def test_failed_flush_does_not_update_the_gate(monkeypatch):
    """A dropped INSERT must be retried in full on the next tick."""
    from eden.self_obs import heartbeats as hb

    hb._reset_write_gate_for_tests()
    broken = _ExecClient(fail=True)
    _install_pg(monkeypatch, broken)

    rows = [("api", "org-1", "healthy", {})]
    assert await hb.record_heartbeats_batch(list(rows)) is False

    working = _ExecClient()
    _install_pg(monkeypatch, working)
    assert await hb.record_heartbeats_batch(list(rows)) is True
    assert len(working.executed) == 1


@pytest.mark.asyncio
async def test_worker_heartbeats_direct_path_is_gated(monkeypatch):
    from eden.self_obs import heartbeats as hb

    hb._reset_write_gate_for_tests()
    clock = {"t": 1000.0}
    monkeypatch.setattr(hb, "_monotonic", lambda: clock["t"])

    # Pretend both rows were just written with these statuses.
    hb._note_written("background_workers", "org-1", "healthy", clock["t"])
    hb._note_written("api", "org-1", "healthy", clock["t"])

    single = AsyncMock()
    monkeypatch.setattr(hb, "record_heartbeat", single)

    clock["t"] += 600
    await hb.record_worker_heartbeats(
        "org-1", {"status": "healthy", "meta": {}}
    )
    assert single.await_count == 0  # unchanged: no writes

    await hb.record_worker_heartbeats(
        "org-1", {"status": "degraded", "meta": {}}
    )
    # Only the changed background_workers row; "api" stays suppressed.
    assert single.await_count == 1
    assert single.await_args.args[0] == "background_workers"
    assert single.await_args.kwargs["status"] == "degraded"


@pytest.mark.asyncio
async def test_worker_heartbeats_sink_path_still_collects_rows(monkeypatch):
    """Sink rows are appended unfiltered — the gate applies at the
    batch flush, keeping ``record_heartbeats_batch`` the single point
    of write-suppression for the scheduled tick."""
    from eden.self_obs import heartbeats as hb

    hb._reset_write_gate_for_tests()
    hb._note_written("background_workers", "org-1", "healthy", 0.0)

    sink: list = []
    await hb.record_worker_heartbeats(
        "org-1", {"status": "healthy", "meta": {}}, sink=sink
    )
    assert [(r[0], r[1], r[2]) for r in sink] == [
        ("background_workers", "org-1", "healthy"),
        ("api", "org-1", "healthy"),
    ]
