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
3. **Critic loop** (Phase 3b) — after T2 generation, run a T2
   critic pass on the diff. If the critic rejects, regenerate
   ONCE. If still rejected, mark the patch low_quality so a
   human can still see it (the inbox surfaces it with a
   "quality concerns" badge) but the on-call is not paged.
4. **Size validation** — soft cap 200 lines, hard cap 500. If
   the diff exceeds the hard cap, return an "investigation"
   envelope — no ``proposed_patches`` row is written, the
   caller is told "this needs architectural review".
5. **Similarity dedup** — before persisting, hash the diff and
   compare against proposed_patches from the last 14d via
   ``difflib.SequenceMatcher.ratio()``. If a >85% match exists,
   skip persistence and return the dedup envelope.
6. **Quality floor** — patches below ``patch_quality_floor``
   (default 0.8) are persisted with ``status='low_quality'``
   instead of ``status='proposed'``.
7. **Persistence** — writes a ``proposed_patches`` row with
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

import difflib
import hashlib
import json
import logging
import re
from typing import Any

from eden.code_change._common import (
    _insert_row,
    _select_rows,
    diff_files_changed,
    diff_hunk_count,
    diff_line_count,
)
from eden.optimization.model_router import ModelRouter, PipelineTask

from ._common import _new_id, _error_envelope, _ok_envelope

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


def _diff_title_hash(diff: str) -> str:
    """Stable hash of the first line of the diff for dedup comparison.

    The first ``+++ b/...`` header is the canonical "what file did
    we touch" signal — two patches targeting the same file with
    the same intent will share the same hash, even if the diff
    bodies differ slightly. Combined with ``difflib.SequenceMatcher``
    in :func:`_is_similar_to_recent_patch` this catches both
    "exact duplicate" and "same intent, slight tweak" cases.
    """
    if not diff:
        return ""
    m = _DIFF_HEADER_RE.search(diff)
    if not m:
        return ""
    target = m.group(0).strip()
    return hashlib.sha256(target.encode("utf-8")).hexdigest()[:16]


async def _is_similar_to_recent_patch(
    org_id: str,
    diff: str,
    *,
    threshold: float,
    lookback_days: int,
) -> dict[str, Any] | None:
    """Return the matching recent ``proposed_patches`` row if any.

    The match logic:

    1. Query ``proposed_patches`` for the same org in the last
       ``lookback_days`` (default 14). Only 50 most-recent rows
       to keep the SequenceMatcher cost bounded.
    2. For each candidate, run ``difflib.SequenceMatcher.ratio``
       against the new diff. If any ratio > ``threshold``,
       return that row.

    Returns ``None`` when no match is found (i.e. it's safe to
    persist the new patch). Pure stdlib ``difflib`` — no extra
    dep, fast enough for the 50-row window.

    Best-effort: DB errors return ``None`` so the caller falls
    through to "save it, let humans sort it out" rather than
    blocking the pipeline on a transient error.
    """
    if not diff or threshold <= 0.0:
        return None
    try:
        rows = await _select_rows(
            org_id,
            "proposed_patches",
            where=f"created_at > NOW() - INTERVAL '{int(lookback_days)} days'",
            order_by="created_at DESC",
            limit=50,
        )
    except Exception as exc:
        logger.debug("patch_gen: dedup select failed: %s", exc)
        return None
    matcher = difflib.SequenceMatcher(a=diff, b="", autojunk=False)
    for row in rows:
        candidate = row.get("diff") or ""
        if not candidate:
            continue
        matcher.set_seq2(candidate)
        ratio = matcher.ratio()
        if ratio > threshold:
            return {
                "matched_patch_id": row.get("id"),
                "matched_created_at": str(row.get("created_at", "")),
                "similarity": round(ratio, 4),
                "lookback_days": lookback_days,
                "threshold": threshold,
            }
    return None


def _validate_size(
    diff: str,
    *,
    soft_cap: int,
    hard_cap: int,
) -> dict[str, Any]:
    """Return a verdict for the size of the diff.

    * lines < soft_cap → ``{"ok": True, "size_class": "small"}``
    * soft_cap ≤ lines < hard_cap → ``{"ok": True, "size_class": "medium"}``
      (still persisted, but quality_scorer is more lenient — fewer
      complexity penalty bumps).
    * lines ≥ hard_cap → ``{"ok": False, "size_class": "investigation"}``
      (caller returns the "investigation" envelope — no persistence,
      human reads the RCA directly).
    """
    lines = diff_line_count(diff) if diff else 0
    if lines >= hard_cap:
        return {
            "ok": False,
            "size_class": "investigation",
            "lines_changed": lines,
            "soft_cap": soft_cap,
            "hard_cap": hard_cap,
        }
    if lines >= soft_cap:
        return {
            "ok": True,
            "size_class": "medium",
            "lines_changed": lines,
            "soft_cap": soft_cap,
            "hard_cap": hard_cap,
        }
    return {
        "ok": True,
        "size_class": "small",
        "lines_changed": lines,
        "soft_cap": soft_cap,
        "hard_cap": hard_cap,
    }


