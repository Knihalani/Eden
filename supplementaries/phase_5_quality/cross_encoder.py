"""Cross-encoder relevance scorer for Phase 5 quality pipeline.

Reference: supplementaries/research/03_hallucination.md + 04_embeddings.md.

Uses `cross-encoder/ms-marco-MiniLM-L-6-v2` (90M params, Apache 2.0)
as a production-grade cross-encoder for query-passage relevance
scoring. Replaces the BGE-reranker-v2-m3 (0.6B) tier-up that the
sandbox cannot install.

Architecture (per spec §4 Phase 5):
  1. PII redaction (Cat 10)
  2. Numeric guard (deterministic, <1ms)
  3. NLI (DistilBERT-MNLI, contradiction detector)
  4. Cross-encoder relevance (this module)
  5. Action decision

Cross-encoders are slower than bi-encoders (~50-100ms per pair vs
~5ms for bi-encoder cosine) but more accurate for fine-grained
relevance — they jointly encode the query and passage, so they
catch subtle mismatches that bi-encoders miss.

For the synthetic dataset's hallucinating archetype, the cross-encoder
scores the LLM response against the source context to detect
unsupported claims.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Iterable

try:
    from transformers import AutoTokenizer, AutoModelForSequenceClassification  # type: ignore
    import torch  # type: ignore
    HAS_TRANSFORMERS = True
except ImportError:
    HAS_TRANSFORMERS = False


DEFAULT_CROSS_ENCODER = os.environ.get(
    "EDEN_CROSS_ENCODER",
    "cross-encoder/ms-marco-MiniLM-L-6-v2",
)


@dataclass(frozen=True)
class CrossEncoderPrediction:
    """Result of a cross-encoder query-passage relevance scoring."""
    score: float               # raw relevance logit (higher = more relevant)
    probability: float         # sigmoid(score), ∈ [0, 1]
    model_name: str
    inference_ms: float


class MiniLMCrossEncoder:
    """Lazy-loaded MiniLM cross-encoder for relevance scoring.

    Usage:
        ce = MiniLMCrossEncoder()
        pred = ce.predict("Q: What is the capital of France?",
                           "A: Paris is the capital of France.")
        # pred.probability > 0.5 → relevant
    """

    def __init__(self, model_name: str = DEFAULT_CROSS_ENCODER):
        self.model_name = model_name
        self._tokenizer = None
        self._model = None

    def _load(self):
        if self._model is not None:
            return self._tokenizer, self._model
        if not HAS_TRANSFORMERS:
            raise RuntimeError(
                "transformers not installed; cannot load cross-encoder. "
                "Run: uv pip install transformers torch"
            )
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        self._tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        self._model = AutoModelForSequenceClassification.from_pretrained(
            self.model_name
        )
        self._model.eval()
        return self._tokenizer, self._model

    def predict(self, query: str, passage: str) -> CrossEncoderPrediction:
        """Score (query, passage) relevance."""
        tok, mdl = self._load()
        t0 = time.perf_counter()
        inputs = tok(
            query, passage,
            return_tensors="pt", truncation=True, max_length=512,
        )
        with torch.no_grad():
            logits = mdl(**inputs).logits
        # MS MARCO models output a single logit per pair.
        score = float(logits[0].item())
        import math
        prob = 1.0 / (1.0 + math.exp(-score))  # sigmoid
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return CrossEncoderPrediction(
            score=score,
            probability=prob,
            model_name=self.model_name,
            inference_ms=elapsed_ms,
        )

    def predict_batch(
        self, pairs: Iterable[tuple[str, str]]
    ) -> list[CrossEncoderPrediction]:
        pairs = list(pairs)
        return [self.predict(q, p) for q, p in pairs]


_CE_SINGLETON: "MiniLMCrossEncoder | None" = None


def get_singleton(
    model_name: str = DEFAULT_CROSS_ENCODER,
) -> MiniLMCrossEncoder:
    """Get the process-lifetime singleton cross-encoder."""
    global _CE_SINGLETON
    if _CE_SINGLETON is None:
        _CE_SINGLETON = MiniLMCrossEncoder(model_name=model_name)
    return _CE_SINGLETON


__all__ = [
    "HAS_TRANSFORMERS",
    "DEFAULT_CROSS_ENCODER",
    "CrossEncoderPrediction",
    "MiniLMCrossEncoder",
    "get_singleton",
]