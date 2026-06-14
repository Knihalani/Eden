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

from .._common import _new_id, _ok_envelope

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
        """List the org's proposed patches. STUB: returns an empty list."""
        if status not in INBOX_STATUSES:
            status = "open"
        if sort not in INBOX_SORTS:
            sort = "priority"
        if group_by not in INBOX_GROUPINGS:
            group_by = "repo"
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "status": status,
                "sort": sort,
                "group_by": group_by,
                "patches": [],
                "count": 0,
                "limit": limit,
                "message": (
                    "Stub inbox — no patches proposed yet. Gate 4a "
                    "will read from proposed_patches + pull_requests + "
                    "revert_events + codebase_knowledge_graph."
                ),
            },
        )

    async def get_patch(
        self,
        org_id: str,
        patch_id: str,
    ) -> dict[str, Any]:
        """Get the full detail view of a single patch. STUB: returns the id."""
        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "status": "open",
                "explanation": {
                    "what_happened": "Stub — no RCA linked.",
                    "why_it_happened": "Stub — no file:line linked.",
                    "what_patch_does": "Stub — no diff linked.",
                    "what_to_watch": "Stub — no post-merge monitor.",
                },
                "diff": "",
                "quality_score": None,
                "blast_radius_score": None,
                "message": "Stub detail — Gate 4a will return the full row.",
            },
        )

    async def get_diff(
        self,
        org_id: str,
        patch_id: str,
    ) -> dict[str, Any]:
        """Return the raw unified diff. STUB: empty diff."""
        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "diff": "",
                "language": "unknown",
                "message": "Stub diff — Gate 4a will return the unified diff.",
            },
        )

    async def get_style(
        self,
        org_id: str,
        patch_id: str,
    ) -> dict[str, Any]:
        """Return the per-patch style breakdown. STUB: empty breakdown."""
        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "quality_breakdown": {},
                "lint_violations": [],
                "style_violations": [],
                "message": (
                    "Stub style — Gate 4a will return the per-dimension "
                    "quality breakdown + the lint + style-violation list."
                ),
            },
        )

    async def get_stats(self, org_id: str) -> dict[str, Any]:
        """Return the aggregate stats. STUB: zero counters."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "proposed_count": 0,
                "approved_count": 0,
                "denied_count": 0,
                "merged_count": 0,
                "reverted_count": 0,
                "needs_revision_count": 0,
                "avg_quality_score": None,
                "avg_review_time_seconds": None,
                "total_cost_savings_usd": 0.0,
                "stats_id": _new_id("inbox_stats"),
                "message": (
                    "Stub stats — Gate 4a will aggregate from "
                    "proposed_patches + pull_requests + revert_events."
                ),
            },
        )
