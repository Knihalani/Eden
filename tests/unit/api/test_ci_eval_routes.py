"""F56 CI-eval route contract tests.

The composite action's PR-comment renderer depends on the exact keys of the
``/ci-eval/run`` response, so this asserts them precisely. Also covers the
runs list/detail endpoints and the commit-status flag (off by default => no
GitHub call).
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import wave6_online as w6
from eden.evaluation.ci_webhook import CIWebhookHandler
from eden.evaluation.regression_runner import RegressionRunResult


def _app() -> FastAPI:
    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(w6.router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


class _FakeRunner:
    def __init__(self, result: RegressionRunResult) -> None:
        self._result = result

    async def run_suite(self, org_id, *, agent_id=None, change_id=None):
        return self._result


class _FakeHistory:
    def __init__(self, baseline=(None, None)) -> None:
        self.enriched: list = []
        self._baseline = baseline

    async def enrich(self, run_id, **kwargs):
        self.enriched.append((run_id, kwargs))

    async def resolve_baseline(self, org_id, *, agent_id, explicit_id, exclude_id):
        return self._baseline


def _result(passed=2, failed=0, skipped=1, errors=0) -> RegressionRunResult:
    cases = []
    for i in range(passed):
        cases.append({"case_id": f"p{i}", "fingerprint": None, "status": "passed", "reason": "ok"})
    for i in range(failed):
        cases.append({"case_id": f"f{i}", "fingerprint": None, "status": "failed", "reason": "mismatch"})
    for i in range(skipped):
        cases.append({"case_id": f"s{i}", "fingerprint": None, "status": "skipped", "reason": "no_trace"})
    for i in range(errors):
        cases.append({"case_id": f"e{i}", "fingerprint": None, "status": "error", "reason": "telemetry_unavailable"})
    failures = [c for c in cases if c["status"] in ("failed", "error")]
    return RegressionRunResult(
        id="11111111-1111-1111-1111-111111111111",
        org_id="org_1",
        agent_id=None,
        change_id="pr-42",
        passed=passed,
        failed=failed,
        skipped=skipped,
        errors=errors,
        failures=failures,
        cases=cases,
    )


_EXPECTED_KEYS = {
    "response_version",
    "change_id",
    "changed_files",
    "ref",
    "commit_sha",
    "pr_number",
    "run_id",
    "ok",
    "gate",
    "regression",
    "summary",
    "score_table",
    "skips",
    "errors_detail",
    "baseline",
    "commit_status",
    "runs_url",
}


def _patch_handler(runner, history):
    handler = CIWebhookHandler(runner=runner, history=history)
    return patch.object(w6, "CIWebhookHandler", lambda: handler)


def test_ci_eval_run_contract_keys(client: TestClient) -> None:
    with _patch_handler(_FakeRunner(_result()), _FakeHistory()):
        resp = client.post(
            "/orgs/org_1/ci-eval/run",
            json={"change_id": "pr-42", "changed_files": ["a.py"]},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    data = body["data"]
    # Exact top-level key set — the action renderer depends on this.
    assert set(data.keys()) == _EXPECTED_KEYS
    assert data["response_version"] == "v1"
    assert data["gate"] == "pass"
    assert data["ok"] is True
    # summary breakdown
    assert data["summary"] == {
        "passed": 2,
        "failed": 0,
        "skipped": 1,
        "errors": 0,
        "total": 3,
        "ok": True,
    }
    # score table row shape
    assert data["score_table"]
    for row in data["score_table"]:
        assert set(row.keys()) == {"metric", "baseline", "current", "delta", "verdict"}
    # skips breakdown carries per-case reasons
    assert data["skips"]["count"] == 1
    assert data["skips"]["cases"][0]["reason"] == "no_trace"
    # flag off by default
    assert data["commit_status"] == {"posted": False, "reason": "flag_disabled"}
    assert data["runs_url"] == "/orgs/org_1/ci-eval/runs"


def test_ci_eval_run_blocks_on_failure(client: TestClient) -> None:
    with _patch_handler(_FakeRunner(_result(passed=1, failed=1, skipped=0)), _FakeHistory()):
        resp = client.post(
            "/orgs/org_1/ci-eval/run",
            json={"change_id": "pr-1", "changed_files": []},
        )
    data = resp.json()["data"]
    assert data["ok"] is False
    assert data["gate"] == "block"
    assert data["errors_detail"] == []


def test_ci_eval_run_commit_status_off_no_github_call(client: TestClient) -> None:
    # Even when repo/sha + opt-in are supplied, the default-off flag must
    # short-circuit before any GitHub work.
    with _patch_handler(_FakeRunner(_result()), _FakeHistory()):
        with patch(
            "eden.evaluation.ci_eval_commit_status.post_commit_status",
            new=AsyncMock(),
        ) as mock_post:
            resp = client.post(
                "/orgs/org_1/ci-eval/run",
                json={
                    "change_id": "pr-42",
                    "changed_files": [],
                    "repo_full_name": "acme/app",
                    "commit_sha": "deadbeefdeadbeef",
                    "post_commit_status": True,
                },
            )
    assert resp.status_code == 200
    mock_post.assert_not_called()
    assert resp.json()["data"]["commit_status"] == {
        "posted": False,
        "reason": "flag_disabled",
    }


def test_ci_eval_run_commit_status_on_calls_github(client: TestClient, monkeypatch) -> None:
    from eden.config import get_settings

    monkeypatch.setattr(get_settings(), "ci_eval_commit_status_v1", True)
    with _patch_handler(_FakeRunner(_result()), _FakeHistory()):
        with patch(
            "eden.evaluation.ci_eval_commit_status.post_commit_status",
            new=AsyncMock(return_value={"posted": True, "check_run_id": 7}),
        ) as mock_post:
            resp = client.post(
                "/orgs/org_1/ci-eval/run",
                json={
                    "change_id": "pr-42",
                    "changed_files": [],
                    "repo_full_name": "acme/app",
                    "commit_sha": "deadbeefdeadbeef",
                    "post_commit_status": True,
                },
            )
    assert resp.status_code == 200
    mock_post.assert_awaited_once()
    assert resp.json()["data"]["commit_status"] == {"posted": True, "check_run_id": 7}


# ── runs list / detail ───────────────────────────────────────────────

class _FakePg:
    def __init__(self, rows=None, detail=None, count=0) -> None:
        self._rows = rows or []
        self._detail = detail
        self._count = count

    async def fetch(self, query, *args):
        return self._rows

    async def fetchrow(self, query, *args):
        if "COUNT(*)" in query:
            return {"n": self._count}
        return self._detail


def _row(run_id="22222222-2222-2222-2222-222222222222"):
    return {
        "id": run_id,
        "org_id": "org_1",
        "agent_id": None,
        "change_id": "pr-42",
        "passed": 3,
        "failed": 0,
        "status": "completed",
        "created_at": datetime(2026, 8, 4, tzinfo=UTC),
        "metadata": {
            "skipped": 1,
            "errors": 0,
            "ref": "refs/heads/main",
            "commit_sha": "abc123",
            "pr_number": 42,
        },
    }


def test_ci_eval_runs_list(client: TestClient) -> None:
    from eden.evaluation.ci_eval_history import CIEvalHistoryStore

    store = CIEvalHistoryStore(pg=_FakePg(rows=[_row()], count=1))
    with patch(
        "eden.evaluation.ci_eval_history.CIEvalHistoryStore", return_value=store
    ):
        resp = client.get("/orgs/org_1/ci-eval/runs?limit=10&offset=0")
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["total"] == 1
    assert data["limit"] == 10
    run = data["runs"][0]
    assert run["counts"] == {"passed": 3, "failed": 0, "skipped": 1, "errors": 0, "total": 4}
    assert run["ok"] is True
    assert run["commit_sha"] == "abc123"
    assert run["ref"] == "refs/heads/main"


def test_ci_eval_run_detail(client: TestClient) -> None:
    from eden.evaluation.ci_eval_history import CIEvalHistoryStore

    detail_row = _row()
    detail_row["failures"] = []
    store = CIEvalHistoryStore(pg=_FakePg(detail=detail_row))
    with patch(
        "eden.evaluation.ci_eval_history.CIEvalHistoryStore", return_value=store
    ):
        resp = client.get(f"/orgs/org_1/ci-eval/runs/{detail_row['id']}")
    assert resp.status_code == 200
    run = resp.json()["data"]["run"]
    assert run["id"] == detail_row["id"]
    assert "cases" in run and "failures" in run


def test_ci_eval_run_detail_404(client: TestClient) -> None:
    from eden.evaluation.ci_eval_history import CIEvalHistoryStore

    store = CIEvalHistoryStore(pg=_FakePg(detail=None))
    with patch(
        "eden.evaluation.ci_eval_history.CIEvalHistoryStore", return_value=store
    ):
        resp = client.get("/orgs/org_1/ci-eval/runs/33333333-3333-3333-3333-333333333333")
    assert resp.status_code == 404
