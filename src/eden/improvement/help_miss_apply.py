"""HelpMiss Do-it apply: prefer a small code PR, else replace one instruction."""

from __future__ import annotations

import logging
from typing import Any

from eden.improvement.issue_patch_trigger import (
    FIX_KIND_CODE,
    classify_help_miss_fix,
    instruction_is_generic,
)

logger = logging.getLogger(__name__)

_DETECTOR_PATHS = frozenset(
    {"ambient", "pointer_thread", "direct", "mention", "dm", "thread"}
)
_CODE_EXTS = (
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".go",
    ".rb",
    ".rs",
    ".java",
    ".kt",
    ".swift",
)


def _looks_like_file_path(path: str | None) -> bool:
    """True when leftover.path is a source file, not a detector label."""
    raw = str(path or "").strip()
    if not raw or raw.lower() in _DETECTOR_PATHS:
        return False
    if "/" in raw or "\\" in raw:
        return True
    lower = raw.lower()
    return any(lower.endswith(ext) for ext in _CODE_EXTS)


def resolve_help_miss_target_file(leftovers: list[Any] | None) -> str | None:
    """First leftover path that looks like a file. Do not ask which file."""
    for raw in leftovers or []:
        if not isinstance(raw, dict):
            continue
        path = str(raw.get("path") or "").strip()
        if _looks_like_file_path(path):
            return path
    return None


def existing_help_miss_pr_url(plan: dict[str, Any] | None) -> str | None:
    """Idempotent: reuse a PR already opened for this plan."""
    if not isinstance(plan, dict):
        return None
    url = str(plan.get("pr_url") or "").strip()
    if url:
        return url
    ev = plan.get("evidence")
    if isinstance(ev, dict):
        url = str(ev.get("pr_url") or "").strip()
        if url:
            return url
        meta = ev.get("approve_metadata")
        if isinstance(meta, dict):
            url = str(meta.get("pr_url") or "").strip()
            if url:
                return url
            apply = meta.get("help_miss_apply")
            if isinstance(apply, dict):
                url = str(apply.get("pr_url") or "").strip()
                if url:
                    return url
        apply = ev.get("help_miss_apply")
        if isinstance(apply, dict):
            url = str(apply.get("pr_url") or "").strip()
            if url:
                return url
    return None


def replace_one_agent_instruction(current: str | None, instruction: str) -> str:
    """Overwrite the one instruction already on the agent. Never append."""
    new_line = (instruction or "").strip()
    text = current or ""
    if not new_line:
        return text
    lines = text.splitlines()
    stripped = [ln.strip() for ln in lines]
    if new_line in stripped:
        return text.rstrip("\n") if text else new_line
    if not any(stripped):
        return new_line
    for index in range(len(lines) - 1, -1, -1):
        if lines[index].strip():
            lines[index] = new_line
            return "\n".join(lines)
    return new_line


def choose_help_miss_apply(
    evidence: dict[str, Any] | None,
    *,
    plan: dict[str, Any] | None = None,
    resolved_file: str | None = None,
) -> dict[str, Any]:
    """Decide code PR vs one-line instruction replace. No agent-file write."""
    ev = evidence if isinstance(evidence, dict) else {}
    instruction = str(ev.get("instruction") or "").strip()
    if instruction_is_generic(instruction):
        return {"status": "refused", "reason": "generic_draft"}
    leftovers = ev.get("leftovers") if isinstance(ev.get("leftovers"), list) else []
    fix_kind = str(ev.get("fix_kind") or classify_help_miss_fix(leftovers) or "")
    target = (
        resolved_file
        if resolved_file is not None
        else resolve_help_miss_target_file(leftovers)
    )
    has_diff = bool(str((plan or {}).get("diff_unified") or "").strip())
    existing_pr = existing_help_miss_pr_url(plan)
    if fix_kind == FIX_KIND_CODE and (target or has_diff or existing_pr):
        return {
            "status": "ok",
            "apply_kind": "code_pr",
            "target_file": target,
            "instruction": instruction,
            "can_open_pr": bool(has_diff or existing_pr),
        }
    return {
        "status": "ok",
        "apply_kind": "instruction_replace",
        "target_file": None,
        "instruction": instruction,
        "can_open_pr": False,
    }


