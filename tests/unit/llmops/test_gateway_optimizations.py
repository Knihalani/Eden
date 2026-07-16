"""Unit tests for gateway optimization helpers."""

from __future__ import annotations

import asyncio
import json

import pytest

from eden.llmops.gateway_optimizations import (
    GatewayCoalescer,
    cache_key_for_chat,
    exact_cache_eligible,
    layout_for_provider_cache,
    resolve_optimization_flags,
)


class _FakeHeaders:
    def __init__(self, data: dict[str, str]):
        self._data = data

    def get(self, key: str, default=None):
        return self._data.get(key, default)


def test_cache_key_stable_for_whitespace_variants():
    messages_a = [{"role": "user", "content": "hello   world"}]
    messages_b = [{"role": "user", "content": "hello world"}]
    key_a = cache_key_for_chat(
        org_id="org-1",
        model="gpt-4o-mini",
        messages=messages_a,
        temperature=0.0,
    )
    key_b = cache_key_for_chat(
        org_id="org-1",
        model="gpt-4o-mini",
        messages=messages_b,
        temperature=0.0,
    )
    assert key_a == key_b


def test_cache_key_differs_by_org():
    messages = [{"role": "user", "content": "hi"}]
    key_a = cache_key_for_chat(org_id="org-a", model="m", messages=messages, temperature=0.0)
    key_b = cache_key_for_chat(org_id="org-b", model="m", messages=messages, temperature=0.0)
    assert key_a != key_b


def test_exact_cache_eligible_only_at_zero_temp():
    assert exact_cache_eligible(0.0) is True
    assert exact_cache_eligible(0) is True
    assert exact_cache_eligible(None) is False
    assert exact_cache_eligible(0.7) is False


def test_resolve_optimization_flags_default_on():
    flags = resolve_optimization_flags(_FakeHeaders({}), {})
    assert flags.exact_cache is True
    assert flags.coalesce is True
    assert flags.provider_cache_layout is True
    assert flags.response_repair is True


def test_resolve_optimization_flags_header_opt_out():
    flags = resolve_optimization_flags(
        _FakeHeaders({"X-Eden-Exact-Cache": "false", "X-Eden-Coalesce": "false"}),
        {},
    )
    assert flags.exact_cache is False
    assert flags.coalesce is False
    assert flags.provider_cache_layout is True


def test_resolve_optimization_flags_body_opt_out():
    flags = resolve_optimization_flags(
        _FakeHeaders({}),
        {"eden_response_repair": False},
    )
    assert flags.response_repair is False


def test_resolve_optimization_flags_body_extras_opt_out():
    flags = resolve_optimization_flags(
        _FakeHeaders({}),
        {},
        extras={"eden_exact_cache": False},
    )
    assert flags.exact_cache is False


def test_optimization_response_headers():
    from eden.llmops.gateway_optimizations import optimization_response_headers

    headers = optimization_response_headers(
        ["exact_cache:hit", "response_repair:applied"],
    )
    assert headers["X-Eden-Exact-Cache"] == "hit"
    assert headers["X-Eden-Response-Repair"] == "applied"
    assert "exact_cache:hit" in headers["X-Eden-Optimizations"]


def test_layout_for_provider_cache_anthropic_system():
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "system", "content": "You are helpful."},
    ]
    laid_out, applied = layout_for_provider_cache(
        messages,
        provider="anthropic",
    )
    assert applied is True
    assert laid_out[0]["role"] == "system"
    content = laid_out[0]["content"]
    assert isinstance(content, list)
    assert content[0].get("cache_control") == {"type": "ephemeral"}


def test_cache_key_differs_by_response_format():
    messages = [{"role": "user", "content": "json"}]
    key_text = cache_key_for_chat(
        org_id="org-1",
        model="m",
        messages=messages,
        temperature=0.0,
        response_format={"type": "text"},
    )
    key_json = cache_key_for_chat(
        org_id="org-1",
        model="m",
        messages=messages,
        temperature=0.0,
        response_format={"type": "json_object"},
    )
    assert key_text != key_json


def test_cache_key_includes_max_completion_tokens():
    messages = [{"role": "user", "content": "hi"}]
    key_a = cache_key_for_chat(
        org_id="org-1",
        model="m",
        messages=messages,
        temperature=0.0,
        max_tokens=100,
    )
    key_b = cache_key_for_chat(
        org_id="org-1",
        model="m",
        messages=messages,
        temperature=0.0,
        max_completion_tokens=100,
    )
    assert key_a != key_b


@pytest.mark.asyncio
async def test_gateway_coalescer_dedupes_concurrent_calls():
    coalescer = GatewayCoalescer(window_ms=500)
    calls = 0

    async def _call():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return {"ok": True}

    async def _runner():
        result, _coalesced = await coalescer.execute("same-key", _call)
        return result

    results = await asyncio.gather(_runner(), _runner())
    assert calls == 1
    assert results[0] == {"ok": True}
    assert results[1] == {"ok": True}
    assert coalescer.coalesced_count >= 1
