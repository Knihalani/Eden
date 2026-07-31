"""Content-addressed message store (Phase A: Laminar 20x dedup).

Stores unique LLM messages once per trace keyed by canonical-JSON
SHA-256 hash. Telemetry spans store an array of message hashes on
their row; the full request_body / response_body is reconstructed at
read time by joining the hash array against this table.

Why per-trace dedup (not project-wide)?
    Laminar's blog explicitly chose trace-scoped because:
      - 95%+ of the value (agents loop within a trace, so the same
        system prompt + earlier turns recur in every span)
      - project-wide dedup would explode on busy tenants (10K traces
        × N messages = huge dictionary)
      - per-trace lookup is much faster: PK is ``(trace_id, hash)``,
        reconstruction is one index scan per span
      - trace deletion is a single ``DELETE WHERE trace_id = $1``

Schema (see migrations/030_trace_messages.sql):
    trace_messages(trace_id TEXT, msg_hash TEXT, role TEXT,
                   content JSONB, first_seen_at TIMESTAMPTZ,
                   PRIMARY KEY (trace_id, msg_hash))

Companion columns on telemetry_events:
    request_message_hashes  TEXT[]  -- hashes of request_body.messages
    response_message_hashes TEXT[]  -- hashes of response_body.choices[0].message
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from typing import Any

from eden.observability.canonical import canonical_hash

logger = logging.getLogger(__name__)


def hash_messages(messages: Iterable[dict[str, Any]]) -> list[str]:
    """Hash an iterable of messages, returning one hash per message.

    The output list is in the same order as the input. Each entry is
    a 64-char hex SHA-256 of the canonical-JSON form of the message.
    """
    return [canonical_hash(m) for m in messages]


def extract_request_messages(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Extract the LLM message list from a request_body.

    Handles the two most common shapes:

      * OpenAI-style:    ``{"messages": [...]}``
      * Anthropic-style: ``{"messages": [...], "system": "..." | [...]}``

    For Anthropic, the system prompt is materialized as a leading
    ``{"role": "system", "content": "..."}`` message so the dedup
    logic sees a uniform shape. Anthropic allows ``system`` to be a
    list of blocks; we concatenate ``text`` blocks into a single
    string so the hash is stable.

    Returns an empty list if ``payload`` is missing or has no messages.
    The output is a list of plain dicts (NOT normalized) so callers can
    still inspect the original structure if they want.
    """
    if not isinstance(payload, dict):
        return []
    out: list[dict[str, Any]] = []
    system = payload.get("system")
    if isinstance(system, str):
        out.append({"role": "system", "content": system})
    elif isinstance(system, list):
        text = "\n".join(
            b.get("text", "")
            for b in system
            if isinstance(b, dict) and b.get("type") == "text"
        )
        if text:
            out.append({"role": "system", "content": text})
    messages = payload.get("messages")
    if isinstance(messages, list):
        for m in messages:
            if isinstance(m, dict):
                out.append(m)
    return out


