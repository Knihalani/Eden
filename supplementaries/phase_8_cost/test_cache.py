"""Tests for Phase 8 cost optimisation — 4-tier cache + AutoMix + z-score."""
from __future__ import annotations

import pytest

from supplementaries.phase_8_cost.cache import (
    CacheLookupResult,
    CompressionResult,
    CostDriftAlert,
    L1ExactCache,
    L2NgramCache,
    L3EmbeddingCache,
    L4AlbertDupCache,
    MultiTierCache,
    QualityValidatorOutput,
    automix_escalate,
    compress_prompt_llmlingua2,
    per_step_cost_zscore,
    quality_validator,
)


# ── L1 exact cache ─────────────────────────────────────────────


def test_l1_exact_hit():
    cache = L1ExactCache()
    cache.put("hello", "world")
    assert cache.get("hello") == "world"
    assert cache.hits == 1
    assert cache.misses == 0


def test_l1_exact_miss():
    cache = L1ExactCache()
    assert cache.get("hello") is None
    assert cache.misses == 1


def test_l1_exact_eviction():
    cache = L1ExactCache(max_size=2)
    cache.put("a", "1")
    cache.put("b", "2")
    cache.put("c", "3")  # evicts oldest
    assert cache.evictions == 1


# ── L2 n-gram cache ────────────────────────────────────────────


def test_l2_hit_on_overlap():
    cache = L2NgramCache(n=3)
    cache.put("the weather in tokyo", "sunny")
    # Different but overlapping → hit
    assert cache.get("what's the weather in tokyo?") == "sunny"


def test_l2_miss_on_no_overlap():
    cache = L2NgramCache(n=5)
    cache.put("the quick brown fox", "jumps")
    # Different tokens → miss
    assert cache.get("totally unrelated question") is None


# ── L3 embedding cache (Jaccard proxy) ──────────────────────────


def test_l3_hit_on_high_similarity():
    cache = L3EmbeddingCache(threshold=0.5)
    cache.put("the weather in Tokyo today", "sunny")
    # Different but similar
    result = cache.get("the weather in Tokyo tomorrow")
    assert result is not None


def test_l3_miss_on_low_similarity():
    cache = L3EmbeddingCache(threshold=0.95)
    cache.put("the weather in Tokyo today", "sunny")
    result = cache.get("what is the capital of France")
    assert result is None


# ── L4 ALBERT dup cache ────────────────────────────────────────


def test_l4_hit_on_punctuation_normalised():
    cache = L4AlbertDupCache()
    cache.put("Hello, World!", "greeting")
    assert cache.get("hello world") == "greeting"


def test_l4_miss_on_different():
    cache = L4AlbertDupCache()
    cache.put("Hello, World!", "greeting")
    assert cache.get("completely different") is None


# ── Multi-tier cascade ──────────────────────────────────────────


def test_multitier_cascade_hit():
    cache = MultiTierCache()
    cache.store("hello", "world")
    result = cache.lookup("hello")
    assert result.hit
    assert result.tier_hit == "L1"


def test_multitier_miss_cascades_all_tiers():
    cache = MultiTierCache()
    result = cache.lookup("never seen this prompt before xyz123")
    assert not result.hit
    assert result.tier_hit is None


def test_multitier_hit_rate():
    cache = MultiTierCache()
    for i in range(10):
        cache.store(f"prompt-{i}", f"response-{i}")
    # 10 lookups: 10 hits
    for i in range(10):
        result = cache.lookup(f"prompt-{i}")
        assert result.hit
    assert cache.hit_rate() == 1.0


# ── QualityValidator (AutoMix) ──────────────────────────────────


def test_quality_validator_accepts_high_score():
    result = quality_validator(
        "What's the weather?",
        "Sunny in Tokyo.",
        hhem_score=0.05,  # low hallucination
        schema_valid=True,
        fingerprint_match=True,
        threshold=0.85,
    )
    assert result.accepted
    assert result.score > 0.85


def test_quality_validator_rejects_low_score():
    result = quality_validator(
        "What's the weather?",
        "Purple elephants dance.",
        hhem_score=0.9,  # high hallucination
        schema_valid=False,
        fingerprint_match=False,
        threshold=0.85,
    )
    assert not result.accepted


def test_quality_validator_score_in_range():
    result = quality_validator("p", "r", schema_valid=True, fingerprint_match=True)
    assert 0.0 <= result.score <= 1.0


# ── AutoMix escalation ─────────────────────────────────────────


def test_automix_first_accepted():
    candidates = [
        ("low quality", 0.9, False, False),
        ("medium quality", 0.5, True, False),
        ("high quality", 0.05, True, True),
    ]
    response, n_tried = automix_escalate("p", candidates, threshold=0.85)
    assert response == "high quality"
    assert n_tried == 3


def test_automix_early_acceptance():
    """Accept at the cheapest tier → saves 2 LLM calls."""
    candidates = [
        ("cheap and good", 0.05, True, True),
        ("expensive and good", 0.05, True, True),
    ]
    response, n_tried = automix_escalate("p", candidates, threshold=0.85)
    assert response == "cheap and good"
    assert n_tried == 1


def test_automix_none_accepted():
    candidates = [
        ("bad 1", 0.9, False, False),
        ("bad 2", 0.9, False, False),
    ]
    response, n_tried = automix_escalate("p", candidates, threshold=0.85)
    assert response is None
    assert n_tried == 2


# ── Per-step cost z-score ──────────────────────────────────────


def test_cost_zscore_normal():
    history = [0.01] * 30
    alert = per_step_cost_zscore(0.011, history)
    assert not alert.is_anomaly


def test_cost_zscore_warn():
    history = [0.01 + (i % 3) * 0.001 for i in range(30)]  # mean ~0.01, std > 0
    # z = (0.04 - 0.01) / std ≈ large → critical
    alert = per_step_cost_zscore(0.04, history)
    assert alert.is_anomaly
    assert alert.severity in {"warn", "critical"}


def test_cost_zscore_critical():
    history = [0.01] * 30
    # Make a non-zero std
    history = [0.01 + (i % 3) * 0.001 for i in range(30)]
    # Cost 10× mean → extreme outlier
    alert = per_step_cost_zscore(0.10, history)
    assert alert.is_anomaly
    assert alert.severity == "critical"


def test_cost_zscore_short_history():
    """< 7 history points → no alert."""
    alert = per_step_cost_zscore(100.0, [1.0])
    assert not alert.is_anomaly


# ── LLMLingua-2 compression stub ────────────────────────────────


def test_compress_removes_stopwords():
    prompt = "the weather in tokyo is sunny and warm"
    result = compress_prompt_llmlingua2(prompt)
    assert result.original_tokens == 8
    assert result.compressed_tokens < result.original_tokens
    assert "the" not in result.compressed.split() or "is" not in result.compressed.split()


def test_compress_ratio():
    prompt = "the " * 100 + "weather " * 10 + "in Tokyo"
    result = compress_prompt_llmlingua2(prompt)
    assert result.ratio < 0.5  # removed most stopwords


def test_compress_empty():
    result = compress_prompt_llmlingua2("")
    assert result.original_tokens == 0
    assert result.ratio == 1.0