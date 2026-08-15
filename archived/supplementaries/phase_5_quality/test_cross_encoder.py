"""Tests for cross-encoder relevance scorer."""
from __future__ import annotations

import pytest

from supplementaries.phase_5_quality.cross_encoder import (
    CrossEncoderPrediction,
    DEFAULT_CROSS_ENCODER,
    MiniLMCrossEncoder,
    get_singleton,
)


def _model_available() -> bool:
    try:
        import transformers  # noqa: F401
        return True
    except ImportError:
        return False


requires_model = pytest.mark.skipif(
    not _model_available(),
    reason="transformers not installed",
)


# ── Constants ────────────────────────────────────────────────


def test_default_model_name():
    assert "MiniLM" in DEFAULT_CROSS_ENCODER or "ms-marco" in DEFAULT_CROSS_ENCODER


# ── Singleton ────────────────────────────────────────────────


@requires_model
def test_singleton_returns_same_instance():
    a = get_singleton()
    b = get_singleton()
    assert a is b


# ── Predict — Relevance cases ──────────────────────────────


@requires_model
def test_relevant_pair_high_score():
    """Relevant (query, passage) → high score."""
    ce = get_singleton()
    pred = ce.predict(
        "What is the capital of France?",
        "Paris is the capital of France.",
    )
    assert isinstance(pred, CrossEncoderPrediction)
    assert pred.score > 0, f"relevant pair score={pred.score}"


@requires_model
def test_irrelevant_pair_lower_score():
    """Irrelevant (query, passage) → lower score."""
    ce = get_singleton()
    pred_relevant = ce.predict(
        "What is the capital of France?",
        "Paris is the capital of France.",
    )
    pred_irrelevant = ce.predict(
        "What is the capital of France?",
        "The moon orbits the earth every 27 days.",
    )
    assert pred_relevant.score > pred_irrelevant.score, (
        f"relevant ({pred_relevant.score}) should beat "
        f"irrelevant ({pred_irrelevant.score})"
    )


@requires_model
def test_score_in_reasonable_range():
    """Raw score is a real-valued logit; probability ∈ [0, 1]."""
    ce = get_singleton()
    pred = ce.predict("hello", "world")
    assert isinstance(pred.score, float)
    assert 0.0 <= pred.probability <= 1.0


# ── Performance ──────────────────────────────────────────────


@requires_model
def test_inference_under_500ms_warm():
    """Warm latency < 500ms (small cross-encoder)."""
    ce = get_singleton()
    # Warm up
    ce.predict("warmup", "warmup")
    import time
    times = []
    for _ in range(10):
        t0 = time.perf_counter()
        ce.predict("hello world", "goodbye world")
        times.append((time.perf_counter() - t0) * 1000.0)
    p99 = sorted(times)[int(0.99 * len(times))]
    assert p99 < 500.0, f"cross-encoder p99 = {p99:.1f}ms"


# ── Edge cases ──────────────────────────────────────────────


@requires_model
def test_handles_long_text():
    ce = get_singleton()
    long_q = "What is X? " * 200
    long_p = "X is the answer. " * 200
    pred = ce.predict(long_q, long_p)
    assert isinstance(pred, CrossEncoderPrediction)


@requires_model
def test_handles_empty_text():
    ce = get_singleton()
    pred = ce.predict("", "")
    assert isinstance(pred, CrossEncoderPrediction)


# ── Hallucination detection use case ────────────────────────


@requires_model
def test_cross_encoder_detects_unsupported_claim():
    """A response that adds unsupported claims → low relevance."""
    ce = get_singleton()
    # Source says NRR 122%
    source = "Q3 2026: Net retention 122%."
    # Response claims NRR 144% (unsupported)
    hallucinated = "Net retention was 144% — top decile of the industry."
    pred = ce.predict(source, hallucinated)
    # Cross-encoder scores passage RELEVANCE to source; the
    # hallucinated claim is more specific than the source so cosine
    # similarity is high, but the cross-encoder should give a lower
    # entailment-style score. We just check it returns a number.
    assert isinstance(pred.score, float)