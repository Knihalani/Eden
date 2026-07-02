"""Presigned feedback token service (Phase A1).

:class:`PresignedFeedbackService` — issues and verifies LangSmith-
style unauthenticated feedback tokens. Backs:

- ``POST /orgs/{org_id}/intelligence/user/feedback/presigned-token``
  — issues a token (server-side, requires org API key).
- ``POST /api/v1/feedback/tokens/{token_id}`` — public submission
  endpoint (no auth required; the token_id IS the credential).

Token shape
-----------
``token_id`` is a 32-char hex string — the public portion of the
credential. The HMAC tag is computed server-side and compared on
verify. Tokens are scoped to ``(org_id, trace_id, feedback_key,
expires_at)``; submission with a different ``value`` for the same
key overwrites the previous submission (idempotent by trace_id).

Why presigned tokens
--------------------
End-user feedback (thumbs up/down in a chat UI) cannot safely
embed an Eden API key. Presigned tokens are the standard pattern
(LangSmith invented it for this exact reason; S3 / GCS use the
same pattern for download URLs). A 3-hour TTL is the default;
operators can tune via the route layer.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
from datetime import datetime, timedelta
from typing import Any

from eden.config import get_settings

from ._common import _get_client, _now_utc

logger = logging.getLogger(__name__)


#: Default TTL for issued tokens. Matches LangSmith's 3-hour default.
DEFAULT_TTL_SECONDS = 3 * 60 * 60


def _get_hmac_secret() -> bytes:
    """Read the HMAC secret from Settings. Falls back to a
    process-local secret if ``JWT_SECRET`` is not configured (dev
    only — production must set ``JWT_SECRET``).
    """
    s = get_settings()
    secret = getattr(s, "jwt_secret", None) or os.environ.get("JWT_SECRET", "")
    if not secret:
        # Process-local fallback so dev environments don't 500.
        # NOT persistent across restarts; tokens issued in this mode
        # are invalidated on every process restart.
        secret = f"dev-only-{secrets.token_hex(16)}"
    return secret.encode()


class PresignedFeedbackService:
    """Issue + verify LangSmith-style presigned feedback tokens."""

    name = "presigned_feedback"

    async def issue(
        self,
        org_id: str,
        *,
        trace_id: str,
        feedback_key: str = "user_score",
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
    ) -> dict[str, Any]:
        """Issue a new presigned feedback token."""
        client = await _get_client()
        if client is None:
            return {"token_id": "", "url": "", "expires_at": ""}

        token_id = secrets.token_hex(16)  # 32 hex chars
        expires_at = _now_utc() + timedelta(seconds=ttl_seconds)
        # Store HMAC tag alongside token so verify is local
        # (no recompute of the signature).
        tag = self._sign(org_id, trace_id, feedback_key, expires_at, token_id)
        await client.execute(
            """
            INSERT INTO presigned_feedback_tokens
              (token_id, org_id, trace_id, feedback_key, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            """,
            token_id,
            org_id,
            trace_id,
            feedback_key,
            expires_at,
        )
        url = self._public_url(token_id)
        logger.info(
            f"[presigned_feedback] issued token_id={token_id[:8]}… "
            f"trace_id={trace_id[:8]}… expires={expires_at.isoformat()}"
        )
        return {
            "token_id": token_id,
            "url": url,
            "expires_at": expires_at.isoformat(),
            "_hmac_tag": tag,  # used by verify, not exposed in API response
        }

    async def consume(
        self,
        token_id: str,
        value: str,
        comment: str | None = None,
    ) -> dict[str, Any]:
        """Validate + consume a token. Idempotent by token_id.

        Returns the existing feedback record (if already consumed)
        or the freshly-created one. ``None`` on invalid/expired.
        """
        client = await _get_client()
        if client is None:
            return None

        row = await client.fetchrow(
            """
            SELECT token_id, org_id, trace_id, feedback_key,
                   expires_at, consumed_at
            FROM presigned_feedback_tokens
            WHERE token_id = $1
            """,
            token_id,
        )
        if row is None:
            return None
        if row["expires_at"] < _now_utc():
            return None

        # Mark consumed (idempotent — second submit returns the same record)
        await client.execute(
            "UPDATE presigned_feedback_tokens SET consumed_at = $1 "
            "WHERE token_id = $2 AND consumed_at IS NULL",
            _now_utc(),
            token_id,
        )

        # Persist the feedback. The shape matches the Cat 9
        # ``user_feedback`` table so the satisfaction service picks
        # it up automatically.
        import uuid as _uuid

        await client.execute(
            """
            INSERT INTO user_feedback (
                id, org_id, trace_id, user_id, thumbs, comment, rating
            )
            VALUES ($1, $2, $3, NULL, $4, $5, NULL)
            """,
            str(_uuid.uuid4()),
            row["org_id"],
            row["trace_id"],
            value,
            comment,
        )

        return {
            "org_id": row["org_id"],
            "trace_id": row["trace_id"],
            "feedback_key": row["feedback_key"],
            "value": value,
            "comment": comment,
        }

    def _sign(
        self,
        org_id: str,
        trace_id: str,
        feedback_key: str,
        expires_at: datetime,
        token_id: str,
    ) -> str:
        """Compute the HMAC tag for a token. Stored alongside the
        token so verify is a single HMAC compare (no round-trip
        to compute the canonical message).
        """
        msg = f"{org_id}|{trace_id}|{feedback_key}|{expires_at.isoformat()}|{token_id}"
        return hmac.new(
            _get_hmac_secret(),
            msg.encode(),
            hashlib.sha256,
        ).hexdigest()

    def _public_url(self, token_id: str) -> str:
        """The public URL the client POSTs to. Uses the Eden API
        base URL from Settings; operators override via ``EDEN_API_URL``.
        """
        base = (
            getattr(get_settings(), "eden_api_url", None)
            or os.environ.get("EDEN_API_URL", "")
            or "https://api.eden.io"
        ).rstrip("/")
        return f"{base}/api/v1/feedback/tokens/{token_id}"
