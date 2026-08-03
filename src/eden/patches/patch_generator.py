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
7. **Persistence** — when ``persist=True`` (legacy Cat 23 /
   direct API callers), writes a ``proposed_patches`` row with
   the diff + the test plan + the quality score + cost +
   model_used. Status is ``proposed`` until a human approves.
   N23 (:mod:`eden.improvement.issue_patch_trigger`) always
   passes ``persist=False`` — the diff is returned in-memory
   and persisted to ``improvement_plans`` instead.

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
from typing import TYPE_CHECKING, Any

from eden.patches._common import (
    _insert_row,
    _select_rows,
    diff_files_changed,
    diff_hunk_count,
    diff_line_count,
)

from ._common import _error_envelope, _new_id, _not_implemented_envelope, _ok_envelope

if TYPE_CHECKING:
    # Only needed for static type checkers. The real import is
    # lazy in ``__getattr__`` below so importing this module
    # doesn't pull in the full ModelRouter pipeline (~1s of
    # ``eden.config`` + ``eden.llm.client`` init).
    from eden.optimization.model_router import ModelRouter  # noqa: F401


def __getattr__(name: str):
    """PEP 562 lazy import.

    ``eden.optimization.model_router`` transitively imports
    ``eden.config`` and ``eden.llm.client``, which alone account
    for ~1 second of cold import time on this module. Tests and
    read-only callers that never run patch generation should
    not pay that cost. We re-export ``ModelRouter`` and
    ``PipelineTask`` from this module so existing imports
    (``from eden.patches.patch_generator import ModelRouter``)
    keep working without the eager import.
    """
    if name in {"ModelRouter", "PipelineTask"}:
        from eden.optimization import model_router
        return getattr(model_router, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

# Cache the credential check — it's pure env-var reads and
# stays constant for the process lifetime. ``os.getenv`` is
# cheap but we still avoid the call on every PatchGenerator
# invocation when the agent runs in a hot loop.
_LLM_CREDENTIAL_PRESENT: bool | None = None


def _has_llm_credentials() -> bool:
    """Return True if any standard LLM provider env var is set."""
    global _LLM_CREDENTIAL_PRESENT
    if _LLM_CREDENTIAL_PRESENT is not None:
        return _LLM_CREDENTIAL_PRESENT
    import os
    keys = (
        "OPENROUTER_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "EDEN_LLM_API_KEY",
    )
    _LLM_CREDENTIAL_PRESENT = any(os.getenv(k) for k in keys)
    return _LLM_CREDENTIAL_PRESENT


logger = logging.getLogger(__name__)


# A minimal unified-diff must contain at least one file header
# (``+++ b/...``) and at least one hunk marker (``@@``).
_DIFF_HEADER_RE = re.compile(r"^\+\+\+\s+\S+", re.MULTILINE)
_DIFF_HUNK_RE = re.compile(r"^@@", re.MULTILINE)


# System-prompt fragment reused on every patch-generation call. Lifted
# out of the per-call user prompt so the static instruction text is
# cacheable by Anthropic prompt caching (saves ~90% of those tokens
# on the second+ call within the cache TTL) and so changes to the
# instructions don't churn the user-side cache key.
_PATCH_GEN_SYSTEM_PROMPT = (
    "You are an expert software engineer generating a unified-diff patch. "
    "Return ONLY a unified diff — no prose, no markdown fences. "
    "The diff must apply cleanly to the linked files and pass the test "
    "plan. Match the style profile and follow the PR patterns. Avoid "
    "the same-file history penalties."
)


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
) -> tuple[str, str]:
    """Build the T2 generation (system_prompt, user_prompt) pair.

    The static instruction text lives in the system prompt so it is
    eligible for Anthropic prompt caching and never gets re-billed on
    the second+ call. Variable context (the RCA, files, test plan)
    stays in the user message.
    """
    parts = [
        f"## Target\nrepo={repo_id} RCA={rca_id} trace={trace_id}\n\n",
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
    # Only include the file section if at least one caller actually
    # populated ``content`` — ``EdenPatchAgent`` historically passed
    # empty strings, which just bloat the prompt with 5 bare headers
    # (``--- path ---``) and no useful content. Saves ~50 tokens per
    # call in that mode.
    files_with_content = [f for f in linked_files[:5] if f.get("content")]
    if files_with_content:
        parts.append("\n## Linked source files\n")
        for f in files_with_content:
            parts.append(f"--- {f['path']} ---\n{f['content'][:2000]}\n\n")
    elif linked_files:
        # Be explicit when paths exist but content was not hydrated —
        # otherwise the model invents edits against imaginary files.
        parts.append(
            "\n## Linked source files\n"
            "(paths known but content unavailable — do not invent file bodies; "
            "propose a minimal diff only if the RCA names exact edits)\n"
        )
        for f in linked_files[:5]:
            if f.get("path"):
                parts.append(f"- {f['path']}\n")
    return _PATCH_GEN_SYSTEM_PROMPT, "".join(parts)


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

    Reuses the compiled helpers in :mod:`eden.patches._common`
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
    """Return the matching recent patch row if any.

    Checks both ``proposed_patches.diff`` and
    ``improvement_plans.diff_unified`` so N23 ``persist=False``
    callers still dedupe against prior inbox plans.
    """
    if not diff or threshold <= 0.0:
        return None
    candidates: list[dict[str, Any]] = []
    try:
        rows = await _select_rows(
            org_id,
            "proposed_patches",
            where=f"created_at > NOW() - INTERVAL '{int(lookback_days)} days'",
            order_by="created_at DESC",
            limit=50,
        )
        for row in rows or []:
            candidates.append(
                {
                    "id": row.get("id"),
                    "created_at": row.get("created_at"),
                    "diff": row.get("diff") or "",
                    "source": "proposed_patches",
                }
            )
    except Exception as exc:
        logger.debug("patch_gen: dedup proposed_patches select failed: %s", exc)

    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is not None:
            plan_rows = await client.fetch(
                f"""
                SELECT id, created_at, diff_unified
                FROM improvement_plans
                WHERE org_id = $1
                  AND plan_kind = 'code_patch'
                  AND diff_unified IS NOT NULL
                  AND diff_unified <> ''
                  AND created_at > NOW() - INTERVAL '{int(lookback_days)} days'
                ORDER BY created_at DESC
                LIMIT 50
                """,
                org_id,
            )
            for row in plan_rows or []:
                candidates.append(
                    {
                        "id": row.get("id"),
                        "created_at": row.get("created_at"),
                        "diff": row.get("diff_unified") or "",
                        "source": "improvement_plans",
                    }
                )
    except Exception as exc:
        logger.debug("patch_gen: dedup improvement_plans select failed: %s", exc)

    matcher = difflib.SequenceMatcher(a=diff, b="", autojunk=False)
    for row in candidates:
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
                "source": row.get("source"),
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

    Returns ``{"passed": bool, "reason": str, "raw": str}``.
    M4 (D13): fail-closed on EVERY path — a critic outage, malformed
    output, or exhausted LLM budget returns ``passed=False`` so an
    unreviewed patch can never continue, regardless of ``persist``.
    (The legacy ``persist=True`` fail-open carve-out is gone.)
    """
    from eden.improvement.sweep_budget import try_consume_llm_call

    if not try_consume_llm_call():
        return {
            "passed": False,
            "reason": "llm_budget_exhausted",
            "raw": "",
        }

    # Lazy import — see module-level __getattr__.
    from eden.optimization.model_router import PipelineTask
    task = PipelineTask(
        agent="patch_critic",
        description="Critic review of generated patch",
        slot="reasoning",
        output_type="format",
        expected_min_length=4,
    )
    # Static critic instructions live in the system prompt so they
    # are eligible for Anthropic prompt caching; the variable diff +
    # RCA are in the user prompt.
    critic_system = (
        "You are the Eden patch critic. Review a unified diff and "
        "decide whether it should be queued for human review. "
        "Return EXACTLY one line: 'PASS: <reason>' or 'FAIL: <reason>'."
    )
    prompt = (
        "## RCA\n"
        f"{rca_summary or '(see attached RCA)'}\n\n"
        "## Diff (first 2000 chars)\n"
        f"{(diff or '')[:2000]}\n"
    )
    try:
        response = await router.aroute(
            task, prompt, system_prompt=critic_system, max_tokens=64,
        )
        raw = (response.content or "").strip()
        first_line = raw.splitlines()[0] if raw else ""
        if not first_line:
            # M4 (D13): an empty/blank critic response is not a review —
            # fail closed rather than defaulting to "passed".
            return {
                "passed": False,
                "reason": "critic_error",
                "raw": raw,
                "cost_usd": float(getattr(getattr(response, "usage", None), "cost", 0) or 0),
            }
        if first_line.upper().startswith("FAIL"):
            return {
                "passed": False,
                "reason": first_line[5:].strip(" :") or "critic_rejected",
                "raw": raw,
                "cost_usd": float(getattr(getattr(response, "usage", None), "cost", 0) or 0),
            }
        return {
            "passed": True,
            "reason": first_line[4:].strip(" :") or "critic_passed",
            "raw": raw,
            "cost_usd": float(getattr(getattr(response, "usage", None), "cost", 0) or 0),
        }
    except Exception as exc:
        logger.debug("patch_gen: critic failed: %s", exc)
        # M4 (D13): outage == not reviewed == fail.
        return {"passed": False, "reason": "critic_error", "raw": ""}


async def _run_static_preverify(
    diff: str,
    linked_files: list[dict[str, str]],
) -> dict[str, Any]:
    """Free apply + syntax check for a candidate diff (no LLM cost)."""
    from eden.improvement.evidence_plane import (
        apply_diff_to_files,
        format_static_errors_for_prompt,
    )

    if not linked_files:
        return {
            "status": "skipped",
            "reason": "no_linked_file_content",
            "errors": [],
            "feedback": "",
        }
    try:
        result = await apply_diff_to_files(diff, linked_files, run_static=True)
    except Exception as exc:
        return {
            "status": "failed",
            "reason": f"static_preverify_error:{exc}",
            "errors": [
                {
                    "path": "",
                    "kind": "apply_error",
                    "message": str(exc)[:400],
                }
            ],
            "feedback": f"Static preverify failed: {exc}",
        }

    status = str(result.get("status") or "skipped")
    detail = result.get("detail") or {}
    static = detail.get("static_check") or {}
    errors: list[dict[str, Any]] = list(static.get("errors") or [])
    if status == "failed" and not errors:
        reason = str(detail.get("reason") or "diff_apply_failed")
        err_msg = str(detail.get("error") or reason)
        errors = [{"path": "", "kind": "diff_apply", "message": err_msg[:400]}]
    feedback = format_static_errors_for_prompt(errors)
    if not feedback and status == "failed":
        feedback = (
            "Static preverify failed — "
            f"{detail.get('reason') or 'diff_apply_or_syntax_failed'}"
        )
    return {
        "status": status,
        "reason": detail.get("reason") or status,
        "errors": errors,
        "feedback": feedback,
        "static_check": static,
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
        persist: bool = True,
        static_feedback: str = "",
    ) -> dict[str, Any]:
        """Generate a real unified diff via T2 with style + KG context.

        ``provider`` is the :class:`RepoProvider` — used by the
        style/PR learners if they need to refresh their profiles.
        ``linked_files`` is the source the patch should modify
        (the rca_linker output). ``test_plan`` is the list of
        tests the patch must satisfy.

        ``persist`` controls ``proposed_patches`` writes:

        * ``True`` (default) — legacy Cat 23 path; insert row
          after gates pass.
        * ``False`` — N23/improvement path; return diff in the
          envelope only; caller writes ``improvement_plans``.

        ``static_feedback`` seeds the first attempt with prior free
        static-preverify errors (approve-time regenerate path).

        Pipeline (Phase 3b): generate → critic → static preverify →
        size check → similarity dedup → quality floor → persist.
        Each rejected gate returns an envelope that names the
        gate so the caller knows what to do next.
        """
        # Fast-skip: if no LLM provider is configured, skip
        # the entire pipeline without spinning up ModelRouter
        # (which alone imports ~1s of eden.config + eden.llm.client).
        # We check the standard env vars that ``ModelRouter`` looks
        # at so this stays in sync with the production config.
        if self._router is None and not _has_llm_credentials():
            return _not_implemented_envelope(
                self.name,
                message=(
                    "No LLM provider is configured (set "
                    "OPENROUTER_API_KEY / OPENAI_API_KEY / "
                    "ANTHROPIC_API_KEY to enable patch generation)."
                ),
                gate="router_missing",
                data={
                    "4a_blocked_alias": True,
                    "patch_id": _new_id("patch"),
                    "router_missing": True,
                },
            )

        # Fall back to the platform's default router if none was
        # injected. The endpoint always runs the full pipeline; only
        # catastrophic config errors (no router at all) return a
        # ``not_implemented`` envelope (legacy Gate-4a-blanked
        # behaviour).
        if self._router is None:
            try:
                # Lazy import — see module-level __getattr__.
                from eden.optimization.model_router import ModelRouter
                self._router = ModelRouter()
            except Exception as exc:
                # Audit 2026-07-02 — router_missing is functionally
                # the same as "no LLM available"; we surface it as a
                # not_implemented envelope so the portal can show
                # "preview / pending infrastructure" rather than a
                # hard error.
                return _not_implemented_envelope(
                    self.name,
                    message=(
                        f"Patch generation requires a ModelRouter. "
                        f"No router was injected and the default "
                        f"router failed to initialise: {exc}"
                    ),
                    gate="router_missing",
                    data={
                        "4a_blocked_alias": True,
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

        system_prompt, prompt = _build_patch_prompt(
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
        if (static_feedback or "").strip():
            prompt = (
                prompt
                + "\n\n## Static preverify feedback (must address)\n"
                + static_feedback.strip()
            )

        # Lazy import — see module-level __getattr__.
        from eden.optimization.model_router import PipelineTask
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
        from eden.improvement.sweep_budget import try_consume_llm_call
        from eden.patches._common import DEFAULT_POLICY

        settings = get_settings()
        soft_cap = settings.patch_max_diff_lines_soft
        hard_cap = settings.patch_max_diff_lines_hard
        dedup_threshold = settings.patch_similarity_threshold
        dedup_lookback_days = settings.patch_similarity_lookback_days
        quality_floor = settings.patch_quality_floor
        max_cost_per_patch = float(
            DEFAULT_POLICY.get("max_cost_per_patch_usd") or 5.0
        )
        # M4 (D13): the critic fails closed on every path — the old
        # ``critic_fail_closed = not persist`` carve-out let the legacy
        # persist path ship diffs the critic never approved.

        # ── Generate → critic → static preverify loop (max 2) ──────
        diff = ""
        cost_usd = 0.0
        # Placeholder until the first routed response reports its real
        # model id (internal chat SSOT — see eden.llm.models).
        model_used = "deepseek/deepseek-v4-flash-0731"
        critic_verdict: dict[str, Any] | None = None
        static_preverify: dict[str, Any] | None = None
        critic_attempts = 0
        last_response_content = ""
        for attempt in range(2):
            if cost_usd >= max_cost_per_patch:
                return _ok_envelope(
                    self.name,
                    {
                        "rca_id": rca_id,
                        "trace_id": trace_id,
                        "repo_id": repo_id,
                        "diff": "",
                        "model_used": model_used,
                        "cost_usd": cost_usd,
                        "status": "low_quality",
                        "reason": (
                            f"max_cost_per_patch_usd exceeded "
                            f"({cost_usd:.4f}>={max_cost_per_patch})"
                        ),
                        "critic_verdict": critic_verdict or {},
                        "static_preverify": static_preverify or {},
                        "attempts": critic_attempts,
                    },
                )
            if not try_consume_llm_call():
                return _ok_envelope(
                    self.name,
                    {
                        "rca_id": rca_id,
                        "trace_id": trace_id,
                        "repo_id": repo_id,
                        "diff": "",
                        "model_used": model_used,
                        "cost_usd": cost_usd,
                        "status": "low_quality",
                        "reason": "llm_budget_exhausted",
                        "critic_verdict": critic_verdict or {},
                        "static_preverify": static_preverify or {},
                        "attempts": critic_attempts,
                    },
                )
            try:
                response = await self._router.aroute(
                    task,
                    prompt,
                    system_prompt=system_prompt,
                    org_id=org_id,
                    user_id=None,
                    max_tokens=4096,
                )
            except Exception as exc:
                # Audit 2026-07-02 — LLM-tier exhaustion (auth, network,
                # rate-limit) is functionally the same as "no model
                # available". Surface as a not_implemented envelope so
                # the portal renders the legacy Gate-4a-blanked badge
                # rather than a hard error.
                return _not_implemented_envelope(
                    self.name,
                    message=f"LLM call failed for {rca_id}: {exc}",
                    gate="4a_blocked",
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
            if cost_usd >= max_cost_per_patch:
                return _ok_envelope(
                    self.name,
                    {
                        "rca_id": rca_id,
                        "trace_id": trace_id,
                        "repo_id": repo_id,
                        "diff": candidate if _is_valid_diff(candidate) else "",
                        "model_used": model_used,
                        "cost_usd": cost_usd,
                        "status": "low_quality",
                        "reason": (
                            f"max_cost_per_patch_usd exceeded "
                            f"({cost_usd:.4f}>={max_cost_per_patch})"
                        ),
                        "static_preverify": static_preverify or {},
                        "attempts": critic_attempts,
                    },
                )
            if not _is_valid_diff(candidate):
                critic_attempts += 1
                continue
            critic_verdict = await _critic_review(
                self._router,
                candidate,
                rca_summary=rca_summary,
            )
            cost_usd += float(critic_verdict.get("cost_usd") or 0.0)
            critic_attempts += 1
            if not critic_verdict.get("passed"):
                # Critic rejected. Inject the reason into the prompt and
                # retry once. If still rejected, leave diff empty so the
                # caller gets a low_quality envelope.
                if attempt == 0 and critic_verdict.get("reason") != "critic_error":
                    prompt = (
                        prompt
                        + "\n\n## Critic feedback (must address)\n"
                        + str(critic_verdict.get("reason", ""))
                    )
                    continue
                diff = ""  # M4 (D13): unreviewed diffs never continue.
                break

            # Critic passed — free static preverify (apply + syntax).
            static_preverify = await _run_static_preverify(
                candidate, linked_files or []
            )
            if static_preverify.get("status") == "failed":
                feedback = str(static_preverify.get("feedback") or "")
                if attempt == 0 and feedback:
                    prompt = (
                        prompt
                        + "\n\n## Static preverify feedback (must address)\n"
                        + feedback
                    )
                    continue
                # Exhausted retries with static still failing — the
                # candidate is suppressed on every path (M4, D13).
                diff = ""
                break

            diff = candidate
            break

        if critic_verdict and not critic_verdict.get("passed"):
            return _ok_envelope(
                self.name,
                {
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                    "diff": "",
                    "model_used": model_used,
                    "cost_usd": cost_usd,
                    "status": "low_quality",
                    "reason": str(critic_verdict.get("reason") or "critic_failed"),
                    "critic_verdict": critic_verdict,
                    "static_preverify": static_preverify or {},
                    "attempts": critic_attempts,
                },
            )

        if (
            static_preverify
            and static_preverify.get("status") == "failed"
            and not diff
        ):
            return _ok_envelope(
                self.name,
                {
                    "rca_id": rca_id,
                    "trace_id": trace_id,
                    "repo_id": repo_id,
                    "diff": "",
                    "model_used": model_used,
                    "cost_usd": cost_usd,
                    "status": "low_quality",
                    "reason": "static_preverify_failed",
                    "critic_verdict": critic_verdict or {},
                    "static_preverify": static_preverify,
                    "attempts": critic_attempts,
                },
            )

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
                    "static_preverify": static_preverify or {},
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
        patch_status = "low_quality" if initial_quality < quality_floor else "proposed"

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

        # Persist to proposed_patches (N23 callers may skip via persist=False).
        if persist:
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
                        "",
                        diff,
                        description,
                        explanation,
                        json.dumps(test_plan or []),
                        0.0,
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
                "static_preverify": static_preverify or {},
            },
        )

        # Gate 5 wiring (legacy persist=True only): record the
        # patch outcome in the CodebaseKnowledgeGraph so future
        # PatchGenerator calls can read the history. N23 callers
        # pass persist=False and skip both proposed_patches and
        # KG writes. Best-effort — a graph write failure doesn't
        # fail the patch generation.
        if persist and patch_status == "proposed" and metrics["files"]:
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
