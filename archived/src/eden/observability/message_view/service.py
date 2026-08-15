"""Message View service (Cat 1).

Lunary-style multi-turn conversation view. Distinct from the
trace tree because the natural unit is a chat message
(role + content + timestamp) rather than a span of agent
activity.

Real implementation reads from and writes to the
``conversations`` and ``conversation_messages`` tables
(migration 020). The flow:

* ``get_conversation_history`` — look up the most recent
  conversation for the given ``session_id``, return its
  messages in chronological order. Missing conversation
  returns an empty list (not an error — the caller can
  interpret that as "no chat history yet").
* ``add_message`` — if a ``conversation_id`` is given,
  append to it; otherwise look up or create a conversation
  for the ``session_id``, then append. Returns the new
  message id.

The Cat 1 service is intentionally chat-only; richer
turn-by-turn LLM payloads stay in ``telemetry_events`` (the
trace tree view). The chat view is the surface a user
expects to see when they open "conversation history" in a
product UI.

See ``docs/observability-gap/01-trace-replay.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.observability._trace_common import (
    error_envelope,
    fetch_conversation_for_session,
    fetch_conversation_messages,
    insert_conversation_message,
    ok_envelope,
    upsert_conversation,
)

logger = logging.getLogger(__name__)


#: Roles accepted by the ``role`` field. The DB column is
#: VARCHAR(16); we restrict the set so callers can't pass
#: arbitrary 16-char strings and call them a "role".
ALLOWED_ROLES: frozenset[str] = frozenset(
    {"user", "assistant", "system", "tool"}
)

#: Hard cap on message content length so a single message
#: can't blow up the response.
MAX_MESSAGE_CHARS = 32_000


class MessageViewService:
    """Multi-turn conversation history per session."""

    name = "message_view"

    async def get_conversation_history(
        self,
        org_id: str,
        *,
        session_id: str,
        limit: int = 100,
        conversation_id: str | None = None,
    ) -> dict[str, Any]:
        """Return the messages of a session in chronological order.

        If ``conversation_id`` is provided, returns messages
        for that specific conversation. Otherwise looks up
        the most-recent conversation for the ``session_id``
        and returns its messages. Missing conversation
        returns an empty list with ``message_count: 0``.
        """
        if not session_id:
            return error_envelope(
                self.name,
                "session_id is required",
                code="invalid_input",
            )

        target_conversation_id = conversation_id
        if target_conversation_id is None:
            convo = await fetch_conversation_for_session(
                org_id, session_id=session_id
            )
            if convo is None:
                return ok_envelope(
                    self.name,
                    {
                        "session_id": session_id,
                        "conversation_id": None,
                        "message_count": 0,
                        "messages": [],
                    },
                )
            target_conversation_id = convo.get("id")

        if target_conversation_id is None:
            return ok_envelope(
                self.name,
                {
                    "session_id": session_id,
                    "conversation_id": None,
                    "message_count": 0,
                    "messages": [],
                },
            )

        rows = await fetch_conversation_messages(
            org_id,
            conversation_id=target_conversation_id,
            limit=limit,
        )

        messages: list[dict[str, Any]] = []
        for r in rows:
            messages.append(
                {
                    "message_id": r.get("id"),
                    "role": r.get("role"),
                    "content": r.get("content"),
                    "created_at": r.get("created_at"),
                }
            )

        return ok_envelope(
            self.name,
            {
                "session_id": session_id,
                "conversation_id": target_conversation_id,
                "message_count": len(messages),
                "messages": messages,
            },
        )

    async def add_message(
        self,
        org_id: str,
        *,
        session_id: str,
        role: str,
        content: str,
        conversation_id: str | None = None,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Append a message to a conversation (creates the convo if needed).

        Returns ``{message_id, conversation_id}`` on success.
        Validates the ``role`` against :data:`ALLOWED_ROLES`
        and the ``content`` length against
        :data:`MAX_MESSAGE_CHARS` so a buggy caller doesn't
        end up with a 100MB "user" message in the DB.
        """
        if not session_id:
            return error_envelope(
                self.name,
                "session_id is required",
                code="invalid_input",
            )
        if role not in ALLOWED_ROLES:
            return error_envelope(
                self.name,
                f"role must be one of {sorted(ALLOWED_ROLES)}",
                code="invalid_input",
            )
        if not isinstance(content, str):
            return error_envelope(
                self.name,
                "content must be a string",
                code="invalid_input",
            )
        if len(content) > MAX_MESSAGE_CHARS:
            return error_envelope(
                self.name,
                f"content exceeds {MAX_MESSAGE_CHARS} chars",
                code="invalid_input",
            )

        # Resolve the target conversation.
        target_conversation_id = conversation_id
        if target_conversation_id is None:
            target_conversation_id = await upsert_conversation(
                org_id,
                session_id=session_id,
                user_id=user_id,
            )
        if target_conversation_id is None:
            return error_envelope(
                self.name,
                "could not resolve or create conversation",
                code="unavailable",
            )

        message_id = await insert_conversation_message(
            org_id,
            conversation_id=target_conversation_id,
            role=role,
            content=content,
        )
        if message_id is None:
            return error_envelope(
                self.name,
                "could not insert message",
                code="unavailable",
            )

        return ok_envelope(
            self.name,
            {
                "session_id": session_id,
                "conversation_id": target_conversation_id,
                "message_id": message_id,
                "role": role,
            },
        )
