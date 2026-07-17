"""Playground / experiment output diff + grades."""

from __future__ import annotations

from typing import Any


def char_diff(a: str, b: str, *, max_chars: int = 4000) -> dict[str, Any]:
    """Simple character-level diff summary (capped)."""
    left = (a or "")[:max_chars]
    right = (b or "")[:max_chars]
    if left == right:
        return {"equal": True, "delta_chars": 0, "left": left, "right": right}
    # Longest common prefix / suffix for a readable hunk.
    i = 0
    while i < len(left) and i < len(right) and left[i] == right[i]:
        i += 1
    j = 0
    while (
        j < len(left) - i
        and j < len(right) - i
        and left[-(j + 1)] == right[-(j + 1)]
    ):
        j += 1
    return {
        "equal": False,
        "delta_chars": abs(len(left) - len(right)),
        "common_prefix": left[:i],
        "left_only": left[i : len(left) - j if j else None],
        "right_only": right[i : len(right) - j if j else None],
        "common_suffix": left[len(left) - j :] if j else "",
        "left": left,
        "right": right,
    }


def grade_outputs(
    control: str,
    treatment: str,
    *,
    control_score: float = 0.0,
    treatment_score: float = 0.0,
    control_cost: float = 0.0,
    treatment_cost: float = 0.0,
) -> tuple[str, float]:
    """Return (grade, score_delta). Prefer numeric scores when present."""
    delta = treatment_score - control_score
    if abs(delta) < 0.01 and control == treatment:
        return "tie", 0.0
    if abs(delta) < 0.01:
        # Text-only: treat equality as tie, else tradeoff.
        if control == treatment:
            return "tie", 0.0
        return "tradeoff", 0.0
    if delta > 0 and treatment_cost > control_cost * 1.2 and control_cost > 0:
        return "tradeoff", delta
    if delta > 0:
        return "improvement", delta
    return "regression", delta
