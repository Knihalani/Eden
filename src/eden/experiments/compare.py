"""F51 offline experiment compare grades."""

from __future__ import annotations

from typing import Any

_GRADES = ("improvement", "regression", "tradeoff", "tie")


def grade_datapoint(
    control: dict[str, Any],
    treatment: dict[str, Any],
    *,
    score_key: str = "score",
) -> tuple[str, float]:
    """Return (grade, score_delta) for one row."""
    c = float(control.get(score_key, 0.0) or 0.0)
    t = float(treatment.get(score_key, 0.0) or 0.0)
    delta = t - c
    if abs(delta) < 0.01:
        return "tie", delta
    c_cost = float(control.get("cost_usd", 0.0) or 0.0)
    t_cost = float(treatment.get("cost_usd", 0.0) or 0.0)
    if delta > 0 and t_cost > c_cost * 1.2:
        return "tradeoff", delta
    if delta > 0:
        return "improvement", delta
    return "regression", delta


def aggregate_grades(grades: list[str]) -> dict[str, int]:
    out = dict.fromkeys(_GRADES, 0)
    for g in grades:
        if g in out:
            out[g] += 1
    return out


def _normalize_score(score: float | None) -> float | None:
    if score is None:
        return None
    return round(float(score), 4)


def build_case_grade_row(
    case_id: str,
    *,
    baseline_score: float | None,
    current_score: float | None,
    fingerprint: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    """Build one per-case score-table row via ``grade_datapoint``.

    ``metric`` is ``case:<case_id>`` (or ``case:<fingerprint>`` when set) so
    aggregate metric rows and per-case F51 rows share the same table shape.
    """
    metric = f"case:{case_id}"
    if fingerprint:
        metric = f"case:{fingerprint}"
    if current_score is None:
        return {
            "metric": metric,
            "case_id": case_id,
            "baseline": _normalize_score(baseline_score),
            "current": None,
            "delta": None,
            "verdict": "skipped",
            "reason": reason or "unscored",
        }
    current = _normalize_score(current_score)
    if baseline_score is None:
        return {
            "metric": metric,
            "case_id": case_id,
            "baseline": None,
            "current": current,
            "delta": None,
            "verdict": "new",
            "reason": reason,
        }
    baseline = _normalize_score(baseline_score)
    assert baseline is not None and current is not None
    grade, delta = grade_datapoint({"score": baseline}, {"score": current})
    verdict = "improvement" if grade in ("improvement", "tradeoff") else grade
    return {
        "metric": metric,
        "case_id": case_id,
        "baseline": baseline,
        "current": current,
        "delta": round(delta, 4),
        "verdict": verdict,
        "reason": reason,
    }


__all__ = ["grade_datapoint", "aggregate_grades", "build_case_grade_row"]