def extract_response_messages(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Extract the LLM message list from a response_body.

    Handles OpenAI's ``{"choices": [{"message": {...}}]}`` shape. Returns
    a single-element list with the assistant message (or empty list if
    no choices).
    """
    if not isinstance(payload, dict):
        return []
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return []
    first = choices[0]
    if not isinstance(first, dict):
        return []
    msg = first.get("message")
    if isinstance(msg, dict):
        return [msg]
    return []


class MessageStore:
    """Per-trace content-addressed message store.

    All methods are async because they go through the Postgres client
    (``eden.storage.postgres``). The store is stateless — every method
    is a thin SQL wrapper. Hashing happens in :mod:`eden.observability.canonical`.

    Public methods:

      * :meth:`upsert_request` / :meth:`upsert_response` — extract
        messages from a request/response body, hash them, insert into
        ``trace_messages`` (idempotent), return the hash arrays.
      * :meth:`get_many` — return messages for a hash list, in input
        order (None for missing hashes).
      * :meth:`reconstruct_request_body` / :meth:`reconstruct_response_body`
        — the Laminar-style "rebuild original payload from hash array"
        operation, used by the trace view.
      * :meth:`delete_trace` — clean up a trace's messages on deletion.
    """

    name = "message_store"

    # ── Write path ───────────────────────────────────────────────────

    async def upsert_request(
        self, trace_id: str, request_body: dict[str, Any] | None,
    ) -> list[str]:
        """Hash + insert request messages; return hash array (input order)."""
        return await self._upsert(trace_id, extract_request_messages(request_body))

    async def upsert_response(
        self, trace_id: str, response_body: dict[str, Any] | None,
    ) -> list[str]:
        """Hash + insert response messages; return hash array (input order)."""
        return await self._upsert(trace_id, extract_response_messages(response_body))

    async def _upsert(
        self, trace_id: str, messages: list[dict[str, Any]],
    ) -> list[str]:
        if not messages:
            return []
        hashes = hash_messages(messages)
        rows = [
            (trace_id, h, m.get("role", "user"), json.dumps(m, default=str))
            for h, m in zip(hashes, messages, strict=False)
        ]
        client = await self._get_client()
        if client is None:
            logger.warning("MessageStore: no Postgres client, skipping upsert")
            return hashes
        try:
            # Nested transaction → SAVEPOINT when the request already
            # holds an open RLS-pinned tx. A failure here must not abort
            # that outer transaction: ``_prepare_postgres_row`` treats
            # dedupe as best-effort, and an aborted outer tx makes the
            # subsequent telemetry INSERT raise InFailedSQLTransaction
            # (or worse, race a background task and lose the commit
            # while ingest already returned accepted:1).
            async with client.transaction() as conn:
                await conn.executemany(
                    """
                    INSERT INTO trace_messages (trace_id, msg_hash, role, content)
                    VALUES ($1, $2, $3, $4::jsonb)
                    ON CONFLICT (trace_id, msg_hash) DO NOTHING
                    """,
                    rows,
                )
        except Exception as exc:
            logger.warning(f"MessageStore._upsert failed: {exc}")
        return hashes

    # ── Read path ────────────────────────────────────────────────────

    async def get_many(
        self, trace_id: str, hashes: list[str],
    ) -> list[dict[str, Any] | None]:
        """Return messages for hashes, in input order.

        The ``content`` JSONB column stores the entire message dict
        (including its ``role`` field) so that reconstruction returns
        the same shape we ingested — the ``role`` column is split out
        only for indexability / CHECK-constraint validation. Missing
        hashes return ``None`` (preserving order so callers can detect
        gaps and fall back to the raw JSONB columns). An empty
        ``hashes`` list returns ``[]`` (no DB hit).
        """
        if not hashes:
            return []
        client = await self._get_client()
        if client is None:
            return [None] * len(hashes)
        try:
            rows = await client.fetch(
                """
                SELECT msg_hash, content
                FROM trace_messages
                WHERE trace_id = $1 AND msg_hash = ANY($2::text[])
                """,
                trace_id, hashes,
            )
            by_hash = {r["msg_hash"]: r["content"] for r in rows}
            return [by_hash.get(h) for h in hashes]
        except Exception as exc:
            logger.warning(f"MessageStore.get_many failed: {exc}")
            return [None] * len(hashes)

    async def reconstruct_request_body(
        self, trace_id: str, hashes: list[str],
    ) -> dict[str, Any] | None:
        """Reconstruct ``{"messages": [...]}`` from a hash array.

        Returns ``None`` if the hash array is empty or no messages were
        found (caller should fall back to the raw JSONB column).
        """
        msgs = await self.get_many(trace_id, hashes)
        out = [m for m in msgs if m is not None]
        if not out:
            return None
        return {"messages": out}

    async def reconstruct_response_body(
        self, trace_id: str, hashes: list[str],
    ) -> dict[str, Any] | None:
        """Reconstruct ``{"choices": [{"message": ...}, ...]}`` from a hash array."""
        msgs = await self.get_many(trace_id, hashes)
        out = [m for m in msgs if m is not None]
        if not out:
            return None
        return {"choices": [{"message": m} for m in out]}

    # ── Cleanup ──────────────────────────────────────────────────────

    async def delete_trace(self, trace_id: str) -> int:
        """Delete all messages for a trace (called on trace cleanup).

        Returns the number of rows deleted. Safe to call on a trace
        that has no messages (returns 0).
        """
        client = await self._get_client()
        if client is None:
            return 0
        try:
            result = await client.execute(
                "DELETE FROM trace_messages WHERE trace_id = $1",
                trace_id,
            )
            # asyncpg returns status string like "DELETE 42"; parse it.
            try:
                return int(str(result).split()[-1])
            except (ValueError, AttributeError, IndexError):
                return 0
        except Exception as exc:
            logger.warning(f"MessageStore.delete_trace failed: {exc}")
            return 0

    # ── Stats ────────────────────────────────────────────────────────

    async def gc_orphans(
        self,
        batch_size: int = 500,
        *,
        dry_run: bool = True,
        min_age_days: int = 7,
    ) -> int:
        """Delete ``trace_messages`` rows whose trace has no rows in
        ``telemetry_events`` (Phase B4).

        Called by the daily retention cron. Phase B3's archive path
        deletes the messages inline; this sweep catches anything
        left over (failed archives, manual SQL deletes, replayed
        traces that were re-ingested from cold).

        Returns the number of orphan rows deleted, or — when ``dry_run`` is
        set — the number that *would* be deleted.

        Safety, all three added in the 2026-07 remediation:

        ``dry_run`` defaults to **True**. ``retention_cron`` invoked this with
        no arguments while its own CLI defaults to ``--dry-run``, so running
        the module as documented permanently deleted rows.

        ``min_age_days`` keeps a freshly-written trace whose events have not
        landed yet from being swept. The anti-join alone cannot distinguish
        "orphaned" from "in flight".

        Rows referenced by ``trace_archive_index`` are excluded outright —
        those messages are the archived copy, and the archive is the only
        remaining source of the prompt/completion text.

        There is deliberately **no ``org_id`` parameter**: ``trace_messages``
        is keyed ``(trace_id, msg_hash)`` and carries no tenant column, so a
        tenant predicate cannot be expressed here.
        """
        client = await self._get_client()
        if client is None:
            return 0
        try:
            total = 0
            while True:
                # Postgres-only anti-join: rows in trace_messages whose
                # trace_id has no remaining telemetry_events row, are older
                # than the age floor, and are not the live copy of an
                # archived trace.
                rows = await client.fetch(
                    """
                    SELECT tm.trace_id
                      FROM trace_messages tm
                     WHERE NOT EXISTS (
                               SELECT 1 FROM telemetry_events te
                                WHERE te.trace_id = tm.trace_id
                           )
                       AND NOT EXISTS (
                               SELECT 1 FROM trace_archive_index tai
                                WHERE tai.trace_id = tm.trace_id
                           )
                       AND tm.first_seen_at < NOW() - ($2 || ' days')::interval
                     LIMIT $1
                    """,
                    batch_size,
                    str(max(0, min_age_days)),
                )
                if not rows:
                    break
                trace_ids = [r["trace_id"] for r in rows]
                if dry_run:
                    total += len(trace_ids)
                    logger.info(
                        "trace_messages gc: dry-run, would delete messages for "
                        "%s trace(s) (total=%s)",
                        len(trace_ids),
                        total,
                    )
                    # No DELETE means the predicate still matches these rows,
                    # so a second pass would loop forever. One batch is a
                    # sufficient estimate for a dry run.
                    break
                deleted = await client.execute(
                    "DELETE FROM trace_messages WHERE trace_id = ANY($1::text[])",
                    trace_ids,
                )
                # Parse "DELETE n" from the asyncpg status string.
                try:
                    n = int(str(deleted).split()[-1])
                except (ValueError, AttributeError, IndexError):
                    n = 0
                total += n
                logger.info(f"trace_messages gc: deleted {n} orphan rows (total={total})")
                # If this batch was full, loop; otherwise done.
                if len(trace_ids) < batch_size:
                    break
            return total
        except Exception as exc:
            logger.warning(f"MessageStore.gc_orphans failed: {exc}")
            return 0

    async def trace_stats(self, trace_id: str) -> dict[str, int]:
        """Return dedup stats for a trace: unique messages + total refs.

        Useful for tests and dashboards. ``unique_messages`` is the
        number of rows in ``trace_messages`` for this trace;
        ``total_refs`` is the sum of array lengths across
        ``request_message_hashes`` + ``response_message_hashes`` on all
        spans in the trace.
        """
        client = await self._get_client()
        if client is None:
            return {"unique_messages": 0, "total_refs": 0}
        try:
            row = await client.fetchrow(
                """
                SELECT
                    (SELECT COUNT(*) FROM trace_messages
                     WHERE trace_id = $1) AS unique_messages,
                    COALESCE((
                        SELECT SUM(COALESCE(array_length(request_message_hashes, 1), 0)
                                 + COALESCE(array_length(response_message_hashes, 1), 0))
                        FROM telemetry_events
                        WHERE trace_id = $1
                    ), 0) AS total_refs
                """,
                trace_id,
            )
            if row is None:
                return {"unique_messages": 0, "total_refs": 0}
            return {
                "unique_messages": int(row.get("unique_messages") or 0),
                "total_refs": int(row.get("total_refs") or 0),
            }
        except Exception as exc:
            logger.warning(f"MessageStore.trace_stats failed: {exc}")
            return {"unique_messages": 0, "total_refs": 0}

    # ── Internal ─────────────────────────────────────────────────────

    @staticmethod
    async def _get_client() -> Any:
        try:
            from eden.storage.postgres import get_postgres_client
            return await get_postgres_client()
        except Exception as exc:
            logger.warning(f"MessageStore: Postgres client unavailable: {exc}")
            return None


# ── Singleton accessor ──────────────────────────────────────────────

_message_store: MessageStore | None = None


def get_message_store() -> MessageStore:
    """Return the process-wide singleton MessageStore."""
    global _message_store
    if _message_store is None:
        _message_store = MessageStore()
    return _message_store
