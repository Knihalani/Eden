"""Per-org provider factory — Cat 23 Phase 2A tenant safety.

Resolves :class:`PRProvider` / :class:`RepoProvider` from the
org's active ``repo_connections`` row and a GitHub App
installation token. Falls back to env-based defaults /
:class:`LocalPRProvider` / :class:`LocalRepoProvider` only when
the org has no connection or ``EDEN_PR_PROVIDER=local``.

When an active connection exists but the installation token
cannot be minted, resolution **fail-closes** (raises
:class:`RepoConnectionError`) instead of falling back to
``EDEN_GITHUB_TOKEN`` / Local — so tenant approve never opens
a PR on the wrong repo.

Call sites that previously used :func:`get_default_pr_provider`
/ :func:`get_default_repo_provider` for multi-tenant work
should prefer these helpers so installation tokens never
leak across orgs.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from .pr import (
    GitHubPRProvider,
    LocalPRProvider,
    PRProvider,
    get_default_pr_provider,
)
from .repo import (
    GitHubRepoProvider,
    LocalRepoProvider,
    RepoProvider,
    get_default_repo_provider,
)

logger = logging.getLogger(__name__)


class RepoConnectionError(RuntimeError):
    """Active repo connection cannot be used (e.g. mint failed)."""

    def __init__(self, reason: str, *, org_id: str | None = None) -> None:
        self.reason = reason
        self.org_id = org_id
        super().__init__(reason)


async def active_repo_connection(
    org_id: str,
    *,
    agent_id: str | None = None,
) -> dict[str, Any] | None:
    """Return the active ``repo_connections`` row for this org (and agent).

    Prefer an agent-scoped link when ``agent_id`` is set. Fall back to the
    newest org-level active row (``agent_id IS NULL``) for legacy connects
    that predate per-agent linking.

    Best-effort: a missing Postgres client or query error returns
    ``None`` so callers can fall back to the env/local defaults
    without raising into the request path.
    """
    if not org_id:
        return None
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("factory: postgres import failed: %s", exc)
        return None
    try:
        client = await get_postgres_client()
    except Exception as exc:
        logger.debug("factory: get_postgres_client failed: %s", exc)
        return None
    if client is None:
        return None
    aid = (agent_id or "").strip() or None
    try:
        async with client.acquire() as conn:
            if aid:
                row = await conn.fetchrow(
                    """
                    SELECT installation_id, repo_full_name, default_branch,
                           provider, id, org_id, status, agent_id
                    FROM repo_connections
                    WHERE org_id = $1
                      AND status = 'active'
                      AND agent_id = $2
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    org_id,
                    aid,
                )
                if row:
                    return dict(row)
                # Legacy: org-wide active row (no agent_id) as fallback.
                row = await conn.fetchrow(
                    """
                    SELECT installation_id, repo_full_name, default_branch,
                           provider, id, org_id, status, agent_id
                    FROM repo_connections
                    WHERE org_id = $1
                      AND status = 'active'
                      AND (agent_id IS NULL OR agent_id = '')
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    org_id,
                )
                return dict(row) if row else None

            row = await conn.fetchrow(
                """
                SELECT installation_id, repo_full_name, default_branch,
                       provider, id, org_id, status, agent_id
                FROM repo_connections
                WHERE org_id = $1 AND status = 'active'
                ORDER BY
                    CASE WHEN agent_id IS NULL OR agent_id = '' THEN 0 ELSE 1 END,
                    created_at DESC
                LIMIT 1
                """,
                org_id,
            )
        return dict(row) if row else None
    except Exception as exc:
        logger.debug(
            "factory: active repo_connections lookup for org=%s agent=%s failed: %s",
            org_id,
            aid,
            exc,
        )
        return None


async def resolve_active_repo_id(
    org_id: str,
    *,
    agent_id: str | None = None,
) -> str | None:
    """Return the active ``repo_connections`` id (or full name), else None.

    When ``agent_id`` is set, resolves that agent's linked repo. Does **not**
    treat ``agent_id`` itself as a repo connection id.
    """
    try:
        conn = await active_repo_connection(org_id, agent_id=agent_id)
    except Exception as exc:
        logger.debug("resolve_active_repo_id: lookup failed: %s", exc)
        return None
    if not conn:
        return None
    rid = conn.get("id")
    if rid is not None and str(rid).strip():
        return str(rid)
    name = (conn.get("repo_full_name") or "").strip()
    return name or None


def _force_local() -> bool:
    """True when ops explicitly force the offline / local provider path."""
    return os.environ.get("EDEN_PR_PROVIDER", "").strip().lower() == "local"


async def _mint_installation_token(installation_id: str | int) -> str | None:
    """Mint a GitHub App installation token, or ``None`` on failure."""
    try:
        from eden.integrations.github import GitHubOAuthClient, is_configured
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("factory: github import failed: %s", exc)
        return None
    if not is_configured():
        logger.debug(
            "factory: GitHub App not configured; cannot mint installation token",
        )
        return None
    try:
        oauth = GitHubOAuthClient()
        token = await oauth.installation_token(int(installation_id))
        return token.token
    except Exception as exc:
        logger.warning(
            "factory: installation_token(%s) failed: %s",
            installation_id,
            exc,
        )
        return None


def _github_connection_fields(conn: dict[str, Any]) -> tuple[Any, str] | None:
    """Return ``(installation_id, repo_full_name)`` when the row is GitHub-shaped."""
    installation_id = conn.get("installation_id")
    repo_full_name = (conn.get("repo_full_name") or "").strip()
    if installation_id and repo_full_name and "/" in repo_full_name:
        return installation_id, repo_full_name
    return None


async def get_pr_provider_for_org(
    org_id: str,
    *,
    agent_id: str | None = None,
) -> PRProvider:
    """Return a :class:`PRProvider` scoped to ``org_id``'s active repo.

    Resolution order:

    1. ``EDEN_PR_PROVIDER=local`` → :class:`LocalPRProvider`.
    2. Active ``repo_connections`` row with a mintable installation
       token → :class:`GitHubPRProvider` for that ``repo_full_name``.
    3. Active connection but mint fails → raise
       :class:`RepoConnectionError` (fail closed; no env/Local fallback).
    4. Otherwise → :func:`get_default_pr_provider` (env token/repo
       or local fallback).
    """
    if _force_local():
        return LocalPRProvider(
            repo_path=os.environ.get("EDEN_LOCAL_REPO_PATH") or None,
        )

    conn = await active_repo_connection(org_id, agent_id=agent_id)
    if conn is not None:
        fields = _github_connection_fields(conn)
        if fields is not None:
            installation_id, repo_full_name = fields
            token = await _mint_installation_token(installation_id)
            if token:
                return GitHubPRProvider(token=token, repo=repo_full_name)
            logger.warning(
                "factory: get_pr_provider_for_org(%s) could not mint token; "
                "fail-closed (no env/Local fallback)",
                org_id,
            )
            raise RepoConnectionError(
                "Could not mint GitHub App installation token for the " "active repo connection",
                org_id=org_id,
            )

    return get_default_pr_provider()


async def get_repo_provider_for_org(
    org_id: str,
    *,
    agent_id: str | None = None,
) -> RepoProvider:
    """Return a :class:`RepoProvider` scoped to ``org_id``'s active repo.

    Same resolution order as :func:`get_pr_provider_for_org`, but
    returns the read-side :class:`GitHubRepoProvider` /
    :class:`LocalRepoProvider`. Local-style ``repo_connections``
    rows (``provider=local``) still resolve to Local without minting.
    """
    if _force_local():
        return LocalRepoProvider(
            repo_path=os.environ.get("EDEN_LOCAL_REPO_PATH") or None,
        )

    conn = await active_repo_connection(org_id, agent_id=agent_id)
    if conn is not None:
        provider_name = (conn.get("provider") or "").strip().lower()
        repo_full_name = (conn.get("repo_full_name") or "").strip()
        if provider_name == "local" and repo_full_name:
            return LocalRepoProvider(repo_path=repo_full_name)

        fields = _github_connection_fields(conn)
        if fields is not None:
            installation_id, repo_full_name = fields
            token = await _mint_installation_token(installation_id)
            if token:
                return GitHubRepoProvider(token=token, repo=repo_full_name)
            logger.warning(
                "factory: get_repo_provider_for_org(%s) could not mint token; "
                "fail-closed (no env/Local fallback)",
                org_id,
            )
            raise RepoConnectionError(
                "Could not mint GitHub App installation token for the " "active repo connection",
                org_id=org_id,
            )

    return get_default_repo_provider()


async def resolve_pr_base_branch(
    org_id: str,
    repo_provider: Any,
    *,
    agent_id: str | None = None,
) -> str:
    """Resolve the PR base branch — never invent ``main`` blindly.

    Preference order:
    1. ``repo_connections.default_branch`` when set
    2. :meth:`RepoProvider.get_default_branch`
    """
    try:
        conn = await active_repo_connection(org_id, agent_id=agent_id)
    except Exception as exc:
        logger.debug("resolve_pr_base_branch: active_repo_connection failed: %s", exc)
        conn = None
    if conn:
        branch = (conn.get("default_branch") or "").strip()
        if branch:
            return branch
    try:
        branch = await repo_provider.get_default_branch()
    except Exception as exc:
        logger.warning("resolve_pr_base_branch: get_default_branch failed: %s", exc)
        raise RuntimeError("could not resolve default branch for PR") from exc
    branch = (branch or "").strip()
    if not branch:
        raise RuntimeError("could not resolve default branch for PR")
    return branch


__all__ = [
    "RepoConnectionError",
    "active_repo_connection",
    "resolve_active_repo_id",
    "resolve_pr_base_branch",
    "get_pr_provider_for_org",
    "get_repo_provider_for_org",
]