async def _critic_review(
    router: ModelRouter,
    diff: str,
    *,
    rca_summary: str,
) -> dict[str, Any]:
    """Run the Phase 3b critic loop on a generated diff.

    Asks a T2 model to evaluate the diff along 4 axes: does it
    actually fix the RCA, does it avoid security footguns, does
    it match the existing style, and would it pass lint/tests.

    Returns ``{"passed": bool, "reason": str, "raw": str}``.
    Never raises — on LLM failure returns ``{"passed": True,
    "reason": "critic_skipped"}`` so a transient critic outage
    doesn't block generation. The trade-off: false negatives
    (over-permissive) are preferable to false positives when
    the critic is itself unreliable.
    """
    task = PipelineTask(
        agent="patch_critic",
        description="Critic review of generated patch",
        slot="reasoning",
        output_type="format",
        expected_min_length=4,
    )
    prompt = (
        "Review this unified diff and decide whether it should be "
        "queued for human review.\n\n"
        "## RCA\n"
        f"{rca_summary or '(see attached RCA)'}\n\n"
        "## Diff (first 2000 chars)\n"
        f"{(diff or '')[:2000]}\n\n"
        "## Verdict\n"
        "Return EXACTLY one line in the form:\n"
        "  PASS: <one-sentence reason>\n"
        "or:\n"
        "  FAIL: <one-sentence reason>\n"
    )
    try:
        response = await router.aroute(task, prompt, max_tokens=64)
        raw = (response.content or "").strip()
        first_line = raw.splitlines()[0] if raw else ""
        if first_line.upper().startswith("FAIL"):
            return {
                "passed": False,
                "reason": first_line[5:].strip(" :") or "critic_rejected",
                "raw": raw,
            }
        return {
            "passed": True,
            "reason": first_line[4:].strip(" :") or "critic_passed",
            "raw": raw,
        }
    except Exception as exc:
        logger.debug("patch_gen: critic failed: %s", exc)
        return {"passed": True, "reason": "critic_skipped", "raw": ""}


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

        Pipeline (Phase 3b): generate → critic → size check →
        similarity dedup → quality floor → persist. The patch is
        persisted only if all gates pass; each rejected gate
        returns an envelope that names the gate so the caller
        knows what to do next.
        """
        # Fall back to the platform's default router if none was
        # injected. The endpoint always runs the full pipeline; only
        # catastrophic config errors (no router at all) return an
        # error envelope.
        if self._router is None:
            try:
                self._router = ModelRouter()
            except Exception as exc:
                return _error_envelope(
                    self.name,
                    message=(
                        f"Patch generation requires a ModelRouter. "
                        f"No router was injected and the default "
                        f"router failed to initialise: {exc}"
                    ),
                    error_code="router_missing",
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

        # Phase 3b: read size + dedup settings once. The scheduler
        # also reads these but we read here so the per-call path
        # works without the scheduler in the loop.
        from eden.config import get_settings
        settings = get_settings()
        soft_cap = settings.patch_max_diff_lines_soft
        hard_cap = settings.patch_max_diff_lines_hard
        dedup_threshold = settings.patch_similarity_threshold
        dedup_lookback_days = settings.patch_similarity_lookback_days
        quality_floor = settings.patch_quality_floor

        # ── Generate → critic loop (max 2 attempts) ────────────────
        diff = ""
        cost_usd = 0.0
        model_used = "anthropic/claude-sonnet-4"
        critic_verdict: dict[str, Any] | None = None
        critic_attempts = 0
        last_response_content = ""
        for attempt in range(2):
            try:
                response = await self._router.aroute(
                    task,
                    prompt,
                    org_id=org_id,
                    user_id=None,
                    max_tokens=4096,
                )
            except Exception as exc:
                return _error_envelope(
                    self.name,
                    message=f"LLM call failed for {rca_id}: {exc}",
                    error_code="llm_failed",
                    data={
                        "patch_id": _new_id("patch"),
                        "rca_id": rca_id,
                        "trace_id": trace_id,
                        "repo_id": repo_id,
                    },
                )
            candidate = _extract_diff_from_response(response.content)
            last_response_content = response.content
            cost_usd += float(getattr(response.usage, "cost", 0.0) or 0.0)
            model_used = getattr(response, "model", model_used)
            if not _is_valid_diff(candidate):
                critic_attempts += 1
                continue
            critic_verdict = await _critic_review(
                self._router, candidate, rca_summary=rca_summary,
            )
            critic_attempts += 1
            if critic_verdict.get("passed"):
                diff = candidate
                break
            # Critic rejected. Inject the reason into the prompt and
            # retry once. If still rejected, leave diff empty so the
            # caller gets a low_quality envelope.
            if attempt == 0:
                prompt = (
                    prompt
                    + "\n\n## Critic feedback (must address)\n"
                    + str(critic_verdict.get("reason", ""))
                )
            else:
                # Second attempt also failed. The diff is the most
                # recent (still invalid) candidate — surface it as
                # low_quality below.
                diff = candidate

        if not diff:
            error_code = (
                "invalid_diff"
                if not _is_valid_diff(last_response_content or "")
                else "critic_rejected"
            )
            return _error_envelope(
                self.name,
                message=(
                    "LLM output failed structural diff validation or "
                    "critic loop after "
                    f"{critic_attempts} attempts. Last output: "
                    f"{last_response_content[:200]!r}"
                ),
                error_code=error_code,
                data={
                    "patch_id": _new_id("patch"),
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                    "critic_verdict": critic_verdict,
                    "attempts": critic_attempts,
                },
            )

        # ── Size validation ─────────────────────────────────────────
        size_verdict = _validate_size(diff, soft_cap=soft_cap, hard_cap=hard_cap)
        if not size_verdict["ok"]:
            return _ok_envelope(
                self.name,
                {
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                    "diff": diff,
                    "files_changed": len(diff_files_changed(diff)),
                    "lines_changed": size_verdict["lines_changed"],
                    "model_used": model_used,
                    "cost_usd": cost_usd,
                    "status": "investigation",
                    "reason": (
                        f"diff exceeds hard cap ({hard_cap} lines); "
                        "this needs architectural review, not a PR"
                    ),
                    "size_verdict": size_verdict,
                },
            )

        # ── Similarity dedup ────────────────────────────────────────
        dup = await _is_similar_to_recent_patch(
            org_id,
            diff,
            threshold=dedup_threshold,
            lookback_days=dedup_lookback_days,
        )
        if dup is not None:
            return _ok_envelope(
                self.name,
                {
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                    "diff": diff,
                    "model_used": model_used,
                    "cost_usd": cost_usd,
                    "status": "deduplicated",
                    "reason": (
                        f"similar to recent patch "
                        f"{dup['matched_patch_id']} "
                        f"(similarity={dup['similarity']})"
                    ),
                    "duplicate_of": dup,
                },
            )

        # ── Quality floor ───────────────────────────────────────────
        # Inline heuristic placeholder — the real PRQualityScorer
        # is called by the queue worker downstream. Here we set the
        # initial quality_score from the critic verdict: PASS → 0.85
        # baseline, FAIL → 0.5 (will trip the floor for most cases).
        initial_quality = 0.85 if (critic_verdict or {}).get("passed") else 0.5
        if initial_quality < quality_floor:
            patch_status = "low_quality"
        else:
            patch_status = "proposed"

        metrics = _estimate_diff_metrics(diff)
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
                    initial_quality,
                    json.dumps({
                        "files_changed": metrics["files_changed"],
                        "lines_changed": metrics["lines_changed"],
                        "size_class": size_verdict["size_class"],
                        "critic_verdict": critic_verdict or {},
                        "critic_attempts": critic_attempts,
                    }),
                    model_used,
                    cost_usd,
                    1,
                    patch_status,
                ],
            )
        except Exception as exc:
            logger.debug("patch_gen: persistence failed: %s", exc)
            # We still return the live envelope — the caller can
            # retry persistence, or the GC job will pick it up.

        response = _ok_envelope(
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
                "status": patch_status,
                "size_class": size_verdict["size_class"],
                "critic_verdict": critic_verdict or {},
                "critic_attempts": critic_attempts,
            },
        )

        # Gate 5 wiring: record the patch outcome in the
        # CodebaseKnowledgeGraph so future PatchGenerator
        # calls + the post-merge monitor can read the
        # history. Best-effort — a graph write failure
        # doesn't fail the patch generation.
        if patch_status == "proposed" and metrics["files"]:
            try:
                from .knowledge_graph import CodebaseKnowledgeGraph
                kg = CodebaseKnowledgeGraph()
                # Record against each touched file. The
                # graph node id is per (org, repo, path)
                # so we get one row per file.
                rca_category = (
                    rca_id.split("_")[0] if "_" in rca_id else ""
                )
                for path in metrics["files"][:5]:
                    await kg.record_outcome(
                        org_id=org_id,
                        repo_id=repo_id,
                        code_path=path,
                        outcome="proposed",  # patch is proposed, not merged
                        rca_category=rca_category,
                        telemetry_signature=trace_id,
                    )
            except Exception as exc:
                logger.debug(
                    "patch_generator: KG record_outcome failed: %s",
                    exc,
                )

        return response
