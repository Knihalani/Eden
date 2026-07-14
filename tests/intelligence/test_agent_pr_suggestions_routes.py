"""Smoke tests for the agent PR-suggestion FastAPI routes.

Mounts the :mod:`eden.api.routes.agent_pr_suggestions`
router on a minimal :class:`FastAPI` app and hits each of
the 4 routes. The feature-flag is enabled at module
scope so the dependencies pass without monkey-patching
per test.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client() -> TestClient:
    from eden.api.deps import get_current_user, require_org_member
    from eden.api.routes.agent_pr_suggestions import router
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True

    async def _fake_user() -> dict:
        return {"sub": "test-user", "org_id": "org_test"}

    app = FastAPI(title="eden-agent-pr-suggestions-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def temp_git_repo(monkeypatch):
    """A temp git repo + a LocalRepoProvider + LocalPRProvider
    pointed at it via env. Used for the open-pr route.
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(["git", "init", "-q"], cwd=tmpdir, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@eden.local"],
            cwd=tmpdir, check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Eden Test"],
            cwd=tmpdir, check=True,
        )
        (Path(tmpdir) / "foo.py").write_text("x = 1\n")
        subprocess.run(["git", "add", "foo.py"], cwd=tmpdir, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "init"],
            cwd=tmpdir, check=True,
        )
        monkeypatch.setenv("EDEN_LOCAL_REPO_PATH", tmpdir)
        monkeypatch.setenv("EDEN_REPO_PROVIDER", "local")
        monkeypatch.setenv("EDEN_PR_PROVIDER", "local")
        yield tmpdir


