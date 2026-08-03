"""M9 (§4.3): check_run / check_suite CI ingestion webhooks.

Covers: red CI stamps the plan THEN notifies and triggers at most one
regenerate; green CI stamps without notifying; re-delivery is
idempotent via the X-GitHub-Delivery SETNX dedupe; non-Eden branches
are ignored; the ``ci_ingestion_v1`` flag gates the whole surface.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.routes import github as gh
from eden.api.routes.github import _ingest_check_conclusion, _maybe_ci_regenerate

_PLAN = {
    "id": "plan-1",
    "org_id": "org-1",
    "status": "pr_opened",
    "title": "Fix foo",
    "agent_id": "repo-a",
    "pr_url": "https://github.com/acme/widgets/pull/42",
    "github_branch": "eden/improve-plan-1",
    "files_changed": [{"path": "src/foo.py"}],
    "evidence": {"issue_id": "iss-1"},
}


def _check_run_payload(
    conclusion: str = "failure",
    *,
    action: str = "completed",
    branch: str = "eden/improve-plan-1",
    pull_requests: list | None = None,
) -> dict:
    return {
        "action": action,
        "check_run": {
            "name": "ci/test",
            "status": "completed",
            "conclusion": conclusion,
            "check_suite": {"head_branch": branch},
            "pull_requests": pull_requests or [],
            "output": {"title": "2 failed", "summary": "test_foo failed"},
        },
        "repository": {"full_name": "acme/widgets"},
    }


def _ingest_patches(plan: dict | None = _PLAN):
    """Standard patch set for _ingest_check_conclusion tests."""
    updated = {**(plan or {}), "evidence": {"ci_status": {}}} if plan else None
    return (
        patch("eden.improvement.plans_repo.find_by_branch", AsyncMock(return_value=plan)),
        patch("eden.improvement.plans_repo.find_by_pr", AsyncMock(return_value=None)),
        patch(
            "eden.improvement.approve._merge_plan_evidence",
            AsyncMock(return_value=updated),
        ),
        patch("eden.services.slack_notify.notify_ci_failure", AsyncMock()),
        patch.object(gh, "_maybe_ci_regenerate", AsyncMock()),
    )


@pytest.mark.asyncio
async def test_check_run_failure_stamps_then_notifies_then_regenerates() -> None:
    find_branch, find_pr, merge, notify, regen = _ingest_patches()
    with find_branch as fb, find_pr, merge as m, notify as n, regen as r:
        result = await _ingest_check_conclusion(
            "check_run", _check_run_payload("failure")
        )

    assert result == {"status": "ok", "ci": "stamped"}
    fb.assert_awaited_once_with(github_branch="eden/improve-plan-1")
    m.assert_awaited_once()
    org_id, plan_id, evidence_patch = m.await_args.args
    assert (org_id, plan_id) == ("org-1", "plan-1")
    ci = evidence_patch["ci_status"]
    assert ci["conclusion"] == "failure"
    assert ci["check_name"] == "ci/test"
    assert ci["state"] == "completed"
    assert ci["updated_at"]
    n.assert_awaited_once()
    assert n.await_args.kwargs["plan_id"] == "plan-1"
    assert n.await_args.kwargs["check_name"] == "ci/test"
    r.assert_awaited_once()
    assert r.await_args.kwargs["excerpt"] == "2 failed — test_foo failed"


@pytest.mark.asyncio
async def test_success_stamps_without_notify_or_regenerate() -> None:
    find_branch, find_pr, merge, notify, regen = _ingest_patches()
    with find_branch, find_pr, merge as m, notify as n, regen as r:
        result = await _ingest_check_conclusion(
            "check_run", _check_run_payload("success")
        )

    assert result == {"status": "ok", "ci": "stamped"}
    assert m.await_args.args[2]["ci_status"]["conclusion"] == "success"
    n.assert_not_awaited()
    r.assert_not_awaited()


@pytest.mark.asyncio
async def test_payload_pr_number_resolves_via_find_by_pr() -> None:
    find_branch, find_pr, merge, notify, regen = _ingest_patches()
    with find_branch as fb, find_pr as fp, merge, notify, regen:
        fp.return_value = _PLAN
        await _ingest_check_conclusion(
            "check_run",
            _check_run_payload("failure", pull_requests=[{"number": 42}]),
        )

    fp.assert_awaited_once_with(repo_full_name="acme/widgets", pr_number=42)
    fb.assert_not_awaited()


@pytest.mark.asyncio
async def test_unknown_branch_ignored_without_lookups() -> None:
    find_branch, find_pr, merge, notify, regen = _ingest_patches()
    with find_branch as fb, find_pr, merge as m, notify as n, regen:
        result = await _ingest_check_conclusion(
            "check_run", _check_run_payload("failure", branch="feature/other")
        )

    assert result == {"status": "ignored", "reason": "not_an_eden_branch"}
    fb.assert_not_awaited()
    m.assert_not_awaited()
    n.assert_not_awaited()


@pytest.mark.asyncio
async def test_non_conclusion_action_ignored() -> None:
    find_branch, find_pr, merge, notify, regen = _ingest_patches()
    with find_branch as fb, find_pr, merge, notify, regen:
        result = await _ingest_check_conclusion(
            "check_run", _check_run_payload("failure", action="created")
        )

    assert result == {"status": "ignored", "reason": "not_a_conclusion"}
    fb.assert_not_awaited()


@pytest.mark.asyncio
async def test_flag_off_ignores_event() -> None:
    find_branch, find_pr, merge, notify, regen = _ingest_patches()
    with (
        patch(
            "eden.config.get_settings",
            return_value=SimpleNamespace(ci_ingestion_v1=False),
        ),
        find_branch as fb,
        find_pr,
        merge as m,
        notify,
        regen,
    ):
        result = await _ingest_check_conclusion(
            "check_run", _check_run_payload("failure")
        )

    assert result == {"status": "ignored", "reason": "ci_ingestion_disabled"}
    fb.assert_not_awaited()
    m.assert_not_awaited()


class TestCiRegenerateGuard:
    """At most one CI regenerate per plan, only while pr_opened."""

    def _patches(self):
        return (
            patch(
                "eden.improvement.approve._merge_plan_evidence",
                AsyncMock(return_value=None),
            ),
            patch(
                "eden.improvement.approve.regenerate_plan_diff_from_static_errors",
                AsyncMock(return_value={"status": "ok"}),
            ),
            patch(
                "eden.providers.factory.get_repo_provider_for_org",
                AsyncMock(return_value=MagicMock()),
            ),
        )

    @pytest.mark.asyncio
    async def test_first_failure_triggers_one_regenerate(self) -> None:
        merge, regen, provider = self._patches()
        with merge as m, regen as r, provider:
            await _maybe_ci_regenerate(
                "org-1", dict(_PLAN), check_name="ci/test", excerpt="boom"
            )

        m.assert_awaited_once()
        assert "ci_regenerate" in m.await_args.args[2]
        r.assert_awaited_once()
        errors = r.await_args.kwargs["static_errors"]
        assert errors == [
            {"path": "ci/test", "kind": "ci_failure", "message": "boom"}
        ]
        assert r.await_args.kwargs["linked_paths"] == ["src/foo.py"]

    @pytest.mark.asyncio
    async def test_second_failure_does_not_regenerate_again(self) -> None:
        plan = {**_PLAN, "evidence": {"ci_regenerate": {"check_name": "ci/test"}}}
        merge, regen, provider = self._patches()
        with merge as m, regen as r, provider:
            await _maybe_ci_regenerate(
                "org-1", plan, check_name="ci/test", excerpt="boom"
            )

        m.assert_not_awaited()
        r.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_closed_plan_never_regenerates(self) -> None:
        merge, regen, provider = self._patches()
        with merge as m, regen as r, provider:
            await _maybe_ci_regenerate(
                "org-1",
                {**_PLAN, "status": "merged"},
                check_name="ci/test",
                excerpt="boom",
            )

        m.assert_not_awaited()
        r.assert_not_awaited()


class TestWebhookDelivery:
    """HTTP-level: signature + X-GitHub-Delivery SETNX re-delivery dedupe."""

    _SECRET = "whsec-test"

    def _client(self) -> TestClient:
        app = FastAPI()
        app.include_router(gh.public_router)
        return TestClient(app)

    def _post(self, client: TestClient, payload: dict, delivery: str):
        body = json.dumps(payload).encode()
        sig = "sha256=" + hmac.new(
            self._SECRET.encode(), body, hashlib.sha256
        ).hexdigest()
        return client.post(
            "/integrations/github/webhook",
            content=body,
            headers={
                "X-Hub-Signature-256": sig,
                "X-GitHub-Event": "check_run",
                "X-GitHub-Delivery": delivery,
            },
        )

    def test_redelivery_short_circuits_before_handler(self, monkeypatch) -> None:
        monkeypatch.setattr(
            gh, "settings", SimpleNamespace(github_app_webhook_secret=self._SECRET)
        )
        redis = MagicMock()
        redis.set = AsyncMock(side_effect=[True, False])
        redis.delete = AsyncMock()
        handler = AsyncMock(return_value={"status": "ok", "ci": "stamped"})
        with (
            patch(
                "eden.storage.redis.get_redis_client",
                AsyncMock(return_value=redis),
            ),
            patch.object(gh, "_ingest_check_conclusion", handler),
        ):
            client = self._client()
            first = self._post(client, _check_run_payload("failure"), "d-1")
            second = self._post(client, _check_run_payload("failure"), "d-1")

        assert first.status_code == 200
        assert first.json() == {"status": "ok", "ci": "stamped"}
        assert second.json() == {"status": "ok", "duplicate": "true"}
        handler.assert_awaited_once()
        assert redis.set.await_count == 2

    def test_bad_signature_rejected(self, monkeypatch) -> None:
        monkeypatch.setattr(
            gh, "settings", SimpleNamespace(github_app_webhook_secret=self._SECRET)
        )
        client = self._client()
        resp = client.post(
            "/integrations/github/webhook",
            content=b"{}",
            headers={
                "X-Hub-Signature-256": "sha256=deadbeef",
                "X-GitHub-Event": "check_run",
                "X-GitHub-Delivery": "d-2",
            },
        )
        assert resp.status_code == 401
