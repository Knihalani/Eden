"""One embedding per request, not two.

``SemanticCache.get`` and ``.set`` each embedded the identical normalized
prompt, so every gateway cache-miss paid for two embeddings. The vector
is now computed once and reused.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llm.client import LLMResponse, UsageStats
from eden.optimization.cache import SemanticCache

VEC = [0.5] * SemanticCache.VECTOR_SIZE


def _cache_with_fake_embedder(vector: list[float] | None = None) -> SemanticCache:
    """A cache whose upstream embed call is a counted stub."""
    cache = SemanticCache()
    create = AsyncMock(
        return_value=SimpleNamespace(data=[SimpleNamespace(embedding=vector or VEC)])
    )
    cache._embed_client = SimpleNamespace(embeddings=SimpleNamespace(create=create))
    cache._create = create  # type: ignore[attr-defined]
    return cache


def _fake_vector_store() -> MagicMock:
    """pgvector store fake with the async API the cache now calls."""
    store = MagicMock()
    store.search_async = AsyncMock(
        return_value=SimpleNamespace(results=[], total=0, unavailable=False)
    )
    store.upsert_async = AsyncMock(return_value=True)
    return store


def _response() -> LLMResponse:
    return LLMResponse(
        content="hello",
        usage=UsageStats(prompt_tokens=1, completion_tokens=1, total_tokens=2, cost=0.0),
        model="m",
        finish_reason="stop",
    )


# ── the memo ────────────────────────────────────────────────────────


async def test_repeated_embedding_of_the_same_text_bills_once() -> None:
    cache = _cache_with_fake_embedder()
    for _ in range(5):
        assert await cache._get_embedding("some prompt") == VEC
    assert cache.embed_calls == 1


async def test_different_text_still_embeds_separately() -> None:
    cache = _cache_with_fake_embedder()
    await cache._get_embedding("prompt a")
    await cache._get_embedding("prompt b")
    assert cache.embed_calls == 2


async def test_failed_embeds_are_not_memoized() -> None:
    """The pseudo-random fallback must never be cached as a real vector."""
    cache = SemanticCache()
    create = AsyncMock(side_effect=RuntimeError("upstream down"))
    cache._embed_client = SimpleNamespace(embeddings=SimpleNamespace(create=create))
    await cache._get_embedding("p")
    assert cache._embed_memo == {}


async def test_memo_is_bounded() -> None:
    cache = _cache_with_fake_embedder()
    for i in range(SemanticCache.EMBED_MEMO_MAX + 25):
        await cache._get_embedding(f"prompt-{i}")
    assert len(cache._embed_memo) <= SemanticCache.EMBED_MEMO_MAX


# ── the get -> set pair ─────────────────────────────────────────────


async def test_get_then_set_embeds_once_for_one_request() -> None:
    cache = _cache_with_fake_embedder()
    prompt = "Explain the cost model"
    with patch("eden.optimization.cache._get_vector_store",
               return_value=lambda: _fake_vector_store()):
        assert await cache.get(prompt, "gpt-4") is None          # miss
        assert await cache.set(prompt, "gpt-4", _response()) is True
    assert cache.embed_calls == 1, "cache-miss still billed two embeddings"


async def test_set_accepts_a_precomputed_embedding_and_does_not_embed() -> None:
    cache = _cache_with_fake_embedder()
    with patch("eden.optimization.cache._get_vector_store",
               return_value=lambda: _fake_vector_store()):
        assert await cache.set("p", "gpt-4", _response(), embedding=VEC) is True
    assert cache.embed_calls == 0


async def test_embedding_for_exposes_the_vector_from_get() -> None:
    cache = _cache_with_fake_embedder()
    prompt = "  Mixed   CASE  prompt "
    with patch("eden.optimization.cache._get_vector_store",
               return_value=lambda: _fake_vector_store()):
        await cache.get(prompt, "gpt-4")
    # Works through the same normalization ``set`` would apply.
    assert cache.embedding_for(prompt) == VEC
    assert cache.embedding_for("mixed case prompt") == VEC


async def test_get_accepts_a_precomputed_embedding() -> None:
    cache = _cache_with_fake_embedder()
    with patch("eden.optimization.cache._get_vector_store",
               return_value=lambda: _fake_vector_store()):
        await cache.get("p", "gpt-4", embedding=VEC)
    assert cache.embed_calls == 0


# ── settings-driven model + kill switch ─────────────────────────────


async def test_embed_model_comes_from_settings() -> None:
    cache = _cache_with_fake_embedder()
    with patch("eden.config.get_settings",
               return_value=SimpleNamespace(semantic_cache_embed_model="acme/tiny-embed")):
        await cache._get_embedding("p")
    assert cache._create.await_args.kwargs["model"] == "acme/tiny-embed"


def test_embed_model_has_a_default() -> None:
    from eden.config import get_settings

    assert get_settings().semantic_cache_embed_model


@pytest.mark.parametrize("method", ["get", "set"])
async def test_kill_switch_blocks_all_embedding_spend(method: str) -> None:
    cache = _cache_with_fake_embedder()
    with patch.object(SemanticCache, "_enabled", staticmethod(lambda: False)):
        if method == "get":
            assert await cache.get("p", "gpt-4") is None
        else:
            assert await cache.set("p", "gpt-4", _response()) is False
    assert cache.embed_calls == 0
