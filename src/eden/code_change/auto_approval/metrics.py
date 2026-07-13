"""AutoApprovalMetricsCollector — compute the patch metrics from a diff.

The 3 metrics:

* ``lines_changed`` — sum of ``lines_added + lines_removed`` (the
  count of ``+`` and ``-`` lines in the unified diff, ignoring
  hunk headers and context).
* ``files_changed`` — count of distinct ``+++ b/path`` headers.
* ``is_first_pr_to_file`` — bool: true if any file touched by the
  patch has ``historical_patches_count = 0`` (or no row) in
  ``codebase_knowledge_graph``. Gate 4a: queries the live table.

Reuses the ``diff_line_count`` + ``diff_files_changed`` helpers
from :mod:`eden.code_change._common`.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _ok_envelope, _select_rows, diff_files_changed, diff_line_count

logger = logging.getLogger(__name__)


async def _is_first_pr_to_file(
    org_id: str,
    repo_id: str,
    file_paths: list[str],
) -> bool:
    """Return ``True`` if any file in ``file_paths`` has no prior patches.

    Queries ``codebase_knowledge_graph`` for each file. Returns ``True``
    (conservative) when:

    * the table has no row for the file (never touched), OR
    * ``historical_patches_count = 0`` for any file.

    Falls back to ``True`` on DB error (fail-closed: require human review
    for unknown files).
    """
    if not file_paths:
        return False  # no files changed → not first
    try:
        rows = await _select_rows(
            org_id,
            "codebase_knowledge_graph",
            where="repo_id = $2 AND historical_patches_count > 0",
            params=(repo_id,),
        )
    except Exception as exc:
        logger.debug("auto_approval.metrics: knowledge_graph query failed: %s", exc)
        return True  # fail-closed

    known_paths = {str(r.get("code_path") or "") for r in rows}
    for path in file_paths:
        if path not in known_paths:
            return True  # first patch to this file
    return False


class AutoApprovalMetricsCollector:
    """Compute the patch metrics the auto-approval rule needs."""

    name = "auto_approval_metrics"

    async def collect(
        self,
        org_id: str,
        diff: str,
        blast_radius_score: float = 0.0,
        quality_score: float = 0.0,
        rca_confidence: float = 0.0,
        repo_id: str = "",
    ) -> dict[str, Any]:
        """Compute the 3 metrics + forward the upstream scores.

        Gate 4a: ``is_first_pr_to_file`` now queries
        ``codebase_knowledge_graph`` for the changed files. Falls back
        to ``True`` (conservative) on any DB error.
        """
        file_list = diff_files_changed(diff)
        is_first = await _is_first_pr_to_file(org_id, repo_id, file_list)
        return _ok_envelope(
            self.name,
            {
                "metrics": {
                    "lines_changed": diff_line_count(diff),
                    "files_changed": len(file_list),
                    "files": file_list,
                    "is_first_pr_to_file": is_first,
                    "blast_radius_score": blast_radius_score,
                    "quality_score": quality_score,
                    "rca_confidence": rca_confidence,
                },
            },
        )
