"""AutoApprovalRuleService — evaluate a patch against the auto-approval policy.

Per the v1.6 cat spec, a patch is auto-approved if AND ONLY IF
**every field** in the policy's ``auto_approval`` block is
satisfied. The 12 fields (per the master doc) are:

* ``enabled`` (master switch, default ``false``)
* ``max_risk_score`` (default 0.3)
* ``max_lines_changed`` (default 50)
* ``max_files_changed`` (default 3)
* ``min_quality_score`` (default 0.9)
* ``min_rca_confidence`` (default 0.85)
* ``require_human_for_protected_paths`` (default ``true``)
* ``require_human_for_first_pr_to_file`` (default ``true``)
* ``cool_off_after_revert_hours`` (default 168 = 1 week)
* ``max_auto_approvals_per_day`` (default 20)
* ``max_auto_approvals_per_file_per_week`` (default 3)
* ``dry_run_mode`` (default ``true``)

The 4 "blocker" fields are the safety net. The 6 "threshold"
fields are the user's knobs. The default values are conservative —
auto-approvals only fire for genuinely small, low-risk,
high-quality patches.

STUB mode (Gate 4a) is a pure function: it takes the patch
metrics + the policy and returns the deterministic
``auto_approved`` boolean + the ``failing_conditions`` list. No
persistence (the real Gate-4a implementation persists to
``auto_approval_events``).
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _ok_envelope

logger = logging.getLogger(__name__)


# The 12 fields, with their types + the v0 defaults. The
# constants are the single source of truth for the policy shape.
AUTO_APPROVAL_DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "max_risk_score": 0.3,
    "max_lines_changed": 50,
    "max_files_changed": 3,
    "min_quality_score": 0.9,
    "min_rca_confidence": 0.85,
    "require_human_for_protected_paths": True,
    "require_human_for_first_pr_to_file": True,
    "cool_off_after_revert_hours": 168,
    "max_auto_approvals_per_day": 20,
    "max_auto_approvals_per_file_per_week": 3,
    "dry_run_mode": True,
}


class AutoApprovalRuleService:
    """Evaluate a patch against the org's auto-approval policy."""

    name = "auto_approval_rules"

    async def evaluate(
        self,
        org_id: str,
        patch_id: str,
        metrics: dict[str, Any],
        policy: dict[str, Any],
    ) -> dict[str, Any]:
        """Return ``auto_approved: bool`` + ``failing_conditions: list[str]``.

        STUB: pure-function evaluation; no persistence. The real
        Gate-4a implementation will additionally persist to
        ``auto_approval_events``.
        """
        cfg = {**AUTO_APPROVAL_DEFAULTS, **policy}
        failing: list[str] = []

        if not bool(cfg.get("enabled", False)):
            failing.append("auto_approval is disabled (master switch)")

        blast = float(metrics.get("blast_radius_score", 0.0))
        if blast > float(cfg["max_risk_score"]):
            failing.append(
                f"blast_radius_score {blast:.3f} > "
                f"max_risk_score {cfg['max_risk_score']:.3f}"
            )

        lines = int(metrics.get("lines_changed", 0))
        if lines > int(cfg["max_lines_changed"]):
            failing.append(
                f"lines_changed {lines} > "
                f"max_lines_changed {cfg['max_lines_changed']}"
            )

        files = int(metrics.get("files_changed", 0))
        if files > int(cfg["max_files_changed"]):
            failing.append(
                f"files_changed {files} > "
                f"max_files_changed {cfg['max_files_changed']}"
            )

        quality = float(metrics.get("quality_score", 0.0))
        if quality < float(cfg["min_quality_score"]):
            failing.append(
                f"quality_score {quality:.3f} < "
                f"min_quality_score {cfg['min_quality_score']:.3f}"
            )

        rca = float(metrics.get("rca_confidence", 0.0))
        if rca < float(cfg["min_rca_confidence"]):
            failing.append(
                f"rca_confidence {rca:.3f} < "
                f"min_rca_confidence {cfg['min_rca_confidence']:.3f}"
            )

        if bool(cfg["require_human_for_protected_paths"]) and bool(
            metrics.get("touches_protected_path", False)
        ):
            failing.append("touches_protected_path requires human review")

        if bool(cfg["require_human_for_first_pr_to_file"]) and bool(
            metrics.get("is_first_pr_to_file", True)
        ):
            failing.append("first_pr_to_file requires human review")

        return _ok_envelope(
            self.name,
            {
                "patch_id": patch_id,
                "auto_approved": len(failing) == 0,
                "failing_conditions": failing,
                "metric_snapshot": metrics,
                "policy_snapshot": cfg,
                "dry_run_mode": bool(cfg["dry_run_mode"]),
            },
        )
