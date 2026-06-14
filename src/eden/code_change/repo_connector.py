"""RepoConnector — connect Eden to a GitHub / GitLab / Bitbucket repo.

The STUB surface accepts a repo connection request and persists a
``repo_connections`` row. The real implementation (Gate 1 — read-
only connectivity, weeks 25-26 per the v1.6 ship plan) will:

* Authenticate as a GitHub App (recommended) or OAuth App (fallback)
* Verify the install ID + repo metadata
* Read CODEOWNERS via the GitHub API
* Verify the ``git`` binary is in the runner
* Persist the install ID + repo metadata to ``repo_connections``

In STUB mode, the service:

* Validates the request body (``provider``, ``repo_full_name``,
  ``default_branch``)
* Persists a ``repo_connections`` row with ``status="pending"``
  (Gate 1 has not yet been reached)
* Returns the live envelope with the new ``repo_id``

The ``Gate 1: read-only connectivity`` exit criterion requires
this service + the :class:`CodeChangePolicyService` to return the
live envelope on ``POST /repos/connect`` and ``POST /policy``.

**Provider delegation (v1.7).** The connector now exposes a
``self._provider: RepoProvider`` (from
:mod:`eden.providers.repo`). Read operations delegate to
the provider so the Cat 23 surface + the agent-suggest
flow share the same source-control abstraction. The
``connect`` path keeps the existing ``repo_connections``
row semantics — the provider is the read side, the row
is the identity-side.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.providers import RepoProvider, get_default_repo_provider

from ._common import _insert_row, _new_id, _ok_envelope

logger = logging.getLogger(__name__)


class RepoConnector:
    """Connect Eden to a source-control repo as a first-class identity."""

    name = "repo_connector"

    def __init__(
        self,
        provider: RepoProvider | None = None,
    ) -> None:
        # Default to the platform's :func:`get_default_repo_provider`
        # so callers can override per-tenant. The local provider
        # is the dev / CI path; the GitHub provider is the
        # Cat 23 Gate-1 real-impl.
        self._provider = provider or get_default_repo_provider()

    async def connect(
        self,
        org_id: str,
        provider: str,
        repo_full_name: str,
        default_branch: str,
        connected_by_user_id: str,
    ) -> dict[str, Any]:
        """Persist a new repo connection and return the live envelope.

        STUB: validates the request, generates a deterministic
        ``repo_<uuid>`` id, persists a row, and returns the live
        envelope. The real Gate-1 implementation will additionally
        authenticate against the provider's API and read the
        CODEOWNERS file.
        """
        if provider not in {"github", "gitlab", "bitbucket"}:
            return {
                "status": "bad_request",
                "feature": self.name,
                "live": True,
                "trace_id": _new_id("live"),
                "timestamp": None,  # filled by the envelope wrapper
                "data": None,
                "message": f"unsupported provider: {provider!r}",
            }

        repo_id = _new_id("repo")
        await _insert_row(
            org_id,
            "repo_connections",
            [
                "id",
                "provider",
                "installation_id",
                "repo_full_name",
                "default_branch",
                "status",
                "connected_by_user_id",
            ],
            [
                repo_id,
                provider,
                "stub_installation",  # Gate-1 will read the real install id
                repo_full_name,
                default_branch,
                "pending",  # Gate-1 will flip to "active"
                connected_by_user_id,
            ],
        )

        return _ok_envelope(
            self.name,
            {
                "repo_id": repo_id,
                "provider": provider,
                "repo_full_name": repo_full_name,
                "default_branch": default_branch,
                "status": "pending",
                "message": (
                    "Stub connection persisted. Gate 1 (read-only "
                    "connectivity) will verify the install against "
                    "the provider and flip status to 'active'."
                ),
            },
        )

    async def list_repos(self, org_id: str) -> dict[str, Any]:
        """List the org's connected repos. STUB: returns an empty list.

        The list of *connected* repos is identity-side (the
        ``repo_connections`` table). The list of *known* PRs
        lives on the read provider side — callers that want
        the PR list can hit :meth:`list_pull_requests` on the
        underlying :class:`RepoProvider`.
        """
        return _ok_envelope(
            self.name,
            {
                "repos": [],
                "count": 0,
                "message": (
                    "Stub list — Gate 1 will read from the "
                    "repo_connections table once the real "
                    "GitHub-App auth flow ships."
                ),
            },
        )

    async def get_repo(self, org_id: str, repo_id: str) -> dict[str, Any]:
        """Get a single repo connection. STUB: returns the id only."""
        return _ok_envelope(
            self.name,
            {
                "repo_id": repo_id,
                "status": "pending",
                "message": "Stub read — Gate 1 will return the full row.",
            },
        )

    async def disconnect(self, org_id: str, repo_id: str) -> dict[str, Any]:
        """Disconnect a repo. STUB: returns a live envelope with a no-op marker.

        The destructive aspect (revoking the GitHub App install) is
        gated behind Gate 1 — the real implementation will POST
        ``DELETE /app/installations/<id>`` to the GitHub API. In
        STUB mode the call is a logged no-op.
        """
        return _ok_envelope(
            self.name,
            {
                "repo_id": repo_id,
                "disconnected": True,
                "message": "Stub disconnect — Gate 1 will revoke the install.",
            },
        )

    # ── Provider delegation (v1.7) ──────────────────────────

    async def list_files(
        self, path_glob: str = "**/*",
    ) -> list[dict[str, Any]]:
        """List files via the underlying :class:`RepoProvider`."""
        entries = await self._provider.list_files(path_glob=path_glob)
        return [
            {"path": e.path, "size": e.size, "sha": e.sha}
            for e in entries
        ]

    async def read_file(self, path: str) -> str:
        """Read a file via the underlying :class:`RepoProvider`."""
        return await self._provider.read_file(path)

    async def get_default_branch(self) -> str:
        """The default branch via the underlying :class:`RepoProvider`."""
        return await self._provider.get_default_branch()

    async def list_pull_requests(
        self, state: str = "open", limit: int = 50,
    ) -> list[dict[str, Any]]:
        """List PRs via the underlying :class:`RepoProvider`."""
        prs = await self._provider.list_pull_requests(
            state=state, limit=limit,
        )
        return [
            {
                "number": p.number,
                "title": p.title,
                "branch": p.branch,
                "base": p.base,
                "url": p.url,
                "state": p.state,
                "created_at": p.created_at.isoformat(),
            }
            for p in prs
        ]

    @property
    def provider_name(self) -> str:
        """The provider name (``"local"``, ``"github"``)."""
        return self._provider.name
