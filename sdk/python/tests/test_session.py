"""F23 agent session SDK — begin / identify / complete / current_session."""

from __future__ import annotations

import time

import httpx
import pytest

import eden
from eden_sdk import session as session_mod


def test_begin_sets_current_session() -> None:
    s = eden.begin(agent_id="a1", user_id="u1")
    assert eden.current_session() is s
    assert s.session_id
    assert s.org_id == "test-org"
    assert s.agent_id == "a1"
    eden.complete_session(s)
    assert eden.current_session() is None


def test_begin_no_nameerror() -> None:
    """Regression: begin() must not raise NameError on get_default_client."""
    s = session_mod.begin(metadata={"k": "v"})
    assert s.metadata["k"] == "v"
    s.complete(success=True, flush=False)


def test_context_manager_completes() -> None:
    with eden.begin(agent_id="ctx") as s:
        assert eden.current_session() is s
        s.add_cost(0.01)
    assert eden.current_session() is None
    assert s._ended is True
    assert s.cost_usd == 0.01


def test_identify_updates_user() -> None:
    s = eden.begin()
    eden.identify("user-42")
    assert s.user_id == "user-42"
    s.complete(flush=False)


def test_session_notify_uses_ingest_path_and_org_api_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    posts: list[tuple[str, dict, dict]] = []

    def _fake_post(url, json=None, headers=None, timeout=None):  # noqa: A002
        posts.append((url, json or {}, dict(headers or {})))
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(httpx, "post", _fake_post)
    s = session_mod.begin(agent_id="agent-x", session_id="sess-fixed")
    time.sleep(0.08)
    s.identify("uid-9")
    time.sleep(0.08)
    # ``complete`` uses wait=True on the end notify — no sleep needed.
    s.complete(success=True, flush=False)

    assert any("/ingest/agent-sessions/start" in u for u, _, _ in posts)
    assert any("/ingest/agent-sessions/sess-fixed/identify" in u for u, _, _ in posts)
    assert any("/ingest/agent-sessions/sess-fixed/end" in u for u, _, _ in posts)
    for _, _, headers in posts:
        assert headers.get("X-Org-Api-Key") == "test-key"
        assert headers.get("X-Org-Id") == "test-org"


def test_session_end_notify_waits_for_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: daemon end-notify used to die under SystemExit before POST."""
    seen: list[str] = []

    def _fake_post(url, json=None, headers=None, timeout=None):  # noqa: A002
        seen.append(url)
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(httpx, "post", _fake_post)
    s = session_mod.begin(agent_id="agent-y", session_id="sess-end-wait")
    time.sleep(0.05)
    s.complete(success=False, failure_reason="boom", flush=False)
    assert any(u.endswith("/sess-end-wait/end") for u in seen)


def test_shim_exports_session_api() -> None:
    assert hasattr(eden, "begin")
    assert hasattr(eden, "identify")
    assert hasattr(eden, "complete_session")
    assert hasattr(eden, "current_session")
    assert hasattr(eden, "AgentSession")
