"""F56 CI-eval commit-status writeback.

Posts a GitHub Check Run carrying the regression verdict for a commit, so
a PR can gate on the Eden eval. Reuses the App auth + check-run plumbing
in ``eden.integrations.github`` (the same primitives ``change_impact/
preview.py`` uses); no new GitHub client code.

Fail-open by design: any missing config, install, repo/sha, or GitHub API
error returns a ``{"posted": False, "reason": ...}`` record and never
raises into the eval request path — an eval must not fail because the
status write failed.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_CHECK_NAME = "Eden eval"


def _conclusion(ok: bool) -> str:
    return "success" if ok else "failure"


def build_check_payload(
    *,
    head_sha: str,
    ok: bool,
    summary_md: str,
    details_url: str | None = None,
) -> dict[str, Any]:
    """GitHub Check Run create payload for a regression verdict."""
    payload: dict[str, Any] = {
        "name": _CHECK_NAME,
        "head_sha": head_sha[:40],
        "status": "completed",
        "conclusion": _conclusion(ok),
        "output": {
            "title": "Regression gate: pass" if ok else "Regression gate: block",
            "summary": summary_md,
        },
    }
    if details_url:
        payload["details_url"] = details_url
    return payload


async def post_commit_status(
    org_id: str,
    *,
    repo_full_name: str | None,
    commit_sha: str | None,
    ok: bool,
    summary_md: str,
    details_url: str | None = None,
    pg: Any | None = None,
) -> dict[str, Any]:
    """Post a Check Run for ``commit_sha``. Never raises.

    Returns a record describing what happened:
      {"posted": True, "check_run_id": ...}
      {"posted": False, "reason": "github_not_configured" | "no_installation"
                                  | "missing_repo_or_sha" | "invalid_repo"
                                  | "flag_disabled" | "error"}
    """
    if not repo_full_name or not commit_sha:
        return {"posted": False, "reason": "missing_repo_or_sha"}
    parts = repo_full_name.split("/", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        return {"posted": False, "reason": "invalid_repo"}
    owner, repo = parts[0], parts[1]

    try:
        from eden.integrations.github import (
            GitHubAPIError,
            GitHubOAuthClient,
            is_configured,
        )
    except Exception:  # pragma: no cover - import guard
        return {"posted": False, "reason": "github_not_configured"}

    if not is_configured():
        return {"posted": False, "reason": "github_not_configured"}

    try:
        if pg is None:
            from eden.storage.postgres import get_postgres_client

            pg = await get_postgres_client()
        row = await pg.fetchrow(
            """
            SELECT installation_id FROM org_github_installations
            WHERE org_id = $1 AND suspended_at IS NULL
            ORDER BY installed_at DESC
            LIMIT 1
            """,
            org_id,
        )
    except Exception as exc:
        logger.warning("ci-eval commit-status install lookup failed: %s", exc)
        return {"posted": False, "reason": "error"}

    if not row or row.get("installation_id") is None:
        return {"posted": False, "reason": "no_installation"}

    try:
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(int(row["installation_id"]))
        check = await oauth.create_check_run(
            token,
            owner=owner,
            repo=repo,
            payload=build_check_payload(
                head_sha=commit_sha,
                ok=ok,
                summary_md=summary_md,
                details_url=details_url,
            ),
        )
        return {"posted": True, "check_run_id": check.get("id")}
    except GitHubAPIError as exc:
        logger.warning("ci-eval create_check_run failed: %s", exc)
        return {"posted": False, "reason": "error"}
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("ci-eval commit-status unexpected failure: %s", exc)
        return {"posted": False, "reason": "error"}


__all__ = ["post_commit_status", "build_check_payload"]
