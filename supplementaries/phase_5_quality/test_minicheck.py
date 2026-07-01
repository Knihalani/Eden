"""Tests for MiniCheck integration."""
from __future__ import annotations

import time

import pytest

from supplementaries.phase_5_quality.minicheck import (
    HAS_MINICHECK_DEPS,
    MINICHECK_REPO,
    MiniCheckPrediction,
    MiniCheckScorer,
    get_singleton,
)


def _model_available() -> bool:
    return HAS_MINICHECK_DEPS


requires_model = pytest.mark.skipif(
    not _model_available(),
    reason="transformers not installed",
)


# ── Constants ────────────────────────────────────────────────


def test_default_model_name():
    """Default repo is `lytang/MiniCheck-RoBERTa-Large`."""
    assert "lytang" in MINICHECK_REPO
    assert "RoBERTa" in MINICHECK_REPO or "Flan-T5" in MINICHECK_REPO


def test_dependencies_available():
    assert HAS_MINICHECK_DEPS


def test_prediction_dataclass():
    pred = MiniCheckPrediction(
        supported_prob=0.95,
        unsupported_prob=0.05,
        model_name="test-model",
        inference_ms=50.0,
    )
    assert pred.supported_prob == 0.95
    assert pred.unsupported_prob == 0.05


# ── Singleton ────────────────────────────────────────────────


@requires_model
def test_singleton_returns_same_instance():
    a = get_singleton()
    b = get_singleton()
    assert a is b


# ── Score ─────────────────────────────────────────────────────


@requires_model
def test_supported_claim_high_score():
    """A claim directly supported by the doc → high supported_prob."""
    scorer = get_singleton()
    pred = scorer.score(
        document="Q3 2026 results: Net retention 122%.",
        claim="Net retention was 122%.",
    )
    assert isinstance(pred, MiniCheckPrediction)
    assert pred.supported_prob > 0.5, (
        f"supported claim got supported_prob={pred.supported_prob} "
        f"(should be > 0.5)"
    )


@requires_model
def test_unsupported_claim_low_score():
    """A fabricated claim → low supported_prob."""
    scorer = get_singleton()
    pred = scorer.score(
        document="Q3 2026 results: Net retention 122%.",
        claim="Net retention was 144% — top decile of the industry.",
    )
    # The hallucinated 144% (the doc says 122%) should score low.
    assert pred.supported_prob < 0.5, (
        f"hallucinated 144% claim got supported_prob={pred.supported_prob} "
        f"(should be < 0.5)"
    )


@requires_model
def test_distinguish_supported_vs_unsupported():
    """Supported claim should score notably higher than unsupported."""
    scorer = get_singleton()
    supported = scorer.score(
        document="Customer count grew from 218 to 311 in 2026.",
        claim="Customer count increased from 218 to 311 in 2026.",
    ).supported_prob
    unsupported = scorer.score(
        document="Customer count grew from 218 to 311 in 2026.",
        claim="Customer count grew from 500 to 1000 in 2026.",
    ).supported_prob
    assert supported > unsupported + 0.2, (
        f"supported={supported:.3f} should exceed "
        f"unsupported={unsupported:.3f} by at least 0.2"
    )


@requires_model
def test_probabilities_sum_to_one():
    scorer = get_singleton()
    pred = scorer.score(
        document="Anything.",
        claim="Anything.",
    )
    assert abs(pred.supported_prob + pred.unsupported_prob - 1.0) < 0.001


# ── Performance ──────────────────────────────────────────────


@requires_model
def test_inference_under_500ms_warm():
    """Warm inference latency < 500ms (RoBERTa-large on CPU)."""
    scorer = get_singleton()
    # Warm up
    scorer.score("warmup doc", "warmup claim")
    times = []
    for _ in range(5):
        t0 = time.perf_counter()
        scorer.score(
            document="Customer count grew from 218 to 311 in 2026.",
            claim="Customer count went from 218 to 311.",
        )
        times.append((time.perf_counter() - t0) * 1000.0)
    avg = sum(times) / len(times)
    assert avg < 500.0, f"MiniCheck warm avg={avg:.1f}ms (CPU)"


# ── Edge cases ──────────────────────────────────────────────


@requires_model
def test_handles_long_text():
    scorer = get_singleton()
    long_doc = "Important information. " * 1000
    pred = scorer.score(long_doc, "A claim.")
    assert isinstance(pred, MiniCheckPrediction)


@requires_model
def test_handles_empty_strings():
    scorer = get_singleton()
    pred = scorer.score("", "")
    assert isinstance(pred, MiniCheckPrediction)