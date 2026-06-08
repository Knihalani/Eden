"""Discord integration for Eden (§7.5)."""
from __future__ import annotations

from eden.integrations.discord.webhook import fan_out_alert, post_to_discord

__all__ = ["fan_out_alert", "post_to_discord"]
