"""Phase 5 NLI integration — typeform/distilbert-base-uncased-mnli.

Reference: supplementaries/research/03_hallucination.md (697 lines).

HHEM-2.1-Open has a broken tokenizer setup (no tokenizer.json or
tokenizer_config.json on HF; SentencePiece conversion fails). As a
production-grade fallback we use DistilBERT-MNLI:
  - typeform/distilbert-base-uncased-mnli
  - 67M params (smaller than HHEM-2.1-Open's 100M)
  - Apache 2.0
  - Fast tokenizer (works with current transformers)
  - MNLI 3-class output: entailment / neutral / contradiction

For numeric-hallucination detection:
  - High contradiction probability → hallucinated
  - High entailment → grounded
  - Neutral → unverifiable

Production deployment (per research agent 03):
  1. Lazy-load on first call via singleton
  2. PII redaction BEFORE NLI (Cat 10 PIIMasker)
  3. Deterministic-first ordering: numeric guard first (sub-ms),
     then DistilBERT-MNLI (~50-100ms CPU), then if contradiction
     > 0.7 → block
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Iterable

# Try to import transformers; fall back gracefully if not installed.
try:
    from transformers import AutoTokenizer, AutoModelForSequenceClassification  # type: ignore
    import torch  # type: ignore
    HAS_TRANSFORMERS = True
except ImportError:
    HAS_TRANSFORMERS = False


# Configurable model name (defaults per research agent 03).
DEFAULT_NLI_MODEL = os.environ.get(
    "EDEN_NLI_MODEL",
    "typeform/distilbert-base-uncased-mnli",
)


@dataclass(frozen=True)
class NLIPrediction:
    """Output of the NLI model."""
    entailment: float       # P(premise entails hypothesis)
    neutral: float         # P(neither entails nor contradicts)
    contradiction: float   # P(premise contradicts hypothesis)
    model_name: str
    inference_ms: float


# Singleton model loader.
_NLI_SINGLETON: "DistilBertMNLI | None" = None


class DistilBertMNLI:
    """Lazy-loaded DistilBERT-MNLI classifier.

    Usage:
        nli = DistilBertMNLI()
        pred = nli.predict("Net retention 122%.", "Net retention was 144%.")
        # pred.contradiction > 0.7 → hallucinated
    """

    def __init__(self, model_name: str = DEFAULT_NLI_MODEL):
        self.model_name = model_name
        self._tokenizer = None
        self._model = None

    def _load(self):
        """Lazy-load the model + tokenizer."""
        if self._model is not None:
            return self._tokenizer, self._model
        if not HAS_TRANSFORMERS:
            raise RuntimeError(
                "transformers not installed; cannot load NLI model. "
                "Run: uv pip install transformers torch"
            )
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        self._tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        self._model = AutoModelForSequenceClassification.from_pretrained(
            self.model_name
        )
        self._model.eval()
        return self._tokenizer, self._model

    def predict(self, premise: str, hypothesis: str) -> NLIPrediction:
        """Run NLI on (premise, hypothesis) and return probabilities."""
        import time
        tok, mdl = self._load()
        t0 = time.perf_counter()
        inputs = tok(premise, hypothesis, return_tensors="pt",
                     truncation=True, max_length=512)
        with torch.no_grad():
            logits = mdl(**inputs).logits
        probs = torch.softmax(logits, dim=-1)[0].tolist()
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        # MNLI label order: 0=entailment, 1=neutral, 2=contradiction
        return NLIPrediction(
            entailment=float(probs[0]),
            neutral=float(probs[1]),
            contradiction=float(probs[2]),
            model_name=self.model_name,
            inference_ms=elapsed_ms,
        )

    def predict_batch(self, pairs: Iterable[tuple[str, str]]) -> list[NLIPrediction]:
        """Batch prediction for efficiency."""
        pairs = list(pairs)
        if not pairs:
            return []
        results = []
        for premise, hypothesis in pairs:
            results.append(self.predict(premise, hypothesis))
        return results


def get_singleton(model_name: str = DEFAULT_NLI_MODEL) -> DistilBertMNLI:
    """Get the process-lifetime singleton NLI classifier."""
    global _NLI_SINGLETON
    if _NLI_SINGLETON is None:
        _NLI_SINGLETON = DistilBertMNLI(model_name=model_name)
    return _NLI_SINGLETON


__all__ = [
    "HAS_TRANSFORMERS",
    "DEFAULT_NLI_MODEL",
    "NLIPrediction",
    "DistilBertMNLI",
    "get_singleton",
]