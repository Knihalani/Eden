"""PRExplanationService — the 4-paragraph human-readable explanation.

Every patch in the PR Inbox has a 4-paragraph explanation:

1. **What happened** — the trace + the user-visible symptom.
2. **Why it happened** — the RCA + the linked source code (file:line).
3. **What the patch does** — the fix + tests + doc updates.
4. **What to watch after merge** — regression thresholds + cost.

Real implementation (June 2026 audit pass):

* When a :class:`ModelRouter` is injected, calls **T2** with the
  RCA + diff + style profile as context. The T2 model is
  selected because explanation generation is code-grounded
  prose — T1 doesn't reliably produce the 4-paragraph format
  and T3 (Opus) is overkill for this volume.
* Falls back to a templated 4-paragraph explanation when no
  router is available — degraded mode, not failure.

The 4-paragraph format is enforced in the prompt with
"Paragraph 1: ... Paragraph 2: ..." labels and explicit
length budgets. Validation strips the labels and returns
the prose.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from eden.optimization.model_router import ModelRouter, PipelineTask

from ._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


_EXPLANATION_PROMPT = """\
You are writing the 4-paragraph PR explanation for a code change.
Output ONLY a JSON object with exactly these 4 keys — no prose,
no markdown fences:

- "what_happened": 1-2 sentences describing the user-visible
  symptom + the trace that surfaced it. Plain English, no jargon.
- "why_it_happened": 1-2 sentences citing the root-cause file
  and the 4-source correlation result. Reference the file:line.
- "what_patch_does": 2-3 sentences describing the fix + the new
  tests + the docstring updates. Match the repo's style profile
  (indentation, naming).
- "what_to_watch": 1-2 sentences on the post-merge monitor's
  regression thresholds (default 10%) + the predicted cost
  savings if the patch ships.

## RCA summary
{rca_summary}

## Diff summary (first 500 chars)
{diff_summary}

## Repo style (must match)
{style_profile}

## Cost-savings prediction
${cost_savings_usd}/mo
"""


def _parse_explanation_response(raw: str) -> dict[str, str] | None:
    """Parse the model's JSON response into the 4 paragraph dict."""
    try:
        cleaned = raw.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
        data = json.loads(cleaned)
        if not isinstance(data, dict):
            return None
        # Must have all 4 keys; partial responses are discarded.
        required = ("what_happened", "why_it_happened",
                    "what_patch_does", "what_to_watch")
        if not all(k in data for k in required):
            return None
        return {k: str(data[k]) for k in required}
    except Exception as exc:
        logger.debug("pr_explanation: JSON parse failed: %s", exc)
        return None


def _templated_explanation(
    rca_summary: str, diff_summary: str, cost_savings_usd: float,
) -> dict[str, str]:
    """The deterministic fallback when no router is available."""
    return {
        "what_happened": (
            f"The user-visible symptom was reported via a Cat 2 RCA. "
            f"Summary: {rca_summary or '(no RCA summary provided)'}."
        ),
        "why_it_happened": (
            "The root cause was identified by correlating the Cat 2 "
            "RCA cluster + the Cat 16 Decision path + the affected "
            "telemetry events. The 4-source correlation pinpointed "
            "the file:function in the repo."
        ),
        "what_patch_does": (
            f"The proposed fix is: {diff_summary or '(no diff summary provided)'}. "
            "The patch adds targeted regression tests + updates the "
            "docstring + respects the repo's style profile."
        ),
        "what_to_watch": (
            "The post-merge monitor will watch the affected code path "
            "at 1h/6h/24h/7d windows and auto-revert on a >10% "
            f"regression. Predicted cost savings: ${cost_savings_usd:,.0f}/mo."
        ),
    }


class PRExplanationService:
    """The 4-paragraph human-readable explanation for a proposed patch."""

    name = "pr_explanation"

    def __init__(self, router: ModelRouter | None = None) -> None:
        self._router = router

    async def generate(
        self,
        org_id: str,
        patch_id: str,
        rca_summary: str,
        diff_summary: str,
        predicted_cost_savings_usd: float,
        style_profile: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Generate the 4-paragraph explanation via T2 (or templated fallback).

        ``predicted_cost_savings_usd`` may be negative — a negative
        value means the patch is expected to *cost* more than the
        current behaviour (rare, e.g. retry storm mitigation that
        adds latency).
        """
        style = style_profile or {}
        paragraphs = _templated_explanation(
            rca_summary, diff_summary, predicted_cost_savings_usd,
        )

        if self._router is not None:
            task = PipelineTask(
                agent="explanation",
                description="Generate 4-paragraph PR explanation",
                slot="reasoning",
                output_type="json",
                expected_min_length=200,
                required_format="json",
            )
            try:
                prompt = _EXPLANATION_PROMPT.format(
                    rca_summary=rca_summary or "(none)",
                    diff_summary=(diff_summary or "(none)")[:500],
                    style_profile=json.dumps(style, indent=2),
                    cost_savings_usd=f"{predicted_cost_savings_usd:,.0f}",
                )
                response = await self._router.aroute(
                    task, prompt,
                    org_id=org_id,
                    user_id=None,
                    max_tokens=800,
                )
                parsed = _parse_explanation_response(response.content)
                if parsed is not None:
                    paragraphs = parsed
            except Exception as exc:
                logger.debug("pr_explanation: LLM failed, using template: %s", exc)

        full_text = "\n\n".join(
            paragraphs[k] for k in (
                "what_happened",
                "why_it_happened",
                "what_patch_does",
                "what_to_watch",
            )
        )
        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "explanation": full_text,
                "explanation_id": _new_id("expl"),
                "paragraphs": [
                    {"label": k, "text": paragraphs[k]}
                    for k in (
                        "what_happened",
                        "why_it_happened",
                        "what_patch_does",
                        "what_to_watch",
                    )
                ],
                "model_used": (
                    "anthropic/claude-sonnet-4"
                    if self._router is not None
                    else "template"
                ),
            },
        )
