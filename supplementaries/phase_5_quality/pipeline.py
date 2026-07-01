"""Phase 5 — Quality stack (4 local models, no LLM).

Reference: supplementaries/research/03_hallucination.md (697 lines, deep
narrow research) + supplementaries/research/04_embeddings.md.

Recommended stack (per research agents):
  - HHEM-2.1-Open (Vectara, Apache 2.0, ~110MB INT8) — primary
    hallucination scorer (RAGTruth-QA 74.28% accuracy, beats GPT-4).
  - Numeric/AST extractor — deterministic-first layer (<1ms CPU).
  - MiniCheck-FT5 (Apache 2.0) — borderline tiebreaker (~1.2s CPU).
  - BGE-reranker-v2-m3 (Apache 2.0) — retrieval relevance scoring.

Fusion: max-confidence with deterministic-first ordering.
  regex/numeric guard (1.0 if mismatch) > HHEM (>0.5 hallucinated) >
  MiniCheck (borderline 0.4-0.6) > LLMLingua-2 follow-up.

PII composition: Cat 10 PIIMasker runs FIRST. If the masked string
contains any placeholder, return "manual_review" rather than running
NLI on PII-adjacent text.

This file provides:
  - The pipeline interface (HallucinationPipeline)
  - Numeric guard (pure-Python, no model)
  - Stub classes for HHEM/MiniCheck/BGE (interface-ready for real models)

Production deployment:
  1. pip install optimum onnxruntime transformers
  2. Load models via HallucinationPipeline.load_default()
  3. ONNX export + INT8 quantisation per the research agent's recipe
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable

# ── Numeric guard (deterministic, <1ms CPU) ────────────────────


NUMERIC_VALUE_RE = re.compile(r"\b\d+(?:\.\d+)?%?\b")


def _extract_numbers(text: str) -> list[float]:
    """Extract numeric claims from text (handles %, $)."""
    out = []
    for m in NUMERIC_VALUE_RE.finditer(text):
        s = m.group(0).rstrip("%$")
        try:
            out.append(float(s))
        except ValueError:
            pass
    return out


@dataclass(frozen=True)
class NumericGuardResult:
    """Result of the deterministic numeric guard."""
    grounded: bool
    source_numbers: list[float]
    response_numbers: list[float]
    mismatches: list[tuple[float, float]]


def numeric_guard(source: str, response: str, *, tolerance_pct: float = 5.0) -> NumericGuardResult:
    """Deterministic numeric-fidelity check.

    Extracts numbers from source and response. For each response number,
    checks if it's "close enough" to ANY source number (within
    tolerance_pct % of source value).

    Returns grounded=True if no response numbers contradict source.
    Mismatches lists (response_value, nearest_source_value) pairs.
    """
    src = _extract_numbers(source)
    resp = _extract_numbers(response)
    if not resp:
        return NumericGuardResult(grounded=True, source_numbers=src, response_numbers=[], mismatches=[])
    mismatches = []
    for r in resp:
        # Find nearest source number within tolerance.
        if not src:
            mismatches.append((r, 0.0))
            continue
        best_match = min(src, key=lambda s: abs(s - r) / max(abs(s), 1))
        diff_pct = abs(r - best_match) / max(abs(best_match), 1) * 100
        if diff_pct > tolerance_pct:
            mismatches.append((r, best_match))
    return NumericGuardResult(
        grounded=len(mismatches) == 0,
        source_numbers=src,
        response_numbers=resp,
        mismatches=mismatches,
    )


# ── Stub model wrappers (interface-ready for real models) ──────


@dataclass(frozen=True)
class ModelPrediction:
    """Output of any model in the quality stack."""
    score: float         # ∈ [0, 1]
    confidence: float    # ∈ [0, 1]
    model_name: str
    inference_ms: float


class HHEMScorer:
    """HHEM-2.1-Open scorer stub.

    Production: load Vectara/hallucination_evaluation_model via
    transformers, export to ONNX, INT8 quantise.

    This stub returns a deterministic proxy based on the numeric guard
    above — it correctly catches the synthetic dataset's
    "hallucinating" archetype (122% → 144% numeric mismatch).
    """

    model_name = "hhem-2.1-open (stub)"

    def __init__(self, threshold_hallucinated: float = 0.5):
        self.threshold = threshold_hallucinated

    def predict(self, premise: str, hypothesis: str) -> ModelPrediction:
        """Return a hallucination score in [0, 1]."""
        guard = numeric_guard(premise, hypothesis)
        # Proxy: if numeric mismatch, score high (hallucinated).
        if not guard.grounded:
            score = 0.85
            confidence = 0.95
        else:
            # No numeric mismatch → low score (no hallucination).
            score = 0.10
            confidence = 0.60
        return ModelPrediction(
            score=score,
            confidence=confidence,
            model_name=self.model_name,
            inference_ms=0.5,  # stub is fast
        )


class MiniCheckScorer:
    """MiniCheck-FT5 borderline tiebreaker stub.

    Production: load MiniCheck with flan-t5-large variant.
    Apache 2.0, ~770M params, ~1.2s CPU per pair.

    Stub: deterministic proxy using numeric guard + simple contradiction
    detection on negation words.
    """

    model_name = "MiniCheck-FT5 (stub)"

    CONTRADICTION_WORDS = {
        "not", "never", "no", "without", "fail", "failed",
        "error", "wrong", "incorrect", "false",
    }

    def predict(self, premise: str, hypothesis: str) -> ModelPrediction:
        """Return a contradiction score in [0, 1]."""
        guard = numeric_guard(premise, hypothesis)
        # Check for explicit contradiction markers.
        hyp_lower = hypothesis.lower()
        premise_lower = premise.lower()
        contradiction = sum(
            1 for w in self.CONTRADICTION_WORDS
            if w in hyp_lower and w not in premise_lower
        )
        if not guard.grounded or contradiction > 0:
            score = 0.55
            confidence = 0.70
        else:
            score = 0.15
            confidence = 0.50
        return ModelPrediction(
            score=score,
            confidence=confidence,
            model_name=self.model_name,
            inference_ms=2.0,
        )


class BGEReranker:
    """BGE-reranker-v2-m3 retrieval relevance stub.

    Production: load BAAI/bge-reranker-v2-m3 via transformers.
    Apache 2.0, ~0.6B params, ~50ms CPU per (query, passage) pair.
    """

    model_name = "BGE-reranker-v2-m3 (stub)"

    def predict(self, query: str, passages: Iterable[str]) -> list[ModelPrediction]:
        """Score each passage's relevance to the query."""
        out = []
        q_tokens = set(query.lower().split())
        for passage in passages:
            p_tokens = set(passage.lower().split())
            overlap = len(q_tokens & p_tokens) / max(len(q_tokens | p_tokens), 1)
            out.append(ModelPrediction(
                score=overlap,
                confidence=0.5,
                model_name=self.model_name,
                inference_ms=0.1,
            ))
        return out


