"""Per-org provider factory — Cat 23 Phase 2A tenant safety.

Resolves :class:`PRProvider` / :class:`RepoProvider` from the
org's active ``repo_connections`` row and a GitHub App
installation token. Falls back to env-based defaults /
:class:`LocalPRProvider` / :class:`LocalRepoProvider` only when
the org has no connection or ``EDEN_PR_PROVIDER=local``.

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


async def active_repo_connection(org_id: str) -> dict[str, Any] | None:
    """Return the org's newest active ``repo_connections`` row, or ``None``.

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
    try:
        async with client.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT installation_id, repo_full_name, provider, id
                FROM repo_connections
                WHERE org_id = $1 AND status = 'active'
                ORDER BY created_at DESC
                LIMIT 1
                """,
                org_id,
            )
        return dict(row) if row else None
    except Exception as exc:
        logger.debug(
            "factory: active repo_connections lookup for org=%s failed: %s",
            org_id, exc,
        )
        return None


async def resolve_active_repo_id(org_id: str) -> str | None:
    """Return the org's active ``repo_connections`` id (or full name), else None.

    Intentionally does **not** fall back to an Eden ``agent_id`` — that field
    is an agent identifier, not a GitHub/repo connection id.
    """
    try:
        conn = await active_repo_connection(org_id)
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
            installation_id, exc,
        )
        return None


async def get_pr_provider_for_org(org_id: str) -> PRProvider:
    """Return a :class:`PRProvider` scoped to ``org_id``'s active repo.

    Resolution order:

    1. ``EDEN_PR_PROVIDER=local`` → :class:`LocalPRProvider`.
    2. Active ``repo_connections`` row with a mintable installation
       token → :class:`GitHubPRProvider` for that ``repo_full_name``.
    3. Otherwise → :func:`get_default_pr_provider` (env token/repo
       or local fallback).
    """
    if _force_local():
        return LocalPRProvider(
            repo_path=os.environ.get("EDEN_LOCAL_REPO_PATH") or None,
        )

    conn = await active_repo_connection(org_id)
    if conn is not None:
        installation_id = conn.get("installation_id")
        repo_full_name = (conn.get("repo_full_name") or "").strip()
        if installation_id and repo_full_name and "/" in repo_full_name:
            token = await _mint_installation_token(installation_id)
            if token:
                return GitHubPRProvider(token=token, repo=repo_full_name)
            logger.debug(
                "factory: get_pr_provider_for_org(%s) could not mint token; "
                "falling back to defaults",
                org_id,
            )

    return get_default_pr_provider()


async def get_repo_provider_for_org(org_id: str) -> RepoProvider:
    """Return a :class:`RepoProvider` scoped to ``org_id``'s active repo.

    Same resolution order as :func:`get_pr_provider_for_org`, but
    returns the read-side :class:`GitHubRepoProvider` /
    :class:`LocalRepoProvider`.
    """
    if _force_local():
        return LocalRepoProvider(
            repo_path=os.environ.get("EDEN_LOCAL_REPO_PATH") or None,
        )

    conn = await active_repo_connection(org_id)
    if conn is not None:
        installation_id = conn.get("installation_id")
        repo_full_name = (conn.get("repo_full_name") or "").strip()
        if installation_id and repo_full_name and "/" in repo_full_name:
            token = await _mint_installation_token(installation_id)
            if token:
                return GitHubRepoProvider(token=token, repo=repo_full_name)
            logger.debug(
                "factory: get_repo_provider_for_org(%s) could not mint token; "
                "falling back to defaults",
                org_id,
            )
        # Local-style connection: repo_full_name may be a filesystem path.
        provider_name = (conn.get("provider") or "").strip().lower()
        if provider_name == "local" and repo_full_name:
            return LocalRepoProvider(repo_path=repo_full_name)

    return get_default_repo_provider()


__all__ = [
    "active_repo_connection",
    "resolve_active_repo_id",
    "get_pr_provider_for_org",
    "get_repo_provider_for_org",
]
