"""Item 1 (2026-08 cost/speed quick wins) — semantic cache wired into
the live gateway singleton.

The two-tier ``SemanticCache`` (eden.llmops.semantic_cache) was fully
built but the gateway route module constructed its ``AIGateway()`` with
no cache, so the check-branch in ``AIGateway.complete`` never ran in
production. These tests pin the new wiring:

* ``get_ai_gateway()`` carries a shared SemanticCache by default;
* a repeated identical completion is served from cache — exactly one
  upstream call — and increments
  ``eden_gateway_cache_hit_total{tier="semantic"}``;
* ``EDEN_GATEWAY_SEMANTIC_CACHE=0`` disables the cache and the request
  path still works (both calls go upstream, no counter increment).
"""

from __future__ import annotations

import pytest

import eden.api.routes.gateway as gateway_route
from eden.llmops.ai_gateway import AIGateway, ModelRequest, Provider

# Matches the definition in eden.llmops.ai_gateway._inc_cache_hit_metric;
# the simple_metrics registry dedupes families by name, so constructing
# with the same signature returns the production family.
_HIT_COUNTER = (
    "eden_gateway_cache_hit_total",
    "AIGateway completion cache hits by tier (exact | semantic)",
)


class _CountingUpstream:
    """Minimal provider client: AIGateway duck-types on ``complete``."""

    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, *, model, prompt, temperature, max_tokens):
        self.calls += 1
        return {
            "text": "the answer is 42",
            "input_tokens": 12,
            "output_tokens": 6,
        }


async def _noop_refresh(self, *args, **kwargs):  # noqa: ANN001
    return False


async def _noop_refresh_int(self, *args, **kwargs):  # noqa: ANN001
    return 0


@pytest.fixture(autouse=True)
def _fresh_singletons(monkeypatch):
    """Reset process singletons + metrics and keep the test hermetic.

    * Fresh ``_gateway`` / ``_semantic_cache`` per test.
    * Pricing refresh + learn-filter install patched to no-ops so
      ``get_ai_gateway()`` does no network / DB work.
    """
    from eden.observability.simple_metrics import reset_for_tests

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

    # ``complete`` records usage best-effort when cost > 0 — stub it
    # so the unit test never reaches for Postgres.
    async def _noop_record_usage(*args, **kwargs):
        return None

    try:
        import eden.services.budget_service as budget_service

        monkeypatch.setattr(
            budget_service, "record_usage", _noop_record_usage
        )
    except ImportError:
        pass
    reset_for_tests()
    yield
    reset_for_tests()


def _hit_count(tier: str) -> float:
    from eden.observability.simple_metrics import Counter

    fam = Counter(_HIT_COUNTER[0], _HIT_COUNTER[1], labelnames=("tier",))
    return sum(
        value
        for _name, labels, value in fam.samples()
        if labels.get("tier") == tier
    )


def _request() -> ModelRequest:
    return ModelRequest(
        model_family="openai",
        model_version="gpt-4o-mini",
        prompt="What is the airspeed velocity of an unladen swallow?",
        # Blank tenant deliberately: skips the best-effort
        # cache_lookups / time-travel DB writes in the hot path.
        tenant_id="",
    )


async def test_repeated_completion_hits_cache_single_upstream_call(
    monkeypatch,
):
    monkeypatch.delenv("EDEN_GATEWAY_SEMANTIC_CACHE", raising=False)
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is not None, (
        "get_ai_gateway() must wire the shared SemanticCache by default"
    )

    upstream = _CountingUpstream()
    gw.register_provider(Provider.OPENAI, upstream)

    first = await gw.complete(_request())
    assert upstream.calls == 1
    assert first.cached is False

    second = await gw.complete(_request())
    assert upstream.calls == 1, (
        "identical repeated completion must be served from cache"
    )
    assert second.cached is True
    assert second.text == first.text
    assert second.cost_usd == 0.0
    assert _hit_count("semantic") == 1.0


async def test_cache_shared_singleton_and_lazy():
    cache_a = gateway_route._get_semantic_cache()
    cache_b = gateway_route._get_semantic_cache()
    assert cache_a is not None
    assert cache_a is cache_b, "SemanticCache must be a shared singleton"
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is cache_a


async def test_cache_disabled_env_still_serves_requests(monkeypatch):
    monkeypatch.setenv("EDEN_GATEWAY_SEMANTIC_CACHE", "0")
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is None

    upstream = _CountingUpstream()
    gw.register_provider(Provider.OPENAI, upstream)

    first = await gw.complete(_request())
    second = await gw.complete(_request())
    assert upstream.calls == 2, (
        "with the cache disabled every completion goes upstream"
    )
    assert first.cached is False
    assert second.cached is False
    assert _hit_count("semantic") == 0.0


async def test_cache_construction_failure_fails_open(monkeypatch):
    """A broken cache build must fail open to an uncached gateway."""
    monkeypatch.delenv("EDEN_GATEWAY_SEMANTIC_CACHE", raising=False)

    import eden.llmops.semantic_cache as semantic_cache_mod

    def _boom(*args, **kwargs):
        raise RuntimeError("cache backend unavailable")

    monkeypatch.setattr(semantic_cache_mod, "SemanticCache", _boom)
    gw = gateway_route.get_ai_gateway()
    assert gw.semantic_cache is None

    upstream = _CountingUpstream()
    gw.register_provider(Provider.OPENAI, upstream)
    resp = await gw.complete(_request())
    assert resp.text == "the answer is 42"
    assert upstream.calls == 1
