"""BUG-22 — ``label_tool_call`` must validate the caller-supplied
``agent_id`` against the span/trace's telemetry-derived owner instead of
persisting it verbatim.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from eden.learning.tool_call_labels import ToolCallLabelService


class _FakePg:
    """Minimal pg stand-in for ``telemetry_events`` + identity lookups."""

    def __init__(
        self,
        *,
        span_owner: dict[str, str] | None = None,
        trace_owner: dict[str, str] | None = None,
        registered: set[str] | None = None,
        aliases: dict[str, str] | None = None,
    ) -> None:
        self.span_owner = span_owner or {}
        self.trace_owner = trace_owner or {}
        self.registered = registered or set()
        self.aliases = aliases or {}

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        org_id = args[0]
        assert org_id == "org_test"
        if "FROM telemetry_events" in sql and "span_id = $2" in sql:
            span_id = args[1]
            agent_id = self.span_owner.get(span_id)
            return {"agent_id": agent_id} if agent_id else None
        if "FROM telemetry_events" in sql and "trace_id = $2" in sql:
            trace_id = args[1]
            agent_id = self.trace_owner.get(trace_id)
            return {"agent_id": agent_id} if agent_id else None
        if "FROM agent_registrations" in sql:
            key = args[1]
            return {"ok": True} if key in self.registered else None
        if "FROM agent_identity_aliases" in sql:
            key = args[1]
            agent_id = self.aliases.get(key)
            return {"agent_id": agent_id} if agent_id else None
        return None


def _patch_pg(monkeypatch: pytest.MonkeyPatch, pg: _FakePg) -> None:
    async def _get_client() -> _FakePg:
        return pg

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_client
    )


@pytest.mark.asyncio
async def test_matching_agent_id_passes_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pg = _FakePg(
        span_owner={"sp1": "agent-a"},
        registered={"agent-a"},
    )
    _patch_pg(monkeypatch, pg)
    svc = ToolCallLabelService()

    resolved = await svc.resolve_and_validate_agent_id(
        "org_test", "sp1", "trace-1", "agent-a"
    )

    assert resolved == "agent-a"


@pytest.mark.asyncio
async def test_mismatched_agent_id_raises_permission_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A caller claiming a *different* agent's span must be rejected."""
    pg = _FakePg(
        span_owner={"sp1": "agent-real-owner"},
        registered={"agent-real-owner", "agent-attacker"},
    )
    _patch_pg(monkeypatch, pg)
    svc = ToolCallLabelService()

    with pytest.raises(PermissionError):
        await svc.resolve_and_validate_agent_id(
            "org_test", "sp1", "trace-1", "agent-attacker"
        )


@pytest.mark.asyncio
async def test_none_agent_id_is_derived_from_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pg = _FakePg(
        span_owner={"sp1": "agent-a"},
        registered={"agent-a"},
    )
    _patch_pg(monkeypatch, pg)
    svc = ToolCallLabelService()

    resolved = await svc.resolve_and_validate_agent_id(
        "org_test", "sp1", "trace-1", None
    )

    assert resolved == "agent-a"


@pytest.mark.asyncio
async def test_synthetic_label_alias_resolves_to_same_canonical_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Caller supplies the canonical id while telemetry only has the
    synthetic fleet label -- they must resolve to the same agent and pass."""
    pg = _FakePg(
        span_owner={"sp1": "pydantic-ai:OpenAIChatModel()"},
        registered={"agent-canonical"},
        aliases={"pydantic-ai:OpenAIChatModel()": "agent-canonical"},
    )
    _patch_pg(monkeypatch, pg)
    svc = ToolCallLabelService()

    resolved = await svc.resolve_and_validate_agent_id(
        "org_test", "sp1", "trace-1", "agent-canonical"
    )

    assert resolved == "agent-canonical"


@pytest.mark.asyncio
async def test_falls_back_to_trace_owner_when_span_has_no_telemetry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pg = _FakePg(
        trace_owner={"trace-1": "agent-a"},
        registered={"agent-a"},
    )
    _patch_pg(monkeypatch, pg)
    svc = ToolCallLabelService()

    resolved = await svc.resolve_and_validate_agent_id(
        "org_test", "sp-unknown", "trace-1", "agent-a"
    )

    assert resolved == "agent-a"


@pytest.mark.asyncio
async def test_no_telemetry_at_all_passes_caller_value_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No telemetry to validate against -- fail open rather than block a
    legitimate label because ingestion lagged/dropped the row."""
    pg = _FakePg()
    _patch_pg(monkeypatch, pg)
    svc = ToolCallLabelService()

    resolved = await svc.resolve_and_validate_agent_id(
        "org_test", "sp-unseen", "trace-unseen", "agent-anything"
    )

    assert resolved == "agent-anything"


@pytest.mark.asyncio
async def test_postgres_unavailable_passes_caller_value_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _get_client() -> None:
        return None

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _get_client
    )
    svc = ToolCallLabelService()

    resolved = await svc.resolve_and_validate_agent_id(
        "org_test", "sp1", "trace-1", "agent-a"
    )

    assert resolved == "agent-a"


@pytest.mark.asyncio
async def test_route_maps_permission_error_to_403() -> None:
    """HTTP route must surface ownership failures as 403, not 500."""
    from eden.api.routes.tool_call_labels import (
        LabelToolCallRequest,
        _svc,
        label_tool_call,
    )

    with patch.object(
        _svc,
        "create_label",
        AsyncMock(side_effect=PermissionError("agent_id mismatch")),
    ):
        with pytest.raises(HTTPException) as exc_info:
            await label_tool_call(
                span_id="sp1",
                body=LabelToolCallRequest(
                    trace_id="trace-1",
                    tool_name="search",
                    label="good",
                    agent_id="wrong-agent",
                ),
                org_id="org_test",
                user={"sub": "user-1"},
            )

    assert exc_info.value.status_code == 403
    assert "agent_id mismatch" in str(exc_info.value.detail)
