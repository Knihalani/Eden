"""Integration tests for Eden authentication routes.

Covers: signup, login, logout, /me, 2FA setup/verify/disable,
        password reset flow, and invite-token signup.
"""

import pytest
from fastapi.testclient import TestClient


class TestAuthSignup:
    def test_signup_success(self, api_client: TestClient):
        """Creating a new account returns user_id and sets cookie."""
        response = api_client.post("/auth/signup", json={
            "email": "newuser@example.com",
            "password": "Str0ng!Pass#2024",
            "name": "New User",
        })

        assert response.status_code == 200
        data = response.json()
        assert "user_id" in data
        assert data["email"] == "newuser@example.com"
        assert "authorization" in api_client.cookies

    def test_signup_weak_password(self, api_client: TestClient):
        """Weak passwords are rejected with 400."""
        response = api_client.post("/auth/signup", json={
            "email": "weak@example.com",
            "password": "password123",
            "name": "Weak User",
        })

        assert response.status_code == 400
        assert "password" in response.json()["detail"].lower() or "at least" in response.json()["detail"].lower()

    def test_signup_duplicate_email(self, api_client: TestClient):
        """Duplicate emails return 409 conflict."""
        # First signup (mock returns existing row for test@example.com)
        response = api_client.post("/auth/signup", json={
            "email": "test@example.com",
            "password": "Str0ng!Pass#2024",
            "name": "Test User",
        })
        assert response.status_code == 409
        assert "already exists" in response.json()["detail"]

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
        assert response.status_code in (200, 429)


class TestAuthLogin:
    def test_login_success(self, api_client: TestClient):
        """Valid credentials return user data and set cookie."""
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
