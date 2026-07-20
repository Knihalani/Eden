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
