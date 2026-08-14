"""Issue → improvement_plan trigger (N20 / N23).

Fingerprint ≥5× → value gates → N22 → PatchGenerator → improvement_plans.
Portal fix-chat is deleted — this is the only issue→code path.
"""

from __future__ import annotations

import contextlib
import logging
from typing import Any

from eden.improvement import plans_repo

logger = logging.getLogger(__name__)

_MIN_FINGERPRINT_COUNT = 5
_MIN_TRIAGE_CONFIDENCE = 0.65
_CODE_ACTIONS = frozenset({"code_change", "propose_patch"})
_SEVERITY_RANK = {
    "critical": 4,
    "p0": 4,
    "high": 3,
    "p1": 3,
    "medium": 2,
    "p2": 2,
    "low": 1,
    "p3": 1,
    "info": 0,
}
_SEVERITY_NORMALIZE = {
    "p0": "critical",
    "critical": "critical",
    "p1": "high",
    "high": "high",
    "p2": "medium",
    "medium": "medium",
    "p3": "low",
    "low": "low",
    "info": "info",
}


def _improvement_enabled_sync() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "improvement_agent_v1", False))
    except Exception:
        return False


async def _improvement_enabled(org_id: str) -> bool:
    try:
        from eden.preview.gates import improvement_agent_enabled

        return await improvement_agent_enabled(org_id)
    except Exception:
        return _improvement_enabled_sync()


def _min_fingerprint_count() -> int:
    try:
        from eden.config import get_settings

        configured = int(getattr(get_settings(), "patch_cluster_min_size", 5) or 5)
    except Exception:
        configured = 5
    return max(_MIN_FINGERPRINT_COUNT, configured)


def _min_confidence() -> float:
    try:
        from eden.config import get_settings

        return float(
            getattr(get_settings(), "patch_min_triage_confidence", _MIN_TRIAGE_CONFIDENCE)
            or _MIN_TRIAGE_CONFIDENCE
        )
    except Exception:
        return _MIN_TRIAGE_CONFIDENCE


def normalize_severity(raw: str | None) -> str:
    key = (raw or "medium").lower().strip()
    return _SEVERITY_NORMALIZE.get(key, "medium" if key not in _SEVERITY_RANK else key)


def severity_meets_floor(raw: str | None, *, floor: str = "medium") -> bool:
    return _SEVERITY_RANK.get(normalize_severity(raw), 0) >= _SEVERITY_RANK.get(
        normalize_severity(floor), 2
    )


def _recommended_action(triage: dict[str, Any]) -> str | None:
    action = triage.get("recommended_action") or triage.get("recommended")
    if action is None:
        return None
    return str(action).strip().lower() or None


async def _issue_context(org_id: str, issue_id: str) -> dict[str, Any] | None:
    try:
        from eden.issues.repo import IssuesRepo

        issue = await IssuesRepo().get_issue(org_id, issue_id)
    except Exception as exc:
        logger.debug("issue_patch_trigger: load issue failed: %s", exc)
        return None
    if issue is None:
        return None
    triage = issue.triage_result or {}
    summary = triage.get("summary") or triage.get("root_cause") or issue.title
    return {
        "issue": issue,
        "agent_id": issue.agent_id or "",
        "kind": issue.kind,
        "fingerprint": issue.fingerprint,
        "triage": triage,
        "rca_summary": (
            f"Issue {issue.fingerprint} ({issue.kind}): {issue.title}. "
            f"Root-cause: {summary}. Seen {issue.stumble_count}x across "
            f"{issue.user_count} user(s)."
        ),
    }


async def _find_open_plan(org_id: str, fingerprint: str) -> dict[str, Any] | None:
    return await plans_repo.find_blocking_by_fingerprint(org_id, fingerprint)


async def build_candidate_from_issue(org_id: str, issue: Any) -> Any | None:
    """Cheap rank candidate — never persisted as empty code_patch."""
    from eden.improvement.planner import PlanCandidate

    triage = issue.triage_result or {}
    sev = normalize_severity(issue.severity)
    fp = f"issue:{issue.id}"
    conf = float(triage.get("confidence", 0.0) or 0.0)
    stumble = int(getattr(issue, "stumble_count", 0) or 0)
    return PlanCandidate(
        plan_kind="code_patch",
        title=issue.title or issue.fingerprint,
        source_ref=fp,
        source_fingerprint=fp,
        agent_id=issue.agent_id,
        summary=triage.get("summary"),
        evidence={
            "issue_id": issue.id,
            "fingerprint": issue.fingerprint,
            "severity": sev,
            "confidence": conf,
            "stumble_count": stumble,
            "recommended_action": _recommended_action(triage),
        },
        triage_snapshot=triage,
        severity=sev,
        confidence=conf,
    )


def issue_passes_cheap_gates(issue: Any) -> tuple[bool, str]:
    """Pre-LLM value funnel (DB fields only)."""
    triage = getattr(issue, "triage_result", None) or {}
    stumble = int(getattr(issue, "stumble_count", 0) or 0)
    min_count = _min_fingerprint_count()
    if stumble < min_count:
        return False, "fingerprint_below_threshold"
    if not severity_meets_floor(getattr(issue, "severity", None)):
        return False, "severity_below_floor"
    conf = float(triage.get("confidence", 0.0) or 0.0)
    if conf < _min_confidence():
        return False, "confidence_below_floor"
    action = _recommended_action(triage)
    if action not in _CODE_ACTIONS:
        return False, "recommended_action_not_code"
    return True, "ok"


