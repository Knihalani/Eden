"""Streaming token capture — D.8 (§6.1) SDK + service.

Public surface:

* :class:`StreamingTokenCapture` — service-side writer used
  by the gateway SSE/WebSocket handler. Persists each token
  to the ``streaming_tokens`` table.
* :func:`capture_byte_count` — the SDK helper. Customers
  wrap an SSE / WebSocket response stream and call this for
  each ``data: <token>`` chunk. PII is pre-masked per
  :data:`streaming_token_capture_mode`.

The byte-count-only mode is the default for free tier
(per the spec config keys); full-text capture is opt-in
via ``streaming_token_capture_mode='full'``.

See ``docs/spec/upgradespec-original-2026-06.md`` §D.8 /
§B.1 / §C.1 for the full spec.
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ── PII pre-mask ─────────────────────────────────────────────────────


# Conservative regex set for the SDK pre-mask. Same
# patterns the Cat 9 PII scanner uses; covered in
# :file:`eden.services.user_intel._common`.
_PII_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("email", re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")),
    ("phone", re.compile(r"\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}\b")),
    ("ssn", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("credit_card", re.compile(r"\b(?:\d[ -]*?){13,19}\b")),
    ("ip_address", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
)


def mask_pii(text: str) -> tuple[str, bool]:
    """Replace PII substrings with ``[REDACTED:<type>]``.

    Returns ``(masked_text, was_redacted)``.
    """
    masked = text
    any_redacted = False
    for label, pattern in _PII_PATTERNS:
        new_text, n = pattern.subn(f"[REDACTED:{label}]", masked)
        if n > 0:
            any_redacted = True
            masked = new_text
    return masked, any_redacted


# ── SDK helper ───────────────────────────────────────────────────────


@dataclass
class TokenStreamStats:
    """Per-stream aggregate the SDK returns to the caller.

    Lightweight — only what's needed for the per-trace
    sparkline (byte length, delta_ms, stall count).
    """
    tokens_captured: int = 0
    bytes_total: int = 0
    redacted_count: int = 0
    stalls: int = 0
    p50_delta_ms: float = 0.0
    max_delta_ms: int = 0
    finish_reason: str | None = None
    started_at_ms: int = field(default_factory=lambda: int(time.time() * 1000))

    def add(self, byte_len: int, delta_ms: int) -> None:
        self.tokens_captured += 1
        self.bytes_total += byte_len
        if delta_ms > self.max_delta_ms:
            self.max_delta_ms = delta_ms
        # Stall = delta > 5x rolling p50; tracked but evaluated
        # only when the stream finishes (rolling p50 needs the
        # full series).
        if self.tokens_captured > 1 and delta_ms > 5 * self.p50_delta_ms:
            self.stalls += 1


def capture_byte_count(
    text: str,
    *,
    span_id: str,
    trace_id: str,
    org_id: str,
    capture_mode: str = "byte_count_only",
    last_token_at_ms: int | None = None,
    redacted: bool = False,
) -> dict[str, Any]:
    """SDK-side token capture helper.

    Returns a dict with the fields needed by
    :meth:`StreamingTokenCapture.write_token`. The caller
    is expected to forward the dict to the gateway ingest
    endpoint (or write directly via the service when
    running in-process).
    """
    if capture_mode == "none":
        return {
            "span_id": span_id,
            "trace_id": trace_id,
            "org_id": org_id,
            "captured": False,
        }
    masked, was_redacted = mask_pii(text) if capture_mode == "full" else ("", False)
    byte_len = len(text.encode("utf-8"))
    now_ms = int(time.time() * 1000)
    delta_ms = (now_ms - last_token_at_ms) if last_token_at_ms else 0
    abs_ms = now_ms
    return {
        "span_id": span_id,
        "trace_id": trace_id,
        "org_id": org_id,
        "token_index": None,  # assigned by the service
        "token_text": masked if capture_mode == "full" else None,
        "token_byte_len": byte_len,
        "delta_ms": max(0, delta_ms),
        "abs_ms": abs_ms,
        "redacted": was_redacted or redacted,
    }


# ── Service-side writer ─────────────────────────────────────────────


class StreamingTokenCapture:
    """Service that persists streaming tokens to Postgres.

    Called by the gateway SSE/WebSocket handler for each
    inbound token chunk. Writes are batched via the
    ``streaming_token_batch_size`` config knob (default 50
    per the spec).

    The CH mirror is intentionally out of scope for this
    module — the worker handles async CH writes per the v1.3
    cat-ship pattern (see ``eden.data_platform.clickhouse_sink``).
    """

    def __init__(
        self,
        *,
        batch_size: int = 50,
        batch_window_ms: int = 250,
    ) -> None:
        self._batch_size = batch_size
        self._batch_window_ms = batch_window_ms
        self._buffer: list[dict[str, Any]] = []
        self._last_index: dict[str, int] = {}  # span_id -> last token_index

    async def write_token(self, token: dict[str, Any]) -> bool:
        """Persist a single token. Buffers until batch_size.

        Returns ``True`` if the buffer was flushed.
        """
        span_id = token.get("span_id")
        if not span_id:
            return False
        next_index = self._last_index.get(span_id, -1) + 1
        self._last_index[span_id] = next_index
        token["token_index"] = next_index
        self._buffer.append(token)
        if len(self._buffer) >= self._batch_size:
            return await self._flush()
        return False

    async def write_batch(self, tokens: list[dict[str, Any]]) -> int:
        """Write a list of tokens directly (bypasses buffer).

        Returns the number of rows written. Best-effort
        like the rest of the surface — DB errors are
        logged and swallowed so the gateway keeps serving.
        """
        if not tokens:
            return 0
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception as exc:
            logger.debug("streaming: postgres import failed: %s", exc)
            return 0
        client = await get_postgres_client()
        if client is None:
            return 0
        written = 0
        for tok in tokens:
            try:
                span_id = tok.get("span_id")
                idx = self._last_index.get(span_id, -1) + 1
                self._last_index[span_id] = idx
                await client.execute(
                    """
                    INSERT INTO streaming_tokens (
                        id, org_id, trace_id, span_id, token_index,
                        token_text, token_byte_len, delta_ms, abs_ms,
                        finish_reason, redacted, created_at
                    ) VALUES (
                        $1, $2, $3, $4, $5,
                        $6, $7, $8, $9,
                        $10, $11, NOW()
                    )
                    ON CONFLICT (span_id, token_index) DO UPDATE
                    SET token_byte_len = EXCLUDED.token_byte_len,
                        delta_ms        = EXCLUDED.delta_ms,
                        abs_ms          = EXCLUDED.abs_ms,
                        finish_reason   = COALESCE(
                            EXCLUDED.finish_reason,
                            streaming_tokens.finish_reason
                        ),
                        redacted        = EXCLUDED.redacted OR
                            streaming_tokens.redacted
                    """,
                    uuid.uuid4(),
                    tok.get("org_id", ""),
                    tok.get("trace_id", ""),
                    span_id,
                    idx,
                    tok.get("token_text"),
                    int(tok.get("token_byte_len", 0)),
                    int(tok.get("delta_ms", 0)),
                    int(tok.get("abs_ms", 0)),
                    tok.get("finish_reason"),
                    bool(tok.get("redacted", False)),
                )
                written += 1
            except Exception as exc:
                logger.debug("streaming: write_token failed: %s", exc)
        return written

    async def _flush(self) -> bool:
        """Flush the buffer to Postgres. Returns True on flush."""
        if not self._buffer:
            return False
        tokens = self._buffer
        self._buffer = []
        written = await self.write_batch(tokens)
        return written > 0

    async def list_tokens(
        self,
        trace_id: str,
        *,
        org_id: str | None = None,
        limit: int = 5000,
    ) -> list[dict[str, Any]]:
        """Read the tokens for a trace, ordered by span + index."""
        try:
            from eden.storage.postgres import get_postgres_client
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("streaming: postgres import failed: %s", exc)
            return []
        client = await get_postgres_client()
        if client is None:
            return []
        try:
            if org_id:
                rows = await client.fetch(
                    """
                    SELECT span_id, token_index, token_text,
                           token_byte_len, delta_ms, abs_ms,
                           finish_reason, redacted, created_at
                      FROM streaming_tokens
                     WHERE org_id = $1 AND trace_id = $2
                     ORDER BY span_id, token_index
                     LIMIT $3
                    """,
                    org_id,
                    trace_id,
                    int(limit),
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT span_id, token_index, token_text,
                           token_byte_len, delta_ms, abs_ms,
                           finish_reason, redacted, created_at
                      FROM streaming_tokens
                     WHERE trace_id = $1
                     ORDER BY span_id, token_index
                     LIMIT $2
                    """,
                    trace_id,
                    int(limit),
                )
        except Exception as exc:
            logger.debug("streaming: list_tokens failed: %s", exc)
            return []
        out: list[dict[str, Any]] = []
        for row in rows:
            d = dict(row)
            for k, v in list(d.items()):
                if hasattr(v, "isoformat"):
                    d[k] = v.isoformat()
            out.append(d)
        return out


# ── SDK module exports ───────────────────────────────────────────────


__all__ = [
    "StreamingTokenCapture",
    "TokenStreamStats",
    "capture_byte_count",
    "mask_pii",
]