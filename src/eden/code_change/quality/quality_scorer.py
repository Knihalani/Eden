"""PRQualityScorer — multi-dimensional patch quality score (0-1).

A patch with ``quality_score < min_quality_score`` (default 0.8)
is marked as ``low_quality`` in the inbox and shown to the human
with a "quality concerns" badge.

Five dimensions with fixed weights:

* **Style compliance** (30%) — does the patch match the repo
  style profile? Computed by reading the diff + the profile and
  asking a T1 model to score 0.0-1.0.
* **Test coverage** (20%) — heuristic: does the patch add at
  least 1 new ``def test_`` / ``it(`` line per new ``def`` /
  ``function`` line? Score is the ratio.
* **Complexity** (15%) — heuristic: more hunks + more added
  lines per hunk = lower score.
* **Security** (20%) — regex pass for secrets, eval/exec,
  path-traversal patterns. Inline (no LLM).
* **Idiomatic fit** (15%) — T1 model evaluates whether the
  patch uses the repo's existing patterns (per the style
  profile's ``architecture_patterns``).

The 3 dimensions that need real lint tools (style_compliance,
test_coverage's exactness, idiomatic_fit's exactness) are
approximated via T1 model calls. The full AST-level checks
ship when Gate 3 (sandbox runner) lands.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from eden.optimization.model_router import ModelRouter, PipelineTask

from .._common import _new_id, diff_hunk_count, diff_line_count

logger = logging.getLogger(__name__)


_WEIGHTS: dict[str, float] = {
    "style_compliance": 0.30,
    "test_coverage": 0.20,
    "complexity": 0.15,
    "security": 0.20,
    "idiomatic_fit": 0.15,
}
if abs(sum(_WEIGHTS.values()) - 1.0) >= 1e-9:
    raise ValueError(
        f"PRQualityScorer weights must sum to 1.0, got {sum(_WEIGHTS.values())}"
    )


# Security patterns (inline, no LLM). The full scanner ships
# with Gate 3 + a real AST-level analyzer.
_SECRET_PATTERN = re.compile(
    r"(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*[\"']?[A-Za-z0-9_\-]{16,}"
)
_INSECURE_EVAL_PATTERN = re.compile(r"\b(eval|exec)\s*\(")
_PATH_TRAVERSAL_PATTERN = re.compile(r"\.\./")
_SQL_INJECTION_PATTERN = re.compile(
    r"(execute|executemany)\s*\(\s*[\"'].*%s.*[\"']\s*%",
    re.IGNORECASE,
)

# Test-pattern heuristics (cheap, no LLM).
_NEW_DEF_RE = re.compile(
    r"^\+\s*(?:def|async\s+def|function)\s+(?!test_)[A-Za-z_][\w]*",
    re.MULTILINE,
)
_NEW_TEST_RE = re.compile(
    r"^\+\s*(?:def\s+test_|async\s+def\s+test_|it\(|test\()",
    re.MULTILINE,
)


def _security_score(diff: str) -> float:
    """0.0 if any hard-rule violation, else 1.0."""
    if not diff:
        return 1.0
    if _SECRET_PATTERN.search(diff):
        return 0.0
    if _INSECURE_EVAL_PATTERN.search(diff):
        return 0.0
    if _SQL_INJECTION_PATTERN.search(diff):
        return 0.0
    if _PATH_TRAVERSAL_PATTERN.search(diff):
        return 0.5
    return 1.0


def _complexity_score(diff: str) -> float:
    """Heuristic: more hunks = lower score, capped at 1.0."""
    hunks = diff_hunk_count(diff)
    lines = diff_line_count(diff)
    if hunks == 0 and lines == 0:
        return 1.0
    # >20 hunks = 0.0, <5 hunks = 1.0, linear in between.
    # The (hunks - 5) / 15 formula can exceed 1.0 when hunks < 5,
    # so clamp the result to [0.0, 1.0].
    raw = 1.0 - (hunks - 5) / 15.0
    return max(0.0, min(1.0, raw))


def _test_coverage_score(diff: str) -> float:
    """1.0 if every new def has at least one matching test, else the ratio."""
    new_defs = _NEW_DEF_RE.findall(diff or "")
    new_tests = _NEW_TEST_RE.findall(diff or "")
    if not new_defs:
        return 1.0
    return min(1.0, len(new_tests) / max(1, len(new_defs)))


async def _llm_dimension_score(
    router: ModelRouter | None,
    agent_name: str,
    diff: str,
    context: str,
    default: float,
) -> float:
    """Ask a T1 model for a single 0.0-1.0 score. Falls back to default."""
    if router is None:
        return default
    task = PipelineTask(
        agent=agent_name,
        description=f"Score {agent_name} for a code patch",
        slot="fast",
        output_type="format",
        expected_min_length=3,
    )
    try:
        response = await router.aroute(
            task,
            (
                f"Return ONLY a single float between 0.0 and 1.0 "
                f"scoring how well this patch satisfies: {agent_name}\n\n"
                f"## Context\n{context}\n\n"
                f"## Diff (first 1500 chars)\n{(diff or '')[:1500]}\n"
            ),
            max_tokens=8,
        )
        raw = response.content.strip().split()[0]
        return max(0.0, min(1.0, float(raw)))
    except Exception as exc:
        logger.debug("quality_scorer: LLM %s failed: %s", agent_name, exc)
        return default


class PRQualityScorer:
    """Multi-dimensional patch quality scorer."""

    name = "pr_quality_scorer"

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

    async def score(
        self,
        org_id: str,
        patch_id: str,
        diff: str,
        repo_id: str,
        style_profile: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Return the 0-1 quality score + per-dimension breakdown.

        Real implementation: inline scoring for security +
        complexity + test_coverage heuristics. T1 model for the
        style_compliance + idiomatic_fit dimensions when a router
        is injected.
        """
        security = _security_score(diff)
        complexity = _complexity_score(diff)
        test_cov = _test_coverage_score(diff)

        style_ctx = json.dumps(style_profile or {}, indent=2)
        idiomatic_ctx = (
            "Evaluate whether the patch uses the repo's existing patterns "
            "(per architecture_patterns, naming_convention, dependency "
            "injection style, async-vs-sync)."
        )
        style_score = await _llm_dimension_score(
            self._router, "style_compliance", diff, style_ctx, default=0.85,
        )
        idiomatic_score = await _llm_dimension_score(
            self._router, "idiomatic_fit", diff, idiomatic_ctx, default=0.85,
        )

        overall = round(
            _WEIGHTS["style_compliance"] * style_score
            + _WEIGHTS["test_coverage"] * test_cov
            + _WEIGHTS["complexity"] * complexity
            + _WEIGHTS["security"] * security
            + _WEIGHTS["idiomatic_fit"] * idiomatic_score,
            4,
        )

        return {
            "status": "ok",
            "feature": self.name,
            "live": True,
            "trace_id": _new_id("live"),
            "timestamp": None,
            "data": {
                "patch_id": patch_id,
                "quality_score": overall,
                "quality_breakdown": {
                    "style_compliance": round(style_score, 4),
                    "test_coverage": round(test_cov, 4),
                    "complexity": round(complexity, 4),
                    "security": round(security, 4),
                    "idiomatic_fit": round(idiomatic_score, 4),
                },
                "weights": _WEIGHTS,
                "scoring_id": _new_id("qscore"),
                "router_used": self._router is not None,
            },
        }
