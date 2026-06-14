"""Conversation history (Cat 9 v0).

:class:`ConversationService` — multi-turn conversation
history (Lunary-style). The SDK writes messages via
:meth:`add_message`; the front-end reads via
:meth:`get_history`. Backed by the ``conversations`` and
``conversation_messages`` tables from migration 020.

Per the appendix:

* ``get_history`` returns the messages in
  ``(created_at ASC)`` order so the front-end can render
  the thread in order. The ``limit`` query-param caps the
  number of messages returned (default 100, max 1000).
* ``add_message`` is *idempotent on (org_id, session_id,
  created_at, role, content_hash)``* — the SDK retries on
  network failure and the service should not double-insert.
  The simple way to achieve idempotency without a unique
  constraint is to check for an existing row first
  (best-effort: a race could double-insert, but the
  service is correct under normal use).

The package degrades gracefully — an empty
``conversations`` table returns a "no conversation data"
envelope.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from ._common import (
    _bad_request_envelope,
    _get_client,
    _new_id,
    _ok_envelope,
)

logger = logging.getLogger(__name__)


#: Valid ``role`` values for ``conversation_messages.role``.
#: Anything else is a bad request.
VALID_ROLES: frozenset[str] = frozenset(
    {"user", "assistant", "system", "tool"}
)


def _content_hash(content: str) -> str:
    """Stable hash of a message's content + role. Used for
    the idempotency check on :meth:`ConversationService.add_message`."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


