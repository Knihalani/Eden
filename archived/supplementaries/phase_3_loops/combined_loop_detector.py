"""Combined loop detector: real cosine + progress signal.

Combines:
  1. Real BGE-small-en-v1.5 cosine similarity (Phase 3 detector 3)
  2. Response-progress signal (Phase 3 mitigation a)

Output: improved F1 over cosine alone by filtering out
"redundancy" traces (high cosine from repeated LLM content BUT with
user responses between repetitions).

Verified against the synthetic dataset.
"""
from __future__ import annotations

from dataclasses import dataclass

from supplementaries.phase_3_loops.progress import (
    ProgressVerdict,
    analyze_progress,
    progress_filter_loop_verdict,
)
from supplementaries.phase_3_loops.real_ensemble import check_real
from supplementaries.phase_3_loops.real_embeddings import get_singleton


@dataclass(frozen=True)
class CombinedLoopReport:
    """Combined loop detector report."""
    verdict: str          # "OK" | "LOOP"
    action: str           # "allow" | "block" | "escalate"
    cosine_verdict: str
    cosine_max: float
    progress: ProgressVerdict
    is_progressing: bool
    is_stuck: bool
    severity: str         # "stable" | "medium" | "high"
    detectors_tripped: list[str]


def check_combined(
    events: list,
    *,
    cosine_threshold: float = 0.92,
    use_real_embeddings: bool = True,
) -> CombinedLoopReport:
    """Run cosine + progress and combine.

    Decision logic:
      1. If cosine_max < threshold: OK (allow).
      2. If cosine_max >= threshold:
         a. If progress.is_stuck: LOOP (block / escalate per severity).
         b. If progress.is_progressing: OK (redundancy, not loop).
         c. Otherwise (equivocal): LOOP (default).
    """
    cosine_report = check_real(
        events,
        cosine_threshold=cosine_threshold,
        use_real_embeddings=use_real_embeddings,
    )
    progress = analyze_progress(events)
    cosine_loop = cosine_report.verdict == "LOOP"

    # Apply progress filter
    is_loop = progress_filter_loop_verdict(events, cosine_loop)

    # Combine for severity
    if is_loop:
        verdict = "LOOP"
        if cosine_report.severity == "high":
            action = "escalate"
            severity = "high"
        else:
            action = "block"
            severity = "medium"
    else:
        verdict = "OK"
        action = "allow"
        severity = "stable"

    return CombinedLoopReport(
        verdict=verdict,
        action=action,
        cosine_verdict=cosine_report.verdict,
        cosine_max=cosine_report.cosine_max,
        progress=progress,
        is_progressing=progress.is_progressing,
        is_stuck=progress.is_stuck,
        severity=severity,
        detectors_tripped=cosine_report.detectors_tripped,
    )


def f1_on_synthetic(
    dataset: list,
    *,
    cosine_threshold: float = 0.92,
    use_real_embeddings: bool = True,
) -> dict:
    """Compute precision/recall/F1 of the combined detector on the dataset.

    Returns a dict with tp/fp/fn/tn + precision/recall/f1.
    """
    tp = fp = fn = tn = 0
    fp_archetypes: list[str] = []
    fn_archetypes: list[str] = []
    for ex in dataset:
        report = check_combined(
            ex.events,
            cosine_threshold=cosine_threshold,
            use_real_embeddings=use_real_embeddings,
        )
        predicted = report.verdict == "LOOP"
        expected = bool(ex.expected_loop_detected)
        if predicted and expected:
            tp += 1
        elif predicted and not expected:
            fp += 1
            fp_archetypes.append(ex.archetype_id)
        elif not predicted and expected:
            fn += 1
            fn_archetypes.append(ex.archetype_id)
        else:
            tn += 1
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (
        2 * precision * recall / (precision + recall)
        if (precision + recall) > 0 else 0.0
    )
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": precision, "recall": recall, "f1": f1,
        "fp_archetypes": fp_archetypes,
        "fn_archetypes": fn_archetypes,
    }


__all__ = [
    "CombinedLoopReport",
    "check_combined",
    "f1_on_synthetic",
]