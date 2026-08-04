"""MCP debugger parity — ``checkpoint_rerun`` (new) + ``get_transcript``.

``checkpoint_rerun`` invokes the F01 live-rerun path via the existing client
(no reimplementation) and preserves the debugger honesty conventions
(``rerun_mode`` + cache stats). ``get_transcript`` was already shipped; we
assert it stays registered and returns structured rows.
"""

from __future__ import annotations

from typing import Any

import pytest

from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.server import _HANDLERS, call_tool, list_tools


class _FakeClient:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, ...]] = []

    async def rerun_debugger(
        self,
        org_id: str,
        *,
        trace_id: str,
        from_step: int = 0,
        prompt_override: str | None = None,
        rerun_mode: str | None = None,
        live_prefix: bool | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            ("rerun", org_id, trace_id, from_step, rerun_mode, live_prefix)
        )
        return {
            "status": "ok",
            "trace_id": trace_id,
            "rerun_mode": rerun_mode,
            "cache_hits": 2,
            "populated_steps": 3,
            "diff": [],
        }

    async def get_transcript(
        self, org_id: str, trace_id: str, *, limit: int = 50
    ) -> dict[str, Any]:
        self.calls.append(("transcript", org_id, trace_id, limit))
        return {
            "status": "ok",
            "trace_id": trace_id,
            "rows": [{"role": "user", "content": "hi"}],
            "count": 1,
        }


def _debug_auth() -> McpAuthContext:
    return McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=("mcp:read", "mcp:debug", "mcp:fix"),
    )


def test_new_tools_registered() -> None:
    listed = {t["name"] for t in list_tools()}
    assert "checkpoint_rerun" in listed
    assert "get_transcript" in listed
    assert "checkpoint_rerun" in _HANDLERS
    assert "get_transcript" in _HANDLERS


@pytest.mark.asyncio
async def test_checkpoint_rerun_uses_live_path_and_returns_stats() -> None:
    fake = _FakeClient()
    out = await call_tool(
        "checkpoint_rerun",
        {"org_id": "org-1", "trace_id": "t1", "from_step": 2},
        client=fake,
        auth=_debug_auth(),
    )
    assert out["status"] == "ok"
    assert out["tool"] == "checkpoint_rerun"
    result = out["result"]
    # Honesty conventions surfaced from the debugger route.
    assert result["rerun_mode"] == "cached_live"
    assert result["cache_hits"] == 2
    assert result["populated_steps"] == 3
    # Delegated to the existing live-rerun client method with live defaults.
    assert fake.calls == [("rerun", "org-1", "t1", 2, "cached_live", True)]


@pytest.mark.asyncio
async def test_checkpoint_rerun_replay_mode_passthrough() -> None:
    fake = _FakeClient()
    out = await call_tool(
        "checkpoint_rerun",
        {"org_id": "org-1", "trace_id": "t1", "rerun_mode": "replay"},
        client=fake,
        auth=_debug_auth(),
    )
    assert out["status"] == "ok"
    assert out["result"]["rerun_mode"] == "replay"


@pytest.mark.asyncio
async def test_checkpoint_rerun_requires_debug_scope() -> None:
    read_only = McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=("mcp:read",),
    )
    out = await call_tool(
        "checkpoint_rerun",
        {"org_id": "org-1", "trace_id": "t1"},
        client=_FakeClient(),
        auth=read_only,
    )
    assert out["status"] == "error"


@pytest.mark.asyncio
async def test_get_transcript_returns_structured_rows() -> None:
    fake = _FakeClient()
    out = await call_tool(
        "get_transcript",
        {"org_id": "org-1", "trace_id": "t1"},
        client=fake,
        auth=_debug_auth(),
    )
    assert out["status"] == "ok"
    assert out["tool"] == "get_transcript"
    assert out["result"]["rows"] == [{"role": "user", "content": "hi"}]
    assert fake.calls == [("transcript", "org-1", "t1", 50)]