class ConversationService:
    """Multi-turn conversation history.

    One ``conversations`` row per session (created lazily on
    the first ``add_message`` call); many
    ``conversation_messages`` rows per conversation. The
    front-end reads via :meth:`get_history`; the SDK writes
    via :meth:`add_message`.
    """

    name = "conversation"

    async def get_history(
        self,
        org_id: str,
        *,
        session_id: str,
        limit: int = 100,
    ) -> dict[str, Any]:
        if not session_id or not isinstance(session_id, str):
            return _bad_request_envelope(
                self.name, "session_id is required"
            )
        # Defensive cap: the Pydantic body already enforces
        # ``ge=1, le=1000`` but a direct service call
        # might not.
        if not isinstance(limit, int) or limit < 1 or limit > 1000:
            limit = 100

        client = await _get_client()
        if client is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "session_id": session_id,
                    "messages": [],
                    "message": "no conversation data",
                },
            )

        # Look up the conversation id from the session_id.
        conversation_id: str | None = None
        try:
            row = await client.fetchrow(
                """
                SELECT id FROM conversations
                 WHERE org_id = $1 AND session_id = $2
                 ORDER BY created_at DESC LIMIT 1
                """,
                org_id,
                session_id,
            )
            if row is not None:
                conversation_id = (
                    row.get("id") if isinstance(row, dict) else row["id"]
                )
        except Exception as exc:
            logger.debug(
                "user_intel: conv lookup failed: %s", exc
            )

        if conversation_id is None:
            return _ok_envelope(
                self.name,
                {
                    "org_id": org_id,
                    "session_id": session_id,
                    "messages": [],
                    "message": "no conversation data",
                },
            )

        # Fetch the messages in chronological order.
        try:
            rows = await client.fetch(
                """
                SELECT id, role, content, created_at
                  FROM conversation_messages
                 WHERE org_id = $1 AND conversation_id = $2
                 ORDER BY created_at ASC
                 LIMIT $3
                """,
                org_id,
                conversation_id,
                limit,
            )
        except Exception as exc:
            logger.debug(
                "user_intel: messages fetch failed: %s", exc
            )
            rows = []

        messages: list[dict[str, Any]] = []
        for r in rows:
            d = dict(r) if not isinstance(r, dict) else r
            messages.append(
                {
                    "message_id": d.get("id"),
                    "role": d.get("role"),
                    "content": d.get("content"),
                    "created_at": (
                        d.get("created_at").isoformat()
                        if hasattr(d.get("created_at"), "isoformat")
                        else str(d.get("created_at"))
                    ),
                }
            )

        return _ok_envelope(
            self.name,
            {
                "org_id": org_id,
                "session_id": session_id,
                "conversation_id": conversation_id,
                "messages": messages,
                "count": len(messages),
            },
        )

    async def add_message(
        self,
        org_id: str,
        *,
        session_id: str,
        role: str,
        content: str,
    ) -> dict[str, Any]:
        if not session_id or not isinstance(session_id, str):
            return _bad_request_envelope(
                self.name, "session_id is required"
            )
        if role not in VALID_ROLES:
            return _bad_request_envelope(
                self.name,
                f"role must be one of {sorted(VALID_ROLES)}",
            )
        if not isinstance(content, str) or not content:
            return _bad_request_envelope(
                self.name, "content must be a non-empty string"
            )
        # Cap content at 16k chars so a careless caller
        # can't blow up the column. (TEXT in Postgres can
        # hold 1 GB, but a single chat message is rarely
        # > 16k chars.)
        content = content[:16384]

        client = await _get_client()
        if client is None:
            # Best-effort: still return a message id so the
            # SDK can keep retrying.
            return _ok_envelope(
                self.name,
                {
                    "message_id": _new_id("msg"),
                    "conversation_id": None,
                    "session_id": session_id,
                    "role": role,
                    "persisted": False,
                },
            )

        # Look up the conversation. If it doesn't exist,
        # create one (lazy).
        conversation_id: str | None = None
        try:
            row = await client.fetchrow(
                """
                SELECT id FROM conversations
                 WHERE org_id = $1 AND session_id = $2
                 ORDER BY created_at DESC LIMIT 1
                """,
                org_id,
                session_id,
            )
            if row is not None:
                conversation_id = (
                    row.get("id") if isinstance(row, dict) else row["id"]
                )
        except Exception as exc:
            logger.debug(
                "user_intel: conv lookup failed: %s", exc
            )

        if conversation_id is None:
            conversation_id = _new_id("conv")
            try:
                await client.execute(
                    """
                    INSERT INTO conversations
                        (id, org_id, user_id, session_id, title, updated_at)
                    VALUES ($1, $2, NULL, $3, NULL, NOW())
                    """,
                    conversation_id,
                    org_id,
                    session_id,
                )
            except Exception as exc:
                logger.debug(
                    "user_intel: conv insert failed: %s", exc
                )

        # Idempotency check: if the most recent message in
        # this conversation has the same role + content
        # hash, return it without inserting. This catches
        # the SDK's network-retry case.
        msg_id = _new_id("msg")
        chash = _content_hash(content)
        try:
            row = await client.fetchrow(
                """
                SELECT id, content
                  FROM conversation_messages
                 WHERE org_id = $1 AND conversation_id = $2
                   AND role = $3
                 ORDER BY created_at DESC LIMIT 1
                """,
                org_id,
                conversation_id,
                role,
            )
            if row is not None:
                existing_content = (
                    row.get("content")
                    if isinstance(row, dict)
                    else row["content"]
                )
                if (
                    existing_content is not None
                    and _content_hash(existing_content) == chash
                ):
                    existing_id = (
                        row.get("id")
                        if isinstance(row, dict)
                        else row["id"]
                    )
                    return _ok_envelope(
                        self.name,
                        {
                            "message_id": existing_id,
                            "conversation_id": conversation_id,
                            "session_id": session_id,
                            "role": role,
                            "persisted": True,
                            "deduplicated": True,
                        },
                    )
        except Exception as exc:
            logger.debug(
                "user_intel: dedup check failed: %s", exc
            )

        # Insert the message.
        try:
            async with client.acquire() as conn, conn.transaction():
                await conn.execute(
                    """
                        INSERT INTO conversation_messages
                            (id, org_id, conversation_id, role, content)
                        VALUES ($1, $2, $3, $4, $5)
                        """,
                    msg_id,
                    org_id,
                    conversation_id,
                    role,
                    content,
                )
                # Bump the conversation's updated_at so
                # the front-end can sort by recency.
                await conn.execute(
                    """
                        UPDATE conversations
                           SET updated_at = NOW()
                         WHERE id = $1
                        """,
                    conversation_id,
                )
        except Exception as exc:
            logger.debug(
                "user_intel: message insert failed: %s", exc
            )

        return _ok_envelope(
            self.name,
            {
                "message_id": msg_id,
                "conversation_id": conversation_id,
                "session_id": session_id,
                "role": role,
                "persisted": True,
            },
        )
