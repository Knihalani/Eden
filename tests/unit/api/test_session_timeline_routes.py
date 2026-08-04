"""N12 timeline routes — contract tests (mini-app + dependency overrides).

Service behaviour (SQL, rollup) is covered by the live-PG tests in
``tests/unit/sessions/test_session_rollup.py``; this file pins the HTTP
contract: auth deps are applied, filters are forwarded, and the
error mapping (404 vs 503) matches the repo convention (storage down →
503 + Retry-After, never a soft-empty list).

Pattern copied from ``tests/unit/api/test_improve_routes.py``.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import eden.sessions as sessions_mod
from eden.api.deps import get_current_user, require_path_org_access
from eden.api.routes import sessions as sessions_routes
from eden.sessions.timeline import IssueNotFoundError, SessionNotFoundError

_SUMMARY = {
    "session_id": "sess-1",
    "agent_id": "agent-a",
    "user_id": "user-1",
    "trace_ids": ["t1", "t2"],
    "turn_count": 2,
    "total_cost_usd": 0.05,
    "total_input_tokens": 300,
    "total_output_tokens": 30,
    "total_latency_ms": 2000.0,
    "session_start": "2026-08-04T10:00:00+00:00",
    "session_end": "2026-08-04T10:05:00+00:00",
    "had_stumble": True,
    "stumble_count": 1,
    "stumble_turn_indices": [2],
    "issue_count": 1,
    "linked_issue_id": None,
    "outcome": "success",
    "updated_at": "2026-08-04T10:05:01+00:00",
}

_TURN = {
    "index": 1,
    "trace_id": "t1",
    "started_at": "2026-08-04T10:00:00+00:00",
    "ended_at": "2026-08-04T10:00:30+00:00",
    "duration_ms": 900.0,
    "cost_usd": 0.02,
    "input_tokens": 100,
    "output_tokens": 10,
    "outcome": "success",
    "error_type": None,
    "had_stumble": False,
    "stumble_kinds": [],
    "issues": [],
    "summary": "turn 1 request",
}


def _app() -> FastAPI:
    app = FastAPI()

    async def _fake_user() -> dict:
        return {"id": "user_1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(sessions_routes.timeline_router)
    return app


@pytest.fixture
def client() -> TestClient:
    return TestClient(_app())


class TestSessionList:
    def test_list_shape_and_filter_forwarding(self, client: TestClient) -> None:
        mock = AsyncMock(
            return_value={
                "sessions": [_SUMMARY],
                "total": 1,
                "limit": 25,
                "offset": 0,
            }
        )
        with patch.object(sessions_mod, "list_sessions", mock):
            resp = client.get(
                "/orgs/org_1/sessions"
                "?agent_id=agent-a&had_stumble=true&min_cost=0.01"
                "&since=2026-08-04T00:00:00Z&limit=25"
            )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert body["sessions"][0]["session_id"] == "sess-1"
        assert body["sessions"][0]["stumble_turn_indices"] == [2]
        kwargs = mock.call_args.kwargs
        assert mock.call_args.args == ("org_1",)
        assert kwargs["agent_id"] == "agent-a"
        assert kwargs["had_stumble"] is True
        assert kwargs["min_cost"] == 0.01
        assert kwargs["since"] is not None
        assert kwargs["limit"] == 25 and kwargs["offset"] == 0

    def test_storage_down_is_503_not_empty(self, client: TestClient) -> None:
        with patch.object(
            sessions_mod,
            "list_sessions",
            AsyncMock(side_effect=ConnectionError("pg down")),
        ):
            resp = client.get("/orgs/org_1/sessions")
        assert resp.status_code == 503
        assert resp.headers.get("Retry-After") == "5"

    def test_bad_limit_rejected(self, client: TestClient) -> None:
        resp = client.get("/orgs/org_1/sessions?limit=0")
        assert resp.status_code == 422


class TestSessionTimeline:
    def test_timeline_shape(self, client: TestClient) -> None:
        mock = AsyncMock(
            return_value={
                "org_id": "org_1",
                "session_id": "sess-1",
                "summary": _SUMMARY,
                "turn_count": 2,
                "turns": [
                    _TURN,
                    {
                        **_TURN,
                        "index": 2,
                        "trace_id": "t2",
                        "had_stumble": True,
                        "stumble_kinds": ["loop"],
                        "issues": [
                            {
                                "issue_id": "9b2f...",
                                "status": "open",
                                "severity": "p2",
                                "title": "loops on retry",
                            }
                        ],
                    },
                ],
            }
        )
        with patch.object(sessions_mod, "get_session_timeline", mock):
            resp = client.get("/orgs/org_1/sessions/sess-1/timeline")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [t["index"] for t in body["turns"]] == [1, 2]
        assert body["turns"][1]["stumble_kinds"] == ["loop"]
        assert body["turns"][1]["issues"][0]["status"] == "open"
        assert body["summary"]["total_cost_usd"] == pytest.approx(0.05)
        mock.assert_awaited_once_with("org_1", "sess-1")

    def test_unknown_session_is_404(self, client: TestClient) -> None:
        with patch.object(
            sessions_mod,
            "get_session_timeline",
            AsyncMock(side_effect=SessionNotFoundError("sess-x")),
        ):
            resp = client.get("/orgs/org_1/sessions/sess-x/timeline")
        assert resp.status_code == 404


class TestLinkIssue:
    def test_link_ok(self, client: TestClient) -> None:
        mock = AsyncMock(
            return_value={"session_id": "sess-1", "linked_issue_id": "abc"}
        )
        with patch.object(sessions_mod, "link_issue", mock):
            resp = client.post(
                "/orgs/org_1/sessions/sess-1/link-issue",
                json={"issue_id": "abc"},
            )
        assert resp.status_code == 200, resp.text
        assert resp.json() == {
            "status": "ok",
            "session_id": "sess-1",
            "linked_issue_id": "abc",
        }
        mock.assert_awaited_once_with("org_1", "sess-1", "abc")

    def test_foreign_or_missing_issue_is_404(self, client: TestClient) -> None:
        with patch.object(
            sessions_mod,
            "link_issue",
            AsyncMock(side_effect=IssueNotFoundError("other-org-issue")),
        ):
            resp = client.post(
                "/orgs/org_1/sessions/sess-1/link-issue",
                json={"issue_id": "other-org-issue"},
            )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "issue not found"

    def test_unknown_session_is_404(self, client: TestClient) -> None:
        with patch.object(
            sessions_mod,
            "link_issue",
            AsyncMock(side_effect=SessionNotFoundError("sess-x")),
        ):
            resp = client.post(
                "/orgs/org_1/sessions/sess-x/link-issue",
                json={"issue_id": "abc"},
            )
        assert resp.status_code == 404
        assert resp.json()["detail"] == "session not found"

    def test_missing_body_is_422(self, client: TestClient) -> None:
        resp = client.post("/orgs/org_1/sessions/sess-1/link-issue", json={})
        assert resp.status_code == 422