async def resolve_help_miss_file(
    org_id: str,
    leftovers: list[Any] | None,
    *,
    agent_id: str | None = None,
) -> str | None:
    """File from leftover.path or leftover.trace_id via the existing linker."""
    found = resolve_help_miss_target_file(leftovers)
    if found:
        return found
    trace_id = None
    for raw in leftovers or []:
        if not isinstance(raw, dict):
            continue
        tid = str(raw.get("trace_id") or "").strip()
        if tid:
            trace_id = tid
            break
    if not trace_id:
        return None
    from eden.improvement.issue_patch_trigger import _linked_files, _resolve_repo_id

    repo_id = await _resolve_repo_id(org_id, agent_id=agent_id)
    if not repo_id:
        return None
    ctx = {
        "rca_summary": "",
        "agent_id": agent_id,
        "triage": {"trace_id": trace_id},
    }
    try:
        linked = await _linked_files(
            org_id,
            f"help_miss:{trace_id}",
            ctx,
            repo_id=repo_id,
            agent_id=agent_id,
        )
    except Exception as exc:
        logger.debug("help_miss apply: linker failed: %s", exc)
        return None
    for item in linked or []:
        path = str((item or {}).get("path") or "").strip()
        if path:
            return path
    return None


async def approve_help_miss_plan(
    org_id: str,
    plan_id: str,
    plan: dict[str, Any],
    *,
    approved_by: str | None = None,
) -> dict[str, Any]:
    """Apply a HelpMiss draft. Human already approved. No auto-merge."""
    from eden.improvement import plans_repo

    _raw_ev = plan.get("evidence")
    evidence: dict[str, Any] = _raw_ev if isinstance(_raw_ev, dict) else {}
    leftovers = evidence.get("leftovers") if isinstance(evidence.get("leftovers"), list) else []
    resolved = None
    if str(evidence.get("fix_kind") or "") == FIX_KIND_CODE:
        resolved = await resolve_help_miss_file(
            org_id, leftovers, agent_id=plan.get("agent_id")
        )
    choice = choose_help_miss_apply(
        evidence, plan=plan, resolved_file=resolved
    )
    if choice.get("status") == "refused":
        return {
            "plan_id": plan_id,
            "status": "refused",
            "reason": choice.get("reason") or "generic_draft",
            "message": "Generic or empty instruction — stay on draft. No pin, no PR.",
        }

    apply_kind = str(choice["apply_kind"])
    target_file = choice.get("target_file") or resolved
    instruction = str(choice.get("instruction") or "")
    pr_url = existing_help_miss_pr_url(plan)
    pr_number = plan.get("pr_number")
    pr_error: str | None = None
    code_pr_attempted = False
    pin: dict[str, Any] | None = None

    if apply_kind == "code_pr":
        code_pr_attempted = True
        if not pr_url and target_file:
            opened = await _open_or_update_help_miss_code_pr(
                org_id,
                plan_id,
                plan,
                target_file,
                instruction=instruction,
                approved_by=approved_by,
            )
            pr_url = opened.get("pr_url") or pr_url
            pr_number = opened.get("pr_number") or pr_number
            pr_error = opened.get("error")
            if opened.get("marked"):
                notify = await _notify_applied(
                    org_id,
                    agent_id=str(plan.get("agent_id") or ""),
                    plan_id=plan_id,
                    apply_kind="code_pr",
                    pr_url=pr_url,
                    pr_error=pr_error,
                )
                return {
                    "plan_id": plan_id,
                    "status": "applied",
                    "apply_kind": "code_pr",
                    "target_file": target_file,
                    "pr_url": pr_url,
                    "pr_number": pr_number,
                    "code_pr_attempted": True,
                    "agents_md": False,
                    "notify": notify,
                    "plan": opened.get("plan") or plan,
                }
        if not pr_url and not str((plan or {}).get("diff_unified") or "").strip():
            apply_kind = "instruction_replace"
            pr_error = pr_error or "no_diff"
    if apply_kind == "instruction_replace":
        pin = await _pin_help_miss_instruction(
            org_id, plan, instruction=instruction, approved_by=approved_by
        )
        if pin.get("status") == "error":
            return {
                "plan_id": plan_id,
                "status": "error",
                "error": pin.get("error"),
                "message": pin.get("message"),
                "apply_kind": "instruction_replace",
                "agents_md": False,
                "plan": plan,
            }

    metadata = {
        "route_status": "applied",
        "apply_kind": apply_kind,
        "target_file": target_file,
        "instruction": instruction,
        "pr_url": pr_url,
        "pr_error": pr_error,
        "code_pr_attempted": code_pr_attempted,
        "agents_md": False,
    }
    if pin:
        metadata["prompt_name"] = pin.get("prompt_name")
        metadata["version"] = pin.get("version")
        metadata["env"] = pin.get("env")
    updated = await plans_repo.mark_approved(
        org_id,
        plan_id,
        approved_by=approved_by,
        status="approved",
        metadata=metadata,
    )
    notify = await _notify_applied(
        org_id,
        agent_id=str(plan.get("agent_id") or ""),
        plan_id=plan_id,
        apply_kind=apply_kind,
        pr_url=pr_url,
        pr_error=pr_error,
    )
    out: dict[str, Any] = {
        "plan_id": plan_id,
        "status": "applied",
        "apply_kind": apply_kind,
        "target_file": target_file,
        "pr_url": pr_url,
        "code_pr_attempted": code_pr_attempted,
        "agents_md": False,
        "notify": notify,
        "plan": updated,
    }
    if pin:
        out["prompt_name"] = pin.get("prompt_name")
        out["version"] = pin.get("version")
        out["env"] = pin.get("env")
    return out


