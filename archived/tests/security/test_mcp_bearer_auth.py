"""``/v1/mcp`` must verify its bearer token against ``org_api_keys``.

Regression lock for the 2026-07 remediation.

The transport used to check only that an ``Authorization`` header was
*present*::

    if not api_key:
        return _rpc_error(..., http_status=401)

and ``resolve_auth`` then granted ``mcp:read + mcp:debug + mcp:fix`` to any
non-empty string. Nothing hashed the key, looked it up, or checked it belonged
to the supplied ``X-Org-Id``. ``MCP_SCOPES`` had no consumer at all.

The org-mismatch guard was not a defence: both the header and the tool argument
are attacker-supplied, so comparing them proves nothing. The org must come from
the verified key row — which is what these tests pin.

Compounding it, ``HttpEdenClient`` implemented none of the generic verbs, so
``tools.py``'s ``hasattr(client, "get"/"post")`` probes fell through to *local*
implementations that query Postgres directly — including a write via
``label_tool_call``. That made the hole an unauthenticated cross-tenant
read **and** write.
"""

from __future__ import annotations

import pytest

from eden.mcp_server.auth import resolve_auth
from eden.mcp_server.errors import McpAuthError, McpScopeError
from eden.mcp_server.verify import _mcp_scopes_for, verify_mcp_bearer


class TestNoUnconditionalGrant:
    def test_garbage_key_does_not_get_full_scopes(self) -> None:
        """The exact call that used to return mcp:read+debug+fix."""
        ctx = resolve_auth(
            api_key="totally-bogus-not-a-real-key", org_id="org_VICTIM"
        )
        assert ctx.scopes == ("mcp:read",)
        assert "mcp:fix" not in ctx.scopes
        assert "mcp:debug" not in ctx.scopes

    def test_resolve_auth_is_stdio_only(self) -> None:
        """HTTP callers must not be able to mint a context this way."""
        assert resolve_auth(api_key="k").transport == "stdio"


class TestScopeResolution:
    @pytest.mark.parametrize(
        ("stored", "expected"),
        [
            (["mcp:read"], ("mcp:read",)),
            (["mcp:read", "mcp:fix"], ("mcp:fix", "mcp:read")),
            (["*"], ("mcp:read", "mcp:debug", "mcp:fix")),
            (["mcp:*"], ("mcp:read", "mcp:debug", "mcp:fix")),
            (["ingest:write"], ()),
            ([], ()),
            (None, ()),
        ],
    )
    def test_only_stored_mcp_scopes_are_granted(
        self, stored: list[str] | None, expected: tuple[str, ...]
    ) -> None:
        assert _mcp_scopes_for({"scopes": stored}) == expected


class TestVerifyBearer:
    @pytest.mark.asyncio
    async def test_missing_key_is_rejected(self) -> None:
        with pytest.raises(McpAuthError):
            await verify_mcp_bearer(
                api_key=None, org_id_header="org_a", base_url="http://x"
            )

    @pytest.mark.asyncio
    async def test_blank_key_is_rejected(self) -> None:
        with pytest.raises(McpAuthError):
            await verify_mcp_bearer(
                api_key="   ", org_id_header="org_a", base_url="http://x"
            )

    @pytest.mark.asyncio
    async def test_missing_org_header_is_rejected(self) -> None:
        """Without an org there is nothing to scope the key lookup to."""
        with pytest.raises(McpAuthError):
            await verify_mcp_bearer(
                api_key="k", org_id_header=None, base_url="http://x"
            )

    @pytest.mark.asyncio
    async def test_unknown_key_is_rejected_without_touching_tools(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A garbage bearer must never reach a tool handler."""
        import eden.api.deps as deps
        import eden.api.routes.api_keys as api_keys

        async def _resolve(org_id: str | None) -> str:
            return "org-resolved"

        async def _validate(org_id: str, key: str) -> None:
            return None  # key not found

        monkeypatch.setattr(deps, "resolve_eden_org_id", _resolve)
        monkeypatch.setattr(api_keys, "validate_org_api_key", _validate)

        with pytest.raises(McpAuthError):
            await verify_mcp_bearer(
                api_key="totally-bogus-not-a-real-key",
                org_id_header="org_VICTIM",
                base_url="http://x",
            )

    @pytest.mark.asyncio
    async def test_key_without_mcp_scope_is_forbidden(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A valid ingest key is not an MCP key."""
        import eden.api.deps as deps
        import eden.api.routes.api_keys as api_keys

        async def _resolve(org_id: str | None) -> str:
            return "org-resolved"

        async def _validate(org_id: str, key: str) -> dict:
            return {"org_id": "org-resolved", "scopes": ["ingest:write"]}

        monkeypatch.setattr(deps, "resolve_eden_org_id", _resolve)
        monkeypatch.setattr(api_keys, "validate_org_api_key", _validate)

        with pytest.raises(McpScopeError):
            await verify_mcp_bearer(
                api_key="real-ingest-key",
                org_id_header="org_a",
                base_url="http://x",
            )

    @pytest.mark.asyncio
    async def test_org_comes_from_the_verified_row_not_the_header(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The property the old mismatch comparison could not provide."""
        import eden.api.deps as deps
        import eden.api.routes.api_keys as api_keys

        async def _resolve(org_id: str | None) -> str:
            return "org-resolved"

        async def _validate(org_id: str, key: str) -> dict:
            return {"org_id": "org-from-row", "scopes": ["mcp:read"]}

        monkeypatch.setattr(deps, "resolve_eden_org_id", _resolve)
        monkeypatch.setattr(api_keys, "validate_org_api_key", _validate)

        ctx = await verify_mcp_bearer(
            api_key="real-key", org_id_header="org_a", base_url="http://x"
        )
        assert ctx.org_id == "org-from-row"
        assert ctx.transport == "http"
        assert ctx.scopes == ("mcp:read",)


class TestLocalFallbacksUnreachableOverHttp:
    def test_http_client_implements_the_generic_verbs(self) -> None:
        """These absences are what routed HTTP callers into local Postgres.

        ``tools.py`` probes ``hasattr(client, "get"/"post")`` at twelve sites
        and falls back to a direct database implementation when they are
        missing. Providing them keeps every HTTP tool call on the API path.
        """
        from eden.mcp_server.client import HttpEdenClient

        assert hasattr(HttpEdenClient, "get")
        assert hasattr(HttpEdenClient, "post")
