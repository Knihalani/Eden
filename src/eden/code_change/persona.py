"""AgentPersonaService — the "Eden Agent" identity per tenant.

The persona is consistent across every surface (PR author in
GitHub, activity feed in the portal, comment author in the PR
review, Slack/Teams poster). The persona is rendered next to the
agent's avatar in the portal with a "track record" block ("In
the last 30 days: 12 PRs opened, 2 reverted, 1 in review,
0.83 quality avg, $4,200/mo cost savings").

STUB mode persists the persona config to ``agent_persona_config``
and reads the current persona. The real implementation (Gate 4a)
will additionally post to the GitHub App bot identity, render the
track record in the portal, and sign commits with the persona's
voice.
"""

from __future__ import annotations

import logging
from typing import Any

from ._common import _json_dumps, _new_id, _ok_envelope

logger = logging.getLogger(__name__)


class AgentPersonaService:
    """Per-tenant "Eden Agent" identity."""

    name = "agent_persona"

    async def get(self, org_id: str) -> dict[str, Any]:
        """Return the org's current persona config. STUB: returns the defaults."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "display_name": "Eden Agent",
                "avatar": "eden-mark",
                "voice": "concise",
                "commit_message_style": "conventional-commits",
                "pr_body_template": "default",
                "track_record_visible_to": [
                    "engineer",
                    "sre",
                    "pm",
                    "exec",
                ],
                "message": "Stub persona — defaults returned.",
            },
        )

    async def update(
        self,
        org_id: str,
        display_name: str,
        avatar: str,
        voice: str,
        track_record_visible_to: list[str],
    ) -> dict[str, Any]:
        """Update the persona. STUB: returns the live envelope with the new config."""
        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "display_name": display_name,
                "avatar": avatar,
                "voice": voice,
                "track_record_visible_to": track_record_visible_to,
                "config_id": _new_id("persona"),
                "commit_message_style": "conventional-commits",
                "pr_body_template": "default",
                "message": (
                    "Stub update — Gate 4a will persist to "
                    "agent_persona_config and re-render the portal."
                ),
                "config_json": _json_dumps(
                    {
                        "display_name": display_name,
                        "avatar": avatar,
                        "voice": voice,
                        "track_record_visible_to": track_record_visible_to,
                    }
                ),
            },
        )
