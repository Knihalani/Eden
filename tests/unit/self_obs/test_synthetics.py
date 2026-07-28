"""F84 admin status route tests."""

from __future__ import annotations

import pytest

pytest.importorskip("httpx")

from eden.self_obs.synthetics import run_golden_probes


@pytest.mark.asyncio
async def test_run_golden_probes_smoke():
    result = await run_golden_probes("org-test", probes=["gateway_health"])
    assert "probes" in result
    assert "gateway_health" in result["probes"]


@pytest.mark.asyncio
async def test_probe_gateway_health():
    from eden.self_obs.synthetics import probe_gateway_health

    out = await probe_gateway_health("org-test")
    assert out["status"] in ("ok", "fail", "degraded")


@pytest.mark.asyncio
async def test_probe_traces_list_queries_telemetry_events(monkeypatch):
    """probe_traces_list must hit telemetry_events (not missing telemetry_traces)."""
    from eden.self_obs import synthetics as syn
    import eden.storage.postgres as pg_mod

    captured: dict[str, object] = {}

    class _Client:
        async def fetchval(self, query: str, *args):
            captured["query"] = query
            captured["args"] = args
            return 3

    async def _pg():
        return _Client()

    monkeypatch.setattr(pg_mod, "get_postgres_client", _pg)

    out = await syn.probe_traces_list("org-abc")
    assert out["status"] == "ok"
    assert out["trace_count_sample"] == 3
    q = str(captured.get("query", ""))
    assert "telemetry_events" in q
    assert "telemetry_traces" not in q
    assert "GROUP BY trace_id" in q
    assert captured.get("args") == ("org-abc",)


@pytest.mark.asyncio
async def test_probe_traces_list_no_postgres(monkeypatch):
    from eden.self_obs import synthetics as syn
    import eden.storage.postgres as pg_mod

    async def _none():
        return None

    monkeypatch.setattr(pg_mod, "get_postgres_client", _none)
    out = await syn.probe_traces_list("org-abc")
    assert out["status"] == "degraded"
    assert "postgres" in out.get("error", "").lower()


# ── shared_results: org-independent probes must not scale with orgs ─


@pytest.mark.asyncio
async def test_run_golden_probes_reuses_shared_results_without_recalling_probe(
    monkeypatch,
):
    """When ``shared_results`` supplies a probe's result, the underlying
    probe function must not be re-invoked (guards the up-to-500x
    per-tick HTTP load regression) but the cached result must still be
    persisted for this org: ``GET /synthetics/last`` is a per-org read
    of ``eden_synthetic_runs``, so skipping persistence here would make
    the scheduled path never write ``sign_in_home`` / ``gateway_health``
    rows for any org (the O(0)-writes regression this guards against).
    """
    from eden.self_obs import synthetics as syn
    import eden.storage.postgres as pg_mod

    class _Client:
        async def fetchval(self, query: str, *args: object) -> int:
            return 0

    async def _pg():
        return _Client()

    monkeypatch.setattr(pg_mod, "get_postgres_client", _pg)

    call_count = 0

    async def _boom(org_id: str):
        nonlocal call_count
        call_count += 1
        raise AssertionError("sign_in_home must not be re-invoked when shared")

    persisted: list[tuple[str, str]] = []

    async def _fake_persist(org_id, probe, status, detail):
        persisted.append((org_id, probe))

    monkeypatch.setattr(syn, "_PROBE_FNS", {**syn._PROBE_FNS, "sign_in_home": _boom})
    monkeypatch.setattr(syn, "_persist_run", _fake_persist)

    result = await syn.run_golden_probes(
        "org-1",
        probes=["sign_in_home", "issues_list"],
        shared_results={"sign_in_home": {"status": "ok"}},
    )

    assert call_count == 0
    assert result["probes"]["sign_in_home"] == {"status": "ok"}
    assert result["failed"] == 0
    # issues_list is genuinely org-specific — it must still run + persist.
    assert ("org-1", "issues_list") in persisted
    # sign_in_home came from shared_results — the probe wasn't re-run,
    # but its cached result must still be persisted for this org so the
    # per-org dashboard sees it.
    assert ("org-1", "sign_in_home") in persisted


