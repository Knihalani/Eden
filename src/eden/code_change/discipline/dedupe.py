"""Dedupe index — duplicate-detection for PR candidates.

The brief is explicit: PR generation must not spam the
same recommendation repeatedly. This module maintains a
short-window, per-org dedupe index keyed on the
``Decision.fingerprint`` from :mod:`confidence_gate`.

Two roles:

* :class:`DedupeIndex.is_duplicate` — query the index. A
  fingerprint is "duplicate" if it's been seen in the
  recent window (default 14d) with an active ``decision``
  (allowed or denied). The query is best-effort: a DB
  outage returns ``False`` so the discipline layer
  fails *open* (preferring the gate over silent blocking).

* :func:`store.record_outcome` — append a fingerprint +
  outcome to the index. Outcomes include ``"allowed"``
  (a PR was opened), ``"denied"`` (the gate said no),
  ``"merged"`` (the PR landed), ``"reverted"`` (the PR
  was reverted), and ``"report_only"`` (a report was
  produced without a PR). Outcomes with ``"reverted"``
  also update the dedupe index for that fingerprint to
  suppress future re-fires.

The index is intentionally lightweight: one row per
``(org_id, fingerprint)`` with a rolling ``last_seen_at``
+ ``outcome`` + ``expires_at``. A nightly sweep (or a
background job) evicts rows past their ``expires_at``.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

logger = logging.getLogger(__name__)


# Default dedupe window. 14 days matches the brief's
# "not-now memory" semantics from the existing
# ``pr_rejection_memory`` table — long enough that a
# genuine re-emergence of the same issue isn't suppressed,
# short enough that a previously-rejected recommendation
# isn't permanently remembered.
DEFAULT_WINDOW_DAYS = 14


_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_table(table: str) -> None:
    """Whitelist SQL identifiers the same way as ``_common``."""
    if not isinstance(table, str) or not _IDENT.match(table):
        raise ValueError(
            f"dedupe: invalid SQL identifier table={table!r}"
        )


@dataclass
class DedupeHit:
    """The result of a dedupe query.

    Attributes:
        is_duplicate: True if the fingerprint was seen
            recently with an active decision.
        last_outcome: The most recent outcome string
            (``"allowed"``, ``"denied"``, ``"merged"``,
            ``"reverted"``, ``"report_only"``).
        last_seen_at: ISO-8601 timestamp of the last
            write.
        occurrences: How many times the fingerprint has
            been seen in the window.
    """

    is_duplicate: bool
    last_outcome: str = ""
    last_seen_at: str = ""
    occurrences: int = 0


class DedupeIndex:
    """Per-org dedupe index for PR candidates.

    Reads + writes go through the same best-effort
    patterns as the rest of the Cat 23 surface — a DB
    outage degrades to "not a duplicate" so the
    confidence gate (which is the more meaningful
    protection) still runs.
    """

    name = "dedupe_index"

    def __init__(self, *, table: str = "pr_dedupe_index",
                 window_days: int = DEFAULT_WINDOW_DAYS) -> None:
        _validate_table(table)
        self._table = table
        self._window_days = int(window_days)

    async def is_duplicate(
        self, org_id: str, fingerprint: str,
    ) -> DedupeHit:
        """Return whether ``fingerprint`` was seen recently for ``org_id``.

        A DB error returns ``DedupeHit(is_duplicate=False)`` so
        the caller can still proceed; the confidence gate will
        still apply, so this is a strict-superset protection.
        """
        if not fingerprint or not org_id:
            return DedupeHit(is_duplicate=False)
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is None:
                return DedupeHit(is_duplicate=False)
            async with client.acquire() as conn:
                row = await conn.fetchrow(
                    f"SELECT last_outcome, last_seen_at, occurrences "
                    f"FROM {self._table} WHERE org_id = $1 "
                    f"AND fingerprint = $2 AND expires_at > NOW()",
                    org_id,
                    fingerprint,
                )
        except Exception as exc:
            logger.debug(
                "dedupe.is_duplicate: %s (failing open)", exc,
            )
            return DedupeHit(is_duplicate=False)
        if row is None:
            return DedupeHit(is_duplicate=False)
        return DedupeHit(
            is_duplicate=True,
            last_outcome=str(row.get("last_outcome") or ""),
            last_seen_at=str(row.get("last_seen_at") or ""),
            occurrences=int(row.get("occurrences") or 0),
        )

    async def record(
        self,
        org_id: str,
        fingerprint: str,
        *,
        outcome: str,
        ttl_days: int | None = None,
    ) -> bool:
        """Append ``fingerprint`` to the index for ``org_id``.

        Upserts the row: increments ``occurrences`` on
        collision, replaces ``last_outcome`` + ``last_seen_at``
        + ``expires_at``. Returns ``True`` if the row was
        written.
        """
        if not fingerprint or not org_id or not outcome:
            return False
        ttl = int(ttl_days) if ttl_days is not None else self._window_days
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is None:
                return False
            now = datetime.now(UTC).isoformat()
            expires = (datetime.now(UTC) + timedelta(days=ttl)).isoformat()
            async with client.acquire() as conn:
                await conn.execute(
                    f"INSERT INTO {self._table} "
                    f"(org_id, fingerprint, last_outcome, last_seen_at, "
                    f"expires_at, occurrences) "
                    f"VALUES ($1, $2, $3, $4, $5, 1) "
                    f"ON CONFLICT (org_id, fingerprint) DO UPDATE SET "
                    f"last_outcome = EXCLUDED.last_outcome, "
                    f"last_seen_at = EXCLUDED.last_seen_at, "
                    f"expires_at = EXCLUDED.expires_at, "
                    f"occurrences = {self._table}.occurrences + 1",
                    org_id,
                    fingerprint,
                    outcome,
                    now,
                    expires,
                )
            return True
        except Exception as exc:
            logger.debug("dedupe.record: %s", exc)
            return False

    async def sweep_expired(self, org_id: str | None = None) -> int:
        """Delete rows past ``expires_at``. Returns the deleted count.

        If ``org_id`` is provided, only that org's expired rows
        are deleted (used by the per-org nightly job). If it's
        ``None``, every expired row across every org is deleted
        (the global sweep).
        """
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is None:
                return 0
            async with client.acquire() as conn:
                if org_id is None:
                    res = await conn.execute(
                        f"DELETE FROM {self._table} WHERE expires_at <= NOW()"
                    )
                else:
                    res = await conn.execute(
                        f"DELETE FROM {self._table} "
                        f"WHERE org_id = $1 AND expires_at <= NOW()",
                        org_id,
                    )
            # asyncpg returns "DELETE <n>"
            try:
                return int(str(res).split()[-1])
            except (ValueError, IndexError):
                return 0
        except Exception as exc:
            logger.debug("dedupe.sweep_expired: %s", exc)
            return 0
