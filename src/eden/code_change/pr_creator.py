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

from eden.providers import PRCreateRequest, PRProvider, get_default_pr_provider

from ._common import (
    _check_two_stage_optin,
    _insert_row,
    _new_id,
    _not_implemented_envelope,
    _ok_envelope,
    _select_one,
    _select_rows,
)

logger = logging.getLogger(__name__)


class PRCreator:
    """Create a branch + commit + PR on the customer's repo."""

    name = "pr_creator"

    def __init__(
        self,
        provider: PRProvider | None = None,
    ) -> None:
        self._provider = provider or get_default_pr_provider()

    async def create(
        self,
        org_id: str,
        patch_id: str,
        policy: dict[str, Any],
        *,
        req: PRCreateRequest | None = None,
        pr_patterns: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create the branch, commit, and open the PR.

        Cat 23 destructive-route path (no ``req``): opt-in
        check fires FIRST (``code_change_enabled`` +
        ``auto_pr_enabled``). On success, delegates to the
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
        if req is None:
            optin = _check_two_stage_optin(
                self.name, policy, "open_pr",
            )
            if optin is not None:
                return optin
            if pr_patterns is None:
                pr_patterns = {}
            req = PRCreateRequest(
                title=pr_patterns.get("title_format") or "[Eden Agent] Fix",
                body=pr_patterns.get("body_template") or "",
                head=pr_patterns.get("common_branch_prefix") or "eden/auto-fix",
                base="main",
                draft=True,
                patch_id=patch_id,
                org_id=org_id,
            )
            try:
                info = await self._provider.create_pr(req)
            except NotImplementedError as exc:
                return _not_implemented_envelope(
                    self.name,
                    message=(
                        f"PR provider not configured: {exc}"
                    ),
                    gate="provider_not_implemented",
                    data={
                        "patch_id": patch_id,
                        "provider": self._provider.name,
                    },
                )
            except Exception as exc:
                return _not_implemented_envelope(
                    self.name,
                    message=f"PR create failed for {patch_id}: {exc}",
                    gate="create_failed",
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
        try:
            info = await self._provider.create_pr(req)
        except NotImplementedError as exc:
            return _not_implemented_envelope(
                self.name,
                message=(
                    f"PR provider not configured: {exc}"
                ),
                gate="provider_not_implemented",
                data={
                    "patch_id": patch_id,
                    "provider": self._provider.name,
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
                    getattr(info, "branch", req.head) or "",
                    getattr(info, "state", "open") or "open",
                    json.dumps(getattr(req, "labels", []) or []),
                    json.dumps(getattr(req, "reviewers", []) or []),
                ],
            )
        except Exception as exc:
            logger.debug("pr_creator: persistence failed: %s", exc)

    @property
    def provider_name(self) -> str:
        """The provider name (``"local"``, ``"github"``)."""
        return self._provider.name

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
