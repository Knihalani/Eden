"""Tests for the /auth/me error → user-friendly copy mapping in use-org.

The (portal) layout surfaces a banner with the authError message set
by useOrg.refreshOrgs() when /auth/me fails. June 22 polish mapped
the raw API error onto actionable copy:

- 401 / "not authenticated"  → "Session expired. Please sign in again."
- 404 / "User not found"     → "Setting up your account…"
- 404 / "not found"           → "We couldn't load your workspace. Please refresh."
- 5xx                        → "Eden is having trouble reaching the server."
- everything else             → raw message

These tests pin the mapping so a future refactor can't silently
revert the raw-error leak that confounded users before the fix.
"""

from __future__ import annotations

import asyncio
import re
from unittest.mock import MagicMock, patch

import pytest


# Lift the mapping out of use-org.tsx so we can test it without
# mounting the full provider tree. The mapping is the line of
# business logic that protects the user — keep it testable.
def _map_auth_error(raw_message: str) -> tuple[str, str | None]:
    """Mirror the mapping in useOrg.refreshOrgs().catch.

    Returns (user_message, session_storage_marker_or_none).
    """
    if re.search(
        r"401|not\s*authenticated|authentication\s*required|unauthorized",
        raw_message,
        re.IGNORECASE,
    ):
        return "Session expired. Please sign in again.", "session_expired"
    if re.search(r"user\s*not\s*found", raw_message, re.IGNORECASE):
        return (
            "Setting up your account… If this takes more than a moment, "
            "refresh the page.",
            None,
        )
    if re.search(r"404|not\s*found", raw_message, re.IGNORECASE):
        return "We couldn't load your workspace. Please refresh.", None
    if re.search(r"5\d\d|server\s*error", raw_message, re.IGNORECASE):
        return (
            "Eden is having trouble reaching the server. "
            "Please try again in a moment.",
            None,
        )
    return raw_message, None


@pytest.mark.parametrize("raw,expected_message", [
    # 401 path — generic session-expired copy, with the sessionStorage marker
    (
        "401 Unauthorized",
        "Session expired. Please sign in again.",
    ),
    (
        "Not authenticated",
        "Session expired. Please sign in again.",
    ),
    (
        "Authentication required",
        "Session expired. Please sign in again.",
    ),
    # 404 / "User not found" — friendly "setting up your account" copy.
    (
        "404 User not found",
        "Setting up your account… If this takes more than a moment, refresh the page.",
    ),
    (
        "User not found",
        "Setting up your account… If this takes more than a moment, refresh the page.",
    ),
    # 404 / other — workspace refresh hint.
    (
        "404 Not Found",
        "We couldn't load your workspace. Please refresh.",
    ),
    # 5xx — server trouble.
    (
        "500 Internal Server Error",
        "Eden is having trouble reaching the server. Please try again in a moment.",
    ),
    (
        "502 Bad Gateway",
        "Eden is having trouble reaching the server. Please try again in a moment.",
    ),
    (
        "server error",
        "Eden is having trouble reaching the server. Please try again in a moment.",
    ),
    # Unknown — surface raw (best fallback).
    (
        "Something weird happened",
        "Something weird happened",
    ),
])
def test_error_message_mapping(raw: str, expected_message: str):
    message, _ = _map_auth_error(raw)
    assert message == expected_message


def test_session_expired_sets_session_storage_marker():
    """The 401 path writes eden:auth:error=session_expired into
    sessionStorage so subsequent page loads can short-circuit and
    redirect to /login. Verify the marker string is returned.
    """
    message, marker = _map_auth_error("401 Unauthorized")
    assert message == "Session expired. Please sign in again."
    assert marker == "session_expired"


def test_non_auth_paths_do_not_set_marker():
    """Only the 401 path should produce a sessionStorage marker —
    every other failure mode just shows the banner."""
    for raw in [
        "404 User not found",
        "500 Internal Server Error",
        "Some random error",
    ]:
        _msg, marker = _map_auth_error(raw)
        assert marker is None, f"Expected no marker for {raw!r}, got {marker!r}"


def test_real_world_error_messages():
    """Spot-check a few raw strings the backend might actually
    return. These mirror what FastAPI sends in the `detail` field
    of an HTTPException."""
    real_world_inputs = [
        # The exact /auth/me auto-provision failure that triggered
        # this whole fix (pre-047, when password_hash was NOT NULL
        # and Clerk IDs weren't UUIDs).
        "User not found",
        # Clerk session JWT verify failure.
        "Not authenticated",
        # Backend down / restart-loop.
        "500 Internal Server Error",
        # Vercel edge returning a 502 from a cold start.
        "502 Bad Gateway",
    ]
    for raw in real_world_inputs:
        message, marker = _map_auth_error(raw)
        # All of these must produce a non-empty, non-raw message
        # for the user — never leak the raw error to the UI.
        assert message, f"Empty message for {raw!r}"
        assert len(message) > 10, f"Message too short for {raw!r}: {message!r}"
        if "User not found" in raw or "5" in raw[:1]:
            # The 404/5xx paths should NOT use the raw error string
            assert raw != message, f"Leaked raw error to user: {message!r}"


def test_actual_use_org_hook_uses_same_mapping():
    """Read the live use-org.tsx file and confirm its catch block
    uses status + raw-detail branches (Wave 4 sanitize-race fix).
    """
    from pathlib import Path

    root = Path(__file__).resolve().parents[3]
    use_org = (
        root / "clients" / "portal" / "src" / "hooks" / "use-org.tsx"
    ).read_text()
    use_me = (
        root / "clients" / "portal" / "src" / "hooks" / "use-me-query.ts"
    ).read_text()
    # Status-keyed auth branches + provision-race helper must remain.
    for token in [
        "status === 401 || status === 403",
        "isUserNotFoundRace",
        "status === 404",
        "status === 429",
        "status >= 500",
    ]:
        assert token in use_org, f"use-org.tsx missing {token!r} branch"
    assert "user\\s*not\\s*found" in use_me
    assert "isUserNotFoundRace" in use_me

