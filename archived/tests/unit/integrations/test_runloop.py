"""Unit tests for the Runloop integration.

These tests focus on the no-op-when-disabled behaviour and the
shape of the devbox spec; they do NOT spin up real Runloop
Devboxes (that requires network + credentials).
"""
from __future__ import annotations

import pytest

from eden.integrations.runloop import RunloopClient, RunloopDevboxSpec


@pytest.mark.asyncio
async def test_create_devbox_is_a_stub_when_api_key_missing():
    client = RunloopClient(api_key="", enabled=False)
    spec = RunloopDevboxSpec(blueprint_id="bp_test", name="test")
    devbox = await client.create_devbox(spec)
    assert devbox.state == "stub"
    assert devbox.id.startswith("null-")


@pytest.mark.asyncio
async def test_execute_returns_stub_marker_when_disabled():
    client = RunloopClient(api_key="", enabled=False)
    spec = RunloopDevboxSpec(blueprint_id="bp_test", name="test")
    devbox = await client.create_devbox(spec)
    result = await client.execute(devbox, "echo hello")
    assert result["stub"] is True
    assert result["exit_code"] == 0


@pytest.mark.asyncio
async def test_destroy_is_safe_when_disabled():
    client = RunloopClient(api_key="", enabled=False)
    spec = RunloopDevboxSpec(blueprint_id="bp_test", name="test")
    devbox = await client.create_devbox(spec)
    # Should not raise.
    await client.destroy(devbox)


def test_devbox_spec_metadata_round_trip():
    spec = RunloopDevboxSpec(
        blueprint_id="bp_x",
        name="n",
        env_vars={"FOO": "bar"},
        metadata={"trace_id": "t_1"},
    )
    assert spec.env_vars == {"FOO": "bar"}
    assert spec.metadata == {"trace_id": "t_1"}
