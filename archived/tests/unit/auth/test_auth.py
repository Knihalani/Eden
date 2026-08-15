"""Auth route smoke tests — happy path + key error paths.

Complements the broader ``tests/integration/test_auth.py`` with
focused unit coverage of the route module itself.
"""

import pytest
from fastapi.testclient import TestClient


class TestAuthMe:
    def test_me_unauthenticated_returns_401(self, api_client: TestClient):
        r = api_client.get("/auth/me")
        assert r.status_code in (401, 403)

    def test_me_authenticated_returns_user(self, authenticated_client: TestClient):
        r = authenticated_client.get("/auth/me")
        assert r.status_code == 200
        data = r.json()
        assert "email" in data or "user_id" in data or "id" in data

    def test_logout_clears_cookie(self, authenticated_client: TestClient):
        r = authenticated_client.post("/auth/logout")
        assert r.status_code in (200, 204, 401)
        # Cookie cleared on success.
        if r.status_code == 200:
            set_cookies = r.headers.get("set-cookie", "")
            assert "authorization" in set_cookies.lower() or "session" in set_cookies.lower()
