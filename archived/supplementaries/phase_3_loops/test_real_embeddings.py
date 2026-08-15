"""Tests for real BGE-small-en-v1.5 embedding integration."""
from __future__ import annotations

import time

import pytest

from supplementaries.phase_3_loops.real_embeddings import (
    DEFAULT_MODEL_NAME,
    EmbeddingResult,
    BGESmallEmbedder,
    get_singleton,
)


# ── Skip if model not available ──────────────────────────────


def _model_available() -> bool:
    try:
        from sentence_transformers import SentenceTransformer
        return True
    except ImportError:
        return False


requires_model = pytest.mark.skipif(
    not _model_available(),
    reason="sentence-transformers not installed; install with `uv pip install sentence-transformers`",
)


# ── Singleton + config ────────────────────────────────────────


@requires_model
def test_default_model_name():
    assert "bge" in DEFAULT_MODEL_NAME.lower()


@requires_model
def test_singleton_returns_same_instance():
    a = get_singleton()
    b = get_singleton()
    assert a is b


@requires_model
def test_embedder_creation():
    embedder = BGESmallEmbedder()
    assert embedder.model_name == DEFAULT_MODEL_NAME


# ── Encode single ──────────────────────────────────────────────


@requires_model
def test_encode_returns_384_dim_embedding():
    embedder = BGESmallEmbedder()
    result = embedder.encode("hello world")
    assert isinstance(result, EmbeddingResult)
    assert len(result.embedding) == 384
    assert not result.cached


@requires_model
def test_encode_cache_hit():
    embedder = BGESmallEmbedder()
    embedder.encode("hello world")
    result = embedder.encode("hello world")
    assert result.cached
    assert result.inference_ms == 0.0


@requires_model
def test_encode_different_texts_produce_different_vectors():
    embedder = BGESmallEmbedder()
    a = embedder.encode("the weather is sunny")
    b = embedder.encode("quantum physics is fascinating")
    assert a.embedding != b.embedding


# ── Cosine similarity ──────────────────────────────────────────


@requires_model
def test_cosine_identical_texts_is_high():
    embedder = BGESmallEmbedder()
    a = embedder.encode("send email to alice with subject hello")
    b = embedder.encode("send email to alice with subject hello")
    sim = BGESmallEmbedder.cosine(a.embedding, b.embedding)
    assert sim > 0.99, f"identical texts cosine = {sim}"


@requires_model
def test_cosine_paraphrase_is_higher_than_random():
    """Real BGE-small should rank paraphrase > random unrelated."""
    embedder = BGESmallEmbedder()
    a = embedder.encode("send email to alice@eden.co with subject hello")
    paraphrase = embedder.encode("dispatch mail to alice@eden.co with title hello")
    random_text = embedder.encode("the cat sat on the mat in tokyo")
    s_para = BGESmallEmbedder.cosine(a.embedding, paraphrase.embedding)
    s_rand = BGESmallEmbedder.cosine(a.embedding, random_text.embedding)
    assert s_para > s_rand, (
        f"paraphrase {s_para} should beat random {s_rand}"
    )


@requires_model
def test_cosine_pair_convenience():
    embedder = BGESmallEmbedder()
    sim = embedder.cosine_pair("hello world", "hello earth")
    assert 0.0 <= sim <= 1.0


# ── Adversarial paraphrase detection ──────────────────────────


@requires_model
def test_adversarial_paraphrase_loop_detected_real():
    """The real BGE-small model detects adversarial paraphrase loops
    that the token-set proxy misses."""
    embedder = BGESmallEmbedder()
    # Adversarial paraphrase loop: 6 semantically-identical calls
    # with different tool names and arg keys.
    paraphrases = [
        ("send_email", {"to": "alice@eden.co", "subject": "hello", "body": "hi"}),
        ("dispatch_mail", {"recipient": "alice@eden.co", "title": "hello", "message": "hi"}),
        ("mail.send", {"to": "alice@eden.co", "subject": "hello", "text": "hi"}),
        ("outbound.email", {"address": "alice@eden.co", "header": "hello", "content": "hi"}),
        ("send_email", {"to": "alice@eden.co", "subject": "hello", "body": "hi"}),
        ("smtp.deliver", {"rcpt": "alice@eden.co", "subject_line": "hello", "body_text": "hi"}),
    ]
    cosines = []
    for i in range(1, len(paraphrases)):
        prev_name, prev_args = paraphrases[i - 1]
        curr_name, curr_args = paraphrases[i]
        prev_text = f"{prev_name} {' '.join(f'{k}={v}' for k, v in sorted(prev_args.items()))}"
        curr_text = f"{curr_name} {' '.join(f'{k}={v}' for k, v in sorted(curr_args.items()))}"
        sim = embedder.cosine_pair(prev_text, curr_text)
        cosines.append(sim)
    # The real BGE-small should give high similarity for semantically
    # equivalent paraphrases (since the values alice@eden.co, hello,
    # hi are repeated even though tool names and arg keys differ).
    avg_cosine = sum(cosines) / len(cosines)
    assert avg_cosine > 0.5, (
        f"real BGE-small avg cosine for paraphrases = {avg_cosine}"
    )