@pytest.mark.asyncio
async def test_run_golden_probes_shares_issue_count_between_list_and_detect(
    monkeypatch,
):
    """issues_list + detect_to_issue must share one agent_issues COUNT."""
    from eden.self_obs import synthetics as syn
    import eden.storage.postgres as pg_mod

    fetches: list[str] = []

    class _Client:
        async def fetchval(self, query: str, *args: object) -> int:
            fetches.append(query)
            return 7

    async def _pg():
        return _Client()

    monkeypatch.setattr(pg_mod, "get_postgres_client", _pg)

    async def _noop_persist(*_a, **_k):
        return None

    monkeypatch.setattr(syn, "_persist_run", _noop_persist)

    result = await syn.run_golden_probes(
        "org-1",
        probes=["issues_list", "detect_to_issue"],
    )

    assert result["probes"]["issues_list"]["issue_count"] == 7
    assert result["probes"]["detect_to_issue"]["issue_count"] == 7
    assert len(fetches) == 1


@pytest.mark.asyncio
async def test_shared_results_persisted_once_per_org_without_reinvoking_probe(
    monkeypatch,
):
    """End-to-end regression for the scheduler's O(1)-invocation /
    O(orgs)-persistence contract: ``run_org_independent_probes`` runs
    each org-independent probe exactly once per tick regardless of org
    count, and feeding that shared result into ``run_golden_probes`` for
    every org writes a per-org ``eden_synthetic_runs`` row for it (so
    ``GET /synthetics/last`` — scoped by ``org_id`` — stays fresh for
    every org) without ever re-invoking the probe function.
    """
    from eden.self_obs import synthetics as syn

    orgs = ["org-a", "org-b", "org-c"]

    call_count = 0

    async def _fake_sign_in(org_id: str):
        nonlocal call_count
        call_count += 1
        return {"status": "ok"}

    persisted: list[tuple[str, str, str]] = []

    async def _fake_persist(org_id, probe, status, detail):
        persisted.append((org_id, probe, status))

    monkeypatch.setattr(
        syn, "_PROBE_FNS", {**syn._PROBE_FNS, "sign_in_home": _fake_sign_in}
    )
    monkeypatch.setattr(syn, "_persist_run", _fake_persist)

    shared = await syn.run_org_independent_probes(probes=["sign_in_home"])
    assert call_count == 1  # invoked once per tick, not once per org

    for org_id in orgs:
        await syn.run_golden_probes(
            org_id, probes=["sign_in_home"], shared_results=shared
        )

    # still invoked exactly once regardless of org count
    assert call_count == 1
    # but persisted once per org, so each org's GET /synthetics/last sees it
    assert sorted(p[0] for p in persisted) == sorted(orgs)
    assert all(p[1] == "sign_in_home" and p[2] == "ok" for p in persisted)


@pytest.mark.asyncio
async def test_run_org_independent_probes_runs_each_probe_once(monkeypatch):
    from eden.self_obs import synthetics as syn

    calls: list[str] = []

    async def _fake_sign_in(org_id: str):
        calls.append(f"sign_in:{org_id}")
        return {"status": "ok"}

    async def _fake_gateway(org_id: str):
        calls.append(f"gateway:{org_id}")
        return {"status": "ok"}

    monkeypatch.setattr(
        syn,
        "_PROBE_FNS",
        {**syn._PROBE_FNS, "sign_in_home": _fake_sign_in, "gateway_health": _fake_gateway},
    )
    result = await syn.run_org_independent_probes()

    assert len(calls) == 2
    assert result["sign_in_home"] == {"status": "ok"}
    assert result["gateway_health"] == {"status": "ok"}
