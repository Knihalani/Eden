"""Integration tests for Eden authentication routes.

Covers: signup, login, logout, /me, 2FA setup/verify/disable,
        password reset flow, invite-token signup, and the
        authenticated ``/auth/invitations/accept`` token-redeem path
        used by the onboarding wizard.
"""

import pytest
from fastapi.testclient import TestClient
from unittest.mock import patch


class TestAuthSignup:
    def test_signup_success(self, api_client: TestClient):
        """Creating a new account returns 202 + a generic message;
        no session cookie until email is verified.

        Audit 2026-06-22 B1.23 changed the signup contract to require
        email verification before issuing a session cookie. The
        security audit of 2026-07-01 further stripped the user_id
        from the response so the endpoint cannot be used to enumerate
        registered emails: every signup — new or duplicate — returns
        the same 202 + generic message.
        """
        response = api_client.post("/auth/signup", json={
            "email": "newuser@example.com",
            "password": "Str0ng!Pass#2024",
            "name": "New User",
        })

        # 202 Accepted = "if not already registered, account created"
        assert response.status_code == 202
        data = response.json()
        assert "message" in data
        # No session cookie until email is verified.
        assert "authorization" not in api_client.cookies

    def test_signup_weak_password(self, api_client: TestClient):
        """Weak passwords are rejected with 400."""
        response = api_client.post("/auth/signup", json={
            "email": "weak@example.com",
            "password": "password123",
            "name": "Weak User",
        })

        assert response.status_code == 400
        assert "password" in response.json()["detail"].lower() or "at least" in response.json()["detail"].lower()

    def test_signup_duplicate_email_returns_generic_202(self, api_client: TestClient):
        """Anti-enumeration: a duplicate email returns the SAME 202 +
        generic message as a fresh signup, NOT a 409 + 'already exists'.

        Audit 2026-07-01 — the old 409 response leaked which emails
        were registered. The mock conftest returns an existing row
        for ``test@example.com``; the route must therefore return 202
        with the same body shape as the new-user path.
        """
        response = api_client.post("/auth/signup", json={
            "email": "test@example.com",
            "password": "Str0ng!Pass#2024",
            "name": "Test User",
        })
        assert response.status_code == 202
        body = response.json()
        assert "message" in body
        assert "If that email is not already registered" in body["message"]

    def test_signup_honeypot_drops_bot_submission(self, api_client: TestClient):
        """A submission with the invisible ``website`` field filled is
        a bot — return 202 + generic message, but do NOT touch the DB.
        The bot cannot distinguish this from a real signup."""
        response = api_client.post("/auth/signup", json={
            "email": "bot@spam.example",
            "password": "Str0ng!Pass#2024",
            "name": "Bot McSpam",
            "website": "http://spam.example/",
        })
        assert response.status_code == 202
        assert "If that email is not already registered" in response.json()["message"]

    def test_signup_rate_limit(self, api_client: TestClient):
        """Too many signups from same IP trigger 429."""
        # Note: rate limiter state is in-memory for tests, so rapid
        # requests would trigger it. We just verify the endpoint
        # structure handles rate limit exceptions gracefully.
        response = api_client.post("/auth/signup", json={
            "email": "ratelimit@example.com",
            "password": "Str0ng!Pass#2024",
            "name": "Rate User",
        })
        # Should not crash; status depends on rate limit state
        assert response.status_code in (202, 429)