async def _open_or_update_help_miss_code_pr(
    org_id: str,
    plan_id: str,
    plan: dict[str, Any],
    target_file: str,
    *,
    instruction: str,
    approved_by: str | None = None,
) -> dict[str, Any]:
    """Reuse PatchGenerator + the existing Improve/canary PR path."""
    from eden.improvement import plans_repo

    existing = existing_help_miss_pr_url(plan)
    if existing:
        return {
            "pr_url": existing,
            "pr_number": plan.get("pr_number"),
            "marked": False,
        }
    pr_url = None
    pr_number = None
    branch = f"eden/improve-{str(plan_id)[:12]}"
    error = None
    try:
        from eden.improvement.issue_patch_trigger import _resolve_repo_id
        from eden.patches.patch_generator import PatchGenerator
        from eden.providers.factory import (
            get_pr_provider_for_org,
            get_repo_provider_for_org,
            resolve_pr_base_branch,
        )

        plan_agent_id = (plan.get("agent_id") or "").strip() or None
        repo_id = await _resolve_repo_id(org_id, agent_id=plan_agent_id)
        content = ""
        if repo_id:
            try:
                repo_provider = await get_repo_provider_for_org(
                    org_id, agent_id=plan_agent_id
                )
                content = await repo_provider.read_file(target_file) or ""
            except Exception as exc:
                logger.debug("help_miss code PR: read_file failed: %s", exc)
        leftovers = (
            (plan.get("evidence") or {})
            if isinstance(plan.get("evidence"), dict)
            else {}
        ).get("leftovers") or []
        trace_id = ""
        for raw in leftovers:
            if isinstance(raw, dict) and raw.get("trace_id"):
                trace_id = str(raw["trace_id"])
                break
        generated = await PatchGenerator().generate(
            org_id=org_id,
            rca_id=str(
                (
                    (plan.get("evidence") or {})
                    if isinstance(plan.get("evidence"), dict)
                    else {}
                ).get("issue_id")
                or plan_id
            ),
            trace_id=trace_id or f"help_miss:{plan_id}",
            repo_id=str(repo_id or ""),
            rca_summary=str(plan.get("summary") or instruction),
            linked_files=[{"path": target_file, "content": content}],
            persist=False,
        )
        data = generated.get("data", {}) if isinstance(generated, dict) else {}
        diff = str(data.get("diff") or "").strip()
        if diff and repo_id:
            from eden.patches.diff_materializer import materialize_unified_diff
            from eden.providers import PRCreateRequest

            repo_provider = await get_repo_provider_for_org(
                org_id, agent_id=plan_agent_id
            )
            files = await materialize_unified_diff(
                diff, read_file=repo_provider.read_file
            )
            pr_provider = await get_pr_provider_for_org(
                org_id, agent_id=plan_agent_id
            )
            base = await resolve_pr_base_branch(
                org_id, repo_provider, agent_id=plan_agent_id
            )
            info = await pr_provider.create_pr(
                PRCreateRequest(
                    title=f"[Eden] {str(plan.get('title') or 'HelpMiss')[:120]}",
                    body=str(plan.get("summary") or instruction),
                    branch=branch,
                    base=base,
                    draft=True,
                    repo_id=repo_id,
                    files=files,
                )
            )
            pr_url = getattr(info, "url", None)
            pr_number = getattr(info, "number", None)
    except Exception as exc:
        logger.debug("help_miss code PR: existing PR path failed: %s", exc)
        error = str(exc)[:200]
    if pr_url:
        updated = await plans_repo.mark_pr_opened(
            org_id,
            plan_id,
            pr_url=str(pr_url),
            pr_number=int(pr_number) if pr_number else None,
            github_branch=branch,
            approved_by=approved_by,
        )
        return {
            "pr_url": pr_url,
            "pr_number": pr_number,
            "plan": updated,
            "marked": True,
        }
    return {"pr_url": None, "pr_number": None, "error": error, "marked": False}


