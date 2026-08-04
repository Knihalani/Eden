"""Chaos — GitHub webhook re-delivery must be idempotent.

GitHub redelivers webhooks (retries, manual redeliver button). The
handler in ``src/eden/api/routes/github.py`` dedupes on
``X-GitHub-Delivery`` via Redis SET NX, and per §10.4 stamps the
``ci_status`` evidence BEFORE notifying, so a crash between stamp and
notify redelivers safely.

This suite delivers the SAME signed ``check_run`` payload twice through
the real route (FastAPI TestClient, real HMAC signature) and asserts a
single side-effect. Infra is faked per tests/chaos convention: an
in-memory Redis with genuine SET-NX semantics, mocked PG client, and
mocked plan repo / evidence merge / notifier.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_SECRET = "chaos-webhook-secret"


class FakeRedis:
    """SET-NX faithful in-memory Redis (the dedupe primitive)."""

    def __init__(self) -> None:
        self.kv: dict[str, str] = {}

    async def set(
        self, key: str, value: str, nx: bool = False, ex: int | None = None
    ) -> bool | None:
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        return True

    async def delete(self, key: str) -> None:
        self.kv.pop(key, None)


def _payload(conclusion: str = "success") -> dict[str, Any]:
    return {
        "action": "completed",
        "check_run": {
            "name": "ci/backend",
            "status": "completed",
            "conclusion": conclusion,
            "check_suite": {"head_branch": "eden/improve-chaos"},
            "pull_requests": [{"number": 7}],
            "output": {"title": "tests", "summary": "42 failed" if conclusion == "failure" else "all green"},
        },
        "repository": {"full_name": "acme/app"},
    }


def _signed_headers(body: bytes, delivery_id: str) -> dict[str, str]:
    sig = hmac.new(_SECRET.encode(), body, hashlib.sha256).hexdigest()
    return {
        "X-GitHub-Event": "check_run",
        "X-GitHub-Delivery": delivery_id,
        "X-Hub-Signature-256": f"sha256={sig}",
        "Content-Type": "application/json",
    }


@pytest.fixture()
def wired(monkeypatch):
    """Route + fakes; yields (client, fake_redis, calls dict)."""
    import eden.api.routes.github as gh

    monkeypatch.setattr(
        gh.settings, "github_app_webhook_secret", _SECRET, raising=False
    )
    from eden.config import get_settings

    monkeypatch.setattr(get_settings(), "ci_ingestion_v1", True, raising=False)

    fake_redis = FakeRedis()
    monkeypatch.setattr(
        "eden.storage.redis.get_redis_client",
        AsyncMock(return_value=fake_redis),
    )
    monkeypatch.setattr(
        gh, "get_postgres_client", AsyncMock(return_value=MagicMock())
    )

    plan = {
        "id": "00000000-0000-0000-0000-0000000000ab",
        "org_id": "org-chaos",
        "title": "chaos plan",
        "pr_url": "https://github.com/acme/app/pull/7",
        "agent_id": "agent-1",
        "status": "pr_opened",
        "files_changed": [],
    }
    calls: dict[str, Any] = {"order": [], "stamps": [], "notifies": []}

    async def _find_by_pr(*, repo_full_name: str, pr_number: int):
        assert repo_full_name == "acme/app" and pr_number == 7
        return dict(plan)

    monkeypatch.setattr("eden.improvement.plans_repo.find_by_pr", _find_by_pr)
    monkeypatch.setattr(
        "eden.improvement.plans_repo.find_by_branch",
        AsyncMock(return_value=None),
    )

    async def _merge_evidence(org_id: str, plan_id: str, evidence: dict):
        calls["order"].append("stamp")
        calls["stamps"].append((org_id, plan_id, evidence))
        return dict(plan)

    monkeypatch.setattr(
        "eden.improvement.approve._merge_plan_evidence", _merge_evidence
    )

    async def _notify(org_id: str, **kwargs: Any):
        calls["order"].append("notify")
        calls["notifies"].append({"org_id": org_id, **kwargs})

    monkeypatch.setattr(
        "eden.services.slack_notify.notify_ci_failure", _notify
    )

    async def _regen(*args: Any, **kwargs: Any):
        calls["order"].append("regenerate")

    monkeypatch.setattr(gh, "_maybe_ci_regenerate", _regen)

    app = FastAPI()
    app.include_router(gh.public_router)
    return TestClient(app), fake_redis, calls


def test_same_delivery_twice_single_side_effect(wired) -> None:
    client, fake_redis, calls = wired
    body = json.dumps(_payload("success")).encode()
    headers = _signed_headers(body, delivery_id="dlv-chaos-1")

    first = client.post(
        "/integrations/github/webhook", content=body, headers=headers
    )
    assert first.status_code == 200, first.text
    assert first.json() == {"status": "ok", "ci": "stamped"}

    # GitHub redelivers the exact same payload + delivery id.
    second = client.post(
        "/integrations/github/webhook", content=body, headers=headers
    )
    assert second.status_code == 200, second.text
    assert second.json() == {"status": "ok", "duplicate": "true"}

    # Exactly ONE evidence stamp — the redelivery short-circuited
    # before any side-effect.
    assert len(calls["stamps"]) == 1
    org_id, plan_id, evidence = calls["stamps"][0]
    assert org_id == "org-chaos"
    assert evidence["ci_status"]["conclusion"] == "success"
    assert "github:delivery:dlv-chaos-1" in fake_redis.kv


def test_red_ci_stamps_before_notify_and_dedupes_redelivery(wired) -> None:
    """§10.4 ordering: the durable ci_status stamp precedes Slack +
    regenerate, so a crash after the stamp loses only the notification
    — and a redelivery of the same conclusion is a no-op."""
    client, _fake_redis, calls = wired
    body = json.dumps(_payload("failure")).encode()
    headers = _signed_headers(body, delivery_id="dlv-chaos-2")

    resp = client.post(
        "/integrations/github/webhook", content=body, headers=headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "ok", "ci": "stamped"}

    # Stamp-first ordering, then the red-CI extras.
    assert calls["order"] == ["stamp", "notify", "regenerate"]
    assert calls["notifies"][0]["conclusion"] == "failure"
    assert calls["notifies"][0]["check_name"] == "ci/backend"

    # Redelivery: no second stamp, no second page.
    dup = client.post(
        "/integrations/github/webhook", content=body, headers=headers
    )
    assert dup.json() == {"status": "ok", "duplicate": "true"}
    assert calls["order"] == ["stamp", "notify", "regenerate"]


def test_unsigned_delivery_rejected(wired) -> None:
    """Chaos guard: a redelivered payload with a bad signature never
    reaches the dedupe or the stamp."""
    client, _fake_redis, calls = wired
    body = json.dumps(_payload("success")).encode()
    headers = _signed_headers(body, delivery_id="dlv-chaos-3")
    headers["X-Hub-Signature-256"] = "sha256=" + "0" * 64

    resp = client.post(
        "/integrations/github/webhook", content=body, headers=headers
    )
    assert resp.status_code == 401
    assert calls["stamps"] == []