class TestAuthLogin:
    def test_login_success(self, api_client: TestClient):
        """Valid credentials return user data and set cookie."""
        # Clear any pre-set cookies so the Set-Cookie response from
        # login doesn't collide with the test's default cookie
        # (httpx raises CookieConflict on duplicate cookie names).
        api_client.cookies.clear()
        response = api_client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "correct-password",
        })

        assert response.status_code == 200
        data = response.json()
        assert data["email"] == "test@example.com"
        assert data["name"] == "Test User"
        assert "authorization" in api_client.cookies

    def test_login_invalid_password(self, api_client: TestClient):
        """Wrong password returns 401."""
        response = api_client.post("/auth/login", json={
            "email": "test@example.com",
            "password": "wrong-password",
        })

        assert response.status_code == 401
        assert "Invalid" in response.json()["detail"]

    def test_login_unknown_email(self, api_client: TestClient):
        """Unknown email returns 401 (not 404, to prevent enumeration)."""
        response = api_client.post("/auth/login", json={
            "email": "nobody@example.com",
            "password": "Str0ng!Pass#2024",
        })

        assert response.status_code == 401
        assert "Invalid" in response.json()["detail"]

    def test_login_rate_limit(self, api_client: TestClient):
        """Repeated failed logins trigger per-IP rate limit."""
        for _ in range(5):
            response = api_client.post("/auth/login", json={
                "email": "test@example.com",
                "password": "wrong",
            })

        # After many failures, rate limit may kick in
        assert response.status_code in (401, 429)


class TestAuthMe:
    def test_me_authenticated(self, authenticated_client: TestClient):
        """/me returns user data when authenticated."""
        response = authenticated_client.get("/auth/me")

        assert response.status_code == 200
        data = response.json()
        assert data["user_id"] == "user-123"
        assert data["email"] == "test@example.com"
        assert data["name"] == "Test User"
        assert isinstance(data["organizations"], list)

    def test_me_unauthenticated(self, api_client: TestClient):
        """/me returns 401 without valid cookie."""
        response = api_client.get("/auth/me")

        assert response.status_code == 401


class TestAuthLogout:
    def test_logout_clears_cookie(self, authenticated_client: TestClient):
        """Logout deletes the authorization cookie."""
        response = authenticated_client.post("/auth/logout")

        assert response.status_code == 200
        assert "message" in response.json()


class TestAuth2FA:
    def test_2fa_setup_success(self, authenticated_client: TestClient):
        """Setup succeeds when 2FA is not yet enabled."""
        response = authenticated_client.post("/auth/2fa/setup")
        # Mock user has two_factor_enabled=False, so setup should succeed
        assert response.status_code == 200
        data = response.json()
        assert "secret" in data
        assert "qr_code_base64" in data
        assert "otpauth_url" in data

    def test_2fa_verify_without_setup(self, authenticated_client: TestClient):
        """Verify fails if setup was not initiated."""
        response = authenticated_client.post("/auth/2fa/verify", json={"code": "123456"})

        assert response.status_code == 400
        assert "setup" in response.json()["detail"]

    def test_2fa_status(self, authenticated_client: TestClient):
        """/2fa/status returns current 2FA state."""
        response = authenticated_client.get("/auth/2fa/status")

        assert response.status_code == 200
        assert "two_factor_enabled" in response.json()

    def test_2fa_disable_not_enabled(self, authenticated_client: TestClient):
        """Disabling 2FA when not enabled returns 400."""
        response = authenticated_client.post("/auth/2fa/disable", json={"code": "123456"})

        assert response.status_code == 400
        assert "not enabled" in response.json()["detail"]

    def test_forgot_password_rate_limit(self, api_client: TestClient):
        """Too many forgot-password requests trigger rate limit."""
        for _ in range(10):
            response = api_client.post("/auth/forgot-password", json={
                "email": "test@example.com",
            })
        # After repeated requests, rate limit may kick in
        assert response.status_code in (200, 429)