def _plan_payload_from_patch(
    org_id: str,
    issue_id: str,
    ctx: dict[str, Any],
    patch_data: dict[str, Any],
    *,
    run_id: str | None = None,
    failure_pack: dict[str, Any] | None = None,
    hermetic_preverify: dict[str, Any] | None = None,
    example_trace_ids: list[str] | None = None,
    replay: dict[str, Any] | None = None,
    sandbox_tests: dict[str, Any] | None = None,
) -> dict[str, Any]:
    issue = ctx["issue"]
    triage = ctx.get("triage") or {}
    files = patch_data.get("files") or []
    sev = normalize_severity(issue.severity)
    pack = failure_pack or {}
    # Evidence tier ladder (§4.1/§4.2): "tested" only when the M8
    # sandbox test gate actually passed; else "replay" only when replay
    # actually passed; else this plan carries static evidence only.
    if (sandbox_tests or {}).get("status") == "passed":
        evidence_tier = "tested"
    elif (replay or {}).get("status") == "passed":
        evidence_tier = "replay"
    else:
        evidence_tier = "static"
    # NOTE (M3, D28): no ``org_id`` key here — the payload is splatted
    # into ``plans_repo.create_plan(org_id, **payload)``, which takes
    # org_id positionally; a duplicate key is a TypeError.
    return {
        "run_id": run_id,
        "plan_kind": "code_patch",
        "title": patch_data.get("description") or issue.title,
        "agent_id": ctx.get("agent_id") or None,
        "summary": patch_data.get("explanation"),
        "source_ref": f"issue:{issue_id}",
        "source_fingerprint": f"issue:{issue_id}",
        "diff_unified": patch_data.get("diff"),
        "files_changed": files,
        "evidence": {
            "issue_id": issue_id,
            "patch_id": patch_data.get("patch_id"),
            "severity": sev,
            "confidence": float(triage.get("confidence", 0.0) or 0.0),
            "stumble_count": int(getattr(issue, "stumble_count", 0) or 0),
            "example_trace_ids": list(example_trace_ids or pack.get("example_trace_ids") or []),
            "failure_pack_format": pack.get("format"),
            "failure_pack_status": pack.get("status"),
            # M7 (§4.1): honest label — success is "static_passed"
            # (readers accept legacy "passed" too).
            "hermetic_preverify": hermetic_preverify,
            "evidence_tier": evidence_tier,
            "replay": replay,
            # M8 (§4.2): targeted sandbox test summary — carries
            # ``synthesized: true`` when the test was LLM-written
            # (PR-body annotation lands in M9).
            "sandbox_tests": sandbox_tests,
            "failure_signature": pack.get("failure_signature"),
        },
        "triage_snapshot": triage,
        "llm_cost_usd": float(patch_data.get("cost_usd") or 0),
    }


async def _n22_may_propose(org_id: str, agent_id: str | None) -> tuple[bool, str]:
    try:
        from eden.closed_loop.autonomy_policy import audit, decide, resolve

        policy = await resolve(org_id, agent_id)
        verdict, reason, tier = decide(policy, "propose_patch")
        await audit(
            org_id,
            agent_id=agent_id,
            action="propose_patch",
            tier=tier or "auto_code_patch_pr",
            decision=verdict,
            reason=reason or "",
        )
        if verdict == "deny":
            return False, reason or "n22_deny"
        return True, reason or "ok"
    except Exception as exc:
        logger.debug("issue_patch_trigger: n22 check failed: %s", exc)
        return False, f"n22_unavailable:{exc}"


async def _budget_ok(org_id: str) -> tuple[bool, str]:
    """M4 (D12): single budget ledger — ``autonomy_policy.check_budget``
    (the Redis ``autonomy:spend:`` counter every ``record_spend`` writer
    feeds) + ``patch_max_per_day``. The parallel ``cost_ledger`` read is
    gone; a broken budget check FAILS CLOSED (``budget_check_error``) —
    the caller stamps the blocker on the issue."""
    try:
        from eden.closed_loop.autonomy_policy import check_budget
        from eden.config import get_settings

        ok, spent, limit = await check_budget(org_id)
        if not ok:
            return False, f"budget_exhausted:{spent:.2f}>={limit:.2f}"

        day_cap = int(getattr(get_settings(), "patch_max_per_day", 10) or 10)
        if day_cap > 0:
            used = await plans_repo.count_code_patches_today(org_id)
            if used >= day_cap:
                return False, f"patch_max_per_day:{used}>={day_cap}"
    except Exception as exc:
        logger.warning(
            "issue_patch_trigger: budget check failed (fail closed): %s", exc
        )
        return False, "budget_check_error"

    return True, "ok"


