"""Tests for the C1-owned slash commands.

We test the pure helpers (the ``run_*`` / ``handle_*`` functions)
without going through Aider's chat loop, plus the parser
construction and quick smoke tests of the cmd_* entry points.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

import httpx
import pytest

from eden.api_client import EdenAPIClient
from eden.config import ContextConfig, EdenCLIConfig
from eden.kb_context import KBContextProvider
from eden.observability_context import ObservabilityContextProvider


# ── KB command ─────────────────────────────────────────────────────────


def test_kb_query_handler_renders_results(monkeypatch):
    cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": [
            {"title": "X", "content": "X-content", "source": "kb"}
        ]})

    client = EdenAPIClient(cfg, max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]

    provider = KBContextProvider(client, ContextConfig(kb_token_budget=2000))

    class _Coder:
        eden_kb_context = provider

    ns = argparse.Namespace(
        text=["reward", "shaping"],
        scope_global=False,
        scope_tenant=False,
        limit=10,
    )
    out = asyncio.run(handle_kb_query_fn(ns, _Coder()))
    assert "KB query" in out
    assert "reward shaping" in out
    assert "X-content" in out


def test_kb_query_handler_no_results(monkeypatch):
    cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": []})
    client = EdenAPIClient(cfg, max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]
    provider = KBContextProvider(client, ContextConfig())

    class _Coder:
        eden_kb_context = provider

    ns = argparse.Namespace(text=["x"], scope_global=False, scope_tenant=False, limit=5)
    out = asyncio.run(handle_kb_query_fn(ns, _Coder()))
    assert "No KB results" in out


# ── Traces command ─────────────────────────────────────────────────────


def test_traces_list_handler(monkeypatch):
    cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"traces": [
            {"trace_id": "abc123def456", "duration_ms": 250, "error": "ok", "agent_id": "a1"}
        ]})
    client = EdenAPIClient(cfg, max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]
    provider = ObservabilityContextProvider(client, ContextConfig())

    class _Coder:
        eden_obs_context = provider

    ns = argparse.Namespace(limit=5, agent_id=None, realm=None)
    out = asyncio.run(handle_traces_list_fn(ns, _Coder()))
    assert "Recent traces" in out
    assert "abc123def456" in out


def test_traces_list_handler_empty(monkeypatch):
    cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"traces": []})
    client = EdenAPIClient(cfg, max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]
    provider = ObservabilityContextProvider(client, ContextConfig())

    class _Coder:
        eden_obs_context = provider

    ns = argparse.Namespace(limit=5, agent_id=None, realm=None)
    out = asyncio.run(handle_traces_list_fn(ns, _Coder()))
    assert "No traces" in out


def test_traces_show_returns_stub():
    from eden.commands.traces import handle_traces_show

    class _Coder:
        eden_obs_context = None

    ns = argparse.Namespace(trace_id="abc")
    out = asyncio.run(handle_traces_show(ns, _Coder()))
    assert "abc" in out
    assert "not yet" in out


# ── Improve command ────────────────────────────────────────────────────


def test_improve_quick_returns_report(tmp_path: Path):
    """Quick mode with no LLM hook → empty report, not a crash."""
    from eden.commands.improve import run_improve, IMPROVE_LLM_CALL

    # Save/restore the hook so we don't pollute the module
    saved = IMPROVE_LLM_CALL

    def _stub(prompt, ctx, temperature=0.2):
        return [
            {
                "title": "Add retries to API client",
                "category": "reliability",
                "file_path": "src/api.py",
                "evidence": "p99 latency 900ms in 24h window",
                "rationale": "Retry+backoff would absorb transient blips",
            }
        ]

    import eden.commands.improve as improve_mod
    improve_mod.IMPROVE_LLM_CALL = _stub  # type: ignore[assignment]
    try:
        cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"results": [], "total_traces": 0})
        client = EdenAPIClient(cfg, max_retries=0)
        async def _ensure():
            if client._client is None or client._client.is_closed:
                client._client = httpx.AsyncClient(
                    base_url="http://x",
                    transport=httpx.MockTransport(handler),
                )
            return client._client
        client._ensure_client = _ensure  # type: ignore[method-assign]
        kb = KBContextProvider(client, ContextConfig())
        obs = ObservabilityContextProvider(client, ContextConfig())

        report = asyncio.run(run_improve(
            repo_root=tmp_path,
            depth="quick",
            max_findings=5,
            kb_provider=kb,
            obs_provider=obs,
            query_seed="q",
            max_files=5,
        ))
        assert report.depth == "quick"
        assert len(report.findings) == 1
        assert report.findings[0].title == "Add retries to API client"
        # The improve report renders nicely
        md = report.to_markdown()
        assert "Eden Improve Report" in md
        assert "Add retries" in md
    finally:
        improve_mod.IMPROVE_LLM_CALL = saved  # type: ignore[assignment]


def test_improve_deep_uses_refinement(tmp_path: Path):
    from eden.commands.improve import run_improve

    saved = run_improve.__globals__.get("IMPROVE_LLM_CALL")

    calls = {"n": 0}
    def _stub(prompt, ctx, temperature=0.2):
        calls["n"] += 1
        if calls["n"] == 1:
            # analysis pass
            return [
                {"title": "t1", "category": "code", "evidence": "e1"},
                {"title": "t2", "category": "perf", "evidence": "e2"},
            ]
        # refinement pass — dedupes, orders
        return [
            {"title": "t2", "category": "perf", "evidence": "e2", "priority": 1},
            {"title": "t1", "category": "code", "evidence": "e1", "priority": 2},
        ]

    import eden.commands.improve as improve_mod
    improve_mod.IMPROVE_LLM_CALL = _stub  # type: ignore[assignment]
    try:
        cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"results": []})
        client = EdenAPIClient(cfg, max_retries=0)
        async def _ensure():
            if client._client is None or client._client.is_closed:
                client._client = httpx.AsyncClient(
                    base_url="http://x",
                    transport=httpx.MockTransport(handler),
                )
            return client._client
        client._ensure_client = _ensure  # type: ignore[method-assign]
        kb = KBContextProvider(client, ContextConfig())
        obs = ObservabilityContextProvider(client, ContextConfig())

        report = asyncio.run(run_improve(
            repo_root=tmp_path,
            depth="deep",
            max_findings=5,
            kb_provider=kb,
            obs_provider=obs,
            query_seed="q",
            max_files=5,
        ))
        assert report.depth == "deep"
        # Refinement was called → priorities are 1, 2 in that order
        assert [f.priority for f in report.findings] == [1, 2]
        assert calls["n"] == 2
    finally:
        improve_mod.IMPROVE_LLM_CALL = saved  # type: ignore[assignment]


def test_improve_no_llm_returns_empty_findings(tmp_path: Path):
    from eden.commands.improve import run_improve

    cfg = EdenCLIConfig(api_key="k", org_id="o", base_url="http://x")
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": []})
    client = EdenAPIClient(cfg, max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]
    kb = KBContextProvider(client, ContextConfig())
    obs = ObservabilityContextProvider(client, ContextConfig())

    report = asyncio.run(run_improve(
        repo_root=tmp_path,
        depth="quick",
        max_findings=5,
        kb_provider=kb,
        obs_provider=obs,
        query_seed="q",
        max_files=5,
    ))
    assert report.findings == []
    assert "No LLM hook" in " ".join(report.notes)
    md = report.to_markdown()
    assert "no actionable findings" in md.lower() or "no actionable" in md.lower()


# ── Helpers (imported here so tests can patch at the source) ────────────

from eden.commands.kb import handle_kb_query as handle_kb_query_fn  # noqa: E402
from eden.commands.traces import handle_traces_list as handle_traces_list_fn  # noqa: E402