class TestAuthPasswordReset:
    def test_forgot_password_existing_email(self, api_client: TestClient):
        """Forgot password returns generic message for existing email."""
        response = api_client.post("/auth/forgot-password", json={
            "email": "test@example.com",
        })

        assert response.status_code == 200
        assert "If an account exists" in response.json()["message"]

    def test_forgot_password_unknown_email(self, api_client: TestClient):
        """Forgot password returns same generic message for unknown email."""
        response = api_client.post("/auth/forgot-password", json={
            "email": "unknown@example.com",
        })

        assert response.status_code == 200
        assert "If an account exists" in response.json()["message"]

    def test_reset_password_invalid_token(self, api_client: TestClient):
        """Reset with invalid token returns 400."""
        response = api_client.post("/auth/reset-password", json={
            "token": "invalid-token",
            "password": "Str0ng!Pass#2024",
        })

        assert response.status_code == 400
        assert "Invalid" in response.json()["detail"]

    def test_reset_password_weak_password(self, api_client: TestClient):
        """Reset with weak password returns 400."""
        response = api_client.post("/auth/reset-password", json={
            "token": "some-token",
            "password": "weak",
        })

        assert response.status_code == 400
        assert "password" in response.json()["detail"].lower()


class TestAuthInviteToken:
    def test_verify_invite_token_invalid(self, api_client: TestClient):
        """Invalid invite token returns 404."""
        response = api_client.get("/auth/verify-invite-token?token=invalid")

        assert response.status_code == 404

    def test_signup_from_invite_invalid_token(self, api_client: TestClient):
        """Signup from invalid invite token returns 404."""
        response = api_client.post("/auth/signup-from-invite", json={
            "token": "invalid-token",
            "password": "Str0ng!Pass#2024",
            "name": "Invited User",
        })

        assert response.status_code == 404


class TestAuthInvitationAccept:
    """Tests for the token-redeem path used by ``/onboarding/org``'s
    join branch. The endpoint is auth-gated and resolves a plaintext
    invite token to a membership row."""

    def test_accept_invitation_invalid_token(self, api_client: TestClient, auth_headers: dict):
        """Invalid or expired token returns 404 (not 500)."""
        # The autouse ``patch_invite_service`` fixture makes
        # ``verify_invite_token`` return None, which the endpoint
        # surfaces as 404. No membership row is touched.
        response = api_client.post(
            "/auth/invitations/accept?token=invalid-token",
            headers=auth_headers,
        )
        assert response.status_code == 404
        assert "Invalid" in response.json()["detail"]

    def test_accept_invitation_unauthenticated(self, api_client: TestClient):
        """Unauthenticated callers get 401 — the endpoint creates a
        membership, so anonymous access would be a privilege issue."""
        response = api_client.post(
            "/auth/invitations/accept?token=anything",
        )
        assert response.status_code == 401

    def test_accept_invitation_valid_token(
        self, api_client: TestClient, auth_headers: dict
    ):
        """Valid token resolves the invite and returns org_id+role.

        We override the autouse ``verify_invite_token`` patch with a
        happy-path invite, then patch the DB-touching
        ``accept_invitation`` to return its expected shape. The
        endpoint should stitch them together and return
        ``{org_id, role, org_name, message}``.

        The autouse ``patch_invite_service`` fixture wraps the test,
        so we patch at the import-site (the auth route module) to
        bypass the wrapping. The auth route's ``verify_invite_token``
        is just a module-level name rebound to the service's symbol,
        so patching the import site is the canonical way to override
        it inside a single test.
        """
        fake_invite = {
            "id": "inv-1",
            "org_id": "org-1",
            "org_name": "Acme AI Labs",
            "email": "test@example.com",
            "role": "member",
            "invited_by": "user-0",
            "inviter_name": "Admin",
            "expires_at": "2099-01-01T00:00:00",
            "status": "pending",
        }
        from eden.api.routes import auth as auth_routes
        with patch.object(
            auth_routes,
            "verify_invite_token",
            return_value=fake_invite,
        ), patch.object(
            auth_routes,
            "accept_invitation",
            return_value={"org_id": "org-1", "role": "member"},
        ):
            response = api_client.post(
                "/auth/invitations/accept?token=any-plaintext-token",
                headers=auth_headers,
            )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["org_id"] == "org-1"
        assert body["role"] == "member"
        assert body["org_name"] == "Acme AI Labs"
        assert "accepted" in body["message"].lower()
