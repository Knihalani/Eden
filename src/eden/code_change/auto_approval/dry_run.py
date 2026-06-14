"""AutoApprovalDryRunService — replay the last 30 days through the rule.

The dry-run mode that lets admins see the impact BEFORE flipping
``auto_approval.enabled`` to ``true``. The service replays the
last 30 days of proposed patches through the rule evaluator and
returns:

* ``total_patches_evaluated``: int
* ``would_have_auto_approved``: int
* ``would_have_blocked_by_threshold``: dict of ``field → count``
* ``would_have_blocked_by_protected_paths``: int
* ``would_have_blocked_by_first_pr_to_file``: int
* ``would_have_blocked_by_cool_off``: int
* ``would_have_blocked_by_rate_limit``: int
* ``estimated_time_saved_minutes``: int

The portal renders this as a bar chart + a per-condition
breakdown. The admin clicks "Enable auto-approval" to flip
the master switch.

STUB mode (Gate 4a) returns a synthetic dry-run response
derived from the (empty) proposed-patches history. The real
implementation will read the last 30 days of
``proposed_patches`` + ``auto_approval_events``.
"""

from __future__ import annotations

import logging
from typing import Any

from .._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


# Default per-patch review-time saving (seconds). The portal
# uses this to compute the ``estimated_time_saved_minutes`` bar.
_AVG_REVIEW_TIME_SECONDS = 300  # 5 min per patch


class AutoApprovalDryRunService:
    """Dry-run the auto-approval rule over the last 30 days."""

    name = "auto_approval_dry_run"

    async def run(
        self,
        org_id: str,
        requested_by_user_id: str,
        window_days: int = 30,
    ) -> dict[str, Any]:
        """Run the dry-run. STUB: zero-patches history."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "window_days": window_days,
                "total_patches_evaluated": 0,
                "would_have_auto_approved": 0,
                "would_have_blocked_by_threshold": {},
                "would_have_blocked_by_protected_paths": 0,
                "would_have_blocked_by_first_pr_to_file": 0,
                "would_have_blocked_by_cool_off": 0,
                "would_have_blocked_by_rate_limit": 0,
                "estimated_time_saved_minutes": 0,
                "dry_run_id": _new_id("aa_dr"),
                "requested_by_user_id": requested_by_user_id,
                "message": (
                    "Stub dry-run — no patches in the last "
                    f"{window_days} days. Gate 4a will replay "
                    "proposed_patches + auto_approval_events."
                ),
            },
        )
