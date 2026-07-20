"""Regression tests for the July 2026 backend hardening pass.

Spans the defensive try/except wrappers added to::

  - src/eden/api/deps.py::get_user_by_id         (returns None on DB blip)
  - src/eden/api/deps.py::require_org_member     (synthesizes pending_sync
    when JWT carries Clerk claim; otherwise 403)

Why these tests:
  - The bare ``client.fetchrow`` calls in get_user_by_id used to bubble
    asyncpg exceptions to the route. Once the route's try/except
    *body* never ran, the handler 500'd before reaching its defensive
    return. The fix must guarantee we get back ``None`` from a DB
    failure so call-sites that synthesise (Clerk trust + pending_sync)
    can still serve the request.
  - require_org_member had the same shape. The fix also adds an
    outer try/except so even if get_current_org raises unexpectedly
    (a foreign-key table missing, Postgres in a brief reconnect
    window) the user with a valid Clerk ``org_id`` claim still
    passes through with a synthesized entry instead of 500.

Both fixes were driven by the July 6, 2026 11:11–13:13 NF log burst::

    GET /orgs/{org_id}/ai-insights/sessions  -> 500
    unhandled exception [request_id=...]

These tests do not require a live database — they patch the
``get_postgres_client`` dependency to raise.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.api.deps import get_user_by_id, require_org_member


# ────────────────────────────────────────────────────────────────────
# get_user_by_id — must NOT propagate DB exceptions
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_user_by_id_swallows_db_exception_returns_none(monkeypatch):
    """If get_postgres_client() raises, get_user_by_id must return
    None instead of propagating to the caller (the previous behaviour
    surfaced as 500 on /orgs/{org_id}/ai-insights/sessions)."""
    fake_db_error = RuntimeError("connection reset by peer")
    # The function under test imports get_postgres_client into
    # eden.api.deps at module load — patch the binding there.
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(side_effect=fake_db_error),
    )

    result = await get_user_by_id("user_2abc")

    assert result is None


@pytest.mark.asyncio
async def test_get_user_by_id_swallows_query_exception_returns_none(monkeypatch):
    """Even when get_postgres_client succeeds but the SELECT raises
    (e.g. asyncpg.IndeterminateDatatypeError, asyncpg.PostgresError,
    asyncpg.exceptions.ConnectionDoesNotExistError), get_user_by_id
    must return None."""
    mock_client = MagicMock()
    mock_client.fetchrow = AsyncMock(
        side_effect=RuntimeError("asyncpg: connection does not exist"),
    )
    monkeypatch.setattr(
        "eden.api.deps.get_postgres_client",
        AsyncMock(return_value=mock_client),
    )

    result = await get_user_by_id("user_2abc")

    assert result is None


@pytest.mark.asyncio
async def test_get_user_by_id_rejects_invalid_lookup_column():
    """Invalid lookup_column must STILL raise ValueError — that path is
    a programming error, not a DB blip, and should not be swallowed."""
    with pytest.raises(ValueError):
        await get_user_by_id("user_x", lookup_column="bogus_column")


# ────────────────────────────────────────────────────────────────────
# require_org_member — must synthesize on DB blip, not 500
# ────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_require_org_member_synthesizes_on_db_blip_with_clerk_claim(monkeypatch):
    """If get_current_org raises (the previous behaviour) AND the
    JWT carries a Clerk ``org_id`` claim, require_org_member must
    synthesise a pending_sync entry rather than 500.

    The synthesize path is critical for Clerk-signed-in users: the
    Clerk webhook for organizationMembership.created may not have
    landed yet (``pending_sync=True``), but Clerk is the source of
    truth for role and the user is validly in the org.
    """
    # Make get_current_org raise
    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(side_effect=RuntimeError("postgres disconnected")),
    )

    clerk_payload = {
        "sub": "user_2abc",
        "org_id": "org_clerktrust",
        "org_role": "org:admin",
    }

    # Bypass the HTTPException layer; the function under test doesn't
    # go through FastAPI in this path. (FastAPI's Depends() calls it
    # directly.)
    result = await require_org_member(
        x_org_id=None,
        payload=clerk_payload,
    )

    assert result["org_id"] == "org_clerktrust"
    assert result["role"] == "owner"  # clerk_role_to_eden_role maps org:admin → owner
    assert result["_pending_sync"] is True


@pytest.mark.asyncio
async def test_require_org_member_raises_403_without_clerk_claim(monkeypatch):
    """If the DB blip and there's no Clerk org_id claim, the user has
    no way to be in an org, and we correctly 403 (not 500)."""
    from fastapi import HTTPException

    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(side_effect=RuntimeError("postgres disconnected")),
    )

    # No Clerk org_id claim — only a sub.
    leaky_jwt_payload = {"sub": "user_2abc"}

    with pytest.raises(HTTPException) as exc_info:
        await require_org_member(x_org_id=None, payload=leaky_jwt_payload)

    assert exc_info.value.status_code == 403
    assert "Not a member" in exc_info.value.detail


@pytest.mark.asyncio
async def test_require_org_member_raises_401_when_payload_is_none(monkeypatch):
    """Unauthenticated callers (payload=None) must be 401, not 403."""
    from fastapi import HTTPException

    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(return_value=None),
    )

    with pytest.raises(HTTPException) as exc_info:
        await require_org_member(x_org_id="org-123", payload=None)

    assert exc_info.value.status_code == 401
    assert "Authentication required" in exc_info.value.detail


@pytest.mark.asyncio
async def test_require_org_member_returns_normal_synth_when_db_missing_row(monkeypatch):
    """Happy path: get_current_org returns None (no org_members row,
    Clerk trust active) and the synthesis path inside get_current_org
    returns a pending_sync entry. require_org_member surfaces that
    entry unchanged. This existed before the hardening — verify it
    still works."""
    synthetic_org = {
        "org_id": "org_pending",
        "role": "member",
        "name": "org_pending",
        "slug": "org_pending",
        "archived_at": None,
        "_pending_sync": True,
    }
    monkeypatch.setattr(
        "eden.api.deps.get_current_org",
        AsyncMock(return_value=synthetic_org),
    )

    result = await require_org_member(
        x_org_id=None,
        payload={"sub": "user_2abc", "org_id": "org_pending"},
    )

    assert result is synthetic_org  # passed through unchanged
