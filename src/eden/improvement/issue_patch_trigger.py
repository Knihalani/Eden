"""Issue → improvement_plan trigger (N20 / N23).

Fingerprint ≥5× → value gates → N22 → PatchGenerator → improvement_plans.
Portal fix-chat is deleted — this is the only issue→code path.
"""

from __future__ import annotations

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
) -> dict[str, Any]:
    issue = ctx["issue"]
    triage = ctx.get("triage") or {}
    files = patch_data.get("files") or []
    sev = normalize_severity(issue.severity)
    pack = failure_pack or {}
    return {
        "org_id": org_id,
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
            "hermetic_preverify": hermetic_preverify,
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
    """Budgets from cost ledger (W7/W8) + daily maintenance cap + patch_max_per_day."""
    try:
        from eden.config import get_settings
        from eden.llmops.cost_ledger import sum_feature_spend_today

        settings = get_settings()
        cap = float(getattr(settings, "daily_maintenance_budget_usd", 25.0) or 0)
        if cap > 0:
            spent = await sum_feature_spend_today(org_id, features=("patches", "autonomy"))
            if spent >= cap:
                return False, f"budget_exhausted:{spent:.2f}>={cap:.2f}"

        day_cap = int(getattr(settings, "patch_max_per_day", 10) or 10)
        if day_cap > 0:
            used = await plans_repo.count_code_patches_today(org_id)
            if used >= day_cap:
                return False, f"patch_max_per_day:{used}>={day_cap}"
    except Exception as exc:
        logger.debug("issue_patch_trigger: cost_ledger budget: %s", exc)

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
                "plan_id": (existing or {}).get("id"),
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

    payload = _plan_payload_from_patch(
        org_id,
        issue_id,
        ctx,
        data,
        run_id=run_id,
        failure_pack=failure_pack,
        hermetic_preverify=hermetic_preverify,
        example_trace_ids=example_trace_ids,
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
        "stumble_count": stumble_count,
    }


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
