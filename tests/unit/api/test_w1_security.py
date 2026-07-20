"""Wave 1 security suites — spoof, scopes, RLS helpers, PII fail-closed."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from eden.api.deps import (
    GATEWAY_SCOPES,
    INGEST_SCOPES,
    MCP_SCOPES,
    api_key_has_scope,
)


# ── Scope helper ────────────────────────────────────────────────────


def test_api_key_has_scope_empty_fail_closed() -> None:
    assert not api_key_has_scope(None, INGEST_SCOPES)
    assert not api_key_has_scope([], GATEWAY_SCOPES)


def test_api_key_has_scope_legacy_no_grandfather() -> None:
    assert not api_key_has_scope(["references:read", "jobs:write"], INGEST_SCOPES)
    assert not api_key_has_scope(["references:read"], GATEWAY_SCOPES)


def test_api_key_has_scope_strict_when_family_present() -> None:
    assert api_key_has_scope(["ingest:write", "references:read"], INGEST_SCOPES)
    assert not api_key_has_scope(["gateway:write"], INGEST_SCOPES)
    assert api_key_has_scope(["gateway:*"], GATEWAY_SCOPES)
    assert api_key_has_scope(["mcp:read"], MCP_SCOPES)
    assert not api_key_has_scope(["mcp:read"], GATEWAY_SCOPES)


def test_api_key_has_scope_star() -> None:
    assert api_key_has_scope(["*"], INGEST_SCOPES)
    assert api_key_has_scope(["*"], GATEWAY_SCOPES)


# ── X-Org-Id spoof ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_assert_org_header_rejects_mismatch() -> None:
    from eden.api.deps import _assert_org_header_matches_session

    payload = {"o": {"id": "org_session"}, "sub": "user_1"}

    async def _resolve(oid: str | None) -> str | None:
        if not oid:
            return None
        return f"eden-{oid}"

    with patch("eden.api.deps.resolve_eden_org_id", side_effect=_resolve):
        with pytest.raises(HTTPException) as ei:
            await _assert_org_header_matches_session(
                x_org_id="org_foreign",
                payload=payload,
                is_clerk=True,
            )
        assert ei.value.status_code == 403
        assert "does not match" in str(ei.value.detail)


@pytest.mark.asyncio
async def test_assert_org_header_allows_matching() -> None:
    from eden.api.deps import _assert_org_header_matches_session

    payload = {"o": {"id": "org_ok"}, "sub": "user_1"}

    async def _resolve(oid: str | None) -> str | None:
        if not oid:
            return None
        # Header may be Eden UUID or Clerk id — both resolve to same.
        if oid in ("org_ok", "eden-uuid"):
            return "eden-uuid"
        return f"eden-{oid}"

    with (
        patch("eden.api.deps.resolve_eden_org_id", side_effect=_resolve),
        patch("eden.api.deps.extract_org_id", return_value="org_ok"),
    ):
        trusted = await _assert_org_header_matches_session(
            x_org_id="eden-uuid",
            payload=payload,
            is_clerk=True,
        )
        assert trusted == "eden-uuid"


@pytest.mark.asyncio
async def test_get_current_org_member_no_upsert_on_spoof() -> None:
    """Foreign X-Org-Id must 403 before ensure_clerk_membership."""
    from eden.api import deps as deps_mod

    payload = {
        "sub": "user_clerk_1",
        "o": {"id": "org_mine"},
        "org_id": "org_mine",
    }

    async def _resolve(oid: str | None) -> str | None:
        mapping = {"org_mine": "eden-mine", "org_other": "eden-other"}
        return mapping.get(oid or "", oid)

    with (
        patch.object(deps_mod, "_resolve_token_payload", return_value=payload),
        patch.object(deps_mod, "_is_clerk_payload_public", return_value=True),
        patch.object(deps_mod, "extract_org_id", return_value="org_mine"),
        patch.object(deps_mod, "extract_user_id", return_value="user_clerk_1"),
        patch.object(deps_mod, "extract_org_role", return_value="org:admin"),
        patch.object(deps_mod, "resolve_eden_user_id", AsyncMock(return_value="u1")),
        patch.object(deps_mod, "resolve_eden_org_id", side_effect=_resolve),
        patch.object(
            deps_mod,
            "ensure_clerk_membership",
            new_callable=AsyncMock,
        ) as upsert,
    ):
        with pytest.raises(HTTPException) as ei:
            await deps_mod.get_current_org_member(
                x_org_id="org_other",
                payload=payload,
            )
        assert ei.value.status_code == 403
        upsert.assert_not_called()


# ── Admin status: no pg_stat_activity ────────────────────────────────


def test_admin_status_has_no_pg_stat_activity() -> None:
    from pathlib import Path

    src = Path(__file__).resolve().parents[3] / "src/eden/api/routes/admin_status.py"
    text = src.read_text(encoding="utf-8")
    assert "pg_stat_activity" not in text
    assert "require_org_admin" in text


# ── RLS GUC cast ────────────────────────────────────────────────────


def test_rls_middleware_casts_org_id_text() -> None:
    from pathlib import Path

    src = (
        Path(__file__).resolve().parents[3]
        / "src/eden/api/middleware/rls_org_context.py"
    )
    text = src.read_text(encoding="utf-8")
    assert "set_config('app.current_org_id', $1::text, true)" in text


# ── PII fail-closed Typesense ───────────────────────────────────────


def test_typesense_build_span_doc_fail_closed_on_mask_error() -> None:
    from eden.data_platform.pii import PIIMaskingError
    from eden.observability.telemetry_collector import TelemetryEvent
    from eden.observability.typesense_client import build_span_doc

    event = TelemetryEvent(
        event_id="e1",
        tenant_id="t1",
        project_id="default",
        trace_id="tr1",
        realm="prod",
        event_type="llm_call",
        timestamp="2026-07-17T00:00:00Z",
        request_body={"messages": [{"role": "user", "content": "ssn 123-45-6789"}]},
        response_body={"content": "ok"},
    )

    with patch(
        "eden.data_platform.pii.PIIMasker.mask",
        side_effect=PIIMaskingError("credential"),
    ):
        with pytest.raises(PIIMaskingError):
            build_span_doc(event)


# ── VALID_SCOPES includes ingest/gateway/mcp ─────────────────────────


def test_valid_scopes_include_wave1_families() -> None:
    from eden.api.routes.api_keys import VALID_SCOPES

    for s in (
        "ingest:write",
        "gateway:write",
        "mcp:read",
        "mcp:debug",
        "mcp:fix",
    ):
        assert s in VALID_SCOPES


# ── MCP require_scope ────────────────────────────────────────────────


def test_mcp_require_scope_rejects_foreign() -> None:
    from eden.mcp_server.auth import McpAuthContext, require_scope

    ctx = McpAuthContext(api_key="k", base_url="http://x", org_id="o1", scopes=("mcp:read",))
    require_scope(ctx, "mcp:read")
    with pytest.raises(PermissionError):
        require_scope(ctx, "mcp:fix")
