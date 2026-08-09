"""Post-resolution issue fix-PR attempt (FEAT-92).

After :class:`IssuePromptEvolver` creates an internal prompt-version
candidate, this module tries to open a draft GitHub PR with the revised
prompt (or stamps ``patch_blocked`` on the issue triage so the portal
``patchBlockedReason`` / ``patchBlockedMessage`` contract is honest).
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_PROMPT_FILE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def _prompt_repo_path(agent: str) -> str:
    """Convention for agent prompt files in customer repos."""
    safe = _PROMPT_FILE_RE.sub("-", (agent or "agent").strip())[:120] or "agent"
    return f"prompts/{safe}.md"


async def attempt_issue_prompt_fix_pr(
    org_id: str,
    issue_id: str,
    *,
    agent: str,
    prompt_template: str,
    issue_title: str,
    fingerprint: str,
) -> dict[str, Any]:
    """Try to open a draft fix PR; stamp ``patch_blocked`` when we cannot.

    Never raises — callers get a structured result and the portal can
    render why no PR appeared.
    """
    from eden.improvement.issue_patch_trigger import stamp_patch_blocked
    from eden.providers.factory import (
        RepoConnectionError,
        get_pr_provider_for_org,
        get_repo_provider_for_org,
        resolve_active_repo_id,
        resolve_pr_base_branch,
    )
    from eden.providers.pr import PRCreateRequest
    from eden.providers.repo import FileEntry

    async def _block(reason: str, message: str) -> dict[str, Any]:
        try:
            await stamp_patch_blocked(
                org_id, issue_id, reason=reason, message=message,
            )
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("issue_fix_pr: stamp patch_blocked failed: %s", exc)
        return {
            "status": "blocked",
            "reason": reason,
            "message": message,
        }

    repo_id = await resolve_active_repo_id(org_id, agent_id=agent)
    if not repo_id:
        return await _block(
            "repo_not_connected",
            "Connect a GitHub repo for this agent so Eden can open fix PRs",
        )

    try:
        from eden.integrations.github import is_configured
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("issue_fix_pr: github import failed: %s", exc)
        return await _block(
            "github_not_configured",
            "GitHub App integration is not available in this environment",
        )

    if not is_configured():
        return await _block(
            "github_not_configured",
            "Connect the Eden GitHub App so Eden can open fix PRs",
        )

    try:
        pr_provider = await get_pr_provider_for_org(org_id, agent_id=agent)
        repo_provider = await get_repo_provider_for_org(org_id, agent_id=agent)
    except RepoConnectionError:
        return await _block(
            "installation_token_failed",
            "Could not mint a GitHub installation token for this repo — "
            "reconnect the GitHub App installation",
        )
    except Exception as exc:
        logger.warning("issue_fix_pr: provider resolution failed: %s", exc)
        return await _block(
            "pr_provider_unavailable",
            f"Could not resolve a PR provider: {exc}",
        )

    prompt_path = _prompt_repo_path(agent)
    content_bytes = prompt_template.encode("utf-8")
    try:
        base = await resolve_pr_base_branch(org_id, repo_provider, agent_id=agent)
    except Exception as exc:
        logger.warning("issue_fix_pr: base branch resolution failed: %s", exc)
        return await _block(
            "base_branch_unresolved",
            "Could not resolve the repository default branch for a fix PR",
        )

    branch = f"eden/issue-prompt-{issue_id[:12]}"
    title = f"[Eden] Prompt fix for issue {fingerprint or issue_id[:8]}"
    body = (
        f"## Issue-driven prompt update\n\n"
        f"- **Issue:** {issue_title}\n"
        f"- **Fingerprint:** `{fingerprint}`\n"
        f"- **Agent / prompt:** `{agent}`\n"
        f"- **File:** `{prompt_path}`\n\n"
        f"Auto-generated after issue resolution. Review before merge."
    )
    req = PRCreateRequest(
        title=title,
        body=body,
        branch=branch,
        base=base,
        draft=True,
        repo_id=repo_id,
        files=[
            FileEntry(
                path=prompt_path,
                content=prompt_template,
                size=len(content_bytes),
            )
        ],
    )

    try:
        info = await pr_provider.create_pr(req)
    except NotImplementedError:
        return await _block(
            "pr_provider_not_implemented",
            "PR provider is not configured for this organization",
        )
    except Exception as exc:
        from eden.providers.pr import GitHubPRPermissionError

        if isinstance(exc, GitHubPRPermissionError):
            return await _block(
                "github_permissions_missing",
                str(exc),
            )
        logger.warning("issue_fix_pr: create_pr failed: %s", exc)
        return await _block(
            "pr_create_failed",
            f"GitHub PR create failed: {exc}",
        )

    state = getattr(info, "state", None)
    number = getattr(info, "number", None)
    url = getattr(info, "url", None)
    if state == "failure" or number is None or not url:
        return await _block(
            "pr_create_failed",
            (
                f"PR provider returned a failed create result "
                f"(state={state!s}, number={number!s})"
            ),
        )

    # Success — clear any stale blocker and record the PR on triage.
    try:
        from eden.issues.repo import IssuesRepo

        repo = IssuesRepo()
        issue = await repo.get_issue(org_id, issue_id)
        if issue is not None:
            triage = dict(issue.triage_result or {})
            triage.pop("patch_blocked", None)
            triage["fix_pr"] = {
                "url": url,
                "number": number,
                "branch": branch,
                "path": prompt_path,
                "kind": "prompt_update",
            }
            await repo.set_triage_result(org_id, issue_id, triage)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("issue_fix_pr: triage fix_pr stamp failed: %s", exc)

    return {
        "status": "opened",
        "pr_url": url,
        "pr_number": number,
        "branch": branch,
        "path": prompt_path,
    }
