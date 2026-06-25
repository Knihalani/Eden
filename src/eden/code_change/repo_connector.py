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

from ._common import _insert_row, _new_id, _ok_envelope, _select_one, _select_rows, _update_row
from .codeowners import CodeOwnersEntry, parse_codeowners

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
        """List the org's connected repos from the ``repo_connections`` table.

        Disconnected repos (status='disconnected') are excluded by
        default. The list of *known* PRs lives on the read provider
        side — callers that want the PR list can hit
        :meth:`list_pull_requests` on the underlying :class:`RepoProvider`.
        """
        rows = await _select_rows(
            org_id,
            "repo_connections",
            where="status != 'disconnected'",
            order_by="created_at DESC",
        )
        repos = [
            {
                "repo_id": r["id"],
                "provider": r["provider"],
                "repo_full_name": r["repo_full_name"],
                "default_branch": r["default_branch"],
                "status": r["status"],
                "connected_by_user_id": r["connected_by_user_id"],
                "connected_at": r["connected_at"].isoformat() if r.get("connected_at") else None,
                "last_synced_at": r["last_synced_at"].isoformat() if r.get("last_synced_at") else None,
            }
            for r in rows
        ]
        return _ok_envelope(
            self.name,
            {"repos": repos, "count": len(repos)},
        )

    async def get_repo(self, org_id: str, repo_id: str) -> dict[str, Any]:
        """Get a single repo connection from the ``repo_connections`` table."""
        row = await _select_one(
            org_id,
            "repo_connections",
            where="id = $2",
            params=(repo_id,),
        )
        if row is None:
            return _ok_envelope(
                self.name,
                {"repo_id": repo_id, "found": False},
            )
        return _ok_envelope(
            self.name,
            {
                "repo_id": row["id"],
                "provider": row["provider"],
                "repo_full_name": row["repo_full_name"],
                "default_branch": row["default_branch"],
                "status": row["status"],
                "installation_id": row["installation_id"],
                "connected_by_user_id": row["connected_by_user_id"],
                "connected_at": row["connected_at"].isoformat() if row.get("connected_at") else None,
                "last_synced_at": row["last_synced_at"].isoformat() if row.get("last_synced_at") else None,
                "found": True,
            },
        )

    async def disconnect(self, org_id: str, repo_id: str) -> dict[str, Any]:
        """Mark a repo as disconnected in the ``repo_connections`` table.

        Per audit: don't delete the row — it serves as the audit
        trail for who connected what, when, and why it was
        disconnected. The destructive aspect (revoking the GitHub
        App install via ``DELETE /app/installations/<id>``) is still
        gated behind Gate 1 — this method only updates the row
        status.
        """
        updated = await _update_row(
            org_id,
            "repo_connections",
            where_col="id",
            where_val=repo_id,
            set_col="status",
            set_val="disconnected",
        )
        return _ok_envelope(
            self.name,
            {
                "repo_id": repo_id,
                "disconnected": updated,
                "message": (
                    "Disconnected (status flag set). Gate 1 will revoke "
                    "the GitHub App installation token when the real "
                    "auth flow ships."
                ),
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

    # ── CODEOWNERS (Gate 1) ────────────────────────────────────

    # GitHub's documented lookup order for CODEOWNERS:
    # 1. ``.github/CODEOWNERS``
    # 2. ``CODEOWNERS`` (repo root)
    # 3. ``docs/CODEOWNERS``
    # We probe each in order and return the first non-empty match.
    _CODEOWNERS_PATHS: tuple[str, ...] = (
        ".github/CODEOWNERS",
        "CODEOWNERS",
        "docs/CODEOWNERS",
    )

    async def read_codeowners(self, org_id: str) -> dict[str, Any]:
        """Read + parse the repo's CODEOWNERS file.

        Per GitHub's lookup order, we probe three locations
        and use the first non-empty match. The response
        carries:

        * ``entries`` — the parsed ``[(pattern, owners)]`` list
        * ``source_path`` — which of the three locations was
          used (so the UI can show "this repo uses the
          root CODEOWNERS" rather than just the entries)
        * ``raw`` — the file body (capped at 256 KiB so a
          pathological CODEOWNERS file can't blow up the
          response)

        The method is read-only and side-effect free — no
        DB writes. Cat 23 Gate-1 audit: this is the only
        Gate-1 read path on the connector.

        ``org_id`` is required: the connector looks up the
        org's active ``repo_connections`` row to pick the
        correct source-control repo (a multi-repo org would
        otherwise get the platform-default repo's CODEOWNERS).

        Examples:
            >>> import asyncio
            >>> from eden.code_change.repo_connector import RepoConnector
            >>> connector = RepoConnector()
            >>> result = asyncio.run(connector.read_codeowners(org_id="demo"))
            >>> result["status"]
            'ok'
        """
        entries: list[CodeOwnersEntry] = []
        source_path = ""
        raw = ""
        provider = await self._provider_for_org(org_id)
        for candidate in self._CODEOWNERS_PATHS:
            try:
                content = await provider.read_file(candidate)
            except Exception as exc:
                logger.debug(
                    "RepoConnector.read_codeowners(%s): %s",
                    candidate, exc,
                )
                content = ""
            if content:
                entries = parse_codeowners(content)
                source_path = candidate
                # Cap the raw body — CODEOWNERS files are
                # typically <2 KiB; 256 KiB is the catastrophic
                # ceiling.
                raw = content[: 256 * 1024]
                break
        return _ok_envelope(
            self.name,
            {
                "entries": [
                    {"pattern": e.pattern, "owners": e.owners}
                    for e in entries
                ],
                "entry_count": len(entries),
                "source_path": source_path,
                "raw": raw,
                "found": bool(source_path),
                "message": (
                    "No CODEOWNERS file found at the standard "
                    "locations. The repo can still be connected, "
                    "but no reviewers will be auto-assigned."
                    if not source_path
                    else f"Loaded CODEOWNERS from {source_path!r}."
                ),
            },
        )

    async def owners_for_files(
        self, org_id: str, file_paths: list[str],
    ) -> dict[str, Any]:
        """Resolve the CODEOWNERS owner for each file path.

        Last-match-wins per GitHub semantics — when multiple
        patterns match a file, the LATER one in CODEOWNERS
        order wins. The result is a ``{path: [owners]}`` map
        suitable for reviewer assignment on a PR.

        Best-effort: if the repo has no CODEOWNERS, every
        file maps to an empty owner list and the caller is
        responsible for the fallback (manual reviewer
        assignment).

        ``org_id`` is required so the connector routes to
        the org's connected repo (multi-tenant isolation).
        """
        codeowners_resp = await self.read_codeowners(org_id)
        entries_raw = codeowners_resp.get("data", {}).get(
            "entries", [],
        )
        entries = [
            CodeOwnersEntry(pattern=e["pattern"], owners=e["owners"])
            for e in entries_raw
        ]
        from .codeowners import match_owner as _match_owner
        return _ok_envelope(
            self.name,
            {
                "owners": {
                    path: _match_owner(entries, path)
                    for path in file_paths
                },
            },
        )

    async def _provider_for_org(self, org_id: str):
        """Return a :class:`RepoProvider` scoped to ``org_id``'s active repo.

        Falls back to the default provider when the org has no
        ``repo_connections`` rows (the pre-multi-repo-isolation
        behaviour). The lookup is best-effort: a DB error logs
        at debug and falls back so a transient Postgres outage
        doesn't break read paths.
        """
        from ._common import _select_rows
        try:
            rows = await _select_rows(
                org_id,
                "repo_connections",
                where="status = 'active'",
                order_by="created_at DESC",
                limit=1,
            )
        except Exception as exc:
            logger.debug(
                "RepoConnector._provider_for_org(%s): %s", org_id, exc,
            )
            return self._provider
        if not rows:
            return self._provider
        repo = rows[0]
        # Local provider: build a fresh one with the repo's
        # working directory. GitHub provider: rebuild with
        # the token + repo from env (the env-driven factory
        # already targets the configured EDEN_GITHUB_REPO).
        from eden.providers import get_default_repo_provider
        from eden.providers.repo import LocalRepoProvider
        provider = get_default_repo_provider()
        if isinstance(provider, LocalRepoProvider):
            return LocalRepoProvider(
                repo_path=repo.get("repo_full_name") or provider.repo_path,
            )
        return provider
