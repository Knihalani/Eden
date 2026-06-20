"""PRInboxService — the human-in-the-loop inbox for proposed patches.

The heart of the Cat 23 UX. The portal ``/agents/eden/inbox`` page
renders this service.

Endpoints:

* ``GET /inbox`` — list all proposed patches in the org, filterable
  by repo, status (``open`` / ``approved`` / ``denied`` / ``merged``
  / ``reverted`` / ``needs_revision``), RCA category, age,
  confidence, blast radius, and quality score. Sortable by
  ``priority`` (default — a composite of confidence + blast-radius
  + cost-savings), ``newest``, ``oldest``, ``quality_score``, or
  ``cost_savings``. Groupable by ``repo`` (default) or
  ``rca_category``. RBAC-gated: ``viewer`` role can see the list,
  but action buttons are disabled.
* ``GET /inbox/{patch_id}`` — the full detail view (the
  4-paragraph ``PRExplanation`` + the diff rendered in a Monaco
  editor with syntax highlighting matching the file's language,
  auto-detected from ``repo_style_profile``).
* ``GET /inbox/{patch_id}/diff`` — raw unified diff (for copy-
  paste into the customer's editor).
* ``GET /inbox/{patch_id}/style`` — the per-patch style breakdown
  (per-dimension quality score + lint violations + style-violation
  annotations).
* ``GET /inbox/stats`` — aggregate stats: ``proposed_count``,
  ``approved_count``, ``merged_count``, ``reverted_count``,
  ``avg_quality_score``, ``avg_review_time_seconds``,
  ``total_cost_savings_usd``.

STUB mode returns deterministic empty / synthetic responses. The
real Gate-4a implementation will read from ``proposed_patches``
+ ``pull_requests`` + ``revert_events`` + ``codebase_knowledge_graph``.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope, _select_one, _select_rows

logger = logging.getLogger(__name__)


# The 5 inbox statuses. Kept in sync with the portal's
# ``InboxFilterBar`` component.
INBOX_STATUSES: frozenset[str] = frozenset(
    {"open", "approved", "denied", "merged", "reverted", "needs_revision"}
)
# The 4 inbox sort options. ``priority`` is the default.
INBOX_SORTS: frozenset[str] = frozenset(
    {"priority", "newest", "oldest", "quality_score", "cost_savings"}
)
# The 2 inbox group-by options.
INBOX_GROUPINGS: frozenset[str] = frozenset({"repo", "rca_category"})


class PRInboxService:
    """The PR Inbox for the human-in-the-loop review of proposed patches."""

    name = "pr_inbox"

    async def list_inbox(
        self,
        org_id: str,
        status: str = "open",
        sort: str = "priority",
        group_by: str = "repo",
        limit: int = 50,
    ) -> dict[str, Any]:
        """List the org's proposed patches from the ``proposed_patches`` table.

        The inbox ``status`` filter maps onto the patch table's
        ``status`` column. The default 'open' maps to the
        'proposed' status (the table's default for newly-created
        rows). Filters / sorts that the DB can't honour cheaply
        (priority composite, group_by) are applied client-side
        after the DB query — that's fine for the Cat 23 v1.6
        scale (≤ ~100 patches/org).
        """
        if status not in INBOX_STATUSES:
            status = "open"
        if sort not in INBOX_SORTS:
            sort = "priority"
        if group_by not in INBOX_GROUPINGS:
            group_by = "repo"

        # Map inbox status → patch table status. ``open`` is an
        # alias for the table's default ``proposed``.
        status_filter = "proposed" if status == "open" else status
        rows = await _select_rows(
            org_id,
            "proposed_patches",
            where="status = $2",
            params=(status_filter,),
            order_by="created_at DESC",
            limit=limit,
        )

        # Patch rows for client-side priority scoring.
        if sort == "priority":
            rows.sort(
                key=lambda r: (
                    -(r.get("quality_score") or 0.0),
                    r.get("blast_radius_score") or 1.0,
                ),
            )
        elif sort == "quality_score":
            rows.sort(key=lambda r: -(r.get("quality_score") or 0.0))

        patches = [self._patch_row_to_dict(r) for r in rows]
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "status": status,
                "sort": sort,
                "group_by": group_by,
                "patches": patches,
                "count": len(patches),
                "limit": limit,
            },
        )

    async def get_patch(
        self,
        org_id: str,
        patch_id: str,
    ) -> dict[str, Any]:
        """Get the full detail view of a single patch from the DB."""
        row = await _select_one(
            org_id,
            "proposed_patches",
            where="id = $2",
            params=(patch_id,),
        )
        if row is None:
            return _ok_envelope(
                self.name,
                {"patch_id": patch_id, "found": False},
            )
        d = self._patch_row_to_dict(row)
        d["explanation"] = {
            "what_happened": row.get("description") or "",
            "why_it_happened": row.get("rca_id") or "",
            "what_patch_does": row.get("diff") or "",
            "what_to_watch": "",  # populated by PostMergeMonitor once Gate 4 ships
        }
        d["found"] = True
        return _ok_envelope(self.name, d)

    async def get_diff(
        self,
        org_id: str,
        patch_id: str,
    ) -> dict[str, Any]:
        """Return the raw unified diff for a patch."""
        row = await _select_one(
            org_id,
            "proposed_patches",
            where="id = $2",
            params=(patch_id,),
        )
        if row is None:
            return _ok_envelope(
                self.name,
                {"patch_id": patch_id, "found": False, "diff": ""},
            )
        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "diff": row.get("diff") or "",
                "language": "unknown",  # repo_style_profile not yet read (Gate 4a)
                "found": True,
            },
        )

    async def get_style(
        self,
        org_id: str,
        patch_id: str,
    ) -> dict[str, Any]:
        """Return the per-patch style breakdown."""
        row = await _select_one(
            org_id,
            "proposed_patches",
            where="id = $2",
            params=(patch_id,),
        )
        if row is None:
            return _ok_envelope(
                self.name,
                {"patch_id": patch_id, "found": False},
            )
        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "quality_breakdown": row.get("quality_breakdown") or {},
                "lint_violations": [],
                "style_violations": [],
                "found": True,
            },
        )

    async def get_stats(self, org_id: str) -> dict[str, Any]:
        """Aggregate inbox stats from ``proposed_patches`` + ``pull_requests``."""
        patch_rows = await _select_rows(
            org_id, "proposed_patches", limit=10_000,
        )
        pr_rows = await _select_rows(
            org_id, "pull_requests", limit=10_000,
        )
        by_status: dict[str, int] = {}
        for r in patch_rows:
            s = (r.get("status") or "proposed").lower()
            by_status[s] = by_status.get(s, 0) + 1
        for r in pr_rows:
            s = (r.get("state") or "open").lower()
            by_status[f"pr_{s}"] = by_status.get(f"pr_{s}", 0) + 1

        scores = [r.get("quality_score") for r in patch_rows if r.get("quality_score") is not None]
        avg_quality = (sum(scores) / len(scores)) if scores else None
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "proposed_count": by_status.get("proposed", 0),
                "approved_count": by_status.get("approved", 0),
                "denied_count": by_status.get("denied", 0) + by_status.get("rejected", 0),
                "merged_count": by_status.get("merged", 0) + by_status.get("pr_merged", 0),
                "reverted_count": by_status.get("reverted", 0),
                "needs_revision_count": by_status.get("needs_revision", 0),
                "open_pr_count": by_status.get("pr_open", 0),
                "avg_quality_score": avg_quality,
                "avg_review_time_seconds": None,
                "total_cost_savings_usd": 0.0,
            },
        )

    @staticmethod
    def _patch_row_to_dict(row: dict[str, Any]) -> dict[str, Any]:
        """Map a ``proposed_patches`` row to the inbox payload shape."""
        return {
            "patch_id": row["id"],
            "repo_id": row["repo_id"],
            "trace_id": row["trace_id"],
            "rca_id": row.get("rca_id"),
            "description": row.get("description") or "",
            "status": row["status"],
            "quality_score": row.get("quality_score"),
            "blast_radius_score": row.get("blast_radius_score"),
            "cost_usd": row.get("cost_usd"),
            "model_used": row.get("model_used"),
            "created_at": row["created_at"].isoformat() if row.get("created_at") else None,
            "updated_at": row["updated_at"].isoformat() if row.get("updated_at") else None,
        }
