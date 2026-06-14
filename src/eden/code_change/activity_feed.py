"""AgentActivityFeed — the public activity feed for the "Eden Agent".

Events: ``patch_proposed`` / ``patch_approved`` / ``patch_denied``
/ ``patch_edited`` / ``patch_pr_opened`` / ``patch_merged`` /
``patch_reverted`` / ``trace_diagnosed`` / ``style_profile_learned``
/ ``auto_approval_rate_limited``.

The feed is tenant-scoped and RBAC-gated (the same RBAC as the
PR Inbox). Persists to ``agent_activity_events``.

STUB mode exposes a ``GET /activity`` list endpoint that returns
an empty feed (no events have been emitted yet because no real
patches exist). The ``emit`` method is exposed for tests + future
services to call.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _new_id, _ok_envelope

logger = logging.getLogger(__name__)


# The canonical event-type vocabulary. The portal renders a
# different icon + colour for each type. Keep in sync with the
# portal's ``ActivityFeed`` component.
EVENT_TYPES: frozenset[str] = frozenset(
    {
        "patch_proposed",
        "patch_approved",
        "patch_denied",
        "patch_edited",
        "patch_pr_opened",
        "patch_merged",
        "patch_reverted",
        "trace_diagnosed",
        "style_profile_learned",
        "auto_approval_rate_limited",
    }
)


class AgentActivityFeed:
    """The agent's public activity feed in the portal."""

    name = "agent_activity_feed"

    async def list_events(self, org_id: str, limit: int = 50) -> dict[str, Any]:
        """List the recent events for the org's agent. STUB: empty list."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "events": [],
                "count": 0,
                "limit": limit,
                "message": (
                    "Stub feed — no events emitted yet. Gate 4a "
                    "will populate from agent_activity_events once "
                    "the first patch is proposed."
                ),
            },
        )

    async def emit(
        self,
        org_id: str,
        event_type: str,
        summary: str,
        deep_link: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Emit an activity-feed event. STUB: returns the live envelope.

        The real implementation will write to ``agent_activity_events``
        and (if the persona has Slack/Teams configured) post a
        notification to the relevant channel.
        """
        if event_type not in EVENT_TYPES:
            return {
                "status": "bad_request",
                "feature": self.name,
                "live": True,
                "trace_id": _new_id("live"),
                "timestamp": None,
                "data": None,
                "message": f"unknown event_type: {event_type!r}",
            }
        logger.info(
            "agent_activity_feed.emit org=%s event=%s summary=%s",
            org_id,
            event_type,
            summary,
        )
        return _ok_envelope(
            self.name,
            {
                "event_id": _new_id("act"),
                "event_type": event_type,
                "summary": summary,
                "deep_link": deep_link,
                "message": "Stub emit — Gate 4a will persist the event.",
            },
        )
