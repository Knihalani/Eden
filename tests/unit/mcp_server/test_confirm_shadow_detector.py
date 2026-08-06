"""MCP tool — ``confirm_shadow_detector`` (P0-D, FEAT-27).

Lets an MCP client (Cursor/Claude) confirm/dismiss a shadow detector (Loop 1
signal feedback) the same way the issues UI does, via a thin wrapper over
``record_shadow_feedback`` (§6.5).
"""

from __future__ import annotations

import pytest

from eden.mcp_server.auth import McpAuthContext
from eden.mcp_server.server import _HANDLERS, call_tool, list_tools


def _fix_auth() -> McpAuthContext:
    return McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=("mcp:read", "mcp:debug", "mcp:fix"),
    )


def test_confirm_shadow_detector_registered() -> None:
    listed = {t["name"] for t in list_tools()}
    assert "confirm_shadow_detector" in listed
    assert "confirm_shadow_detector" in _HANDLERS


@pytest.mark.asyncio
async def test_confirm_shadow_detector_confirm_calls_record_shadow_feedback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, bool | None, bool | None]] = []

    async def _fake_record(org_id, signal_id, *, confirm=None, dismiss=None):
        calls.append((org_id, signal_id, confirm, dismiss))
        return True

    monkeypatch.setattr(
        "eden.services.soft_issue_review.record_shadow_feedback", _fake_record
    )

    out = await call_tool(
        "confirm_shadow_detector",
        {"org_id": "org-1", "signal_id": "sig-1", "confirm_or_dismiss": "confirm"},
        client=object(),
        auth=_fix_auth(),
    )

    assert out["status"] == "ok"
    assert out["tool"] == "confirm_shadow_detector"
    assert out["result"]["updated"] is True
    assert calls == [("org-1", "sig-1", True, None)]


@pytest.mark.asyncio
async def test_confirm_shadow_detector_dismiss_calls_record_shadow_feedback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, str, bool | None, bool | None]] = []

    async def _fake_record(org_id, signal_id, *, confirm=None, dismiss=None):
        calls.append((org_id, signal_id, confirm, dismiss))
        return True

    monkeypatch.setattr(
        "eden.services.soft_issue_review.record_shadow_feedback", _fake_record
    )

    out = await call_tool(
        "confirm_shadow_detector",
        {"org_id": "org-1", "signal_id": "sig-1", "confirm_or_dismiss": "dismiss"},
        client=object(),
        auth=_fix_auth(),
    )

    assert out["status"] == "ok"
    assert out["result"]["updated"] is True
    assert calls == [("org-1", "sig-1", None, True)]


@pytest.mark.asyncio
async def test_confirm_shadow_detector_rejects_bad_arg() -> None:
    out = await call_tool(
        "confirm_shadow_detector",
        {"org_id": "org-1", "signal_id": "sig-1", "confirm_or_dismiss": "maybe"},
        client=object(),
        auth=_fix_auth(),
    )
    # Dispatch itself succeeds; the handler surfaces its own validation error.
    assert out["status"] == "ok"
    assert out["result"]["status"] == "error"


@pytest.mark.asyncio
async def test_confirm_shadow_detector_requires_fix_scope() -> None:
    read_only = McpAuthContext(
        api_key="test-key",
        base_url="http://127.0.0.1:8000",
        org_id="org-1",
        scopes=("mcp:read",),
    )
    out = await call_tool(
        "confirm_shadow_detector",
        {"org_id": "org-1", "signal_id": "sig-1", "confirm_or_dismiss": "confirm"},
        client=object(),
        auth=read_only,
    )
    assert out["status"] == "error"
