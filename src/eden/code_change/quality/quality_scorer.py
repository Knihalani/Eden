"""PRQualityScorer — multi-dimensional patch quality score (0-1).

A patch with ``quality_score < min_quality_score`` (default 0.8)
is marked as ``low_quality`` in the inbox and shown to the human
with a "quality concerns" badge. The scorer is a multi-dimensional
check:

* **Style compliance** (30% weight) — does the patch match
  ``repo_style_profile``? Lint check (ruff/mypy/eslint/tsc/biome)
  runs in the sandbox; any violation reduces the score.
* **Test coverage** (20% weight) — the patch should not decrease
  coverage of the touched files. A patch that adds a new function
  without a test gets flagged.
* **Complexity** (15% weight) — cyclomatic complexity of new code
  must be ≤ the repo's median (auto-detected from
  ``lizard`` / ``radon`` / ``complexity-report``).
* **Security** (20% weight) — no secrets, no ``eval``/``exec``, no
  SQL injection patterns, no path-traversal patterns, no insecure
  deserialization.
* **Idiomatic fit** (15% weight) — does the patch use the repo's
  existing patterns? E.g., if the repo uses ``Depends(get_db)``
  for DB access, a patch that creates a raw ``psycopg2.connect()``
  is unidiomatic and flagged.

STUB mode computes a deterministic score from the diff (hunks +
lines + a simple secret-pattern regex) so the per-dimension
breakdown is non-zero in tests. The real Gate-4a implementation
will run the actual lint + coverage + complexity tools inside
the sandbox.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from .._common import (
    _new_id,
    _not_implemented_envelope,
    diff_hunk_count,
    diff_line_count,
)

logger = logging.getLogger(__name__)


# The 5 weights — keep in sync with the v1.6 cat spec.
_WEIGHTS: dict[str, float] = {
    "style_compliance": 0.30,
    "test_coverage": 0.20,
    "complexity": 0.15,
    "security": 0.20,
    "idiomatic_fit": 0.15,
}
assert abs(sum(_WEIGHTS.values()) - 1.0) < 1e-9, "weights must sum to 1.0"

# Patterns the stub-mode security check uses. The real Gate-4a
# implementation will use a proper AST-level scan.
_SECRET_PATTERN = re.compile(
    r"(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{16,}"
)
_INSECURE_EVAL_PATTERN = re.compile(r"\b(eval|exec)\s*\(")
_PATH_TRAVERSAL_PATTERN = re.compile(r"\.\./")


def _stub_security_score(diff: str) -> float:
    """Return 0.0 if any secret / eval / path-traversal pattern is found,
    else 1.0. The real Gate-4a implementation will run a real scanner.
    """
    if not diff:
        return 1.0
    if _SECRET_PATTERN.search(diff):
        return 0.0
    if _INSECURE_EVAL_PATTERN.search(diff):
        return 0.0
    if _PATH_TRAVERSAL_PATTERN.search(diff):
        return 0.5  # suspicious but not necessarily a vuln
    return 1.0


def _stub_complexity_score(diff: str) -> float:
    """Heuristic complexity proxy: more hunks = lower score.

    Real Gate-4a: tree-sitter + lizard/radon cyclomatic complexity.
    """
    hunks = diff_hunk_count(diff)
    lines = diff_line_count(diff)
    if hunks == 0 and lines == 0:
        return 1.0
    # Penalise: >20 hunks = 0.0, <5 hunks = 1.0, linear in between.
    return max(0.0, 1.0 - (hunks - 5) / 15.0)


class PRQualityScorer:
    """Multi-dimensional patch quality scorer."""

    name = "pr_quality_scorer"

    async def score(
        self,
        org_id: str,
        patch_id: str,
        diff: str,
        repo_id: str,
    ) -> dict[str, Any]:
        """Return the 0-1 quality score + per-dimension breakdown.

        STUB: computes the security + complexity dimensions
        inline; the other 3 dimensions return the live envelope
        because they require the sandbox runner (Gate 3) to
        run the actual lint / coverage / idiomatic-fit checks.
        """
        security = _stub_security_score(diff)
        complexity = _stub_complexity_score(diff)

        # The 3 sandbox-dependent dimensions are Gate-3 blocked.
        sandbox_blocked = _not_implemented_envelope(
            self.name,
            message=(
                "Style / coverage / idiomatic-fit scoring require "
                "the sandbox runner (Gate 3) to execute the "
                "lint + coverage + tree-sitter checks. STUB "
                "returns a blocked envelope for the 3 dimensions "
                "and inline scores for security + complexity."
            ),
            gate="3_blocked",
            data={
                "patch_id": patch_id,
                "quality_score": None,
                "quality_breakdown": None,
                "stub_id": _new_id("qscore_stub"),
            },
        )

        # The stub-mode overall score weights only the 2
        # inline-computable dimensions, normalised to sum to 1.
        stub_weights = _WEIGHTS["security"] + _WEIGHTS["complexity"]
        normalised = {
            "security": _WEIGHTS["security"] / stub_weights,
            "complexity": _WEIGHTS["complexity"] / stub_weights,
        }
        stub_overall = (
            normalised["security"] * security
            + normalised["complexity"] * complexity
        )

        return {
            "status": "ok",
            "feature": self.name,
            "live": True,
            "trace_id": _new_id("live"),
            "timestamp": None,
            "data": {
                "patch_id": patch_id,
                "quality_score": round(stub_overall, 4),
                "quality_breakdown": {
                    "style_compliance": sandbox_blocked,
                    "test_coverage": sandbox_blocked,
                    "complexity": round(complexity, 4),
                    "security": round(security, 4),
                    "idiomatic_fit": sandbox_blocked,
                },
                "weights": _WEIGHTS,
                "stub": True,
                "message": (
                    "Stub quality score — 2/5 dimensions are "
                    "inline-computable; 3/5 require Gate 3 (sandbox)."
                ),
            },
        }