async def _current_agent_template(
    org_id: str, agent_id: str
) -> tuple[str, int | None]:
    try:
        from eden.services.prompt_versioning import PromptService

        versions = await PromptService().list_versions(org_id, agent_id, limit=1)
    except Exception as exc:
        logger.debug("help_miss pin: list_versions failed: %s", exc)
        return "", None
    if not versions:
        return "", None
    row = versions[0]
    return str(row.get("template") or ""), row.get("version")


async def _pin_help_miss_instruction(
    org_id: str,
    plan: dict[str, Any],
    *,
    instruction: str,
    approved_by: str | None = None,
) -> dict[str, Any]:
    """Pin the one instruction via PromptDeployService + canary."""
    agent_id = str(plan.get("agent_id") or "").strip()
    if not agent_id:
        return {
            "status": "error",
            "error": "missing_agent_id",
            "message": "HelpMiss pin needs an agent to overwrite",
        }
    current, current_version = await _current_agent_template(org_id, agent_id)
    template = replace_one_agent_instruction(current, instruction)
    _raw = plan.get("evidence")
    evidence: dict[str, Any] = _raw if isinstance(_raw, dict) else {}
    env = str(evidence.get("env") or "prod")
    version = current_version
    reused = bool(
        current_version is not None and template == (current or "").rstrip("\n")
    )
    if not reused:
        try:
            from eden.services.prompt_versioning import PromptService

            created = await PromptService().create_version(
                org_id,
                agent_id,
                template=template,
                model="eden-help-miss",
                change_note="help_miss instruction replace",
                created_by=approved_by or "system",
            )
        except Exception as exc:
            logger.warning("help_miss pin: create_version failed: %s", exc)
            return {
                "status": "error",
                "error": "prompt_version_create_failed",
                "message": str(exc),
            }
        if created is None:
            return {
                "status": "error",
                "error": "prompt_version_create_failed",
                "message": "Could not write the one-line instruction pin",
            }
        version = created.get("version")
    if version is None:
        return {
            "status": "error",
            "error": "prompt_version_create_failed",
            "message": "No prompt version to pin",
        }
    try:
        from eden.prompts.deploy import PromptDeployService

        deployed = await PromptDeployService().deploy(
            org_id,
            prompt_name=agent_id,
            env=env,
            version=int(version),
            deployed_by=approved_by,
        )
    except Exception as exc:
        logger.warning("help_miss pin: deploy failed: %s", exc)
        return {
            "status": "error",
            "error": "prompt_deploy_failed",
            "message": str(exc),
        }
    if deployed is None:
        return {
            "status": "error",
            "error": "prompt_deploy_failed",
            "message": "PromptDeployService returned no result",
        }
    try:
        from eden.agents.prompt_canary import arm_help_miss_canary

        await arm_help_miss_canary(
            org_id,
            agent_id,
            candidate_version=int(version),
            control_version=int(current_version or 0),
        )
    except Exception as exc:
        logger.debug("help_miss pin: canary arm failed: %s", exc)
    return {
        "status": "pinned",
        "prompt_name": agent_id,
        "version": int(version),
        "env": env,
    }


async def _notify_applied(
    org_id: str,
    *,
    agent_id: str,
    plan_id: str,
    apply_kind: str,
    pr_url: str | None,
    pr_error: str | None,
) -> dict[str, Any]:
    try:
        from eden.services.slack_notify import notify_help_miss_applied

        return await notify_help_miss_applied(
            org_id,
            agent_id=agent_id,
            plan_id=plan_id,
            apply_kind=apply_kind,
            pr_url=pr_url,
            pr_error=pr_error,
        )
    except Exception as exc:
        logger.debug("help_miss_apply: notify failed: %s", exc)
        return {"status": "error", "reason": str(exc)[:200]}

