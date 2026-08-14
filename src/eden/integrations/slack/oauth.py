"""Slack App OAuth v2 + request verification.

Flow (mirrors the GitHub App wizard):

1. Owner/admin clicks "Connect Slack" → backend returns
   ``https://slack.com/oauth/v2/authorize?client_id=…&scope=…&state=…``.
2. User picks the workspace + channel, Slack redirects to
   ``/integrations/slack/callback?code=…&state=…``.
3. Backend verifies state, exchanges the code for a bot token
   (``xoxb-``), persists ``(org_id, team_id, encrypted bot_token)`` to
   ``org_slack_installs``, redirects back to the portal.

All four Slack env vars (``SLACK_CLIENT_ID``, ``SLACK_CLIENT_SECRET``,
``SLACK_SIGNING_SECRET``, ``SLACK_CALLBACK_URL``) are optional — when
any is missing, :func:`is_configured` returns False and the portal
hides the connect button. A single-workspace dev fallback exists via
``SLACK_BOT_TOKEN`` (xoxb-) which skips OAuth entirely.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlencode

import httpx

from eden.config import get_settings

logger = logging.getLogger(__name__)

SLACK_API_BASE = "https://slack.com/api"
SLACK_AUTHORIZE_BASE = "https://slack.com/oauth/v2/authorize"

#: Bot scopes Eden requests at install time. ``chat:write`` is the
#: notify core; ``channels:read``+``groups:read`` let the portal render
#: the channel picker. History scopes enable ambient listen after
#: ``/invite @Eden``; ``mpim:history`` is optional for later (P0 has no
#: consumer). Notify still works without history. Do not request
#: ``im:history`` (DMs stay off).
BOT_SCOPES = (
    "chat:write",
    "channels:read",
    "groups:read",
    "channels:history",
    "groups:history",
    "mpim:history",
)

#: Slack rejects signatures on requests older than 5 minutes.
_SIGNATURE_MAX_AGE_S = 60 * 5

_HTTPX: httpx.AsyncClient | None = None


@asynccontextmanager
async def _shared_httpx() -> AsyncIterator[httpx.AsyncClient]:
    """Yield the shared client, deliberately NOT closing it on exit.

    Same pattern as ``eden.integrations.github.oauth`` — closing the
    singleton on scope exit permanently kills the pool for the process.
    """
    global _HTTPX
    if _HTTPX is None or _HTTPX.is_closed:
        _HTTPX = httpx.AsyncClient(timeout=15.0)
    yield _HTTPX


async def _close_shared_httpx() -> None:
    """Close + drop the shared client. Tests only."""
    global _HTTPX
    if _HTTPX is not None:
        try:
            await _HTTPX.aclose()
        finally:
            _HTTPX = None


def is_configured() -> bool:
    """True iff a real Slack App is wired up on this Eden instance."""
    s = get_settings()
    return all(
        [
            getattr(s, "slack_client_id", "").strip(),
            getattr(s, "slack_client_secret", "").strip(),
            getattr(s, "slack_signing_secret", "").strip(),
        ]
    )


def has_dev_bot_token() -> bool:
    """True when the single-workspace ``SLACK_BOT_TOKEN`` fallback is set."""
    tok = getattr(get_settings(), "slack_bot_token", "") or ""
    return tok.strip().startswith("xoxb-")


class SlackConfigError(RuntimeError):
    """Raised when an OAuth call lands on an unconfigured Eden instance."""


class SlackAPIError(RuntimeError):
    """Raised when Slack returns a non-2xx or ``ok: false`` response."""

    def __init__(self, message: str, *, status_code: int = 0, error: str = "") -> None:
        super().__init__(f"Slack API error: {message} ({error or status_code})")
        self.status_code = status_code
        self.error = error


class SlackOAuthClient:
    """Thin wrapper around Slack OAuth v2 + signing-secret verification."""

    def __init__(
        self,
        *,
        client_id: str | None = None,
        client_secret: str | None = None,
        signing_secret: str | None = None,
        callback_url: str | None = None,
    ) -> None:
        s = get_settings()
        self.client_id = client_id or getattr(s, "slack_client_id", "")
        self.client_secret = client_secret or getattr(s, "slack_client_secret", "")
        self.signing_secret = signing_secret or getattr(s, "slack_signing_secret", "")
        self.callback_url = self._resolve_callback_url(
            callback_url if callback_url is not None else getattr(s, "slack_callback_url", ""),
            s,
        )
        if not is_configured():
            raise SlackConfigError(
                "Slack App is not configured. Set SLACK_CLIENT_ID, "
                "SLACK_CLIENT_SECRET, and SLACK_SIGNING_SECRET."
            )

    @staticmethod
    def _resolve_callback_url(configured: str, settings: Any) -> str:
        """API callback Slack redirects to after the user approves.

        Prefer ``SLACK_CALLBACK_URL``. When empty, fall back to
        ``{API_PUBLIC_URL}/integrations/slack/callback`` — the callback
        is an API route, not a portal page. Only include redirect_uri
        when non-empty (it must match a Redirect URL registered on the
        Slack App).
        """
        url = (configured or "").strip()
        if url:
            return url
        base = (
            getattr(settings, "api_public_url", "")
            or getattr(settings, "app_url", "")
            or getattr(settings, "portal_base_url", "")
            or ""
        ).rstrip("/")
        if base and "example.com" not in base:
            return f"{base}/integrations/slack/callback"
        return ""

    def get_authorize_url(self, *, state: str) -> str:
        """Return the Slack OAuth v2 authorize URL for the connect flow."""
        params: dict[str, str] = {
            "client_id": self.client_id,
            "scope": ",".join(BOT_SCOPES),
            "state": state,
        }
        if self.callback_url:
            params["redirect_uri"] = self.callback_url
        return f"{SLACK_AUTHORIZE_BASE}?{urlencode(params)}"

    @staticmethod
    def new_state_token() -> str:
        """32-byte URL-safe CSRF token (same shape as the GitHub flow)."""
        return secrets.token_urlsafe(32)

    async def exchange_code(self, code: str) -> dict[str, Any]:
        """Exchange an OAuth code for a bot token + workspace identity.

        Returns the parsed ``oauth.v2.access`` payload. Raises
        :class:`SlackAPIError` on ``ok: false`` or transport failure.
        """
        async with _shared_httpx() as client:
            r = await client.post(
                f"{SLACK_API_BASE}/oauth.v2.access",
                data={
                    "client_id": self.client_id,
                    "client_secret": self.client_secret,
                    "code": code,
                    **({"redirect_uri": self.callback_url} if self.callback_url else {}),
                },
            )
            if r.status_code != 200:
                raise SlackAPIError("code exchange failed", status_code=r.status_code)
            payload = r.json()
            if not payload.get("ok"):
                raise SlackAPIError(
                    "code exchange rejected",
                    error=str(payload.get("error") or "unknown"),
                )
            return payload


def verify_slack_signature(
    *,
    body: bytes,
    timestamp: str,
    signature: str,
    secret: str,
) -> bool:
    """Verify ``X-Slack-Signature`` on an inbound webhook/interaction.

    Slack signs ``v0:{timestamp}:{body}`` with HMAC-SHA256 keyed on the
    signing secret. Rejects stale timestamps (>5 min) to bound replay.
    Constant-time compare; refuses empty secrets/malformed headers.
    """
    if not secret or not signature or not timestamp:
        return False
    if not signature.startswith("v0="):
        return False
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > _SIGNATURE_MAX_AGE_S:
        return False
    basestring = b"v0:" + timestamp.encode("utf-8") + b":" + body
    expected = (
        "v0="
        + hmac.new(secret.encode("utf-8"), basestring, hashlib.sha256).hexdigest()
    )
    return hmac.compare_digest(expected, signature)


__all__ = [
    "BOT_SCOPES",
    "SLACK_API_BASE",
    "SlackAPIError",
    "SlackConfigError",
    "SlackOAuthClient",
    "has_dev_bot_token",
    "is_configured",
    "verify_slack_signature",
]
