"""S-5 + S-6 audit-trail / API-key auth tests.

Two related fixes from the Jun 22 audit batch:

* **S-5** — ``get_current_org_api_key`` (and the lower-level
  ``validate_org_api_key``) used to return any matching row regardless
  of ``active`` / ``revoked_at`` / ``expires_at``. A leaked, rotated,
  or expired API key kept authenticating indefinitely. The fix adds
  explicit pre-flight checks.
* **S-6** — the response shape used to include
  ``is_owner = row["owner_id"] == row["org_id"]``, which compared a
  user UUID to an org UUID — always False, and a different-type
  comparison to boot. Dropped.

These tests pin both behaviors using the conftest's autouse
``patch_postgres`` + ``mock_postgres_client`` fixtures.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient


UTC = timezone.utc


def _key_row(**overrides: Any) -> dict[str, Any]:
    """A fully-populated ``org_api_keys`` row that should authenticate."""
    base = {
        "org_id": "org-123",
        "name": "Test Org",
        "slug": "test-org",
        "owner_id": "user-123",
        "key_id": "key-abc",
        "scopes": ["read", "write"],
        "active": True,
        "revoked_at": None,
        "expires_at": None,
        "last_used_at": None,
    }
    base.update(overrides)
    return base


@pytest.fixture
def api_app(patch_postgres, patch_settings) -> FastAPI:
    """FastAPI app exposing only the API-key auth dep."""
    from eden.api.deps import get_current_org_api_key

    app = FastAPI(title="eden-api-key-test")

    @app.get("/probe")
    async def probe(ctx: dict = Depends(get_current_org_api_key)):
        return {"ctx": ctx}

    return app


@pytest.fixture
def client(api_app: FastAPI) -> TestClient:
    return TestClient(api_app)


def _stub_key_query(mock_pg, row: dict[str, Any] | None) -> None:
    """Replace ``fetchrow`` so the API-key SELECT returns ``row``."""
    async def _fake(query: str, *args, **kwargs):
        if "org_api_keys" in query and "JOIN organizations" in query:
            return row
        return None

    mock_pg.fetchrow = AsyncMock(side_effect=_fake)
    mock_pg.execute = AsyncMock(return_value="UPDATE 1")


def _headers() -> dict[str, str]:
    return {"X-Org-Id": "org-123", "X-Org-Api-Key": "the-secret-key"}


# ─── S-5: filter on active / revoked_at / expires_at ────────────────
class TestS5ActiveRevokedExpiredFilter:
    def test_active_unrevoked_unexpired_passes(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        _stub_key_query(mock_postgres_client, _key_row())
        resp = client.get("/probe", headers=_headers())
        assert resp.status_code == 200, resp.text
        ctx = resp.json()["ctx"]
        assert ctx["org_id"] == "org-123"
        assert "is_owner" not in ctx  # S-6: field is gone

    def test_inactive_key_rejected(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        _stub_key_query(mock_postgres_client, _key_row(active=False))
        resp = client.get("/probe", headers=_headers())
        assert resp.status_code == 401
        assert "disabled" in resp.text.lower()

    def test_revoked_key_rejected(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        _stub_key_query(
            mock_postgres_client,
            _key_row(revoked_at=datetime.now(UTC)),
        )
        resp = client.get("/probe", headers=_headers())
        assert resp.status_code == 401
        assert "revoked" in resp.text.lower()

    def test_expired_key_rejected(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        _stub_key_query(
            mock_postgres_client,
            _key_row(expires_at=datetime.now(UTC) - timedelta(minutes=1)),
        )
        resp = client.get("/probe", headers=_headers())
        assert resp.status_code == 401
        assert "expired" in resp.text.lower()

    def test_future_expiry_passes(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        _stub_key_query(
            mock_postgres_client,
            _key_row(expires_at=datetime.now(UTC) + timedelta(days=30)),
        )
        resp = client.get("/probe", headers=_headers())
        assert resp.status_code == 200, resp.text

    def test_naive_past_expires_at_rejected(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        """Audit 2026-07-03 — asyncpg returns naive ``datetime`` from
        ``TIMESTAMP WITH TIME ZONE`` columns when the server's
        ``TimeZone`` setting is ``UTC`` (the project default). The
        pre-fix ``expires_at < datetime.now(UTC)`` comparison raised
        ``TypeError`` and 500'd the request. The fix pins an
        explicit tz-aware coercion so the comparison is naive-safe.
        """
        # Naive datetime — exactly what asyncpg returns under the
        # project's default ``TimeZone = UTC`` server setting.
        naive_expired = datetime.utcnow() - timedelta(minutes=1)
        assert naive_expired.tzinfo is None
        _stub_key_query(
            mock_postgres_client,
            _key_row(expires_at=naive_expired),
        )
        resp = client.get("/probe", headers=_headers())
        # Must NOT 500 — the comparison is now naive-safe.
        assert resp.status_code in (200, 401), resp.text
        assert "expired" in resp.text.lower()

    def test_no_row_rejected(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        _stub_key_query(mock_postgres_client, None)
        resp = client.get("/probe", headers=_headers())
        assert resp.status_code == 401
        assert "invalid" in resp.text.lower()

    def test_missing_header_rejected(self, client: TestClient) -> None:
        resp = client.get("/probe", headers={"X-Org-Id": "org-123"})
        assert resp.status_code == 401
        assert "required" in resp.text.lower()


# ─── S-6: is_owner field removed from BOTH layers ──────────────────
class TestS6IsOwnerRemoved:
    def test_route_response_does_not_contain_is_owner(
        self, client: TestClient, mock_postgres_client,
    ) -> None:
        _stub_key_query(mock_postgres_client, _key_row())
        resp = client.get("/probe", headers=_headers())
        assert resp.status_code == 200, resp.text
        ctx = resp.json()["ctx"]
        # S-6 fix: the buggy ``is_owner = owner_id == org_id`` field
        # is gone. (A new ``is_owner`` based on user-vs-owner would
        # be a different feature; the audit only asked for the buggy
        # comparison to be removed.)
        assert "is_owner" not in ctx

    def test_validate_org_api_key_dict_has_no_is_owner(
        self, mock_postgres_client, patch_postgres, patch_settings,
    ) -> None:
        """The lower-level helper ``validate_org_api_key`` also must
        not include ``is_owner`` in its returned dict.
        """
        from eden.api.routes.api_keys import validate_org_api_key

        _stub_key_query(mock_postgres_client, _key_row())

        async def _run():
            return await validate_org_api_key(
                "org-123", "the-secret-key",
            )

        result = asyncio.new_event_loop().run_until_complete(_run())
        asyncio.new_event_loop().close()
        assert result is not None
        assert "is_owner" not in result
        assert result["org_id"] == "org-123"
