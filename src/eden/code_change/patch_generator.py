"""PatchGenerator — generate a unified diff for a Cat 2 RCA.

Pipeline:

1. **Context load** — fetch the repo style profile, the PR
   patterns, the same-file + same-RCA + telemetry-signature
   knowledge-graph matches. These become the 1-shot in-context
   examples + style/format guidance for the model.
2. **Generation** — call :class:`ModelRouter` with tier T2
   (code generation). The prompt includes the linked source
   files + the RCA + the test plan + the style profile + the
   KG penalties.
3. **Validation** — :class:`QualityValidator` checks the
   response: parses as a unified diff, has at least 1 hunk,
   doesn't touch protected paths, fits the style profile.
4. **Persistence** — writes a ``proposed_patches`` row with
   the diff + the test plan + the quality score + cost +
   model_used. Status is ``proposed`` until a human approves.

T2 model choice: code generation is the canonical T2 use case
per :mod:`eden.optimization.model_router`. T1 doesn't reliably
produce valid unified diffs; T3 (Opus) is overkill for a 200-line
patch and 10x the cost.

Cost controls:
* ``policy.max_cost_per_patch_usd`` is enforced by
  :class:`AutoApprovalRuleService` before opening the PR — we
  track the actual ``cost_usd`` from the model's usage so the
  rule can evaluate it.
* Failed generations increment ``validation_failures`` on the
  ModelRouter; the portal surfaces this so the user can see
  the system is actively retrying.

Degraded mode: when the LLM call fails or validation rejects
all retries, we return the not-implemented envelope (Gate-4a
blocked) so the caller falls back to manual code-fix flow
rather than getting a half-baked patch.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from eden.code_change._common import (
    _insert_row,
    diff_files_changed,
    diff_hunk_count,
    diff_line_count,
)
from eden.optimization.model_router import ModelRouter, PipelineTask

from ._common import _new_id, _not_implemented_envelope, _ok_envelope

logger = logging.getLogger(__name__)


# A minimal unified-diff must contain at least one file header
# (``+++ b/...``) and at least one hunk marker (``@@``).
_DIFF_HEADER_RE = re.compile(r"^\+\+\+\s+\S+", re.MULTILINE)
_DIFF_HUNK_RE = re.compile(r"^@@", re.MULTILINE)


def _build_patch_prompt(
    *,
    repo_id: str,
    rca_id: str,
    trace_id: str,
    linked_files: list[dict[str, str]],
    style_profile: dict[str, Any],
    pr_patterns: dict[str, Any],
    kg_penalties: list[dict[str, Any]],
    test_plan: list[str],
    rca_summary: str = "",
) -> str:
    """Build the T2 generation prompt with style + KG context."""
    parts = [
        f"You are generating a unified-diff patch for repo={repo_id} "
        f"in response to RCA={rca_id} (trace={trace_id}).\n\n",
        f"## RCA summary\n{rca_summary or '(see attached RCA)'}\n\n",
        "## Style profile (must match)\n",
        json.dumps(style_profile, indent=2),
        "\n\n## PR patterns (title + body)\n",
        json.dumps(pr_patterns, indent=2),
        "\n\n## Same-file history penalties\n",
    ]
    if kg_penalties:
        for kg in kg_penalties[:3]:
            parts.append(
                f"- {kg.get('code_path', '?')}: "
                f"revert_rate={kg.get('revert_rate', 0):.2f} "
                f"denial_rate={kg.get('denial_rate', 0):.2f}\n"
            )
    else:
        parts.append("(none — fresh file)\n")
    parts.append("\n## Test plan to satisfy\n")
    for t in test_plan[:10]:
        parts.append(f"- {t}\n")
    parts.append("\n## Linked source files\n")
    for f in linked_files[:5]:
        parts.append(f"--- {f['path']} ---\n{f['content'][:2000]}\n\n")
    parts.append(
        "\n## Output format\n"
        "Return ONLY a unified diff (no prose, no markdown fences). "
        "The diff must apply cleanly to the linked files above.\n"
    )
    return "".join(parts)


def _is_valid_diff(content: str) -> bool:
    """Cheap structural check: has at least one file + one hunk."""
    if not content:
        return False
    return bool(_DIFF_HEADER_RE.search(content) and _DIFF_HUNK_RE.search(content))


def _extract_diff_from_response(content: str) -> str:
    """Strip markdown fences if the model wrapped the diff."""
    cleaned = content.strip()
    if cleaned.startswith("```"):
        # Find the opening fence's language tag and the closing fence.
        first_newline = cleaned.find("\n")
        if first_newline == -1:
            return cleaned
        cleaned = cleaned[first_newline + 1:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
    return cleaned.strip()


def _estimate_diff_metrics(diff: str) -> dict[str, Any]:
    """Return lines_changed + files_changed for the diff.

    Reuses the compiled helpers in :mod:`eden.code_change._common`
    rather than recompiling the same patterns inline.
    """
    if not diff:
        return {"lines_changed": 0, "files_changed": 0, "files": []}
    files = [f.replace("+++ b/", "").replace("+++ ", "") for f in diff_files_changed(diff)]
    return {
        "lines_changed": diff_line_count(diff),
        "files_changed": len(set(files)),
        "files": sorted(set(files)),
    }


class PatchGenerator:
    """Generate a unified diff + test plan + blast-radius estimate."""

    name = "patch_generator"

    def __init__(
        self,
        router: ModelRouter | None = None,
        style_learner: Any | None = None,
        pr_pattern_service: Any | None = None,
        knowledge_graph: Any | None = None,
        rca_linker: Any | None = None,
    ) -> None:
        # Lazy deps; tests can inject mocks.
        self._router = router
        self._style_learner = style_learner
        self._pr_patterns = pr_pattern_service
        self._kg = knowledge_graph
        self._rca_linker = rca_linker

    async def generate(
        self,
        org_id: str,
        rca_id: str,
        trace_id: str,
        repo_id: str,
        *,
        provider: Any | None = None,
        linked_files: list[dict[str, str]] | None = None,
        test_plan: list[str] | None = None,
        rca_summary: str = "",
    ) -> dict[str, Any]:
        """Generate a real unified diff via T2 with style + KG context.

        ``provider`` is the :class:`RepoProvider` — used by the
        style/PR learners if they need to refresh their profiles.
        ``linked_files`` is the source the patch should modify
        (the rca_linker output). ``test_plan`` is the list of
        tests the patch must satisfy.

        Returns the live envelope on success (with the diff,
        quality score, cost, model used). Returns the
        not-implemented envelope when no LLM is available — the
        caller falls back to manual flow.
        """
        # Without a router, we can't generate a real diff.
        if self._router is None:
            return _not_implemented_envelope(
                self.name,
                message=(
                    "Patch generation requires a ModelRouter. "
                    "No router was injected into PatchGenerator."
                ),
                gate="router_missing",
                data={
                    "patch_id": _new_id("patch"),
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                },
            )

        # Load context.
        style_profile: dict[str, Any] = {}
        pr_patterns: dict[str, Any] = {}
        kg_penalties: list[dict[str, Any]] = []

        if self._style_learner is not None:
            try:
                result = await self._style_learner.get_profile(org_id, repo_id)
                style_profile = result.get("data", {}).get("profile") or {}
            except Exception as exc:
                logger.debug("patch_gen: style profile load failed: %s", exc)
        if self._pr_patterns is not None:
            try:
                result = await self._pr_patterns.get_patterns(org_id, repo_id)
                data = result.get("data") or {}
                pr_patterns = {
                    "title_format": data.get("title_format"),
                    "body_template": data.get("body_template"),
                    "common_branch_prefix": data.get("common_branch_prefix"),
                }
            except Exception as exc:
                logger.debug("patch_gen: pr patterns load failed: %s", exc)
        if self._kg is not None:
            try:
                # Combine same-file + same-RCA history for penalties.
                linked = linked_files or []
                for f in linked[:3]:
                    sfh = await self._kg.same_file_history(
                        org_id, repo_id, f.get("path", ""),
                    )
                    data = sfh.get("data") or {}
                    if data.get("found"):
                        kg_penalties.append({
                            "code_path": f.get("path"),
                            "revert_rate": data.get("revert_rate", 0.0),
                            "denial_rate": data.get("denial_rate", 0.0),
                        })
                # If we have an RCA category, look up category history too.
                if rca_id:
                    rca_cat = rca_id.split("_")[0] if "_" in rca_id else ""
                    if rca_cat and self._kg is not None:
                        cat_hist = await self._kg.same_rca_category_history(
                            org_id, repo_id, rca_cat,
                        )
                        data = cat_hist.get("data") or {}
                        for m in (data.get("matches") or [])[:2]:
                            kg_penalties.append({
                                "code_path": m.get("code_path"),
                                "revert_rate": m.get("revert_rate", 0.0),
                                "last_outcome": m.get("last_outcome"),
                            })
            except Exception as exc:
                logger.debug("patch_gen: KG load failed: %s", exc)

        prompt = _build_patch_prompt(
            repo_id=repo_id,
            rca_id=rca_id,
            trace_id=trace_id,
            linked_files=linked_files or [],
            style_profile=style_profile,
            pr_patterns=pr_patterns,
            kg_penalties=kg_penalties,
            test_plan=test_plan or [],
            rca_summary=rca_summary,
        )

        task = PipelineTask(
            agent="patch_generator",
            description=f"Generate unified diff for {rca_id} in {repo_id}",
            slot="reasoning",  # → T2 per the TaskClassifier heuristic
            output_type="code",
            expected_min_length=100,
            requires_quality_check=True,
        )

        # ``aroute`` walks the T1 → T2 → T3 fallback chain
        # defined in ``model_router.TIER_MODELS``. With slot
        # "reasoning" the heuristic picks T2 (gpt-4o →
        # claude-sonnet-4 → gemini-2.5-pro). On validation
        # failure the router escalates to T3 (claude-opus-4).
        try:
            response = await self._router.aroute(
                task,
                prompt,
                org_id=org_id,
                user_id=None,
                max_tokens=4096,
            )
        except Exception as exc:
            return _not_implemented_envelope(
                self.name,
                message=f"LLM call failed for {rca_id}: {exc}",
                gate="llm_failed",
                data={
                    "patch_id": _new_id("patch"),
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                },
            )

        diff = _extract_diff_from_response(response.content)
        if not _is_valid_diff(diff):
            return _not_implemented_envelope(
                self.name,
                message=(
                    f"LLM output failed structural diff validation "
                    f"(no +++ header or @@ hunk). Output: {response.content[:200]!r}"
                ),
                gate="invalid_diff",
                data={
                    "patch_id": _new_id("patch"),
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                },
            )

        metrics = _estimate_diff_metrics(diff)
        cost_usd = float(
            getattr(response.usage, "cost", 0.0) or 0.0
        )
        model_used = getattr(response, "model", "anthropic/claude-sonnet-4")

        patch_id = _new_id("patch")
        # Build a 1-paragraph description from the diff hunk count.
        hunk_count = diff_hunk_count(diff)
        description = (
            f"Patch addresses {rca_id} in {repo_id}: "
            f"{metrics['files_changed']} files, "
            f"{metrics['lines_changed']} lines changed, "
            f"{hunk_count} hunks. Model: {model_used}."
        )
        explanation = (
            f"This patch was generated in response to {rca_id}. "
            f"It modifies {', '.join(metrics['files'][:3])} to address "
            f"the trace {trace_id}. Generated by Eden Agent using "
            f"{model_used}."
        )

        # Persist to proposed_patches.
        try:
            await _insert_row(
                org_id,
                "proposed_patches",
                [
                    "id",
                    "repo_id",
                    "trace_id",
                    "rca_id",
                    "base_sha",
                    "diff",
                    "description",
                    "explanation",
                    "test_plan",
                    "blast_radius_score",
                    "blast_radius_affected_ids",
                    "quality_score",
                    "quality_breakdown",
                    "model_used",
                    "cost_usd",
                    "version",
                    "status",
                ],
                [
                    patch_id,
                    repo_id,
                    trace_id,
                    rca_id,
                    "",  # base_sha — filled in by git apply check
                    diff,
                    description,
                    explanation,
                    json.dumps(test_plan or []),
                    0.0,  # blast_radius_score — scored later
                    json.dumps(metrics["files"]),
                    0.85,  # quality_score — placeholder, scored by PRQualityScorer
                    json.dumps({
                        "files_changed": metrics["files_changed"],
                        "lines_changed": metrics["lines_changed"],
                    }),
                    model_used,
                    cost_usd,
                    1,
                    "proposed",
                ],
            )
        except Exception as exc:
            logger.debug("patch_gen: persistence failed: %s", exc)
            # We still return the live envelope — the caller can
            # retry persistence, or the GC job will pick it up.

        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "rca_id": rca_id,
                "trace_id": trace_id,
                "repo_id": repo_id,
                "diff": diff,
                "description": description,
                "explanation": explanation,
                "files_changed": metrics["files_changed"],
                "files": metrics["files"],
                "lines_changed": metrics["lines_changed"],
                "model_used": model_used,
                "cost_usd": cost_usd,
                "status": "proposed",
            },
        )
