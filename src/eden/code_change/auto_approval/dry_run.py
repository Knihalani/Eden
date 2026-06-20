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

from .._common import _not_implemented_envelope

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
        """Run the dry-run. STUB: not implemented.

        The dry-run needs to replay every ``proposed_patches``
        row in the window against the org's
        ``auto_approval_policies`` config — that's a Gate-4a
        feature (the rule evaluator + the time-saved estimator
        aren't built yet). Per the audit pass: return a clean
        ``not_implemented`` envelope with no synthesised IDs
        so the front-end can distinguish "stub" from "real but
        empty" via the envelope shape.
        """
        return _not_implemented_envelope(
            self.name,
            message=(
                "Auto-approval dry-run requires Gate 4a (the rule "
                "evaluator + time-saved estimator). STUB returns "
                "a blocked envelope with no synthetic IDs."
            ),
            gate="4a_blocked",
            data={
                "org_id": org_id,
                "window_days": window_days,
                "requested_by_user_id": requested_by_user_id,
            },
        )
