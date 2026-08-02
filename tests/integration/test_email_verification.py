"""Integration tests for the email-verification flow (shipped 2026-08-02).

Covers the register's re-enable condition for
``email_verification_enabled`` (docs/ops/disabled-features.md §1c):
the ``email_verification_tokens`` table path, the
``send_verification_email`` dispatch, and the ``/auth/verify-email``
route — one signup walked through to a verified login, plus the
failure modes (unknown / used / expired token, flag off).
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from eden.api.utils.auth import hash_password
from eden.config import Settings

_PORTAL = "https://portal.test"
_EMAIL = "verify-me@example.com"
_PASSWORD = "Str0ng!Pass#2024"


@pytest.fixture
def verify_settings(
    test_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> Settings:
    """Settings with the flag on and a resolvable portal URL.

    ``auth.py`` and ``email_service.py`` each bind ``get_settings`` at
    import time, so patch both bindings (the autouse
    ``patch_settings`` only covers ``eden.config`` + middleware).
    """
    monkeypatch.setattr(test_settings, "portal_base_url", _PORTAL, raising=False)
    monkeypatch.setattr(
        test_settings, "email_verification_enabled", True, raising=False
    )
    monkeypatch.setattr(
        "eden.api.routes.auth.get_settings", lambda: test_settings
    )
    monkeypatch.setattr(
        "eden.services.email_service.get_settings", lambda: test_settings
    )
    return test_settings


def _signup(client: TestClient) -> None:
    resp = client.post(
        "/auth/signup",
        json={"email": _EMAIL, "password": _PASSWORD, "name": "Verify Me"},
    )
    assert resp.status_code == 202, resp.text


def _dispatched_token(email_service: MagicMock) -> str:
    """The plaintext token lives only in the emailed link."""
    send = email_service.send_email
    assert send.await_count >= 1
    html = send.await_args.kwargs["html_content"]
    match = re.search(r"/verify-email\?token=([A-Za-z0-9_\-]+)", html)
    assert match, f"no verification link in dispatched email: {html[:200]}"
    return match.group(1)


class TestSignupDispatch:
    def test_signup_stores_hash_and_emails_plaintext(
        self,
        api_client: TestClient,
        mock_postgres_client: MagicMock,
        patch_email_service: MagicMock,
        verify_settings: Settings,
    ) -> None:
        api_client.cookies.clear()
        _signup(api_client)

        # The DB got a SHA-256 hash, never the plaintext token.
        token_inserts = [
            c
            for c in mock_postgres_client.execute.await_args_list
            if "email_verification_tokens" in str(c.args[0])
        ]
        assert token_inserts, "no email_verification_tokens INSERT issued"
        stored_hash = token_inserts[0].args[2]
        assert isinstance(stored_hash, str) and len(stored_hash) == 64

        # The email carries the plaintext; it hashes to the stored value.
        token = _dispatched_token(patch_email_service)
        assert hashlib.sha256(token.encode("utf-8")).hexdigest() == stored_hash

    def test_signup_message_points_at_inbox_when_sent(
        self,
        api_client: TestClient,
        patch_email_service: MagicMock,
        verify_settings: Settings,
    ) -> None:
        api_client.cookies.clear()
        resp = api_client.post(
            "/auth/signup",
            json={"email": _EMAIL, "password": _PASSWORD, "name": "Verify Me"},
        )
        assert resp.status_code == 202
        assert "verify your address" in resp.json()["message"]


class TestVerifyEmailRoute:
    def _queue_token_row(
        self,
        pg: MagicMock,
        *,
        expired: bool = False,
        used: bool = False,
    ) -> None:
        expires = datetime.now(UTC) + (
            timedelta(hours=-1) if expired else timedelta(hours=1)
        )
        pg._fetchrow_overrides.append(
            (
                "FROM email_verification_tokens",
                {
                    "id": "tok-1",
                    "user_id": "user-verify-1",
                    "expires_at": expires,
                    "used_at": datetime.now(UTC) if used else None,
                },
            )
        )

    def test_full_flow_signup_to_verified_login(
        self,
        api_client: TestClient,
        mock_postgres_client: MagicMock,
        patch_email_service: MagicMock,
        verify_settings: Settings,
    ) -> None:
        """The register's re-enable test: one signup walked through
        to a verified login."""
        api_client.cookies.clear()
        _signup(api_client)
        token = _dispatched_token(patch_email_service)

        self._queue_token_row(mock_postgres_client)
        verify = api_client.post("/auth/verify-email", json={"token": token})
        assert verify.status_code == 200, verify.text
        assert verify.json()["message"] == "Email address verified"

        executed = "\n".join(
            str(c.args[0]) for c in mock_postgres_client.execute.await_args_list
        )
        assert "UPDATE email_verification_tokens" in executed
        assert "email_verified = TRUE" in executed

        # The verified account can sign in.
        mock_postgres_client._fetchrow_overrides.append(
            (
                "deleted_at IS NULL",
                {
                    "id": "user-verify-1",
                    "email": _EMAIL,
                    "password_hash": hash_password(_PASSWORD),
                    "name": "Verify Me",
                    "failed_login_count": 0,
                    "locked_until": None,
                    "last_failed_login_at": None,
                    "token_version": 1,
                    "two_factor_enabled": False,
                    "preferred_org_id": None,
                },
            )
        )
        api_client.cookies.clear()
        login = api_client.post(
            "/auth/login", json={"email": _EMAIL, "password": _PASSWORD}
        )
        assert login.status_code == 200, login.text

    def test_unknown_token_rejected(
        self,
        api_client: TestClient,
        verify_settings: Settings,
    ) -> None:
        # Default fetchrow returns None for the token lookup.
        resp = api_client.post(
            "/auth/verify-email", json={"token": "x" * 43}
        )
        assert resp.status_code == 400
        assert "Invalid or expired" in resp.json()["detail"]

    def test_used_token_rejected(
        self,
        api_client: TestClient,
        mock_postgres_client: MagicMock,
        verify_settings: Settings,
    ) -> None:
        self._queue_token_row(mock_postgres_client, used=True)
        resp = api_client.post(
            "/auth/verify-email", json={"token": "y" * 43}
        )
        assert resp.status_code == 400

    def test_expired_token_rejected(
        self,
        api_client: TestClient,
        mock_postgres_client: MagicMock,
        verify_settings: Settings,
    ) -> None:
        self._queue_token_row(mock_postgres_client, expired=True)
        resp = api_client.post(
            "/auth/verify-email", json={"token": "z" * 43}
        )
        assert resp.status_code == 400

    def test_route_hidden_when_flag_off(
        self,
        api_client: TestClient,
        test_settings: Settings,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            test_settings, "email_verification_enabled", False, raising=False
        )
        monkeypatch.setattr(
            "eden.api.routes.auth.get_settings", lambda: test_settings
        )
        resp = api_client.post(
            "/auth/verify-email", json={"token": "x" * 43}
        )
        assert resp.status_code == 404
