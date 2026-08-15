"""Default-deny must not 401 Slack Events / Interactivity / OAuth callback.

Same class of bug as GitHub (2026-07-04): Slack POSTs url_verification
with no Eden JWT. A 401 ``Authentication required`` makes Slack say
"Your URL didn't respond."
"""

from __future__ import annotations

from starlette.testclient import TestClient

from eden.api.app import app
from eden.api.middleware.default_deny import DEFAULT_PUBLIC_PREFIXES


def test_slack_public_prefix_present() -> None:
    assert "/integrations/slack" in DEFAULT_PUBLIC_PREFIXES


def test_slack_events_not_blocked_by_default_deny() -> None:
    client = TestClient(app)
    resp = client.post(
        "/integrations/slack/events",
        json={"type": "url_verification", "challenge": "eden-check"},
    )
    body = resp.json() if resp.headers.get("content-type", "").startswith(
        "application/json"
    ) else {}
    assert body.get("detail") != "Authentication required", (
        f"/integrations/slack/events must pass default-deny; got {resp.status_code} {body}"
    )
    # Unsigned: 401 invalid signature or 503 signing secret unset.
    assert resp.status_code in (401, 503)


def test_slack_interactions_not_blocked_by_default_deny() -> None:
    client = TestClient(app)
    resp = client.post(
        "/integrations/slack/interactions",
        data={"payload": "{}"},
    )
    body = resp.json() if resp.headers.get("content-type", "").startswith(
        "application/json"
    ) else {}
    assert body.get("detail") != "Authentication required", (
        f"/integrations/slack/interactions must pass default-deny; got {resp.status_code} {body}"
    )
    assert resp.status_code in (401, 503)


def test_slack_callback_reachable_without_auth() -> None:
    client = TestClient(app)
    resp = client.get("/integrations/slack/callback")
    assert resp.status_code != 401, (
        "/integrations/slack/callback must be public; got 401"
    )
