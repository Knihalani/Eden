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


__all__ = ["grade_datapoint", "aggregate_grades"]
