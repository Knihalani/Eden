"""AgentActivityFeed — the public activity feed for the "Eden Agent".

Events: ``patch_proposed`` / ``patch_approved`` / ``patch_denied``
/ ``patch_edited`` / ``patch_pr_opened`` / ``patch_merged`` /
``patch_reverted`` / ``trace_diagnosed`` / ``style_profile_learned``
/ ``auto_approval_rate_limited``.

The feed is tenant-scoped and RBAC-gated (the same RBAC as the
PR Inbox). Persists to ``agent_activity_events`` (migration 095).

Gate 4a: ``emit`` writes to ``agent_activity_events``; ``list_events``
reads from it. Both fall back gracefully when Postgres is unavailable.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _insert_row, _json_dumps, _new_id, _ok_envelope, _select_rows

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
        """List recent events from ``agent_activity_events``."""
        rows = await _select_rows(
            org_id,
            "agent_activity_events",
            order_by="created_at DESC",
            limit=limit,
        )
        events = [
            {
                "event_id": r.get("id"),
                "event_type": r.get("event_type"),
                "summary": r.get("summary", ""),
                "deep_link": r.get("deep_link", ""),
                "metadata": r.get("metadata") or {},
                "created_at": str(r.get("created_at") or ""),
            }
            for r in rows
        ]
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "events": events,
                "count": len(events),
                "limit": limit,
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
        """Persist an activity-feed event to ``agent_activity_events``."""
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
        event_id = _new_id("act")
        meta_json = _json_dumps(metadata or {})
        await _insert_row(
            org_id,
            "agent_activity_events",
            ["id", "event_type", "summary", "deep_link", "metadata"],
            [event_id, event_type, summary, deep_link, meta_json],
        )
        logger.info(
            "agent_activity_feed.emit org=%s event=%s summary=%s",
            org_id,
            event_type,
            summary,
        )
        return _ok_envelope(
            self.name,
            {
                "event_id": event_id,
                "event_type": event_type,
                "summary": summary,
                "deep_link": deep_link,
            },
        )
