"""AutoApprovalMetricsCollector — compute the patch metrics from a diff.

The 3 metrics:

* ``lines_changed`` — sum of ``lines_added + lines_removed`` (the
  count of ``+`` and ``-`` lines in the unified diff, ignoring
  hunk headers and context).
* ``files_changed`` — count of distinct ``+++ b/path`` headers.
* ``is_first_pr_to_file`` — bool: true if this is the first
  patch to this file in the repo. STUB mode returns ``True``
  because the real ``codebase_knowledge_graph`` lookup
  requires Gate 5.

Reuses the ``diff_line_count`` + ``diff_files_changed`` helpers
from :mod:`eden.code_change._common`.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope, diff_files_changed, diff_line_count

logger = logging.getLogger(__name__)


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
    ) -> dict[str, Any]:
        """Compute the 3 metrics + forward the upstream scores.

        STUB: ``is_first_pr_to_file`` defaults to ``True``
        (conservative) because the real ``codebase_knowledge_graph``
        lookup requires Gate 5.
        """
        return _ok_envelope(
            self.name,
            {
                "metrics": {
                    "lines_changed": diff_line_count(diff),
                    "files_changed": len(diff_files_changed(diff)),
                    "files": diff_files_changed(diff),
                    "is_first_pr_to_file": True,  # Gate-5 will read
                    "blast_radius_score": blast_radius_score,
                    "quality_score": quality_score,
                    "rca_confidence": rca_confidence,
                },
                "metrics_id": _new_id("aa_mtr"),
                "message": (
                    "Stub metrics — is_first_pr_to_file defaults to "
                    "True because the real codebase_knowledge_graph "
                    "lookup requires Gate 5."
                ),
            },
        )
