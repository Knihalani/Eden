"""Sessions service (Phase A1).

:class:`SessionIdentityService` — manages the app/site-layer
session lifecycle. Backs the
``/orgs/{org_id}/intelligence/user/sessions/...`` endpoints.

Sessions are a Phase A1 wrapper around the existing Cat 9
``user_sessions`` table (migration 024). The new flow is:

1. ``start()`` — allocate a ``session_id`` (32-hex chars),
   generate a ``session_secret`` (HMAC seed), hash it, write to
   ``session_secrets`` + insert into ``user_sessions``.
2. ``end()`` — close the session (sets ``last_event_at``,
   marks inactive).
3. ``identify()`` — attach a ``user_id`` to an anonymous session.
4. ``get()`` — read a session summary.
"""
from __future__ import annotations

import hashlib
import json
import logging
import secrets
from datetime import timedelta
from typing import Any

from ._common import _get_client, _now_utc

logger = logging.getLogger(__name__)


#: Default session TTL — 7 days, matching the Cat 9 default window.
DEFAULT_TTL_HOURS = 24 * 7


class SessionIdentityService:
    """App/site session lifecycle."""

    name = "session_identity"

    async def start(
        self,
        org_id: str,
        *,
        user_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        ttl_hours: int = DEFAULT_TTL_HOURS,
    ) -> dict[str, Any]:
        """Allocate a session_id + secret; return both."""
        client = await _get_client()
        if client is None:
            return {"session_id": "", "session_secret": "", "expires_at": ""}

        session_id = secrets.token_hex(16)  # 32 hex chars
        # Generate a 256-bit secret; HMAC-SHA256 hash for storage.
        raw_secret = secrets.token_urlsafe(32)
        secret_hash = hashlib.sha256(raw_secret.encode()).digest()
        expires_at = _now_utc() + timedelta(hours=ttl_hours)
        metadata_json = json.dumps(metadata or {})

        # Write session_secrets (Phase A1)
        await client.execute(
            """
            INSERT INTO session_secrets (session_id, org_id, secret_hash, expires_at)
            VALUES ($1, $2, $3, $4)
            """,
            session_id,
            org_id,
            secret_hash,
            expires_at,
        )

        # Insert into user_sessions (Cat 9, migration 024)
        await client.execute(
            """
            INSERT INTO user_sessions (
                id, org_id, session_id, user_id,
                first_event_at, last_event_at, n_turns, n_traces, abandoned
            )
            VALUES ($1, $2, $3, $4, $5, $5, 0, 0, FALSE)
            """,
            secrets.token_hex(16),
            org_id,
            session_id,
            user_id,
            _now_utc(),
        )

        return {
            "session_id": session_id,
            "session_secret": raw_secret,
            "expires_at": expires_at.isoformat(),
        }

    async def end(self, org_id: str, session_id: str) -> bool:
        """Close the session. Returns True on success."""
        client = await _get_client()
        if client is None:
            return False
        await client.execute(
            "UPDATE user_sessions SET last_event_at = $1 "
            "WHERE org_id = $2 AND session_id = $3",
            _now_utc(),
            org_id,
            session_id,
        )
        await client.execute(
            "DELETE FROM session_secrets "
            "WHERE org_id = $1 AND session_id = $2",
            org_id,
            session_id,
        )
        return True

    async def identify(
        self,
        org_id: str,
        session_id: str,
        user_id: str,
    ) -> bool:
        """Attach a user_id to an anonymous session."""
        client = await _get_client()
        if client is None:
            return False
        await client.execute(
            "UPDATE user_sessions SET user_id = $1 "
            "WHERE org_id = $2 AND session_id = $3",
            user_id,
            org_id,
            session_id,
        )
        return True

    async def get(self, org_id: str, session_id: str) -> dict[str, Any]:
        """Read a session summary. Returns the row or a ``not_found`` envelope."""
        client = await _get_client()
        if client is None:
            return {"session_id": session_id, "user_id": None, "n_events": 0,
                    "first_event_at": None, "last_event_at": None}
        row = await client.fetchrow(
            """
            SELECT session_id, user_id, first_event_at, last_event_at,
                   n_turns, n_traces, abandoned
            FROM user_sessions
            WHERE org_id = $1 AND session_id = $2
            """,
            org_id,
            session_id,
        )
        if row is None:
            return {
                "session_id": session_id,
                "user_id": None,
                "n_events": 0,
                "first_event_at": None,
                "last_event_at": None,
                "not_found": True,
            }

        # n_events = n_turns + n_traces (proxy for "events the SDK emitted")
        n_events = int(row["n_turns"] or 0) + int(row["n_traces"] or 0)
        return {
            "session_id": row["session_id"],
            "user_id": row["user_id"],
            "n_events": n_events,
            "first_event_at": (
                row["first_event_at"].isoformat() if row["first_event_at"] else None
            ),
            "last_event_at": (
                row["last_event_at"].isoformat() if row["last_event_at"] else None
            ),
            "abandoned": bool(row["abandoned"]),
        }
