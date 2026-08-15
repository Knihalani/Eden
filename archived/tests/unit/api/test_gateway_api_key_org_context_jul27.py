"""Regression tests — 2026-07-27 adversarial-review follow-up.

The CRITICAL fix in ``RLSOrgContextMiddleware`` (2026-07-27,
``_has_verified_identity``) stopped an unauthenticated ``X-Org-Id``
header from being trusted as the RLS tenant boundary, but the first
cut only recognized the Eden cookie JWT and the Clerk Bearer JWT —
NOT ``X-Org-Api-Key``, a third, fully legitimate,
cryptographically-verified auth mechanism (SHA-256 hash lookup
against ``org_api_keys.key_hash``; see ``get_current_org_api_key`` /
``_ingestion_auth_impl`` in ``eden.api.deps``).

The AI Gateway (``gateway.router``, mounted at ``/gateway/v1`` with
no ``{org_id}`` path param) authenticates purely via
``X-Org-Api-Key`` + ``X-Org-Id`` headers. Post-fix (pre this
follow-up), ``_resolve_org_id`` ALWAYS returned ``None`` for that
entire traffic class — reintroducing the exact "RLS policies
inactive" bug class the middleware exists to prevent, just for a
different traffic class.

Separately, ``QuotaEnforcementMiddleware._resolve_org_id`` was never
updated to match and still trusted a raw ``X-Org-Id`` header
verbatim as its first branch, diverging from the comment in
``rls_org_context.py`` claiming the two middlewares are kept "in
sync".

This module covers both regressions.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest
from starlette.requests import Request


def _scope(headers: list[tuple[bytes, bytes]], path: str = "/gateway/v1/chat/completions") -> dict:
    return {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.0"},
        "method": "POST",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "headers": headers,
        "path_params": {},  # gateway.router has no {org_id} path param
        "client": ("203.0.113.7", 51234),
        "server": ("testserver", 80),
        "scheme": "http",
        "http_version": "1.1",
    }


async def _receive():
    return {"type": "http.request", "body": b"", "more_body": False}


def _fake_org_row(**overrides) -> dict:
    row = {
        "name": "Acme",
        "slug": "acme",
        "owner_id": "owner-uuid",
        "org_id": "org-real-42",
        "scopes": ["gateway:write", "gateway:read"],
        "key_id": "key-uuid",
        "active": True,
        "revoked_at": None,
        "expires_at": None,
        "last_used_at": None,
    }
    row.update(overrides)
    return row


class TestRLSOrgContextApiKeyVerification:
    """``RLSOrgContextMiddleware._resolve_org_id`` / ``_has_verified_identity``
    with a real (mocked-at-the-DB-boundary) ``X-Org-Api-Key`` +
    ``X-Org-Id`` gateway-style request.
    """

    def test_resolves_org_id_when_api_key_genuinely_verifies(self) -> None:
        """A gateway-style request (no path param, no cookie, no
        Bearer) whose ``X-Org-Api-Key`` hash-lookup genuinely
        succeeds must have its ``X-Org-Id`` trusted — this is the
        exact regression the adversarial review found: post the
        first CRITICAL fix, this case incorrectly returned ``None``.
        """
        from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

        scope = _scope(
            [
                (b"x-org-id", b"org-real-42"),
                (b"x-org-api-key", b"eden_live_realsecretkey"),
            ]
        )
        req = Request(scope, _receive)

        fake_client = AsyncMock()
        fake_client.fetchrow = AsyncMock(return_value=_fake_org_row())
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            org_id = asyncio.run(RLSOrgContextMiddleware._resolve_org_id(req))

        assert org_id == "org-real-42", (
            "REGRESSION: a genuinely hash-verified X-Org-Api-Key + "
            "X-Org-Id gateway request must resolve an org_id so RLS "
            f"policies are active for it, got {org_id!r}"
        )
        fake_client.fetchrow.assert_awaited_once()

    def test_does_not_resolve_when_api_key_invalid(self) -> None:
        """An ``X-Org-Api-Key`` that fails hash lookup (unknown /
        wrong org binding) must NOT unlock the header — presence of
        the header alone must never be sufficient."""
        from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

        scope = _scope(
            [
                (b"x-org-id", b"org-real-42"),
                (b"x-org-api-key", b"totally-bogus-key"),
            ]
        )
        req = Request(scope, _receive)

        fake_client = AsyncMock()
        # No matching row -> get_current_org_api_key raises 401 HTTPException.
        fake_client.fetchrow = AsyncMock(return_value=None)
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            org_id = asyncio.run(RLSOrgContextMiddleware._resolve_org_id(req))

        assert org_id is None, (
            "REGRESSION: an invalid X-Org-Api-Key must not resolve an "
            f"org_id, got {org_id!r}"
        )

    def test_does_not_resolve_when_api_key_revoked(self) -> None:
        """A hash-matched but revoked key must not verify either —
        confirms the branch reuses the full ``get_current_org_api_key``
        check (active/revoked/expires), not just the hash lookup."""
        from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

        scope = _scope(
            [
                (b"x-org-id", b"org-real-42"),
                (b"x-org-api-key", b"eden_live_revokedkey"),
            ]
        )
        req = Request(scope, _receive)

        fake_client = AsyncMock()
        fake_client.fetchrow = AsyncMock(
            return_value=_fake_org_row(revoked_at="2026-01-01T00:00:00+00:00")
        )
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            org_id = asyncio.run(RLSOrgContextMiddleware._resolve_org_id(req))

        assert org_id is None, (
            f"REGRESSION: a revoked X-Org-Api-Key must not resolve an "
            f"org_id, got {org_id!r}"
        )

    def test_does_not_resolve_when_api_key_header_missing(self) -> None:
        """Gateway-style request with only X-Org-Id and no API key
        (and no cookie/Bearer) must still be refused — mirrors the
        pre-existing unauthenticated-header regression test but in
        the gateway (no path param) shape explicitly called out by
        the review."""
        from eden.api.middleware.rls_org_context import RLSOrgContextMiddleware

        scope = _scope([(b"x-org-id", b"org-real-42")])
        req = Request(scope, _receive)

        org_id = asyncio.run(RLSOrgContextMiddleware._resolve_org_id(req))

        assert org_id is None, (
            f"REGRESSION: X-Org-Id with no verified identity at all "
            f"(no API key, no cookie, no Bearer) must not resolve, "
            f"got {org_id!r}"
        )


class TestQuotaEnforcementOrgIdVerification:
    """``QuotaEnforcementMiddleware._resolve_org_id`` must no longer
    trust a raw ``X-Org-Id`` header with zero verification — matching
    the hardened pattern in ``TenantRateLimitMiddleware`` /
    ``RLSOrgContextMiddleware``.
    """

    def test_unauthenticated_raw_header_is_not_trusted(self) -> None:
        """CRITICAL fix (2026-07-27 follow-up): an unauthenticated
        request carrying only a raw ``X-Org-Id`` header (no API key,
        no cookie, no Bearer) must NOT have that header value
        returned. Pre-fix this was the very first branch and
        returned the header verbatim unconditionally."""
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        scope = _scope([(b"x-org-id", b"victim-org")], path="/orgs/victim-org/references")
        req = Request(scope, _receive)

        org_id = asyncio.run(QuotaEnforcementMiddleware._resolve_org_id(req))

        assert org_id is None, (
            "REGRESSION: QuotaEnforcementMiddleware._resolve_org_id "
            "trusted a raw, unauthenticated X-Org-Id header — got "
            f"{org_id!r} instead of None"
        )

    def test_resolves_org_id_when_api_key_genuinely_verifies(self) -> None:
        """Symmetric with the RLS fix — a genuinely hash-verified
        X-Org-Api-Key + X-Org-Id pair IS trusted (quota enforcement
        must still work for legitimately authenticated API-key
        traffic, not just be locked down)."""
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        scope = _scope(
            [
                (b"x-org-id", b"org-real-42"),
                (b"x-org-api-key", b"eden_live_realsecretkey"),
            ]
        )
        req = Request(scope, _receive)

        fake_client = AsyncMock()
        fake_client.fetchrow = AsyncMock(return_value=_fake_org_row())
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            org_id = asyncio.run(QuotaEnforcementMiddleware._resolve_org_id(req))

        assert org_id == "org-real-42", (
            "REGRESSION: quota enforcement must still resolve org_id "
            f"for a genuinely verified X-Org-Api-Key request, got {org_id!r}"
        )

    def test_invalid_api_key_does_not_unlock_header(self) -> None:
        """An invalid/unknown X-Org-Api-Key must not unlock the
        X-Org-Id header for quota purposes either."""
        from eden.api.middleware.quota_enforcement import QuotaEnforcementMiddleware

        scope = _scope(
            [
                (b"x-org-id", b"victim-org"),
                (b"x-org-api-key", b"totally-bogus-key"),
            ]
        )
        req = Request(scope, _receive)

        fake_client = AsyncMock()
        fake_client.fetchrow = AsyncMock(return_value=None)
        fake_client.execute = AsyncMock()

        with patch(
            "eden.api.deps.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            org_id = asyncio.run(QuotaEnforcementMiddleware._resolve_org_id(req))

        assert org_id is None, (
            f"REGRESSION: an invalid X-Org-Api-Key must not unlock "
            f"X-Org-Id for quota enforcement, got {org_id!r}"
        )
