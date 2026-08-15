"""Item 1 (2026-08 cost/speed quick wins) — semantic cache wired into
the live gateway singleton.

The two-tier ``SemanticCache`` (eden.llmops.semantic_cache) is attached
to the shared ``AIGateway`` instance for cache helper methods used by
/gateway/v1-adjacent tooling. These tests pin the wiring:

* ``get_ai_gateway()`` carries a shared SemanticCache by default;
* ``_check_semantic_cache`` / ``_cache_response`` round-trip a prompt;
* ``EDEN_GATEWAY_SEMANTIC_CACHE=0`` disables the cache on the singleton.
"""

from __future__ import annotations

import pytest

import eden.api.routes.gateway as gateway_route
from eden.llmops.ai_gateway import AIGateway, ModelRequest


async def _noop_refresh(self, *args, **kwargs):  # noqa: ANN001
    return False


async def _noop_refresh_int(self, *args, **kwargs):  # noqa: ANN001
    return 0


@pytest.fixture(autouse=True)
def _fresh_singletons(monkeypatch):
    """Reset process singletons and keep the test hermetic."""
    monkeypatch.setattr(gateway_route, "_gateway", None)
    monkeypatch.setattr(gateway_route, "_semantic_cache", None)
    monkeypatch.setattr(AIGateway, "refresh_pricing", _noop_refresh)
    monkeypatch.setattr(
        AIGateway, "refresh_pricing_from_models_dev", _noop_refresh_int
    )
    import eden.llmops.learn_wiring as learn_wiring

    monkeypatch.setattr(
        learn_wiring, "install_learn_filters", lambda gateway: None
    )
    yield


def _request() -> ModelRequest:
    return ModelRequest(
        model_family="openai",
        model_version="gpt-4o-mini",
        prompt="What is the airspeed velocity of an unladen swallow?",
        tenant_id="",
    )


def _fresh_response() -> object:
    from eden.llmops.ai_gateway import ModelResponse

    return ModelResponse(
        text="the answer is 42",
        input_tokens=12,
        output_tokens=6,
        latency_ms=50,
        cost_usd=0.001,
        provider="openai",
        model="gpt-4o-mini",
        cached=False,
    )


async def test_semantic_cache_round_trip_on_gateway_singleton(monkeypatch):
    monkeypatch.delenv("EDEN_GATEWAY_SEMANTIC_CACHE", raising=False)
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is not None, (
        "get_ai_gateway() must wire the shared SemanticCache by default"
    )

    req = _request()
    assert await gw._check_semantic_cache(req) is None

    await gw._cache_response(req, _fresh_response())
    cached = await gw._check_semantic_cache(req)
    assert cached is not None
    assert cached.cached is True
    assert cached.text == "the answer is 42"
    assert cached.cost_usd == 0.0


async def test_cache_shared_singleton_and_lazy():
    cache_a = gateway_route._get_semantic_cache()
    cache_b = gateway_route._get_semantic_cache()
    assert cache_a is not None
    assert cache_a is cache_b, "SemanticCache must be a shared singleton"
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is cache_a


async def test_cache_disabled_env_still_constructs_gateway(monkeypatch):
    monkeypatch.setenv("EDEN_GATEWAY_SEMANTIC_CACHE", "0")
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is None
    assert await gw._check_semantic_cache(_request()) is None


async def test_cache_construction_failure_fails_open(monkeypatch):
    """A broken cache build must fail open to an uncached gateway."""
    monkeypatch.delenv("EDEN_GATEWAY_SEMANTIC_CACHE", raising=False)

    import eden.llmops.semantic_cache as semantic_cache_mod

    def _boom(*args, **kwargs):
        raise RuntimeError("cache backend unavailable")

    monkeypatch.setattr(semantic_cache_mod, "SemanticCache", _boom)
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is None
    assert await gw._check_semantic_cache(_request()) is None
