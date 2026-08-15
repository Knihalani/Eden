"""Slack App integration for Soft Autonomy alerts.

Mirrors the GitHub App pattern (``eden.integrations.github``):

* :mod:`eden.integrations.slack.oauth` — OAuth v2 authorize/exchange +
  request-signature verification.
* :mod:`eden.integrations.slack.client` — Slack Web API client
  (``chat.postMessage`` with Block Kit, ``conversations.list``).
* :mod:`eden.integrations.slack.store` — ``org_slack_installs`` +
  ``agent_slack_channels`` persistence (bot tokens encrypted at rest).

The dispatcher that turns Eden events into Slack messages lives in
:mod:`eden.services.slack_notify`.
"""

from eden.integrations.slack.oauth import (
    SlackAPIError,
    SlackConfigError,
    SlackOAuthClient,
    is_configured,
    verify_slack_signature,
)

__all__ = [
    "SlackAPIError",
    "SlackConfigError",
    "SlackOAuthClient",
    "is_configured",
    "verify_slack_signature",
]
