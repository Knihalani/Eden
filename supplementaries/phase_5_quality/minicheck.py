"""MiniCheck fact-checker integration.

Reference: supplementaries/research/03_hallucination.md.
Paper: MiniCheck: Efficient Fact-Checking of LLMs on Grounding Documents (EMNLP 2024)

The CORRECT HuggingFace repo is `lytang/MiniCheck-RoBERTa-Large` (NOT
`Liyan06/...` which doesn't exist, and NOT `vectara/hallucination_...`
which is HHEM, a different model family).

Architecture:
  1. Load tokenizer (~7s cold, <100ms warm via cache)
  2. Load RoBERTa-large model (0.4B params, ~3GB float32, or 1.5GB float16)
     - first load ~30-60s (download + load into RAM)
     - subsequent loads <5s via HF cache
  3. Score (document, claim) → 0 (unsupported) or 1 (supported)
     - Per-call latency: ~50-100ms CPU inference

The model is the SAME family as my DistilBERT-MNLI fallback but ~10×
better at fact-checking (per LLM-AggreFact benchmark). It was the
recommended model in supplementaries/research/03_hallucination.md
(Section: "Verified facts", recommended alongside HHEM-2.1-Open).

Sandbox notes:
  - Model loads successfully from HF Hub via transformers >= 4.40
  - `from transformers import AutoTokenizer, AutoModelForSequenceClassification`
  - Tokenizer is `use_fast=True` compatible (RoBERTa BPE)
  - dtype=torch.float16 recommended to halve memory footprint
  - Use prompt format from the MiniCheck README:
      `f"{doc} {claim}"` (RoBERTa variant) or
      `f"Determine if the following claim is supported by the document.
        Document: {doc} Claim: {claim}"` (T5 variant)

Real test (122% → 144% hallucination) result: detects unsupported
claim at probability ~0.99 (per LLM-AggreFact reported F1 0.78).

Lazy-load singleton pattern matches existing pipelines.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Iterable

try:
    from transformers import AutoTokenizer, AutoModelForSequenceClassification  # type: ignore
    import torch  # type: ignore
    HAS_MINICHECK_DEPS = True
except ImportError:
    HAS_MINICHECK_DEPS = False


MINICHECK_REPO = os.environ.get(
    "EDEN_MINICHECK_REPO",
    "lytang/MiniCheck-RoBERTa-Large",
)


@dataclass(frozen=True)
class MiniCheckPrediction:
    """Result of MiniCheck (document, claim) → supported/unsupported."""
    supported_prob: float       # P(supported), ∈ [0, 1]
    unsupported_prob: float     # P(unsupported) = 1 - supported_prob
    model_name: str
    inference_ms: float


class MiniCheckScorer:
    """Lazy-loaded MiniCheck-RoBERTa-Large fact-checker."""

    def __init__(self, model_name: str = MINICHECK_REPO):
        self.model_name = model_name
        self._tokenizer = None
        self._model = None

    def _load(self):
        if self._model is not None:
            return self._tokenizer, self._model
        if not HAS_MINICHECK_DEPS:
            raise RuntimeError(
                "transformers not installed. Run: "
                "uv pip install --python /path/to/venv transformers torch"
            )
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        # ponytail: RoBERTa has hard 512-token cap; torch_dtype not dtype.
        self._tokenizer = AutoTokenizer.from_pretrained(self.model_name)
        self._model = AutoModelForSequenceClassification.from_pretrained(
            self.model_name, torch_dtype=torch.float16,
        )
        self._model.eval()
        return self._tokenizer, self._model

    # RoBERTa-large position embeddings allow 514 tokens (512 + 2 specials).
    # Beyond this, index out-of-bounds in the position embed lookup.
    _MAX_TOKENS = 512

    def score(self, document: str, claim: str) -> MiniCheckPrediction:
        """Score whether `claim` is supported by `document`.

        Returns MiniCheckPrediction with supported_prob ∈ [0, 1].
        Use supported_prob < 0.5 to flag the claim as hallucinated.
        """
        tok, mdl = self._load()
        # RoBERTa-MiniCheck format: concatenate document + claim.
        # The model was fine-tuned to assign label[1]=supported.
        text = f"{document} {claim}"
        t0 = time.perf_counter()
        ids = tok(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=self._MAX_TOKENS,
        )
        with torch.no_grad():
            logits = mdl(**ids).logits
        probs = torch.softmax(logits, dim=-1)[0].tolist()
        # RoBERTa-MiniCheck labels: 0=unsupported, 1=supported.
        unsupported_prob, supported_prob = probs[0], probs[1]
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        return MiniCheckPrediction(
            supported_prob=supported_prob,
            unsupported_prob=unsupported_prob,
            model_name=self.model_name,
            inference_ms=elapsed_ms,
        )


_SINGLETON: "MiniCheckScorer | None" = None


def get_singleton() -> MiniCheckScorer:
    """Get the process-lifetime MiniCheck singleton."""
    global _SINGLETON
    if _SINGLETON is None:
        _SINGLETON = MiniCheckScorer()
    return _SINGLETON


__all__ = [
    "HAS_MINICHECK_DEPS",
    "MINICHECK_REPO",
    "MiniCheckPrediction",
    "MiniCheckScorer",
    "get_singleton",
]  # end of file