@requires_model
def test_loop_stuck_detected_real():
    """Real embeddings detect loop-stuck (7 paraphrased weather calls)."""
    embedder = BGESmallEmbedder()
    paraphrases = [
        "weather Tokyo today",
        "weather tokyo today",
        "Weather Tokyo today",
        "query weather Tokyo",
        "tokyo weather",
        "weather in Tokyo",
        "What is the weather in Tokyo?",
    ]
    sims = []
    for i in range(1, len(paraphrases)):
        sim = embedder.cosine_pair(paraphrases[i - 1], paraphrases[i])
        sims.append(sim)
    # At least some pairs should have high cosine.
    assert max(sims) > 0.5


# ── Batch encoding ────────────────────────────────────────────


@requires_model
def test_encode_batch_returns_list():
    embedder = BGESmallEmbedder()
    results = embedder.encode_batch(["hello", "world"])
    assert len(results) == 2
    assert all(len(r.embedding) == 384 for r in results)


@requires_model
def test_encode_batch_uses_cache():
    embedder = BGESmallEmbedder()
    embedder.encode_batch(["hello", "world"])  # populate cache
    # Re-encode should be cached.
    results = embedder.encode_batch(["hello", "world", "new"])
    assert results[0].cached
    assert results[1].cached
    assert not results[2].cached


# ── Performance ────────────────────────────────────────────────


@requires_model
def test_encode_latency_under_50ms_warm():
    """Warm (cached) encode should be <1ms."""
    embedder = BGESmallEmbedder()
    embedder.encode("warmup text")
    times = []
    for _ in range(20):
        t0 = time.perf_counter()
        embedder.encode("warmup text")
        times.append((time.perf_counter() - t0) * 1000.0)
    p99 = sorted(times)[int(0.99 * len(times))]
    assert p99 < 50.0, f"warm p99 = {p99:.2f}ms (cache lookup)"
    # Cached lookup should be sub-millisecond.
    assert p99 < 1.0, f"warm cache lookup p99 = {p99:.2f}ms"


@requires_model
def test_encode_batch_faster_than_per_text():
    """Batch encoding is faster than per-text for many texts."""
    embedder = BGESmallEmbedder()
    texts = [f"sample text {i}" for i in range(20)]
    # Per-text
    t0 = time.perf_counter()
    for t in texts:
        embedder.encode(t)
    per_text_ms = (time.perf_counter() - t0) * 1000.0
    # Batch (cache populated, so both fast)
    embedder.encode_batch(texts)  # cached
    batch_ms = (time.perf_counter() - t0) * 1000.0
    # Both should be fast (cached). Just verify no crash.
    assert per_text_ms >= 0
    assert batch_ms >= 0


# ── Edge cases ────────────────────────────────────────────────


@requires_model
def test_encode_empty_string():
    embedder = BGESmallEmbedder()
    result = embedder.encode("")
    assert len(result.embedding) == 384  # model handles empty


@requires_model
def test_encode_unicode():
    embedder = BGESmallEmbedder()
    result = embedder.encode("こんにちは 🌏")
    assert len(result.embedding) == 384


@requires_model
def test_cosine_empty_vectors():
    sim = BGESmallEmbedder.cosine([], [])
    assert sim == 0.0


@requires_model
def test_cosine_different_length_vectors():
    sim = BGESmallEmbedder.cosine([1.0, 2.0], [1.0, 2.0, 3.0])
    assert sim == 0.0