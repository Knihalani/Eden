"""Tests for ``eden.kb_context`` — KB context provider."""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from eden.api_client import EdenAPIClient
from eden.config import ContextConfig
from eden.kb_context import (
    KBContext,
    KBContextProvider,
    KBEntry,
    _approx_tokens,
    _truncate_to_budget,
)


def _mock_client(payload: Any) -> EdenAPIClient:
    cfg_payload = {"api_key": "k", "org_id": "o", "base_url": "http://x"}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    client = EdenAPIClient(__import__("eden.config", fromlist=["EdenCLIConfig"]).EdenCLIConfig(**cfg_payload), max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
                headers={"X-Org-Api-Key": "k", "X-Org-Id": "o"},
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]
    return client


def test_approx_tokens_basic():
    assert _approx_tokens("") == 1
    assert _approx_tokens("abcd") == 1
    assert _approx_tokens("a" * 400) == 100


def test_truncate_to_budget_no_truncation_when_small():
    entries = [
        KBEntry(title="a", content="hello", source="kb", scope="global", confidence=0.9)
    ]
    text, truncated = _truncate_to_budget(entries, budget=1000)
    assert "hello" in text
    assert "### a" in text
    assert truncated is False


def test_truncate_to_budget_drops_entries_when_over():
    entries = [
        KBEntry(title=f"e{i}", content="x" * 200, source="kb", scope="global", confidence=0.9)
        for i in range(5)
    ]
    # Budget so small only the first entry fits
    text, truncated = _truncate_to_budget(entries, budget=10)
    assert truncated is True
    # At least one entry rendered
    assert "### e0" in text


def test_parse_entries_handles_known_shapes():
    provider = KBContextProvider.__new__(KBContextProvider)
    provider.client = None  # type: ignore[assignment]
    provider.config = ContextConfig()  # type: ignore[assignment]
    provider._cache = {}  # type: ignore[assignment]

    # 1. results list
    out = KBContextProvider._parse_entries(
        {"results": [{"title": "t1", "content": "c1", "source": "kb", "confidence": 0.7}]},
        scope="global",
    )
    assert len(out) == 1
    assert out[0].title == "t1"
    assert out[0].scope == "global"

    # 2. episodic + semantic
    out2 = KBContextProvider._parse_entries(
        {
            "episodic_results": [{"title": "e", "content": "ec"}],
            "semantic_results": [{"title": "s", "content": "sc"}],
        },
        scope="all",
    )
    assert {e.title for e in out2} == {"e", "s"}

    # 3. graceful on garbage
    out3 = KBContextProvider._parse_entries(
        {"results": "not a list"}, scope="all"
    )
    assert out3 == []


def test_provider_returns_empty_on_empty_query():
    cfg_payload = {"api_key": "k", "org_id": "o", "base_url": "http://x"}
    client = _mock_client({})
    provider = KBContextProvider(client, ContextConfig())
    out = asyncio.run(provider.get_global_context(""))
    assert out.text == ""
    assert out.hit_count == 0


def test_provider_caches_within_ttl():
    cfg_payload = {"api_key": "k", "org_id": "o", "base_url": "http://x"}
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, json={"results": [{"title": "t", "content": "c"}]})

    client = EdenAPIClient(__import__("eden.config", fromlist=["EdenCLIConfig"]).EdenCLIConfig(**cfg_payload), max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]

    provider = KBContextProvider(client, ContextConfig(cache_ttl_seconds=60))
    a = asyncio.run(provider.get_global_context("q"))
    b = asyncio.run(provider.get_global_context("q"))
    assert a.text == b.text
    assert b.cached is True
    assert calls["n"] == 1


def test_combined_renders_both_sections():
    cfg_payload = {"api_key": "k", "org_id": "o", "base_url": "http://x"}
    def handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if "scope=global" in url:
            return httpx.Response(200, json={"results": [{"title": "G", "content": "global text"}]})
        if "scope=tenant" in url:
            return httpx.Response(200, json={"results": [{"title": "T", "content": "tenant text"}]})
        return httpx.Response(200, json={"results": []})
    client = EdenAPIClient(__import__("eden.config", fromlist=["EdenCLIConfig"]).EdenCLIConfig(**cfg_payload), max_retries=0)
    async def _ensure():
        if client._client is None or client._client.is_closed:
            client._client = httpx.AsyncClient(
                base_url="http://x",
                transport=httpx.MockTransport(handler),
            )
        return client._client
    client._ensure_client = _ensure  # type: ignore[method-assign]

    provider = KBContextProvider(client, ContextConfig(kb_token_budget=2000))
    out = asyncio.run(provider.get_combined_context("q"))
    assert "[GLOBAL KNOWLEDGE]" in out.text
    assert "[TENANT CONTEXT]" in out.text
    assert "global text" in out.text
    assert "tenant text" in out.text
