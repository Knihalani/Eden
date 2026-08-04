"""F49 scorer registry — deterministic per-cell output scoring.

Scores are honest: when a scorer needs an expected value and the row
has none, the score is ``None`` with a reason — never a fabricated
midpoint. ``llm_judge`` is deliberately absent: wiring it through the
internal router needs judge-prompt design and response parsing that is
not trivially reusable here, and a fake judge is worse than none.

Config shape (per task or playground-global)::

    "scorers": [{"type": "regex", "pattern": "^ok"}, {"type": "exact_match"}]

``name`` is accepted as a legacy alias for ``type``. Each result is
``{"name": str, "score": float | bool | None, "detail": str | None}``.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from typing import Any

logger = logging.getLogger(__name__)

_MISSING_EXPECTED = "expected value missing"

# A scorer takes (output, expected, spec) and returns (score, detail).
Scorer = Callable[
    [str, str | None, dict[str, Any]], tuple[float | bool | None, str | None]
]


def _score_exact_match(
    output: str, expected: str | None, spec: dict[str, Any]
) -> tuple[float | bool | None, str | None]:
    if expected is None:
        return None, _MISSING_EXPECTED
    return (1.0 if output == expected else 0.0), None


def _needle(expected: str | None, spec: dict[str, Any]) -> str | None:
    value = spec.get("value")
    if value is not None:
        return str(value)
    return expected


def _score_contains(
    output: str, expected: str | None, spec: dict[str, Any]
) -> tuple[float | bool | None, str | None]:
    needle = _needle(expected, spec)
    if needle is None:
        return None, _MISSING_EXPECTED
    return (1.0 if needle in output else 0.0), None


def _score_icontains(
    output: str, expected: str | None, spec: dict[str, Any]
) -> tuple[float | bool | None, str | None]:
    needle = _needle(expected, spec)
    if needle is None:
        return None, _MISSING_EXPECTED
    return (1.0 if needle.lower() in output.lower() else 0.0), None


def _score_regex(
    output: str, expected: str | None, spec: dict[str, Any]
) -> tuple[float | bool | None, str | None]:
    pattern = spec.get("pattern")
    if not pattern:
        return None, "pattern missing"
    try:
        rx = re.compile(str(pattern))
    except re.error as exc:
        return None, f"invalid pattern: {exc}"
    return bool(rx.search(output)), None


def _score_json_valid(
    output: str, expected: str | None, spec: dict[str, Any]
) -> tuple[float | bool | None, str | None]:
    try:
        json.loads(output)
    except (ValueError, TypeError) as exc:
        return 0.0, f"invalid json: {exc}"
    return 1.0, None


def _levenshtein_distance(a: str, b: str) -> int:
    """Classic two-row DP edit distance (pure python, no deps)."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(
                min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (ca != cb))
            )
        prev = curr
    return prev[-1]


def _score_levenshtein_ratio(
    output: str, expected: str | None, spec: dict[str, Any]
) -> tuple[float | bool | None, str | None]:
    if expected is None:
        return None, _MISSING_EXPECTED
    longest = max(len(output), len(expected))
    if longest == 0:
        return 1.0, None
    return 1.0 - (_levenshtein_distance(output, expected) / longest), None


SCORERS: dict[str, Scorer] = {
    "exact_match": _score_exact_match,
    "contains": _score_contains,
    "icontains": _score_icontains,
    "regex": _score_regex,
    "json_valid": _score_json_valid,
    "levenshtein_ratio": _score_levenshtein_ratio,
}


def run_scorers(
    specs: list[dict[str, Any]] | None,
    *,
    output: str,
    expected: str | None,
) -> list[dict[str, Any]]:
    """Score ``output`` against every scorer spec.

    Unknown types and scorer bugs produce a ``score: None`` entry with a
    reason instead of raising, so one bad spec never sinks a run.
    """
    results: list[dict[str, Any]] = []
    for spec in specs or []:
        if not isinstance(spec, dict):
            continue
        stype = str(spec.get("type") or spec.get("name") or "").strip()
        fn = SCORERS.get(stype)
        if fn is None:
            results.append(
                {
                    "name": stype or "unknown",
                    "score": None,
                    "detail": f"unknown scorer type: {stype or '?'}",
                }
            )
            continue
        try:
            score, detail = fn(str(output or ""), expected, spec)
        except Exception as exc:  # noqa: BLE001 — cell must survive a scorer bug
            logger.warning("scorer %s failed: %s", stype, exc)
            score, detail = None, f"scorer error: {exc}"
        entry: dict[str, Any] = {"name": stype, "score": score}
        if detail:
            entry["detail"] = detail
        results.append(entry)
    return results


def aggregate_score(scores: list[dict[str, Any]] | None) -> float | None:
    """Mean of the numeric/bool scores; ``None`` when nothing was scored."""
    vals = [
        float(s["score"])
        for s in scores or []
        if isinstance(s, dict) and isinstance(s.get("score"), (bool, int, float))
    ]
    if not vals:
        return None
    return sum(vals) / len(vals)


__all__ = ["SCORERS", "aggregate_score", "run_scorers"]
