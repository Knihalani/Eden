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
        live: bool | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            ("rerun", org_id, trace_id, from_step, rerun_mode, live_prefix, live)
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
    # BUG-28: `live` must default to False — never silently invoke/bill a
    # real model on the live gateway without an explicit opt-in.
    assert fake.calls == [("rerun", "org-1", "t1", 2, "cached_live", True, False)]


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
async def test_checkpoint_rerun_forwards_explicit_live_opt_in() -> None:
    """BUG-28: an explicit ``live=True`` must reach the client call."""
    fake = _FakeClient()
    out = await call_tool(
        "checkpoint_rerun",
        {"org_id": "org-1", "trace_id": "t1", "live": True},
        client=fake,
        auth=_debug_auth(),
    )
    assert out["status"] == "ok"
    assert fake.calls == [("rerun", "org-1", "t1", 0, "cached_live", True, True)]


@pytest.mark.asyncio
async def test_rerun_debugger_forwards_live_param() -> None:
    """BUG-28: the plain ``rerun_debugger`` tool also forwards ``live``."""
    fake = _FakeClient()
    out = await call_tool(
        "rerun_debugger",
        {"org_id": "org-1", "trace_id": "t1", "live": True},
        client=fake,
        auth=_debug_auth(),
    )
    assert out["status"] == "ok"
    assert fake.calls == [("rerun", "org-1", "t1", 0, None, None, True)]


@pytest.mark.asyncio
async def test_rerun_debugger_live_defaults_to_none() -> None:
    """Existing callers who don't pass ``live`` see no behavior change."""
    fake = _FakeClient()
    await call_tool(
        "rerun_debugger",
        {"org_id": "org-1", "trace_id": "t1"},
        client=fake,
        auth=_debug_auth(),
    )
    assert fake.calls == [("rerun", "org-1", "t1", 0, None, None, None)]


@pytest.mark.asyncio
async def test_http_client_rerun_debugger_includes_live_in_body(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BUG-28: ``HttpEdenClient.rerun_debugger`` must map ``live`` into the
    HTTP request body sent to ``POST /orgs/{org_id}/debugger/rerun``."""
    from eden.mcp_server.client import HttpEdenClient

    captured: dict[str, Any] = {}

    async def _fake_request(self, method, path, *, json_body=None, params=None):
        captured["method"] = method
        captured["path"] = path
        captured["json_body"] = json_body
        return {"status": "ok"}

    monkeypatch.setattr(HttpEdenClient, "_request", _fake_request)

    client = HttpEdenClient(auth=_debug_auth())
    await client.rerun_debugger(
        "org-1", trace_id="t1", from_step=2, live=True
    )

    assert captured["json_body"]["live"] is True

    captured.clear()
    await client.rerun_debugger("org-1", trace_id="t1")
    assert "live" not in captured["json_body"]


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
