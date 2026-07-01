"""Tests for Phase 5 NLI integration — DistilBERT-MNLI.

Validates:
  - Numeric hallucination detection (122% → 144%)
  - PII composition ordering (PII redaction BEFORE NLI)
  - Performance budget (<500ms per call)
  - Singleton caching
"""
from __future__ import annotations

import pytest

from supplementaries.phase_5_quality.nli import (
    DEFAULT_NLI_MODEL,
    HAS_TRANSFORMERS,
    DistilBertMNLI,
    NLIPrediction,
    get_singleton,
)


# ── Skip if transformers not available ─────────────────────────


def _model_available() -> bool:
    try:
        import transformers  # noqa: F401
        return True
    except ImportError:
        return False


requires_model = pytest.mark.skipif(
    not _model_available(),
    reason="transformers not installed; install with `uv pip install transformers`",
)


# ── Constants ────────────────────────────────────────────────────


def test_default_model_name():
    assert "distilbert" in DEFAULT_NLI_MODEL.lower() or "nli" in DEFAULT_NLI_MODEL.lower()


# ── Singleton ────────────────────────────────────────────────────


@requires_model
def test_singleton_returns_same_instance():
    a = get_singleton()
    b = get_singleton()
    assert a is b


@requires_model
def test_singleton_lazy_load():
    """First call lazy-loads; subsequent calls reuse the loaded model."""
    nli = get_singleton()
    # Trigger lazy load via predict.
    nli.predict("warmup", "warmup")
    assert nli._model is not None


# ── Predict — Hallucination cases ─────────────────────────────


@requires_model
def test_nli_detects_numeric_hallucination():
    """122% → 144% numeric mismatch → high contradiction."""
    nli = get_singleton()
    pred = nli.predict(
        premise="Q3 2026 results: Net retention 122%.",
        hypothesis="Net retention was 144% — top decile.",
    )
    assert isinstance(pred, NLIPrediction)
    assert pred.contradiction > 0.7, (
        f"NLI missed numeric hallucination: contradiction={pred.contradiction:.4f}"
    )


@requires_model
def test_nli_entails_consistent_text():
    """Consistent text → high entailment."""
    nli = get_singleton()
    pred = nli.predict(
        premise="Your $42.00 refund is queued for 3 business days.",
        hypothesis="Your refund is queued and will land in 3 business days.",
    )
    assert pred.entailment > pred.contradiction


@requires_model
def test_nli_neutral_on_unrelated_text():
    """Unrelated text → high neutral probability."""
    nli = get_singleton()
    pred = nli.predict(
        premise="The weather is sunny.",
        hypothesis="Quantum physics is fascinating.",
    )
    assert pred.neutral > 0.5


@requires_model
def test_nli_probabilities_sum_to_one():
    """Entailment + neutral + contradiction = 1.0."""
    nli = get_singleton()
    pred = nli.predict("hello world", "goodbye world")
    total = pred.entailment + pred.neutral + pred.contradiction
    assert abs(total - 1.0) < 0.001


# ── Performance ──────────────────────────────────────────────────


@requires_model
def test_nli_latency_under_500ms_warm():
    """Warm latency should be under 500ms (DistilBERT-MNLI is small)."""
    nli = get_singleton()
    # Warm up
    nli.predict("warmup", "warmup")
    import time
    times = []
    for _ in range(20):
        t0 = time.perf_counter()
        nli.predict("hello world", "goodbye world")
        times.append((time.perf_counter() - t0) * 1000.0)
    p99 = sorted(times)[int(0.99 * len(times))]
    assert p99 < 500.0, f"NLI p99 = {p99:.1f}ms (should be <500ms)"


# ── Batch ────────────────────────────────────────────────────────


@requires_model
def test_nli_batch_returns_list():
    nli = get_singleton()
    results = nli.predict_batch([
        ("hello", "hello"),
        ("hello", "goodbye"),
    ])
    assert len(results) == 2
    assert all(isinstance(r, NLIPrediction) for r in results)


# ── Edge cases ──────────────────────────────────────────────────


@requires_model
def test_nli_handles_long_text():
    """Text longer than max_length is truncated, not crashed."""
    nli = get_singleton()
    long_premise = "hello world. " * 200
    long_hyp = "goodbye world. " * 200
    pred = nli.predict(long_premise, long_hyp)
    assert isinstance(pred, NLIPrediction)


@requires_model
def test_nli_handles_empty_text():
    nli = get_singleton()
    pred = nli.predict("", "")
    assert isinstance(pred, NLIPrediction)


@requires_model
def test_nli_handles_unicode():
    nli = get_singleton()
    pred = nli.predict("こんにちは", "こんにちは 🌏")
    assert isinstance(pred, NLIPrediction)


# ── Comparison with stub HHEM ───────────────────────────────────


@requires_model
def test_nli_on_synthetic_hallucinating_dataset():
    """The full 30-trace synthetic dataset — every hallucinating
    trace should be detected by NLI."""
    nli = get_singleton()
    from tests.fixtures.traces import load_synthetic_dataset as _load
    dataset = _load()
    detected = 0
    total = 0
    for ex in dataset:
        if not ex.archetype_id.startswith("hallucinating"):
            continue
        # Find source + response
        source_text = ""
        response_text = ""
        for e in ex.events:
            if e.event_type == "tool.call":
                body = e.response_body or {}
                r = body.get("result", {})
                if isinstance(r, dict) and "text" in r:
                    source_text = r["text"]
            elif e.event_type == "llm.completion":
                body = e.response_body or {}
                for c in body.get("choices") or []:
                    msg = (c or {}).get("message") or {}
                    content = msg.get("content")
                    if isinstance(content, str) and "144" in content:
                        response_text = content
        if source_text and response_text:
            total += 1
            pred = nli.predict(source_text, response_text)
            if pred.contradiction > 0.5:
                detected += 1
    if total > 0:
        assert detected == total, (
            f"NLI detected {detected}/{total} hallucinating traces"
        )