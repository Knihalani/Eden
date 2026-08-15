"""Phase 9 — Reasoning quality + self-correction.

Reference: supplementaries/research/10_reasoning.md (900 lines, comprehensive).

Implements:
  4 metrics:
    - Coherence (pairwise NLI proxy via text-shingle Jaccard)
    - Informativeness (avg pairwise cosine dissimilarity)
    - Goal Alignment (cosine to user prompt)
    - Verification Presence (18-marker regex across 5 families)
  6 reasoning-failure patterns (regex-based detection):
    - post-hoc rationalisation
    - premature conclusion
    - unjustified assertion
    - self-contradictory chain
    - verification absence with high confidence
    - failure attribution gap
  8 self-correction patterns (Reflexion/Self-Refine/CRITIC/etc.)
  Composite: 0.3·coh + 0.2·info + 0.2·goal + 0.15·ver + 0.15·(1 - calib)
  Lanham Trap Guard: cap coherence at 0.70 when verification < 0.10.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Sequence

# ── 18 verification markers across 5 families ──────────────────

VERIFICATION_MARKERS: tuple[re.Pattern[str], ...] = (
    # Family 1: explicit "check" phrases
    re.compile(r"let'?s (?:check|verify|confirm)", re.I),
    re.compile(r"sanity check", re.I),
    re.compile(r"double.?check", re.I),
    re.compile(r"re.?check", re.I),
    re.compile(r"cross.?check", re.I),
    # Family 2: validation verbs
    re.compile(r"\bverify(?:ing|ed)?\b", re.I),
    re.compile(r"\bvalidat(?:e|ing|ed|ation)\b", re.I),
    re.compile(r"\bconfirm(?:ing|ed)?\b", re.I),
    # Family 3: reasoning meta-language
    re.compile(r"\bbecause\s+(?:of|we|the)", re.I),
    re.compile(r"\bsince\s+(?:the|we|it)", re.I),
    re.compile(r"\btherefore\b", re.I),
    re.compile(r"\bhowever\b", re.I),
    re.compile(r"\bnevertheless\b", re.I),
    # Family 4: source/citation language
    re.compile(r"\baccording to\b", re.I),
    re.compile(r"\bper (?:the|our|policy)\b", re.I),
    re.compile(r"\bbased on\b", re.I),
    # Family 5: hedge / uncertainty
    re.compile(r"\b(?:might|may|could) be\b", re.I),
    # Family 6: explicit reasoning connectors
    re.compile(r"\b(?:this|that|it)\s+(?:means|implies|suggests)\b", re.I),
)

# ── 6 failure patterns ────────────────────────────────────────

FAILURE_PATTERNS: dict[str, re.Pattern[str]] = {
    "post_hoc_rationalisation": re.compile(
        r"\b(?:because|since)\s+(?:I|we)\s+(?:just|already)", re.I
    ),
    "premature_conclusion": re.compile(
        r"^(?:therefore|thus|so),?\s+(?:the answer|answer is)", re.I | re.M
    ),
    "unjustified_assertion": re.compile(
        r"\b(?:definitely|certainly|absolutely)\s+is\b", re.I
    ),
    "verification_absence_high_confidence": re.compile(
        r"\b(?:definitely|certainly|absolutely)\s+(?!\s*verify)", re.I
    ),
    "self_contradictory": re.compile(
        r"\b(?:but|however)\s+(?:actually|now|in fact)\b", re.I
    ),
    "failure_attribution_gap": re.compile(
        r"\b(?:success(?:fully)?|completed)\b.*\b(?:despite|although|even though)\b.*\b(?:error|fail|issue)\b",
        re.I | re.S,
    ),
}

# ── 8 self-correction patterns ─────────────────────────────────

SELF_CORRECTION_PATTERNS: dict[str, re.Pattern[str]] = {
    "reflexion": re.compile(r"\breflection:\s", re.I),
    "feedback": re.compile(r"\bfeedback:\s", re.I),
    "self_refine": re.compile(r"\bself.?refine\b", re.I),
    "critic": re.compile(r"\bcritic(?:al)?:\s", re.I),
    "self_consistency": re.compile(r"\bself.?consistency\b", re.I),
    "sanity_check_marker": re.compile(r"\bsanity check:\s", re.I),
    "let_me_reconsider": re.compile(r"\blet me (?:re-?consider|rethink|re-?evaluate)\b", re.I),
    "actually_i_think": re.compile(r"\bactually,?\s+(?:i think|i believe|in retrospect)", re.I),
}


# ── Step text extraction ───────────────────────────────────────


def _llm_text(event) -> str:
    body = event.response_body or {}
    bits = []
    for c in body.get("choices") or []:
        msg = (c or {}).get("message") or {}
        content = msg.get("content")
        if isinstance(content, str):
            bits.append(content)
    return " ".join(bits)


def _user_text(event) -> str:
    body = event.request_body or {}
    for m in body.get("messages") or []:
        if isinstance(m, dict) and m.get("role") == "user":
            content = m.get("content")
            if isinstance(content, str):
                return content
    return ""


def _shingles(text: str, k: int = 5) -> set[str]:
    tokens = re.findall(r"\w+", text.lower())
    if len(tokens) < k:
        return {" ".join(tokens)} if tokens else set()
    return {" ".join(tokens[i:i + k]) for i in range(len(tokens) - k + 1)}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _cosine_proxy(a: str, b: str) -> float:
    """Sqrt-Jaccard proxy for embedding cosine."""
    sa, sb = _shingles(a), _shingles(b)
    return math.sqrt(_jaccard(sa, sb))


# ── Metrics ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReasoningScore:
    """Composite reasoning score for a trace."""
    coherence: float          # ∈ [0, 1]
    informativeness: float    # ∈ [0, 1]
    goal_alignment: float     # ∈ [0, 1]
    verification: float       # ∈ [0, 1]
    calibration_error: float  # ∈ [0, 1]
    composite: float          # weighted composite


def compute_coherence(steps: Sequence[str]) -> float:
    """Mean pairwise Jaccard on adjacent step shingles."""
    if len(steps) < 2:
        return 1.0
    sims = []
    for i in range(len(steps) - 1):
        sims.append(_jaccard(_shingles(steps[i]), _shingles(steps[i + 1])))
    return sum(sims) / len(sims)


def compute_informativeness(steps: Sequence[str]) -> float:
    """1 - mean pairwise cosine similarity (higher = more novel)."""
    if len(steps) < 2:
        return 1.0
    sims = []
    for i in range(len(steps)):
        for j in range(i + 1, len(steps)):
            sims.append(_cosine_proxy(steps[i], steps[j]))
    if not sims:
        return 1.0
    mean_sim = sum(sims) / len(sims)
    return max(0.0, 1.0 - mean_sim)


def compute_goal_alignment(steps: Sequence[str], user_prompt: str) -> float:
    """Cosine similarity between each step and the user prompt."""
    if not steps or not user_prompt:
        return 0.0
    sims = [_cosine_proxy(s, user_prompt) for s in steps]
    return sum(sims) / len(sims)


def compute_verification(steps: Sequence[str]) -> float:
    """Fraction of steps containing any of 18 verification markers."""
    if not steps:
        return 1.0
    hits = sum(
        1 for s in steps
        if any(p.search(s) for p in VERIFICATION_MARKERS)
    )
    return hits / len(steps)


def compute_calibration_error(steps: Sequence[str]) -> float:
    """Rate of unjustified high-confidence assertions (no verify in same step)."""
    if not steps:
        return 0.0
    unjustified = 0
    for s in steps:
        has_high_conf = bool(FAILURE_PATTERNS["unjustified_assertion"].search(s))
        has_verify = bool(VERIFICATION_MARKERS[0].search(s) or
                          VERIFICATION_MARKERS[5].search(s))
        if has_high_conf and not has_verify:
            unjustified += 1
    return unjustified / len(steps)


def lanham_trap_guard(coherence: float, verification: float) -> float:
    """Cap coherence at 0.70 when verification < 0.10.

    Per Lanham 2023: most CoT is post-hoc rationalisation. If the
    agent doesn't verify, coherence is likely post-hoc and shouldn't
    be trusted at full weight.
    """
    if verification < 0.10:
        return min(coherence, 0.70)
    return coherence


def compute_composite(score: ReasoningScore) -> float:
    """Weighted composite: 0.30·coh + 0.20·info + 0.20·goal + 0.15·ver + 0.15·(1 - calib)."""
    return (
        0.30 * score.coherence
        + 0.20 * score.informativeness
        + 0.20 * score.goal_alignment
        + 0.15 * score.verification
        + 0.15 * (1.0 - score.calibration_error)
    )


def score_reasoning(
    steps: Sequence[str], user_prompt: str = ""
) -> ReasoningScore:
    """Compute all 4 metrics + calibration error + composite.

    Applies Lanham Trap Guard to coherence before composite.
    """
    coherence_raw = compute_coherence(steps)
    verification = compute_verification(steps)
    coherence = lanham_trap_guard(coherence_raw, verification)
    return ReasoningScore(
        coherence=coherence,
        informativeness=compute_informativeness(steps),
        goal_alignment=compute_goal_alignment(steps, user_prompt),
        verification=verification,
        calibration_error=compute_calibration_error(steps),
        composite=0.0,  # filled below
    )


def score_with_composite(
    steps: Sequence[str], user_prompt: str = ""
) -> ReasoningScore:
    """Score and compute the composite in one call."""
    score = score_reasoning(steps, user_prompt)
    return ReasoningScore(
        coherence=score.coherence,
        informativeness=score.informativeness,
        goal_alignment=score.goal_alignment,
        verification=score.verification,
        calibration_error=score.calibration_error,
        composite=compute_composite(score),
    )


# ── Failure pattern + self-correction detection ───────────────


@dataclass(frozen=True)
class ReasoningDiagnostic:
    """Failure patterns + self-correction counts in a trace."""
    failure_patterns: dict[str, int]
    self_correction_patterns: dict[str, int]
    total_failure_hits: int
    total_correction_hits: int


def diagnose(steps: Sequence[str]) -> ReasoningDiagnostic:
    """Detect failure patterns + self-correction patterns in steps."""
    failures: dict[str, int] = {name: 0 for name in FAILURE_PATTERNS}
    corrections: dict[str, int] = {name: 0 for name in SELF_CORRECTION_PATTERNS}
    for s in steps:
        for name, pattern in FAILURE_PATTERNS.items():
            if pattern.search(s):
                failures[name] += 1
        for name, pattern in SELF_CORRECTION_PATTERNS.items():
            if pattern.search(s):
                corrections[name] += 1
    return ReasoningDiagnostic(
        failure_patterns=failures,
        self_correction_patterns=corrections,
        total_failure_hits=sum(failures.values()),
        total_correction_hits=sum(corrections.values()),
    )


# ── Spec-extension to fire on_drift_alert ──────────────────────


def on_judge_regression_check(
    score: ReasoningScore, *, threshold: float = 0.5
) -> bool:
    """Returns True if the composite drops below threshold.

    Per spec §9 Phase 9: triggers on_judge_regression when 7d mean
    drops > 0.1 (per-trace threshold here is 0.5).
    """
    return score.composite < threshold


__all__ = [
    "VERIFICATION_MARKERS",
    "FAILURE_PATTERNS",
    "SELF_CORRECTION_PATTERNS",
    "ReasoningScore",
    "ReasoningDiagnostic",
    "compute_coherence",
    "compute_informativeness",
    "compute_goal_alignment",
    "compute_verification",
    "compute_calibration_error",
    "lanham_trap_guard",
    "compute_composite",
    "score_reasoning",
    "score_with_composite",
    "diagnose",
    "on_judge_regression_check",
]