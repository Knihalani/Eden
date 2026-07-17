"""Issue → improvement_plan trigger (N20 / N23).

Fingerprint ≥5× → N22 gate → PatchGenerator → improvement_plans.
Portal fix-chat is deleted — this is the only issue→code path.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.improvement import plans_repo

logger = logging.getLogger(__name__)

_MIN_FINGERPRINT_COUNT = 5


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
    return await plans_repo.find_open_by_fingerprint(org_id, fingerprint)


async def build_candidate_from_issue(org_id: str, issue: Any) -> Any | None:
    from eden.improvement.planner import PlanCandidate

    triage = issue.triage_result or {}
    sev = (issue.severity or "medium").lower()
    fp = f"issue:{issue.id}"
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
            "confidence": float(triage.get("confidence", 0.6)),
            "stumble_count": int(getattr(issue, "stumble_count", 0) or 0),
        },
        triage_snapshot=triage,
        severity=sev,
        confidence=float(triage.get("confidence", 0.6)),
    )


def _plan_payload_from_patch(
    org_id: str,
    issue_id: str,
    ctx: dict[str, Any],
    patch_data: dict[str, Any],
    *,
    run_id: str | None = None,
) -> dict[str, Any]:
    issue = ctx["issue"]
    triage = ctx.get("triage") or {}
    files = patch_data.get("files") or []
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
            "severity": (issue.severity or "medium").lower(),
            "confidence": float(triage.get("confidence", 0.6)),
            "stumble_count": int(getattr(issue, "stumble_count", 0) or 0),
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
    """Budgets from cost ledger (W7/W8) + daily maintenance cap."""
    try:
        from eden.config import get_settings
        from eden.llmops.cost_ledger import sum_feature_spend_today

        cap = float(getattr(get_settings(), "daily_maintenance_budget_usd", 25.0) or 0)
        if cap > 0:
            spent = await sum_feature_spend_today(
                org_id, features=("patches", "autonomy")
            )
            if spent >= cap:
                return False, f"budget_exhausted:{spent:.2f}>={cap:.2f}"
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
    min_count = _min_fingerprint_count()
    stumble_count = int(getattr(issue, "stumble_count", 0) or 0)
    if stumble_count < min_count:
        return {
            "status": "suppressed",
            "reason": "fingerprint_below_threshold",
            "stumble_count": stumble_count,
            "min_required": min_count,
            "issue_id": issue_id,
        }

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

    linked_files = await _linked_files(org_id, rca_id, ctx)

    try:
        from eden.patches.patch_generator import PatchGenerator

        result = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=rca_id,
            trace_id=rca_id,
            repo_id=ctx["agent_id"],
            rca_summary=ctx["rca_summary"],
            test_plan=[],
            linked_files=linked_files,
            persist=False,
        )
    except Exception as exc:
        logger.warning("issue_patch_trigger: generate failed: %s", exc)
        return {"status": "error", "reason": str(exc)}

    data = result.get("data", {}) if isinstance(result, dict) else {}
    status = data.get("status") or "proposed"
    if status in ("deduplicated", "investigation"):
        return {
            "status": "suppressed",
            "reason": status,
            "issue_id": issue_id,
        }
    if not data.get("diff"):
        return {"status": "error", "reason": "empty_diff", "issue_id": issue_id}

    payload = _plan_payload_from_patch(org_id, issue_id, ctx, data, run_id=run_id)
    plan = await plans_repo.create_plan(org_id, **payload)
    if plan is None:
        return {"status": "error", "reason": "persist_failed", "issue_id": issue_id}

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
        "stumble_count": stumble_count,
    }


async def _linked_files(
    org_id: str, rca_id: str, ctx: dict[str, Any]
) -> list[dict[str, str]]:
    """Resolve linked files via RCA linker (salvaged Cat 23)."""
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
            repo_id=ctx.get("agent_id") or "",
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
    out: list[dict[str, str]] = []
    for item in linked:
        path = item.get("path") or ""
        if path and path not in seen:
            seen.add(path)
            out.append({"path": path, "content": item.get("content") or ""})
    return out


def _stack_trace_from_detail(detail: dict[str, Any] | None) -> str | None:
    if not isinstance(detail, dict):
        return None
    for key in ("stack_trace", "stacktrace", "traceback", "exc_info"):
        val = detail.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return None


async def _extract_linker_inputs(
    org_id: str, ctx: dict[str, Any]
) -> dict[str, Any]:
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


async def propose_patch_for_issue(org_id: str, issue_id: str) -> dict[str, Any]:
    """Alias for improve/autofix and F46."""
    result = await propose_plan_for_issue(org_id, issue_id)
    if result.get("plan_id"):
        result["patch_id"] = result["plan_id"]
    return result


async def propose_patch_for_action(
    org_id: str, action: dict[str, Any]
) -> dict[str, Any]:
    """Adapter for closed_loop_executor._dispatch_side_effect."""
    payload = action.get("payload") or {}
    issue_id = None
    if isinstance(payload, dict):
        issue_id = payload.get("issue_id")
    issue_id = issue_id or action.get("target")
    if not issue_id:
        return {"status": "no_target", "reason": "action has no issue_id/target"}
    return await propose_plan_for_issue(org_id, str(issue_id))