class TestAgentPRSugRoutes:
    def test_list_empty(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        resp = client.get(
            "/orgs/org_x/agent/pr-suggestions"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["suggestions"] == []
        assert body["data"]["count"] == 0

    def test_create_suggestion(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_abc",
                "trigger_payload": {
                    "affected_files": ["foo.py"],
                    "description": "x should be 2",
                },
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["suggestion_id"].startswith("prsug_")
        assert body["data"]["suggestion"]["trigger"] == "rca_cluster"
        assert (
            body["data"]["suggestion"]["trigger_id"] == "clu_abc"
        )

    def test_list_after_create(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        # Create one.
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_abc",
                "trigger_payload": {
                    "affected_files": ["foo.py"],
                },
            },
        )
        assert create_resp.status_code == 200
        sid = create_resp.json()["data"]["suggestion_id"]
        # List returns it.
        list_resp = client.get(
            "/orgs/org_x/agent/pr-suggestions"
        )
        assert list_resp.status_code == 200
        suggestions = list_resp.json()["data"]["suggestions"]
        assert any(s["id"] == sid for s in suggestions)

    def test_get_suggestion(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_abc",
                "trigger_payload": {
                    "affected_files": ["foo.py"],
                },
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        resp = client.get(
            f"/orgs/org_x/agent/pr-suggestions/{sid}"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["data"]["suggestion"]["id"] == sid

    def test_get_missing_returns_not_found(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        resp = client.get(
            "/orgs/org_x/agent/pr-suggestions/prsug_does_not_exist"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "not_found"

    def test_open_pr_creates_pr_record(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        # 1. Create a suggestion.
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_open",
                "trigger_payload": {
                    "affected_files": ["foo.py"],
                    "description": "x should be 2",
                },
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        # 2. Open the PR — LocalPRProvider writes the
        # JSON record to .eden/prs/1.json.
        open_resp = client.post(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/open-pr",
            json={
                "pr_title": "[Eden Agent] Test open",
                "branch": "eden/test-open",
                "base": "main",
            },
        )
        assert open_resp.status_code == 200
        body = open_resp.json()
        assert body["status"] == "ok"
        assert body["data"]["pr"]["number"] == 1
        # 3. The PR record exists on disk.
        record_path = os.path.join(
            temp_git_repo, ".eden", "prs", "1.json",
        )
        assert os.path.isfile(record_path)
        with open(record_path, encoding="utf-8") as fh:
            data = json.load(fh)
        assert data["title"] == "[Eden Agent] Test open"


# ── v1.7 endpoints: file / status / regenerate / bulk ──────────


class TestAgentPRFileRoute:
    def test_get_file_content(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        # Create a suggestion whose affected_files
        # include foo.py (which the temp repo has).
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_file",
                "trigger_payload": {"affected_files": ["foo.py"]},
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        # Read the file.
        resp = client.get(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/files/foo.py"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["path"] == "foo.py"
        assert "x = 1" in body["data"]["content"]

    def test_get_file_not_in_affected(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        # Create a suggestion WITHOUT foo.py in its
        # affected files.
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_safe",
                "trigger_payload": {"affected_files": []},
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        # The provider cannot read foo.py because the
        # suggestion doesn't include it.
        resp = client.get(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/files/foo.py"
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "not_found"

    def test_get_file_missing_suggestion(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        resp = client.get(
            "/orgs/org_x/agent/pr-suggestions/prsug_does_not_exist/files/foo.py"
        )
        assert resp.status_code == 200
        assert resp.json()["status"] == "not_found"


class TestAgentPRStatusRoute:
    def test_mark_merged(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_merge",
                "trigger_payload": {"affected_files": ["foo.py"]},
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        # First open the PR (status -> opened).
        client.post(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/open-pr",
            json={"branch": "eden/merge-test", "base": "main"},
        )
        # Then mark merged.
        resp = client.post(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/status",
            json={"status": "merged"},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["suggestion"]["status"] == "merged"

    def test_mark_rejected(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_rej",
                "trigger_payload": {"affected_files": ["foo.py"]},
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        resp = client.post(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/status",
            json={"status": "rejected"},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["suggestion"]["status"] == "rejected"

    def test_status_invalid(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_inv",
                "trigger_payload": {"affected_files": ["foo.py"]},
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        resp = client.post(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/status",
            json={"status": "nonsense"},
        )
        assert resp.json()["status"] == "bad_request"

    def test_status_missing_suggestion(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        resp = client.post(
            "/orgs/org_x/agent/pr-suggestions/prsug_nope/status",
            json={"status": "merged"},
        )
        assert resp.json()["status"] == "bad_request"


class TestAgentPRRegenerateRoute:
    def test_regenerate_resets_status(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        create_resp = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_regen",
                "trigger_payload": {"affected_files": ["foo.py"]},
            },
        )
        sid = create_resp.json()["data"]["suggestion_id"]
        # Mark as rejected first.
        client.post(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/status",
            json={"status": "rejected"},
        )
        # Regenerate.
        resp = client.post(
            f"/orgs/org_x/agent/pr-suggestions/{sid}/regenerate"
        )
        assert resp.status_code == 200
        body = resp.json()
        # Status resets to pending.
        assert body["data"]["suggestion"]["status"] == "pending"
        # The new suggestion has the same id.
        assert body["data"]["suggestion"]["id"] == sid

    def test_regenerate_missing(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        resp = client.post(
            "/orgs/org_x/agent/pr-suggestions/prsug_nope/regenerate"
        )
        assert resp.json()["status"] == "not_found"


class TestAgentPRBulkRegenerateRoute:
    def test_bulk_regenerate_mixed(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        ids: list[str] = []
        for i in range(3):
            resp = client.post(
                "/orgs/org_x/agent/pr-suggestions",
                json={
                    "trigger": "rca_cluster",
                    "trigger_id": f"clu_bulk_{i}",
                    "trigger_payload": {"affected_files": ["foo.py"]},
                },
            )
            ids.append(resp.json()["data"]["suggestion_id"])
        # Regenerate 2 real + 1 fake.
        resp = client.post(
            "/orgs/org_x/agent/pr-suggestions/bulk/regenerate",
            json={
                "suggestion_ids": [
                    ids[0], ids[1], "prsug_does_not_exist",
                ],
            },
        )
        assert resp.status_code == 200
        body = resp.json()
        # 2 real ids regenerated.
        assert len(body["data"]["regenerated"]) == 2
        assert ids[0] in body["data"]["regenerated"]
        assert ids[1] in body["data"]["regenerated"]
        # 1 fake id skipped.
        assert "prsug_does_not_exist" in body["data"]["skipped"]
        assert body["data"]["requested"] == 3

    def test_bulk_regenerate_empty(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        resp = client.post(
            "/orgs/org_x/agent/pr-suggestions/bulk/regenerate",
            json={"suggestion_ids": []},
        )
        assert resp.json()["data"]["requested"] == 0
        assert resp.json()["data"]["regenerated"] == []
        assert resp.json()["data"]["skipped"] == []


class TestAgentPRListFilter:
    def test_filter_by_trigger(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        for trig in ("rca_cluster", "drift_alert", "rca_cluster"):
            client.post(
                "/orgs/org_x/agent/pr-suggestions",
                json={
                    "trigger": trig,
                    "trigger_id": f"clu_{trig}",
                    "trigger_payload": {"affected_files": ["foo.py"]},
                },
            )
        resp = client.get(
            "/orgs/org_x/agent/pr-suggestions?trigger=drift_alert"
        )
        rows = resp.json()["data"]["suggestions"]
        assert len(rows) == 1
        assert rows[0]["trigger"] == "drift_alert"

    def test_filter_by_status(
        self, client: TestClient, temp_git_repo: str,
    ) -> None:
        client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_s1",
                "trigger_payload": {"affected_files": ["foo.py"]},
            },
        ).json()["data"]["suggestion_id"]
        s2 = client.post(
            "/orgs/org_x/agent/pr-suggestions",
            json={
                "trigger": "rca_cluster",
                "trigger_id": "clu_s2",
                "trigger_payload": {"affected_files": ["foo.py"]},
            },
        ).json()["data"]["suggestion_id"]
        # Reject s2.
        client.post(
            f"/orgs/org_x/agent/pr-suggestions/{s2}/status",
            json={"status": "rejected"},
        )
        # Filter for rejected.
        resp = client.get(
            "/orgs/org_x/agent/pr-suggestions?status=rejected"
        )
        rows = resp.json()["data"]["suggestions"]
        assert all(r["id"] == s2 for r in rows)
