"""PRReviewerNotifier — post the PR link to Slack/Teams.

Reuses the existing :file:`src/eden/integrations/slack.py`
webhook surface. The notification template includes the RCA
category, the test pass rate, the blast radius, the estimated
cost saved (or cost incurred) per the post-merge monitor's
pre-merge baseline, and a 1-click "Pause auto-revert for 24h"
button for reviewers.

On revert: notifies the team with the revert reason + the
regression evidence + a 1-click "Investigate" button that
deep-links to the Cat 2 RCA + the :class:`PostMergeMonitor`'s
``post_merge_windows`` rows.

STUB mode (Gate 4a) returns the live envelope with the
notification payload. The real implementation will POST to
the configured Slack/Teams webhook.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


class PRReviewerNotifier:
    """Post the PR link to Slack/Teams."""

    name = "pr_reviewer_notifier"

    async def notify_pr_opened(
        self,
        org_id: str,
        pr_id: str,
        rca_category: str,
        test_pass_rate: float,
        blast_radius_score: float,
        estimated_cost_savings_usd: float,
        slack_webhook_url: str = "",
    ) -> dict[str, Any]:
        """Post the PR-opened notification. STUB: returns the payload."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "notification_id": _new_id("notif"),
                "payload": {
                    "rca_category": rca_category,
                    "test_pass_rate": test_pass_rate,
                    "blast_radius_score": blast_radius_score,
                    "estimated_cost_savings_usd": estimated_cost_savings_usd,
                    "slack_webhook_url": slack_webhook_url,
                    "buttons": [
                        {"label": "View PR", "url": f"https://example.com/pr/{pr_id}"},
                        {
                            "label": "Pause auto-revert for 24h",
                            "url": f"https://example.com/pr/{pr_id}/pause",
                        },
                    ],
                },
                "message": (
                    "Stub notification — Gate 4a will POST to the "
                    "configured Slack/Teams webhook."
                ),
            },
        )

    async def notify_revert(
        self,
        org_id: str,
        pr_id: str,
        revert_reason: str,
        regression_evidence: dict[str, Any] | None = None,
        slack_webhook_url: str = "",
    ) -> dict[str, Any]:
        """Post the revert notification. STUB: returns the payload."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "pr_id": pr_id,
                "notification_id": _new_id("notif"),
                "payload": {
                    "revert_reason": revert_reason,
                    "regression_evidence": regression_evidence or {},
                    "slack_webhook_url": slack_webhook_url,
                    "buttons": [
                        {
                            "label": "Investigate",
                            "url": (
                                f"https://example.com/rca/{org_id}?pr_id={pr_id}"
                            ),
                        },
                    ],
                },
                "message": (
                    "Stub revert notification — Gate 4a will POST "
                    "to the configured Slack/Teams webhook."
                ),
            },
        )
