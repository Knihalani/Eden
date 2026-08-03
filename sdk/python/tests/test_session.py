"""F23 agent session SDK — begin / identify / complete / current_session."""

from __future__ import annotations

import httpx
import pytest

import eden
from eden_sdk import session as session_mod
from _http_body import decode_ingest_body


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
    posts: list[tuple[str, bytes, dict]] = []

    def _fake_post(self, url, content=None, headers=None, timeout=None):
        posts.append((url, content or b"", dict(headers or {})))
        return httpx.Response(200, json={"status": "ok"})

    # Patched on the class (not the module-level ``httpx.post`` free
    # function) because ``_notify_session`` now posts through a
    # pooled, reused ``httpx.Client`` instance (see
    # ``session._get_session_http_client``) rather than opening a
    # fresh connection per call.
    monkeypatch.setattr(httpx.Client, "post", _fake_post)
    s = session_mod.begin(agent_id="agent-x", session_id="sess-fixed")
    # ``begin``/``identify``/``complete`` all use wait=True, so no
    # sleeps are needed — the pool job has already resolved by the
    # time each call returns.
    s.identify("uid-9")
    s.complete(success=True, flush=False)

    assert any("/ingest/agent-sessions/start" in u for u, _, _ in posts)
    assert any("/ingest/agent-sessions/sess-fixed/identify" in u for u, _, _ in posts)
    assert any("/ingest/agent-sessions/sess-fixed/end" in u for u, _, _ in posts)
    for _, content, headers in posts:
        assert headers.get("X-Org-Api-Key") == "test-key"
        assert headers.get("X-Org-Id") == "test-org"
        # Every lifecycle notify is gzip-compressed like the main
        # ingest path (K35-style parity with ``client.py``).
        assert headers.get("Content-Encoding") == "gzip"
        decode_ingest_body(content, headers)  # must not raise


def test_session_end_notify_waits_for_worker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: end-notify must complete before ``complete()`` returns."""
    seen: list[str] = []

    def _fake_post(self, url, content=None, headers=None, timeout=None):
        seen.append(url)
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(httpx.Client, "post", _fake_post)
    s = session_mod.begin(agent_id="agent-y", session_id="sess-end-wait")
    s.complete(success=False, failure_reason="boom", flush=False)
    assert any(u.endswith("/sess-end-wait/end") for u in seen)


def test_notify_session_reuses_pooled_client_and_executor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Phase 5 — no new httpx.Client / OS thread per lifecycle call.

    Regression guard for the fix: previously every ``_notify_session``
    call built a brand-new ``httpx`` connection (module-level
    ``httpx.post``) inside a brand-new ``threading.Thread``. Now both
    the client and the worker pool are built once and reused.
    """
    calls = 0

    def _fake_post(self, url, content=None, headers=None, timeout=None):
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"status": "ok"})

    monkeypatch.setattr(httpx.Client, "post", _fake_post)

    client_before = session_mod._get_session_http_client()
    executor_before = session_mod._get_session_executor()

    s = session_mod.begin(agent_id="agent-pool", session_id="sess-pool")
    s.identify("uid-pool")
    s.complete(success=True, flush=False)

    assert calls == 3
    assert session_mod._get_session_http_client() is client_before
    assert session_mod._get_session_executor() is executor_before


def test_shim_exports_session_api() -> None:
    assert hasattr(eden, "begin")
    assert hasattr(eden, "identify")
    assert hasattr(eden, "complete_session")
    assert hasattr(eden, "current_session")
    assert hasattr(eden, "AgentSession")
