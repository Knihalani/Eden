"""PRCreator — open a real PR against the customer's repo.

Creates a branch (``eden/auto-fix-<trace_id_short>``), commits
the patch (signed commit via the GitHub App's bot identity),
opens a PR with:

* **Title:** ``[Eden Agent] Fix: <short description>`` (the
  agent's persona, not ``"[Eden] Auto-fix"`` — Eden is a team
  member, not a bot).
* **Body:** the 4-paragraph explanation (from
  :class:`PRExplanationService`), the test results, the
  blast-radius, the quality score, the cost-savings
  prediction, and a "Eden will auto-revert this PR <hours>
  after merge if the following metrics regress by <pct>%"
  callout.
* **Labels:** ``eden-agent``, ``auto-revertable`` (if
  ``auto_revert_enabled=true``), ``needs-review``, the RCA
  category.
* **Reviewers:** ``required_reviewers`` from the policy + the
  CODEOWNERS for the touched files + the user who originated
  the trace.

STUB mode (Gate 4a — manual end-to-end) returns the
not-implemented envelope. The user-triggered "Propose code
fix" + "Open PR" flow opens a real PR against a test repo
once Gate 4a ships.

**Provider delegation (v1.7).** The creator now exposes a
``self._provider: PRProvider`` (from
:mod:`eden.providers.pr`). The Cat 23 STUB surface
delegates the actual ``create_pr`` call to the provider
so the agent-suggest flow + the Cat 23 surface share the
same write-side abstraction.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from eden.providers import (
    FileEntry,
    PRCreateRequest,
    PRProvider,
)

from ._common import (
    _check_two_stage_optin,
    _error_envelope,
    _insert_row,
    _new_id,
    _ok_envelope,
    _select_one,
    _select_rows,
)


def _parse_unified_diff(diff: str) -> list[FileEntry]:
    """Parse a unified diff into FileEntry records.

    Each ``+++ b/<path>`` line starts a new file. Following ``+``/``-``
    lines are collected as the diff body for that path. The parser
    is intentionally minimal — it doesn't reconstruct full file
    contents, it just packages the per-file diff hunks for the PR
    provider to apply.

    Returns an empty list when the diff can't be parsed.
    """
    if not diff:
        return []
    entries: list[FileEntry] = []
    current_path: str | None = None
    current_lines: list[str] = []
    for raw_line in diff.splitlines():
        line = raw_line.rstrip()
        if line.startswith("+++ b/"):
            if current_path is not None:
                body = "\n".join(current_lines)
                entries.append(
                    FileEntry(
                        path=current_path,
                        content=body,
                        size=len(body.encode("utf-8")),
                        sha="",
                    )
                )
            current_path = line[len("+++ b/"):].strip()
            current_lines = []
        elif line.startswith("--- "):
            # Skip — the a/ path is the original, not what we commit.
            continue
        elif current_path is not None:
            current_lines.append(line)
    if current_path is not None:
        body = "\n".join(current_lines)
        entries.append(
            FileEntry(
                path=current_path,
                content=body,
                size=len(body.encode("utf-8")),
                sha="",
            )
        )
    return entries


async def _load_patch_for_pr(org_id: str, patch_id: str) -> dict[str, Any] | None:
    """Load the patch row from ``proposed_patches`` for the PR creator.

    Returns the full row including the diff + repo_id + base_sha, or
    ``None`` if the patch doesn't exist (the caller converts that
    to a 404-style envelope).
    """
    return await _select_one(
        org_id,
        "proposed_patches",
        where="id = $2",
        params=(patch_id,),
    )

logger = logging.getLogger(__name__)


class PRCreator:
    """Create a branch + commit + PR on the customer's repo."""

    name = "pr_creator"

    def __init__(
        self,
        provider: PRProvider | None = None,
    ) -> None:
        # Explicit override (tests / callers). When ``None``,
        # :meth:`create` resolves a per-org provider via
        # :func:`eden.providers.factory.get_pr_provider_for_org`.
        self._provider = provider

    async def _resolve_provider(self, org_id: str) -> PRProvider:
        """Return the injected provider or an org-scoped factory result."""
        if self._provider is not None:
            return self._provider
        from eden.providers.factory import get_pr_provider_for_org
        return await get_pr_provider_for_org(org_id)

    async def create(
        self,
        org_id: str,
        patch_id: str,
        policy: dict[str, Any],
        *,
        req: PRCreateRequest | None = None,
        pr_patterns: dict[str, Any] | None = None,
        action_kind: str = "manual_open_pr",
    ) -> dict[str, Any]:
        """Create the branch, commit, and open the PR.

        Cat 23 destructive-route path (no ``req``): opt-in
        check fires FIRST. Admin manual open (default
        ``action_kind="manual_open_pr"``) only requires
        ``code_change_enabled``. Automated callers pass
        ``action_kind="open_pr"`` to also require
        ``auto_pr_enabled``. On success, delegates to the
        :class:`PRProvider` and persists the result to
        ``pull_requests``.

        Agent-suggest path (``req`` provided): bypasses
        opt-in (the human clicking "open PR" IS the opt-in),
        delegates to the provider, returns the
        :class:`PullRequestInfo`.

        ``pr_patterns`` (optional) supplies the title format
        + body template + labels from the PRPatternService.
        Without it, defaults are used.
        """
        provider = await self._resolve_provider(org_id)
        if req is None:
            optin = _check_two_stage_optin(
                self.name, policy, action_kind,
            )
            if optin is not None:
                return optin
            # Load the patch row so we know which repo + files to commit.
            patch = await _load_patch_for_pr(org_id, patch_id)
            if patch is None:
                return _error_envelope(
                    self.name,
                    message=(
                        f"Patch {patch_id} not found in proposed_patches. "
                        "Generate a patch first via PatchGenerator."
                    ),
                    error_code="patch_not_found",
                    data={"patch_id": patch_id},
                )
            repo_id = patch.get("repo_id") or ""
            if not repo_id:
                return _error_envelope(
                    self.name,
                    message=(
                        f"Patch {patch_id} has no repo_id — connect the "
                        "repo via RepoConnector before opening a PR."
                    ),
                    error_code="repo_not_connected",
                    data={"patch_id": patch_id},
                )
            if pr_patterns is None:
                pr_patterns = {}
            files = _parse_unified_diff(patch.get("diff") or "")
            if not files:
                return _error_envelope(
                    self.name,
                    message=(
                        f"Patch {patch_id} has an empty diff — nothing "
                        "to commit. Re-run PatchGenerator."
                    ),
                    error_code="empty_diff",
                    data={"patch_id": patch_id},
                )
            title_format = (
                pr_patterns.get("title_format")
                or f"[Eden Agent] Fix {patch_id[:8]}"
            )
            body = (
                pr_patterns.get("body_template")
                or (
                    f"## Auto-generated patch\n\n"
                    f"- **Patch ID:** `{patch_id}`\n"
                    f"- **Trace:** `{patch.get('trace_id', 'n/a')}`\n"
                    f"- **RCA:** `{patch.get('rca_id', 'n/a')}`\n"
                    f"- **Quality score:** {patch.get('quality_score', 0):.2f}\n"
                    f"\n### Explanation\n\n{patch.get('explanation') or '_No explanation provided._'}\n"
                )
            )
            branch_prefix = pr_patterns.get("common_branch_prefix") or "eden/auto-fix"
            branch = f"{branch_prefix}-{patch_id[:12]}"
            req = PRCreateRequest(
                title=title_format,
                body=body,
                branch=branch,
                base=patch.get("base_sha") or "main",
                draft=True,
                repo_id=repo_id,
                files=files,
            )
            try:
                info = await provider.create_pr(req)
            except NotImplementedError as exc:
                return _error_envelope(
                    self.name,
                    message=(
                        f"PR provider not configured: {exc}"
                    ),
                    error_code="provider_not_implemented",
                    data={
                        "patch_id": patch_id,
                        "provider": provider.name,
                    },
                )
            except Exception as exc:
                return _error_envelope(
                    self.name,
                    message=f"PR create failed for {patch_id}: {exc}",
                    error_code="create_failed",
                    data={"patch_id": patch_id, "error": str(exc)},
                )
            await self._persist_pr(org_id, patch_id, info, req)
            return {
                "status": "ok",
                "feature": self.name,
                "live": True,
                "trace_id": _new_id("live"),
                "timestamp": None,
                "data": {
                    "patch_id": patch_id,
                    "pr": {
                        "number": info.number,
                        "title": info.title,
                        "branch": info.branch,
                        "base": info.base,
                        "url": info.url,
                        "state": info.state,
                        "created_at": info.created_at.isoformat(),
                    },
                },
            }
        # Agent-suggest path: ``req`` provided by the caller.
        # CODEOWNERS lookup is meaningful only when the
        # request carries files (the touched paths).
        if req.files:
            file_paths = [f.path for f in req.files if f.path]
            codeowners = await self.resolve_codeowners_reviewers(
                org_id, file_paths,
            )
            if codeowners:
                req = self.attach_codeowners_reviewers(req, codeowners)
        try:
            info = await provider.create_pr(req)
        except NotImplementedError as exc:
            return _error_envelope(
                self.name,
                message=(
                    f"PR provider not configured: {exc}"
                ),
                error_code="provider_not_implemented",
                data={
                    "patch_id": patch_id,
                    "provider": provider.name,
                },
            )
        await self._persist_pr(org_id, patch_id, info, req)
        return {
            "status": "ok",
            "feature": self.name,
            "live": True,
            "trace_id": _new_id("live"),
            "timestamp": None,
            "data": {
                "patch_id": patch_id,
                "pr": {
                    "number": info.number,
                    "title": info.title,
                    "branch": info.branch,
                    "base": info.base,
                    "url": info.url,
                    "state": info.state,
                    "created_at": info.created_at.isoformat(),
                },
            },
        }

    async def _persist_pr(
        self,
        org_id: str,
        patch_id: str,
        info: Any,
        req: PRCreateRequest,
    ) -> None:
        """Write the PR result to the ``pull_requests`` table."""
        pr_id = _new_id("pr")
        try:
            await _insert_row(
                org_id,
                "pull_requests",
                [
                    "id",
                    "repo_id",
                    "patch_id",
                    "pr_url",
                    "pr_number",
                    "base_branch",
                    "head_branch",
                    "state",
                    "labels",
                    "reviewers",
                ],
                [
                    pr_id,
                    getattr(req, "repo_id", "") or "",
                    patch_id,
                    getattr(info, "url", "") or "",
                    getattr(info, "number", None),
                    getattr(info, "base", "main") or "main",
                    getattr(info, "branch", req.branch) or "",
                    getattr(info, "state", "open") or "open",
                    json.dumps(getattr(req, "labels", []) or []),
                    json.dumps(getattr(req, "reviewers", []) or []),
                ],
            )
        except Exception as exc:
            # Surface the persistence failure — previously debug-only,
            # which let the API claim success while the row was dropped.
            # Audit trail must match operator-visible status.
            logger.warning(
                "pr_creator: persistence failed for patch_id=%s pr_id=%s: %s",
                patch_id, pr_id, exc,
            )

    @property
    def provider_name(self) -> str:
        """The provider name (``"local"``, ``"github"``).

        When no provider was injected, returns ``"unresolved"``
        until :meth:`create` resolves a per-org provider.
        """
        if self._provider is None:
            return "unresolved"
        return self._provider.name

    # ── CODEOWNERS reviewer resolution (Gate 4a) ─────────────

    async def resolve_codeowners_reviewers(
        self,
        org_id: str,
        file_paths: list[str],
    ) -> list[str]:
        """Return the CODEOWNERS owners for ``file_paths``.

        ``org_id`` is required so the connector routes to the
        org's connected repo (multi-tenant isolation).

        Best-effort: when the connector fails to read
        CODEOWNERS (no repo connected, no CODEOWNERS file,
        etc.), returns an empty list. The caller is
        responsible for the fallback (the human or the
        ``required_reviewers`` policy field).
        """
        if not file_paths:
            return []
        try:
            from .repo_connector import RepoConnector
            connector = RepoConnector()
            owners_resp = await connector.owners_for_files(
                org_id, file_paths,
            )
            owners_map = (owners_resp.get("data") or {}).get("owners") or {}
        except Exception as exc:
            logger.debug(
                "pr_creator: CODEOWNERS resolve failed: %s", exc,
            )
            return []
        # Flatten + dedupe. ``owners_for_files`` returns
        # ``{path: [owner1, owner2, ...]}``; we take the
        # union across all files so every required
        # reviewer is on the PR.
        seen: set[str] = set()
        flat: list[str] = []
        for owners in owners_map.values():
            for owner in owners:
                if owner and owner not in seen:
                    seen.add(owner)
                    flat.append(owner)
        return flat

    def attach_codeowners_reviewers(
        self,
        req: PRCreateRequest,
        codeowners: list[str],
    ) -> PRCreateRequest:
        """Return a new request with CODEOWNERS merged into reviewers.

        The provider's ``create_pr`` takes the ``reviewers``
        list verbatim; we want the union of any
        human-supplied reviewers + the CODEOWNERS. Duplicate
        owners are de-duped; the policy-required reviewers
        come first so they appear at the top of GitHub's
        reviewer list.
        """
        if not codeowners:
            return req
        merged = list(req.reviewers) + [
            o for o in codeowners if o not in req.reviewers
        ]
        return PRCreateRequest(
            title=req.title,
            body=req.body,
            branch=req.branch,
            base=req.base,
            labels=req.labels,
            reviewers=merged,
            draft=req.draft,
            files=req.files,
            commit_message=req.commit_message,
            repo_id=req.repo_id,
        )

    # ── Read side (real, queries ``pull_requests`` table) ──────────

    async def list_prs(
        self,
        org_id: str,
        *,
        repo_id: str | None = None,
        state: str = "open",
        limit: int = 50,
    ) -> dict[str, Any]:
        """List PRs from the ``pull_requests`` table, filtered by org/repo/state."""
        where_parts: list[str] = []
        params: list[Any] = []
        if state in {"open", "merged", "closed"}:
            where_parts.append("state = $2")
            params.append(state)
        if repo_id is not None:
            param_idx = len(params) + 2
            where_parts.append(f"repo_id = ${param_idx}")
            params.append(repo_id)
        where_clause = " AND ".join(where_parts) if where_parts else ""
        rows = await _select_rows(
            org_id,
            "pull_requests",
            where=where_clause,
            params=tuple(params),
            order_by="created_at DESC",
            limit=limit,
        )
        prs = [self._pr_row_to_dict(r) for r in rows]
        return _ok_envelope(
            self.name,
            {"prs": prs, "count": len(prs), "state": state},
        )

    async def get_pr(
        self, org_id: str, pr_id: str,
    ) -> dict[str, Any]:
        """Get a single PR from the ``pull_requests`` table."""
        row = await _select_one(
            org_id,
            "pull_requests",
            where="id = $2",
            params=(pr_id,),
        )
        if row is None:
            return _ok_envelope(
                self.name,
                {"pr_id": pr_id, "found": False},
            )
        d = self._pr_row_to_dict(row)
        d["found"] = True
        return _ok_envelope(self.name, d)

    @staticmethod
    def _pr_row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
        """Map a ``pull_requests`` row to the PR payload shape."""
        return {
            "pr_id": row["id"],
            "repo_id": row["repo_id"],
            "patch_id": row["patch_id"],
            "pr_url": row.get("pr_url") or "",
            "pr_number": row.get("pr_number"),
            "base_branch": row.get("base_branch"),
            "head_branch": row.get("head_branch") or "",
            "state": row.get("state") or "open",
            "merged_at": row["merged_at"].isoformat() if row.get("merged_at") else None,
            "merged_by": row.get("merged_by"),
            "labels": row.get("labels") or [],
            "reviewers": row.get("reviewers") or [],
            "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
        }
