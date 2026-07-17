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