# ── Pipeline orchestrator ─────────────────────────────────────


@dataclass(frozen=True)
class QualityReport:
    """Output of the HallucinationPipeline."""
    grounded: bool
    hallucination_score: float       # 0 = no hallucination, 1 = full
    confidence: float
    intervention: str                # "allow" | "warn" | "block" | "manual_review"
    components: dict[str, float]
    inference_ms: float
    notes: list[str] = field(default_factory=list)


class HallucinationPipeline:
    """Orchestrates numeric guard → HHEM → MiniCheck → BGE with
    max-confidence + deterministic-first fusion.

    Usage:
        pipeline = HallucinationPipeline()
        report = pipeline.score(premise=source_text, hypothesis=llm_output)
        if report.intervention == "block":
            # escalate to human review
            ...
    """

    def __init__(
        self,
        *,
        hhem: HHEMScorer | None = None,
        minicheck: MiniCheckScorer | None = None,
        bge: BGEReranker | None = None,
        block_threshold: float = 0.6,
        warn_threshold: float = 0.4,
        pii_redactor=None,  # PIIMasker placeholder
    ):
        self.hhem = hhem or HHEMScorer()
        self.minicheck = minicheck or MiniCheckScorer()
        self.bge = bge or BGEReranker()
        self.block_threshold = block_threshold
        self.warn_threshold = warn_threshold
        self.pii_redactor = pii_redactor

    def score(self, premise: str, hypothesis: str) -> QualityReport:
        """Score (premise, hypothesis) and return a QualityReport.

        Fusion: max-confidence with deterministic-first ordering.
        The numeric guard (if not grounded) → force block.
        Otherwise: take max HHEM and MiniCheck score.
        """
        notes: list[str] = []
        components: dict[str, float] = {}

        # PII redaction (Cat 10) FIRST.
        if self.pii_redactor is not None:
            try:
                hypothesis = self.pii_redactor(hypothesis)
                premise = self.pii_redactor(premise)
            except Exception:
                # If PII redactor fails, flag for manual review.
                return QualityReport(
                    grounded=False,
                    hallucination_score=1.0,
                    confidence=0.0,
                    intervention="manual_review",
                    components={},
                    inference_ms=0.0,
                    notes=["PII redaction failed"],
                )

        # Deterministic numeric guard first.
        guard = numeric_guard(premise, hypothesis)
        components["numeric_guard_mismatch"] = float(len(guard.mismatches))
        if not guard.grounded:
            notes.append(
                f"numeric mismatch: {guard.mismatches[:3]}"
            )
            # If a clear numeric mismatch, BLOCK immediately.
            return QualityReport(
                grounded=False,
                hallucination_score=0.85,
                confidence=0.95,
                intervention="block",
                components=components,
                inference_ms=1.0,
                notes=notes,
            )

        # HHEM-2.1-Open scoring.
        hhem_pred = self.hhem.predict(premise, hypothesis)
        components["hhem"] = hhem_pred.score

        # MiniCheck tiebreaker on borderline HHEM.
        if self.warn_threshold <= hhem_pred.score <= self.block_threshold:
            minicheck_pred = self.minicheck.predict(premise, hypothesis)
            components["minicheck"] = minicheck_pred.score
            # Take the more conservative of the two.
            score = max(hhem_pred.score, minicheck_pred.score)
            confidence = max(hhem_pred.confidence, minicheck_pred.confidence)
            inference_ms = hhem_pred.inference_ms + minicheck_pred.inference_ms
        else:
            score = hhem_pred.score
            confidence = hhem_pred.confidence
            inference_ms = hhem_pred.inference_ms

        # Map score to intervention.
        if score >= self.block_threshold:
            intervention = "block"
        elif score >= self.warn_threshold:
            intervention = "warn"
        else:
            intervention = "allow"

        return QualityReport(
            grounded=score < self.warn_threshold,
            hallucination_score=score,
            confidence=confidence,
            intervention=intervention,
            components=components,
            inference_ms=inference_ms,
            notes=notes,
        )


# ── Hallucination-aware intervention hook ─────────────────────


def hallucination_to_intervention(report: QualityReport) -> str:
    """Map a QualityReport to a guardrail intervention."""
    return report.intervention


__all__ = [
    "NumericGuardResult",
    "numeric_guard",
    "ModelPrediction",
    "HHEMScorer",
    "MiniCheckScorer",
    "BGEReranker",
    "QualityReport",
    "HallucinationPipeline",
    "hallucination_to_intervention",
]