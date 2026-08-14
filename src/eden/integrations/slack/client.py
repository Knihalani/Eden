"""Slack Web API client — chat.postMessage with Block Kit.

Deliberately minimal: Eden only posts alerts and lists channels. No
SDK dependency — plain httpx against ``https://slack.com/api`` so the
integration has the same failure/timeout semantics as the GitHub one.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.integrations.slack.oauth import SLACK_API_BASE, SlackAPIError, _shared_httpx

logger = logging.getLogger(__name__)


class SlackClient:
    """Bot-token-scoped Slack Web API client."""

    def __init__(self, bot_token: str) -> None:
        if not bot_token:
            raise ValueError("bot_token is required")
        self._token = bot_token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json; charset=utf-8",
        }

    async def post_message(
        self,
        *,
        channel: str,
        text: str,
        blocks: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Post a message. ``text`` is the notification fallback; ``blocks``
        carry the Block Kit payload. Raises :class:`SlackAPIError` on
        ``ok: false``."""
        payload: dict[str, Any] = {"channel": channel, "text": text}
        if blocks:
            payload["blocks"] = blocks
        async with _shared_httpx() as client:
            r = await client.post(
                f"{SLACK_API_BASE}/chat.postMessage",
                headers=self._headers(),
                json=payload,
            )
            if r.status_code != 200:
                raise SlackAPIError("chat.postMessage failed", status_code=r.status_code)
            body = r.json()
            if not body.get("ok"):
                raise SlackAPIError(
                    "chat.postMessage rejected",
                    error=str(body.get("error") or "unknown"),
                )
            return body

    async def list_channels(self, *, limit: int = 200) -> list[dict[str, Any]]:
        """List public + private channels the bot can see (for the portal
        channel picker). Returns ``[{id, name, is_private}]``."""
        out: list[dict[str, Any]] = []
        async with _shared_httpx() as client:
            cursor = ""
            for _ in range(5):  # cap pagination — a picker never needs more
                params: dict[str, Any] = {
                    "types": "public_channel,private_channel",
                    "limit": min(limit, 200),
                    "exclude_archived": "true",
                }
                if cursor:
                    params["cursor"] = cursor
                r = await client.get(
                    f"{SLACK_API_BASE}/conversations.list",
                    headers=self._headers(),
                    params=params,
                )
                if r.status_code != 200:
                    raise SlackAPIError("conversations.list failed", status_code=r.status_code)
                body = r.json()
                if not body.get("ok"):
                    raise SlackAPIError(
                        "conversations.list rejected",
                        error=str(body.get("error") or "unknown"),
                    )
                for ch in body.get("channels") or []:
                    out.append(
                        {
                            "id": str(ch.get("id") or ""),
                            "name": str(ch.get("name") or ""),
                            "is_private": bool(ch.get("is_private")),
                            "is_member": bool(ch.get("is_member")),
                        }
                    )
                cursor = str((body.get("response_metadata") or {}).get("next_cursor") or "")
                if not cursor or len(out) >= limit:
                    break
        return out[:limit]

    async def auth_test(self) -> dict[str, Any]:
        """``auth.test`` — used by the health probe to validate a token."""
        async with _shared_httpx() as client:
            r = await client.post(f"{SLACK_API_BASE}/auth.test", headers=self._headers())
            if r.status_code != 200:
                raise SlackAPIError("auth.test failed", status_code=r.status_code)
            body = r.json()
            if not body.get("ok"):
                raise SlackAPIError("auth.test rejected", error=str(body.get("error") or ""))
            return body



    async def conversations_replies(
        self,
        *,
        channel: str,
        ts: str,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """Pull a pointer thread. Extra-work reader — not conversations.history."""
        if not channel or not ts:
            return []
        out: list[dict[str, Any]] = []
        async with _shared_httpx() as client:
            cursor = ""
            for _ in range(5):
                params: dict[str, Any] = {
                    "channel": channel,
                    "ts": ts,
                    "limit": min(limit, 200),
                }
                if cursor:
                    params["cursor"] = cursor
                r = await client.get(
                    f"{SLACK_API_BASE}/conversations.replies",
                    headers=self._headers(),
                    params=params,
                )
                if r.status_code != 200:
                    raise SlackAPIError(
                        "conversations.replies failed", status_code=r.status_code
                    )
                body = r.json()
                if not body.get("ok"):
                    raise SlackAPIError(
                        "conversations.replies rejected",
                        error=str(body.get("error") or "unknown"),
                    )
                out.extend(list(body.get("messages") or []))
                cursor = str(
                    (body.get("response_metadata") or {}).get("next_cursor") or ""
                )
                if not cursor or len(out) >= limit:
                    break
        return out[:limit]

    async def conversations_history(
        self,
        *,
        channel: str,
        oldest: str,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        """One-time invite backfill only. Not the extra-work reader."""
        if not channel or not oldest:
            return []
        out: list[dict[str, Any]] = []
        async with _shared_httpx() as client:
            cursor = ""
            for _ in range(5):
                params: dict[str, Any] = {
                    "channel": channel,
                    "oldest": oldest,
                    "limit": min(limit, 200),
                    "inclusive": "true",
                }
                if cursor:
                    params["cursor"] = cursor
                r = await client.get(
                    f"{SLACK_API_BASE}/conversations.history",
                    headers=self._headers(),
                    params=params,
                )
                if r.status_code != 200:
                    raise SlackAPIError(
                        "conversations.history failed", status_code=r.status_code
                    )
                body = r.json()
                if not body.get("ok"):
                    raise SlackAPIError(
                        "conversations.history rejected",
                        error=str(body.get("error") or "unknown"),
                    )
                out.extend(list(body.get("messages") or []))
                cursor = str(
                    (body.get("response_metadata") or {}).get("next_cursor") or ""
                )
                if not cursor or len(out) >= limit:
                    break
        return out[:limit]

    async def list_users(self, *, limit: int = 200) -> list[dict[str, Any]]:
        """Workspace members for the Y picker. Bots and deleted users omitted."""
        out: list[dict[str, Any]] = []
        async with _shared_httpx() as client:
            cursor = ""
            for _ in range(5):
                params: dict[str, Any] = {"limit": min(limit, 200)}
                if cursor:
                    params["cursor"] = cursor
                r = await client.get(
                    f"{SLACK_API_BASE}/users.list",
                    headers=self._headers(),
                    params=params,
                )
                if r.status_code != 200:
                    raise SlackAPIError("users.list failed", status_code=r.status_code)
                body = r.json()
                if not body.get("ok"):
                    raise SlackAPIError(
                        "users.list rejected",
                        error=str(body.get("error") or "unknown"),
                    )
                for u in body.get("members") or []:
                    if u.get("deleted") or u.get("is_bot") or u.get("id") == "USLACKBOT":
                        continue
                    profile = u.get("profile") or {}
                    name = (
                        str(profile.get("display_name") or "").strip()
                        or str(profile.get("real_name") or "").strip()
                        or str(u.get("name") or "").strip()
                    )
                    uid = str(u.get("id") or "")
                    if not uid:
                        continue
                    out.append({"id": uid, "name": name or uid})
                cursor = str((body.get("response_metadata") or {}).get("next_cursor") or "")
                if not cursor or len(out) >= limit:
                    break
        return out[:limit]



__all__ = ["SlackClient"]