async def propose_plan_for_issue(
    org_id: str,
    issue_id: str,
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Generate patch + return plan payload (N20 inbox). Never raises."""
    if not await _improvement_enabled(org_id):
        return {"status": "disabled", "reason": "improvement_agent_v1=false"}

    ctx = await _issue_context(org_id, issue_id)
    if ctx is None:
        return {"status": "not_found", "reason": f"issue {issue_id!r} not found"}

    issue = ctx["issue"]
    ok, gate_reason = issue_passes_cheap_gates(issue)
    if not ok:
        return {
            "status": "suppressed",
            "reason": gate_reason,
            "stumble_count": int(getattr(issue, "stumble_count", 0) or 0),
            "min_required": _min_fingerprint_count(),
            "issue_id": issue_id,
        }

    stumble_count = int(getattr(issue, "stumble_count", 0) or 0)

    allowed, n22_reason = await _n22_may_propose(org_id, ctx.get("agent_id") or None)
    if not allowed:
        return {
            "status": "denied",
            "reason": n22_reason,
            "issue_id": issue_id,
        }

    budget_ok, budget_reason = await _budget_ok(org_id)
    if not budget_ok:
        if budget_reason == "budget_check_error":
            # M4 (D12): a broken budget check fails closed — stamp the
            # blocker so the portal shows *why* no fix appeared.
            await _stamp_patch_blocked(
                org_id,
                issue_id,
                reason="budget_check_error",
                message=(
                    "Budget check failed — patch generation suppressed "
                    "(fail closed)"
                ),
            )
        return {
            "status": "suppressed",
            "reason": budget_reason,
            "issue_id": issue_id,
        }

    fp = f"issue:{issue_id}"
    existing = await _find_open_plan(org_id, fp)
    if existing is not None:
        return {
            "status": "suppressed",
            "reason": "duplicate_open_plan",
            "plan_id": existing.get("id"),
            "issue_id": issue_id,
        }

    rejected = await plans_repo.is_rejection_active(
        org_id,
        title=issue.title or issue.fingerprint,
        fingerprint=fp,
        file_paths=[fp, str(issue.fingerprint or "")],
    )
    if rejected:
        return {
            "status": "suppressed",
            "reason": "rejection_memory",
            "issue_id": issue_id,
        }

    rca_id = f"iss_{issue_id}"
    try:
        from eden.closed_loop.efficiency import AgentEfficiencyController

        allowed, reason = await AgentEfficiencyController().should_run_patch(
            org_id, issue_id, rca_id=rca_id
        )
        if not allowed:
            return {
                "status": "suppressed",
                "reason": reason,
                "plan_id": None,
                "issue_id": issue_id,
            }
    except Exception as exc:
        logger.debug("issue_patch_trigger: efficiency check failed: %s", exc)

    # Resolve this agent's linked repo (one repo per agent).
    issue_agent_id = (ctx.get("agent_id") or "").strip() or None
    repo_id = await _resolve_repo_id(org_id, agent_id=issue_agent_id)
    if not repo_id:
        # Soft Autonomy Phase 3: never fail silently. Stamp the issue so
        # the portal can render a "Connect GitHub" state instead of the
        # fix PR just never appearing.
        await _stamp_patch_blocked(
            org_id,
            issue_id,
            reason="repo_not_connected",
            message="Connect a GitHub repo for this agent so Eden can open fix PRs",
        )
        return {
            "status": "error",
            "reason": "repo_not_connected",
            "issue_id": issue_id,
            "message": "Connect a GitHub repo for this agent so Eden can open fix PRs",
        }

    linked_files = await _linked_files(
        org_id, rca_id, ctx, repo_id=repo_id, agent_id=issue_agent_id
    )
    if not linked_files:
        return {
            "status": "suppressed",
            "reason": "no_linked_files",
            "issue_id": issue_id,
        }

    linked_paths = [str(f.get("path") or "") for f in linked_files if f.get("path")]
    rejected = await plans_repo.is_rejection_active(
        org_id,
        title=issue.title or issue.fingerprint,
        fingerprint=fp,
        file_paths=linked_paths + [fp],
    )
    if rejected:
        return {
            "status": "suppressed",
            "reason": "rejection_memory",
            "issue_id": issue_id,
        }

    # Phase 1 — bind redacted failure pack + real example traces.
    from eden.improvement.evidence_plane import (
        build_failure_pack,
        run_hermetic_preverify,
    )

    failure_pack: dict[str, Any] = {}
    try:
        failure_pack = await build_failure_pack(org_id, issue_id)
    except Exception as exc:
        logger.debug("issue_patch_trigger: failure_pack failed: %s", exc)
        failure_pack = {"status": "error", "example_trace_ids": [], "excerpt": ""}

    example_trace_ids = list(failure_pack.get("example_trace_ids") or [])
    linker_trace = None
    try:
        linker_inputs = await _extract_linker_inputs(org_id, ctx)
        linker_trace = linker_inputs.get("trace_id")
    except Exception:
        linker_trace = None
    if linker_trace and linker_trace not in example_trace_ids:
        example_trace_ids = [str(linker_trace), *example_trace_ids][:5]

    rca_summary = ctx["rca_summary"]
    excerpt = (failure_pack.get("excerpt") or "").strip()
    if excerpt:
        rca_summary = f"{rca_summary}\n\n## Failure pack\n{excerpt}"

    # Prefer a real production trace id for the generator; never invent iss_*.
    generator_trace_id = (
        example_trace_ids[0] if example_trace_ids else f"unknown_trace:{issue_id}"
    )

    try:
        from eden.patches.patch_generator import PatchGenerator

        result = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=rca_id,
            trace_id=generator_trace_id,
            repo_id=repo_id,
            rca_summary=rca_summary,
            test_plan=[],
            linked_files=linked_files,
            persist=False,
        )
    except Exception as exc:
        logger.warning("issue_patch_trigger: generate failed: %s", exc)
        return {"status": "error", "reason": str(exc)}

    data = result.get("data", {}) if isinstance(result, dict) else {}
    status = data.get("status") or "proposed"
    # Never inbox: empty / investigation / dedup / low_quality / critic fail
    if status in ("deduplicated", "investigation", "low_quality"):
        return {
            "status": "suppressed",
            "reason": status,
            "issue_id": issue_id,
        }
    critic = data.get("critic_verdict") or {}
    if critic and critic.get("passed") is False:
        return {
            "status": "suppressed",
            "reason": "critic_failed",
            "issue_id": issue_id,
        }
    if critic.get("reason") == "critic_error":
        return {
            "status": "suppressed",
            "reason": "critic_failed",
            "issue_id": issue_id,
        }
    if not data.get("diff"):
        return {"status": "error", "reason": "empty_diff", "issue_id": issue_id}

    # Phase 2 — hermetic/fixture smoke on bound traces (quiet-window stays on approve).
    hermetic_preverify: dict[str, Any] = {}
    try:
        hermetic_preverify = await run_hermetic_preverify(
            org_id,
            issue_id,
            example_trace_ids=example_trace_ids,
            fingerprint=str(getattr(issue, "fingerprint", "") or ""),
            diff_unified=str(data.get("diff") or ""),
            linked_files=linked_files,
        )
    except Exception as exc:
        logger.debug("issue_patch_trigger: hermetic preverify failed: %s", exc)
        hermetic_preverify = {
            "status": "skipped",
            "detail": {"reason": str(exc)[:240]},
        }

    # Hard gate: failed apply/syntax must not enter the Improve inbox.
    # PatchGenerator already retried; this is the final belt.
    if hermetic_preverify.get("status") == "failed":
        return {
            "status": "suppressed",
            "reason": "static_preverify_failed",
            "issue_id": issue_id,
            "hermetic_preverify": hermetic_preverify.get("status"),
            "hermetic_detail": hermetic_preverify.get("detail") or {},
        }

    # M7 (§4.1) — replay-before-PR: signature-based check of the patched
    # context on checkpointed example traces. "failed" gates like a
    # static failure; every "skipped" is allowed through, labeled.
    replay_summary: dict[str, Any] = {"status": "skipped", "reason": "replay_error"}
    try:
        from eden.improvement.replay_verify import run_replay_verify

        replay_result = await run_replay_verify(
            org_id,
            issue_id,
            str(data.get("diff") or ""),
            linked_files,
            failure_pack,
        )
        replay_summary = replay_result.to_json()
    except Exception as exc:
        logger.debug("issue_patch_trigger: replay verify failed: %s", exc)
        replay_summary = {
            "status": "skipped",
            "reason": "replay_error",
            "error": str(exc)[:200],
        }

    if replay_summary.get("status") == "failed":
        # Same stamp path as a static failure: the portal must show why
        # no fix appeared instead of the plan silently not existing.
        await _stamp_patch_blocked(
            org_id,
            issue_id,
            reason="replay_failed",
            message=(
                "Replay verify: the failure signature is still present "
                "after applying the patch — plan suppressed"
            ),
        )
        return {
            "status": "suppressed",
            "reason": "replay_failed",
            "issue_id": issue_id,
            "replay": replay_summary,
        }

    # M8 (§4.2) — sandbox test gate: run convention-discovered targeted
    # tests on the patched files. "failed" earns exactly one regenerate
    # with the failure excerpt on the PatchGenerator static_feedback
    # channel; still failing → suppress. Every "skipped" is allowed
    # through, labeled. "passed" upgrades the evidence tier to "tested".
    test_gate_summary = await _run_sandbox_test_gate(
        org_id,
        repo_id,
        str(data.get("diff") or ""),
        linked_files,
        agent_id=issue_agent_id,
    )
    if test_gate_summary.get("status") == "failed":
        data, test_gate_summary, regen_ok = await _regenerate_after_test_failure(
            org_id,
            rca_id=rca_id,
            trace_id=generator_trace_id,
            repo_id=repo_id,
            rca_summary=rca_summary,
            linked_files=linked_files,
            agent_id=issue_agent_id,
            data=data,
            test_gate_summary=test_gate_summary,
        )
        if not regen_ok:
            await _stamp_patch_blocked(
                org_id,
                issue_id,
                reason="test_gate_failed",
                message=(
                    "Sandbox test gate: targeted tests still failing "
                    "after one regenerate — plan suppressed"
                ),
            )
            return {
                "status": "suppressed",
                "reason": "test_gate_failed",
                "issue_id": issue_id,
                "sandbox_tests": test_gate_summary,
            }

    payload = _plan_payload_from_patch(
        org_id,
        issue_id,
        ctx,
        data,
        run_id=run_id,
        failure_pack=failure_pack,
        hermetic_preverify=hermetic_preverify,
        example_trace_ids=example_trace_ids,
        replay=replay_summary,
        sandbox_tests=test_gate_summary,
    )
    plan = await plans_repo.create_plan(org_id, **payload)
    if plan is None:
        return {"status": "error", "reason": "persist_failed", "issue_id": issue_id}

    # Soft Autonomy Phase 6: a drafted plan IS the approval request —
    # alert the agent's Slack channel with a deep link to the plan.
    try:
        from eden.services.slack_notify import notify_needs_approval

        await notify_needs_approval(
            org_id,
            plan_id=str(plan["id"]),
            title=str(plan.get("title") or payload.get("title") or "Improvement plan"),
            kind=str(payload.get("plan_kind") or "code_patch"),
            agent_id=(ctx.get("agent_id") or "").strip() or None,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("issue_patch_trigger: slack needs_approval notify failed: %s", exc)

    cost = float(data.get("cost_usd") or payload.get("llm_cost_usd") or 0)
    if cost > 0:
        try:
            from eden.closed_loop.autonomy_policy import record_spend

            await record_spend(
                org_id,
                cost,
                feature="patches",
                model=str(data.get("model_used") or "patch_generator"),
                agent_id=ctx.get("agent_id") or None,
                metadata={"issue_id": issue_id, "plan_id": plan["id"]},
            )
        except Exception as exc:
            logger.debug("issue_patch_trigger: record_spend failed: %s", exc)

    return {
        "status": "proposed",
        "plan_id": plan["id"],
        "plan": plan,
        "issue_id": issue_id,
        "linked_files_count": len(linked_files),
        "linked_files_with_content": sum(
            1 for f in linked_files if (f.get("content") or "").strip()
        ),
        "example_trace_ids": example_trace_ids,
        "hermetic_preverify": hermetic_preverify.get("status"),
        "replay": replay_summary.get("status"),
        "sandbox_tests": test_gate_summary.get("status"),
        "evidence_tier": (payload.get("evidence") or {}).get("evidence_tier"),
        "stumble_count": stumble_count,
    }


async def _run_sandbox_test_gate(
    org_id: str,
    repo_id: str | None,
    diff: str,
    linked_files: list[dict[str, str]],
    *,
    agent_id: str | None,
) -> dict[str, Any]:
    """M8 (§4.2): one guarded test-gate run. Never raises."""
    try:
        from eden.improvement.test_gate import run_test_gate

        provider = None
        try:
            from eden.providers.factory import get_repo_provider_for_org

            provider = await get_repo_provider_for_org(org_id, agent_id=agent_id)
        except Exception as exc:
            logger.debug("issue_patch_trigger: repo provider unavailable: %s", exc)
        result = await run_test_gate(
            org_id,
            str(repo_id or ""),
            diff,
            linked_files,
            provider=provider,
            base_files=linked_files,
        )
        return result.to_json()
    except Exception as exc:
        logger.debug("issue_patch_trigger: test gate failed: %s", exc)
        return {
            "status": "skipped",
            "reason": "test_gate_error",
            "error": str(exc)[:200],
        }


async def _regenerate_after_test_failure(
    org_id: str,
    *,
    rca_id: str,
    trace_id: str,
    repo_id: str | None,
    rca_summary: str,
    linked_files: list[dict[str, str]],
    agent_id: str | None,
    data: dict[str, Any],
    test_gate_summary: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], bool]:
    """One regenerate with the test failure as static feedback (§4.2).

    Mirrors the static-preverify regenerate pattern: the failure
    excerpt rides the ``static_feedback`` channel (origin marked
    ``test_gate``) and the new candidate is re-gated. Returns
    ``(data, test_gate_summary, ok)`` — ``ok=False`` means suppress.
    """
    tests_run = ", ".join(test_gate_summary.get("tests_run") or []) or "(unknown)"
    excerpt = str(test_gate_summary.get("output_excerpt") or "")[:2000]
    feedback = (
        f"[origin: test_gate] Sandbox test gate: targeted tests failed "
        f"({tests_run}). Fix the diff so these tests pass.\n{excerpt}"
    )
    try:
        from eden.patches.patch_generator import PatchGenerator

        if not repo_id:
            return data, test_gate_summary, False
        regen = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=rca_id,
            trace_id=trace_id,
            repo_id=repo_id,
            rca_summary=rca_summary,
            test_plan=[],
            linked_files=linked_files,
            persist=False,
            static_feedback=feedback,
        )
    except Exception as exc:
        logger.debug("issue_patch_trigger: test-gate regenerate failed: %s", exc)
        return data, test_gate_summary, False
    regen_data = (regen or {}).get("data") or {}
    if regen_data.get("status") != "proposed" or not regen_data.get("diff"):
        return data, test_gate_summary, False
    retry_summary = await _run_sandbox_test_gate(
        org_id,
        repo_id,
        str(regen_data.get("diff") or ""),
        linked_files,
        agent_id=agent_id,
    )
    retry_summary["regenerated"] = True
    if retry_summary.get("status") == "failed":
        return data, retry_summary, False
    # Fold the first attempt's cost into the accepted candidate.
    with contextlib.suppress(TypeError, ValueError):
        regen_data["cost_usd"] = float(regen_data.get("cost_usd") or 0.0) + float(
            data.get("cost_usd") or 0.0
        )
    return regen_data, retry_summary, True


async def _stamp_patch_blocked(
    org_id: str,
    issue_id: str,
    *,
    reason: str,
    message: str,
) -> None:
    """Best-effort: record on the issue why Eden could not draft a fix PR.

    Merges ``patch_blocked`` into the existing ``triage_result`` so the
    portal Issues page can surface the blocker (e.g. "Connect GitHub")
    instead of the fix silently never appearing.
    """
    try:
        from eden.issues.repo import IssuesRepo

        repo = IssuesRepo()
        issue = await repo.get_issue(org_id, issue_id)
        if issue is None:
            return
        triage = dict(issue.triage_result or {})
        triage["patch_blocked"] = {
            "reason": reason,
            "message": message,
        }
        await repo.set_triage_result(org_id, issue_id, triage)
    except Exception as exc:
        logger.debug("issue_patch_trigger: stamp patch_blocked failed: %s", exc)


#: Public export (M3, D3): the orchestrator stamps patch-request failures
#: through this seam so the portal shows why no plan appeared.
stamp_patch_blocked = _stamp_patch_blocked


async def _resolve_repo_id(
    org_id: str,
    *,
    agent_id: str | None = None,
) -> str | None:
    """Return the active repo_connections id for this org/agent, else None.

    Uses ``agent_id`` to pick that agent's linked repo (one repo per agent).
    """
    from eden.providers.factory import resolve_active_repo_id

    return await resolve_active_repo_id(org_id, agent_id=agent_id)


async def _linked_files(
    org_id: str,
    rca_id: str,
    ctx: dict[str, Any],
    *,
    repo_id: str,
    agent_id: str | None = None,
) -> list[dict[str, str]]:
    """Resolve linked files via RCA linker, then hydrate source via RepoProvider."""
    from eden.improvement.evidence_plane import hydrate_linked_files
    from eden.patches.rca_linker import CodeRootCauseLinker, _stack_trace_files

    inputs = await _extract_linker_inputs(org_id, ctx)
    linked: list[dict[str, str]] = []

    if inputs["stack_trace"]:
        try:
            for path, _conf in _stack_trace_files(inputs["stack_trace"]):
                linked.append({"path": path, "content": ""})
        except Exception as exc:
            logger.debug("issue_patch_trigger: stack parse failed: %s", exc)

    try:
        linker = CodeRootCauseLinker(router=None, repo_connector=None)
        link_result = await linker.link(
            org_id=org_id,
            rca_id=rca_id,
            repo_id=repo_id,
            rca_description=ctx.get("rca_summary") or "",
            stack_trace=inputs["stack_trace"],
            request_path=inputs["request_path"],
            trace_id=inputs["trace_id"],
            candidate_files=inputs["candidate_files"],
        )
        data = (link_result or {}).get("data") or {}
        primary = data.get("primary_path")
        if primary:
            linked.append({"path": str(primary), "content": ""})
        for item in data.get("links") or []:
            if isinstance(item, dict) and item.get("path"):
                linked.append({"path": str(item["path"]), "content": ""})
    except Exception as exc:
        logger.debug("issue_patch_trigger: rca_linker failed: %s", exc)

    for path in inputs["candidate_files"]:
        linked.append({"path": path, "content": ""})

    seen: set[str] = set()
    path_shells: list[dict[str, str]] = []
    for item in linked:
        path = item.get("path") or ""
        if path and path not in seen:
            seen.add(path)
            path_shells.append({"path": path, "content": item.get("content") or ""})

    hydrated = await hydrate_linked_files(
        org_id, path_shells, agent_id=agent_id or (ctx.get("agent_id") or None)
    )
    # Prefer hydrated (non-empty) content; fall back to path shells so
    # callers that only need paths still see candidates when the repo
    # is unreachable — PatchGenerator will omit empty content sections.
    if hydrated:
        return hydrated
    return path_shells


def _stack_trace_from_detail(detail: dict[str, Any] | None) -> str | None:
    if not isinstance(detail, dict):
        return None
    for key in ("stack_trace", "stacktrace", "traceback", "exc_info"):
        val = detail.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return None


async def _extract_linker_inputs(org_id: str, ctx: dict[str, Any]) -> dict[str, Any]:
    triage = ctx.get("triage") or {}
    stack_trace = _stack_trace_from_detail(triage)
    if not stack_trace:
        stack_trace = _stack_trace_from_detail(triage.get("evidence"))

    candidate_files: list[str] = []
    for key in ("candidate_files", "linked_files", "files"):
        raw = triage.get(key)
        if isinstance(raw, list):
            for item in raw:
                if isinstance(item, str) and item:
                    candidate_files.append(item)
                elif isinstance(item, dict) and item.get("path"):
                    candidate_files.append(str(item["path"]))
    for key in ("primary_file", "file_path", "primary_path"):
        val = triage.get(key)
        if isinstance(val, str) and val:
            candidate_files.append(val)

    trace_id = triage.get("trace_id") or triage.get("example_trace_id")
    request_path = triage.get("request_path") or triage.get("path")

    if not stack_trace or not candidate_files:
        try:
            from eden.issues.repo import IssuesRepo

            issue = ctx["issue"]
            stumbles = await IssuesRepo().list_stumbles(
                org_id, fingerprint=issue.fingerprint, limit=5
            )
            for s in stumbles or []:
                detail = getattr(s, "detail", None) or (
                    s.get("detail") if isinstance(s, dict) else None
                )
                if not stack_trace:
                    stack_trace = _stack_trace_from_detail(detail)
                if not trace_id:
                    trace_id = getattr(s, "trace_id", None) or (
                        s.get("trace_id") if isinstance(s, dict) else None
                    )
                if isinstance(detail, dict):
                    fp = detail.get("code_path") or detail.get("file_path")
                    if isinstance(fp, str) and fp:
                        candidate_files.append(fp)
        except Exception as exc:
            logger.debug("issue_patch_trigger: stumble enrich failed: %s", exc)

    seen: set[str] = set()
    uniq_files: list[str] = []
    for p in candidate_files:
        if p not in seen:
            seen.add(p)
            uniq_files.append(p)

    return {
        "stack_trace": stack_trace,
        "candidate_files": uniq_files,
        "trace_id": str(trace_id) if trace_id else None,
        "request_path": str(request_path) if request_path else None,
    }


def _default_run_llm_budget() -> int:
    """Per-run LLM call ceiling for patch paths outside a sweep."""
    try:
        from eden.config import get_settings

        return int(getattr(get_settings(), "patch_max_llm_calls_per_run", 4) or 4)
    except Exception:
        return 4


async def propose_patch_for_issue(org_id: str, issue_id: str) -> dict[str, Any]:
    """Alias for improve/autofix and F46."""
    from eden.improvement.sweep_budget import llm_budget_scope

    # COST: this entry path never armed an LLM budget, so every
    # ``try_consume_llm_call`` inside PatchGenerator waved the call
    # through. Arm a per-run ceiling; a sweep that already armed a
    # (larger, shared) budget keeps its own — see ``llm_budget_scope``.
    with llm_budget_scope(_default_run_llm_budget()):
        result = await propose_plan_for_issue(org_id, issue_id)
    if result.get("plan_id"):
        result["patch_id"] = result["plan_id"]
    return result


async def propose_patch_for_action(org_id: str, action: dict[str, Any]) -> dict[str, Any]:
    """Adapter for closed_loop_executor._dispatch_side_effect."""
    from eden.improvement.sweep_budget import llm_budget_scope

    payload = action.get("payload") or {}
    issue_id = None
    if isinstance(payload, dict):
        issue_id = payload.get("issue_id")
    issue_id = issue_id or action.get("target")
    if not issue_id:
        return {"status": "no_target", "reason": "action has no issue_id/target"}
    # COST: closed-loop ``propose_patch`` actions are the unbudgeted path
    # the audit flagged. Arm the per-run ceiling before any LLM work.
    with llm_budget_scope(_default_run_llm_budget()):
        return await propose_plan_for_issue(org_id, str(issue_id))


_GENERIC_DRAFT_PHRASES = (
    "be more helpful",
    "follow the instructions",
    "be careful",
    "prompt canary aimed at",
    "eden does not land the change",
)
_HELP_MISS_INSTRUCTION = (
    "Do the job yourself when you see this leftover work. "
    "Do not leave it for the human."
)
_NEVER_ATTEMPTED = "this job was never attempted"
_MAX_HELP_MISS_LEFTOVERS = 3
FIX_KIND_CODE = "code_change"
FIX_KIND_INSTRUCTION = "instruction_replace"
_FIX_KIND_LINE = {
    FIX_KIND_CODE: "This is a code change.",
    FIX_KIND_INSTRUCTION: "This is an instruction replace.",
}


def kinds_for_help_miss_reason(reason: str | None) -> list[str]:
    """ExtraWorkEvent.kind values that fingerprint to this HelpMiss reason."""
    from eden.issues.fingerprint import HELP_MISS_REASON_BY_KIND

    if not reason:
        return []
    return [kind for kind, mapped in HELP_MISS_REASON_BY_KIND.items() if mapped == reason]


def instruction_is_generic(instruction: str | None) -> bool:
    """True when the draft is a style platitude, not a leftover-backed change."""
    import re

    text = (instruction or "").strip()
    if not text:
        return True
    stripped = re.sub(r'"[^"]*"', " ", text)
    stripped = re.sub(r"\s+", " ", stripped).strip().lower()
    if not stripped:
        return True
    return any(phrase in stripped for phrase in _GENERIC_DRAFT_PHRASES)


def _leftover_snippet(item: dict[str, Any]) -> str:
    return str(item.get("snippet") or "").strip()[:280]


def normalize_help_miss_leftovers(
    leftovers: list[Any] | None,
) -> list[dict[str, Any]]:
    """Keep up to three ExtraWorkEvent leftovers that have a snippet."""
    cleaned: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for raw in leftovers or []:
        if not isinstance(raw, dict):
            continue
        snippet = _leftover_snippet(raw)
        if not snippet:
            continue
        session_id = str(raw.get("session_id") or "").strip()
        trace_id = str(raw.get("trace_id") or "").strip()
        key = (snippet, session_id, trace_id)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(
            {
                "snippet": snippet,
                "session_id": session_id or None,
                "trace_id": trace_id or None,
                "kind": raw.get("kind"),
                "path": raw.get("path"),
            }
        )
        if len(cleaned) >= _MAX_HELP_MISS_LEFTOVERS:
            break
    return cleaned


def classify_help_miss_fix(leftovers: list[Any] | None) -> str:
    """Code change when leftover text or a matching run can point at a file."""
    from eden.improvement.help_miss_apply import (
        _looks_like_file_path,
        paths_from_leftover_text,
    )

    if paths_from_leftover_text(leftovers):
        return FIX_KIND_CODE
    for raw in leftovers or []:
        if not isinstance(raw, dict):
            continue
        if _looks_like_file_path(str(raw.get("path") or "")):
            return FIX_KIND_CODE
        if str(raw.get("trace_id") or "").strip():
            return FIX_KIND_CODE
    return FIX_KIND_INSTRUCTION


def build_help_miss_improve_draft(
    leftovers: list[Any] | None,
    *,
    instruction: str | None = None,
) -> dict[str, Any] | None:
    """Deterministic Improve draft from leftover snippets. None = do not offer."""
    cleaned = normalize_help_miss_leftovers(leftovers)
    if not cleaned:
        return None
    instruction_text = (instruction or _HELP_MISS_INSTRUCTION).strip()
    if instruction_is_generic(instruction_text):
        return None
    any_session = any(item.get("session_id") for item in cleaned)
    fix_kind = classify_help_miss_fix(cleaned)
    lines: list[str] = []
    if not any_session:
        lines.append(_NEVER_ATTEMPTED)
    else:
        lines.append(
            "A person still did the work this agent was supposed to take off them."
        )
    lines.append(_FIX_KIND_LINE[fix_kind])
    lines.append("")
    lines.append(instruction_text)
    lines.append("")
    lines.append("Leftovers that caused this draft:")
    for index, item in enumerate(cleaned, 1):
        suffix = ""
        if item.get("session_id"):
            bits = [f"session {item['session_id']}"]
            if item.get("trace_id"):
                bits.append(f"trace {item['trace_id']}")
            suffix = f" ({', '.join(bits)})"
        elif any_session:
            suffix = f" — {_NEVER_ATTEMPTED}"
        lines.append(f'{index}. "{item["snippet"]}"{suffix}')
    summary = "\n".join(lines)
    if instruction_is_generic(summary):
        return None
    return {
        "summary": summary,
        "leftovers": cleaned,
        "never_attempted": not any_session,
        "instruction": instruction_text,
        "fix_kind": fix_kind,
    }


async def _fetch_help_miss_leftovers(
    org_id: str,
    *,
    agent_id: str | None,
    help_contract_id: str | None,
    reason: str | None,
) -> list[dict[str, Any]]:
    if not agent_id:
        return []
    kinds = kinds_for_help_miss_reason(reason)
    if not kinds:
        return []
    try:
        from eden.integrations.slack.store import list_help_miss_leftovers

        rows = await list_help_miss_leftovers(
            org_id,
            agent_id=agent_id,
            help_contract_id=help_contract_id,
            kinds=kinds,
            limit=_MAX_HELP_MISS_LEFTOVERS,
        )
    except Exception as exc:
        logger.debug("issue_patch_trigger: list_help_miss_leftovers failed: %s", exc)
        return []
    return [row for row in (rows or []) if isinstance(row, dict)]


async def propose_prompt_canary_for_help_miss(
    org_id: str,
    issue: Any,
    *,
    reason: str | None = None,
    help_contract_id: str | None = None,
    leftovers: list[dict[str, Any]] | None = None,
    snippet: str | None = None,
    session_id: str | None = None,
    trace_id: str | None = None,
    instruction: str | None = None,
) -> dict[str, Any]:
    """Draft a prompt_update plan from ExtraWorkEvent leftovers. Human approve."""
    fingerprint = getattr(issue, "fingerprint", None) or ""
    if not fingerprint:
        return {"status": "suppressed", "reason": "missing_fingerprint"}
    existing = await plans_repo.find_open_by_fingerprint(org_id, fingerprint)
    if existing is not None:
        return {
            "status": "suppressed",
            "reason": "duplicate_open_plan",
            "plan_id": existing.get("id"),
            "issue_id": getattr(issue, "id", None),
        }
    issue_id = str(getattr(issue, "id", "") or "")
    agent_id = getattr(issue, "agent_id", None)
    collected: list[dict[str, Any]] = []
    if leftovers is not None:
        collected.extend(item for item in leftovers if isinstance(item, dict))
    else:
        if snippet and str(snippet).strip():
            collected.append(
                {
                    "snippet": str(snippet).strip(),
                    "session_id": session_id,
                    "trace_id": trace_id,
                }
            )
        fetched = await _fetch_help_miss_leftovers(
            org_id,
            agent_id=agent_id,
            help_contract_id=help_contract_id,
            reason=reason,
        )
        collected.extend(fetched)
    cleaned = normalize_help_miss_leftovers(collected)
    if not cleaned:
        return {
            "status": "suppressed",
            "reason": "no_leftovers",
            "issue_id": issue_id or None,
        }
    draft = build_help_miss_improve_draft(cleaned, instruction=instruction)
    if draft is None:
        return {
            "status": "suppressed",
            "reason": "generic_draft",
            "issue_id": issue_id or None,
            "leftovers": cleaned,
        }
    from eden.improvement.help_miss_apply import resolve_help_miss_file

    target_file = await resolve_help_miss_file(
        org_id, draft["leftovers"], agent_id=agent_id
    )
    if target_file:
        draft["fix_kind"] = FIX_KIND_CODE
        draft["summary"] = draft["summary"].replace(
            _FIX_KIND_LINE[FIX_KIND_INSTRUCTION],
            _FIX_KIND_LINE[FIX_KIND_CODE],
            1,
        )
    title = getattr(issue, "title", None) or f"{agent_id or 'agent'} did not help"
    plan = await plans_repo.create_plan(
        org_id,
        plan_kind="prompt_update",
        title=title,
        agent_id=agent_id,
        summary=draft["summary"],
        source_ref=f"help_miss:{issue_id}" if issue_id else "help_miss",
        source_fingerprint=fingerprint,
        evidence={
            "issue_id": issue_id,
            "fingerprint": fingerprint,
            "reason": reason,
            "help_contract_id": help_contract_id,
            "help_miss": True,
            "leftovers": draft["leftovers"],
            "never_attempted": draft["never_attempted"],
            "instruction": draft["instruction"],
            "fix_kind": draft["fix_kind"],
            "target_file": target_file,
        },
        status="draft",
    )
    if plan is None:
        return {"status": "error", "reason": "create_plan_failed", "issue_id": issue_id}
    return {
        "status": "drafted",
        "plan_id": plan.get("id"),
        "plan_kind": "prompt_update",
        "issue_id": issue_id,
        "plan": plan,
        "leftovers": draft["leftovers"],
        "never_attempted": draft["never_attempted"],
        "fix_kind": draft["fix_kind"],
        "target_file": target_file,
        "instruction": draft["instruction"],
    }
