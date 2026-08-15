"""Issue → plan trigger — re-export from improvement (N23)."""

from __future__ import annotations

from eden.improvement.issue_patch_trigger import (  # noqa: F401
    propose_patch_for_action,
    propose_patch_for_issue,
    propose_plan_for_issue,
)

__all__ = [
    "propose_patch_for_action",
    "propose_patch_for_issue",
    "propose_plan_for_issue",
]
