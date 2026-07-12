"""Issue → autonomous patch trigger (N20, Wave 6).

Bridges the closed-loop (F46) to the Cat 23 patch pipeline: when the
orchestrator decides an issue warrants a code fix (and the N22 policy
permits it), it calls :func:`propose_patch_for_issue`, which drives
``PatchGenerator.generate(rca_id=issue_id, ...)`` and leaves the diff in
the ``proposed_patches`` inbox for human review (or auto-PR when
``auto_pr_enabled``).

Hardening (Waves 4–6):

* Resolve real ``linked_files`` via :class:`CodeRootCauseLinker` instead
  of always passing ``[]``.
* Suppress duplicate-open proposes when a ``proposed``/in-flight patch
  already exists for the same RCA id.
* Gate through :class:`AgentEfficiencyController.should_run_patch`.

The master ``code_change_enabled`` switch is a hard gate — this refuses
to generate anything when it is off, mirroring the propose route and the
scheduler. All failures are swallowed to a structured dict so the loop
never crashes on a missing patch substrate.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_OPEN_PATCH_STATUSES = ("proposed", "pending_review", "approved")


def _code_change_enabled() -> bool:
    try:
        from eden.config import get_settings

        return bool(getattr(get_settings(), "code_change_enabled", False))
    except Exception:
        return False


async def _issue_context(org_id: str, issue_id: str) -> dict[str, Any] | None:
    """Load the issue for RCA grounding (title, kind, triage summary)."""
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
    """Pull stack_trace / candidate_files / trace_id from triage + stumbles."""
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

    trace_id = (
        triage.get("trace_id")
        or triage.get("example_trace_id")
        or None
    )
    request_path = triage.get("request_path") or triage.get("path")

    # Enrich from example stumbles when triage lacks a stack.
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

    # Dedupe preserve order.
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


async def _linked_files_via_rca(
    org_id: str, rca_id: str, ctx: dict[str, Any]
) -> list[dict[str, str]]:
    """Resolve linked_files through CodeRootCauseLinker (best-effort)."""
    inputs = await _extract_linker_inputs(org_id, ctx)
    linked: list[dict[str, str]] = []

    # Prefer stack-derived paths even before the linker runs.
    if inputs["stack_trace"]:
        try:
            from eden.code_change.rca_linker import _stack_trace_files

            for path, _conf in _stack_trace_files(inputs["stack_trace"]):
                linked.append({"path": path, "content": ""})
        except Exception as exc:
            logger.debug("issue_patch_trigger: stack parse failed: %s", exc)

    try:
        from eden.code_change.rca_linker import CodeRootCauseLinker

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

    # Fall back to triage candidate files.
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


async def _find_open_patch(
    org_id: str, rca_id: str
) -> dict[str, Any] | None:
    """Return an in-flight proposed_patches row for ``rca_id``, if any."""
    try:
        from eden.code_change._common import _select_rows

        statuses = ", ".join(f"'{s}'" for s in _OPEN_PATCH_STATUSES)
        rows = await _select_rows(
            org_id,
            "proposed_patches",
            where=f"rca_id = $2 AND status IN ({statuses})",
            params=(rca_id,),
            limit=1,
        )
        return rows[0] if rows else None
    except Exception as exc:
        logger.debug("issue_patch_trigger: open-patch lookup failed: %s", exc)
        return None


async def propose_patch_for_issue(
    org_id: str, issue_id: str
) -> dict[str, Any]:
    """Generate a proposed patch for an issue (N20).

    Returns ``{"status": ..., "patch_id"?, "reason"?}``. Never raises.
    """
    if not _code_change_enabled():
        return {"status": "disabled", "reason": "code_change_enabled=false"}

    ctx = await _issue_context(org_id, issue_id)
    if ctx is None:
        return {"status": "not_found", "reason": f"issue {issue_id!r} not found"}

    rca_id = f"iss_{issue_id}"

    # Efficiency / duplicate-open suppress (N20 harden).
    try:
        from eden.closed_loop.efficiency import AgentEfficiencyController

        allowed, reason = await AgentEfficiencyController().should_run_patch(
            org_id, issue_id, rca_id=rca_id
        )
        if not allowed:
            existing = await _find_open_patch(org_id, rca_id)
            return {
                "status": "suppressed",
                "reason": reason,
                "patch_id": (existing or {}).get("id"),
                "issue_id": issue_id,
            }
    except Exception as exc:
        logger.debug("issue_patch_trigger: efficiency check failed: %s", exc)

    # Belt-and-suspenders duplicate check even if efficiency is unavailable.
    existing = await _find_open_patch(org_id, rca_id)
    if existing is not None:
        return {
            "status": "suppressed",
            "reason": "duplicate_open_patch",
            "patch_id": existing.get("id"),
            "issue_id": issue_id,
        }

    linked_files = await _linked_files_via_rca(org_id, rca_id, ctx)

    try:
        from eden.code_change.patch_generator import PatchGenerator

        result = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=rca_id,
            trace_id=rca_id,
            repo_id=ctx["agent_id"],
            rca_summary=ctx["rca_summary"],
            test_plan=[],
            linked_files=linked_files,
        )
    except Exception as exc:
        logger.warning(
            "issue_patch_trigger: generate failed for issue %s: %s",
            issue_id,
            exc,
        )
        return {"status": "error", "reason": str(exc)}

    data = result.get("data", {}) if isinstance(result, dict) else {}
    status = data.get("status") or "proposed"
    if status == "deduplicated":
        return {
            "status": "suppressed",
            "reason": "similar_recent_patch",
            "patch_id": (data.get("duplicate_of") or {}).get("matched_patch_id"),
            "issue_id": issue_id,
            "linked_files_count": len(linked_files),
        }
    return {
        "status": "proposed",
        "patch_id": data.get("patch_id"),
        "patch_status": status,
        "cost_usd": data.get("cost_usd"),
        "issue_id": issue_id,
        "linked_files_count": len(linked_files),
    }


async def propose_patch_for_action(
    org_id: str, action: dict[str, Any]
) -> dict[str, Any]:
    """Adapter for ``closed_loop_executor._dispatch_side_effect``.

    Resolves the issue id from the action payload/target and delegates to
    :func:`propose_patch_for_issue`.
    """
    payload = action.get("payload") or {}
    issue_id = None
    if isinstance(payload, dict):
        issue_id = payload.get("issue_id")
    issue_id = issue_id or action.get("target")
    if not issue_id:
        return {"status": "no_target", "reason": "action has no issue_id/target"}
    return await propose_patch_for_issue(org_id, str(issue_id))
