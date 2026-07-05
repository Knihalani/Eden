"""Test default-deny allowlist covers the public GitHub integration surface.

Bug found 2026-07-04 — the /integrations/github/{configured,callback,webhook}
routes were documented as public but the default-deny middleware 401'd them
all. Impact:
  - /configured: portal's githubApi.configured() fell through to
    setConfigured(false) → permanent "GitHub integration not configured"
    panel even when the App was configured.
  - /callback: OAuth handoff from GitHub (no Eden auth at that point)
    always 401, no installation row persisted.
  - /webhook: GitHub posts PR events with only HMAC. Always 401, PR
    status never updated.

These tests lock the prefix in so a future middleware refactor can't
regress the public list silently.
"""

from __future__ import annotations

from starlette.testclient import TestClient

from eden.api.app import app
from eden.api.middleware.default_deny import DEFAULT_PUBLIC_PREFIXES


def test_github_public_prefix_present():
    assert "/integrations/github" in DEFAULT_PUBLIC_PREFIXES


def test_github_configured_reachable_without_auth():
    client = TestClient(app)
    resp = client.get("/integrations/github/configured")
    # Must NOT 401 — either 200 with the configured flag, or 503 if the
    # Eden instance has no GitHub App env vars set. Both prove the
    # default-deny gate is open.
    assert resp.status_code in (200, 503), (
        f"/integrations/github/configured must be public; got {resp.status_code} "
        f"({resp.json() if resp.headers.get('content-type', '').startswith('application/json') else resp.text})"
    )


def test_github_callback_reachable_without_auth():
    client = TestClient(app)
    # No installation_id query param — FastAPI returns 422 on the
    # validation error, which proves the route is reachable past the
    # middleware. With default-deny blocking, we'd see 401 instead.
    resp = client.get("/integrations/github/callback")
    assert resp.status_code != 401, (
        "/integrations/github/callback must be public; got 401"
    )
    # 422 = validation error (no installation_id), 302 = redirect to
    # the wizard, 503 = GitHub App not configured. All prove reach.
    assert resp.status_code in (302, 422, 503)


def test_github_webhook_reachable_without_auth():
    client = TestClient(app)
    resp = client.post(
        "/integrations/github/webhook",
        headers={"X-GitHub-Event": "ping"},
        json={},
    )
    # 401 = HMAC verification rejected the empty signature — proof the
    # route is reachable past default-deny. 503 = webhook secret not
    # configured. Both acceptable; default-deny-401 is the bug.
    assert resp.status_code != 401, (
        "/integrations/github/webhook must be public; got 401"
    )
    assert resp.status_code in (401, 503)
