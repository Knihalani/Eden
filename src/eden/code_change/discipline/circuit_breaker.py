"""Circuit breaker — short-window protection against PR noise.

The brief is explicit: PR generation must not become a
source of operational noise. The circuit breaker tracks
recent outcomes (rejections, failures, reverted PRs) and
trips when the failure rate crosses a threshold. Once
tripped, the breaker forces every subsequent trigger to
take the report-only path for ``cooldown_seconds``.

State machine:

* ``closed`` — normal operation; every decision flows
  through the confidence gate.
* ``open`` — tripped; all triggers are forced to
  report-only. The breaker's :meth:`should_allow`
  returns ``False`` until the cooldown expires.
* ``half_open`` — the cooldown has expired but we have
  not yet seen a "good" outcome. The next call is
  allowed through as a probe. If it fails, the breaker
  re-opens. If it succeeds, the breaker closes.

The breaker is **fail-open by default** — a DB outage
treats the state as ``closed`` so the discipline layer
degrades gracefully. This is the opposite of the
existing per-day rate caps, which fail-closed; the
breaker's role is to protect against *too many* PRs,
so failing open means "let the rate caps decide".

The breaker state is persisted in
``circuit_breaker_state`` keyed on ``(org_id, breaker_name)``
so a restart doesn't reset it.

The :class:`Record` dataclass is the shape stored in
the DB.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

logger = logging.getLogger(__name__)


State = Literal["closed", "open", "half_open"]


# Default breaker policy. Per-org overrides via the
# discipline policy JSONB.
DEFAULT_BREAKER_POLICY: dict[str, Any] = {
    "failure_threshold": 5,        # open after this many failures in window
    "window_seconds": 3600,        # 1h rolling window
    "cooldown_seconds": 1800,      # 30m cool-down after trip
    "min_rejections_to_trip": 3,   # at least 3 human rejections
}


_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_table(table: str) -> None:
    if not isinstance(table, str) or not _IDENT.match(table):
        raise ValueError(
            f"circuit_breaker: invalid SQL identifier table={table!r}"
        )


@dataclass
class Record:
    """A single breaker's persisted state.

    Attributes:
        state: ``"closed"`` / ``"open"`` / ``"half_open"``.
        failure_count: Count of failures in the current window.
        rejection_count: Count of human rejections in the window.
        opened_at: When the breaker last opened (ISO 8601).
        window_started_at: When the current window started.
    """

    state: State = "closed"
    failure_count: int = 0
    rejection_count: int = 0
    opened_at: str = ""
    window_started_at: str = field(
        default_factory=lambda: datetime.now(UTC).isoformat(),
    )


class CircuitBreaker:
    """Per-org short-window circuit breaker for PR automation.

    The breaker is named (``breaker_name``) so an org can
    run multiple breakers in parallel — e.g. one for
    incident-driven PRs and one for scheduled
    optimization PRs. The names are part of the DB key
    but have no effect on the logic.
    """

    name = "circuit_breaker"

    def __init__(
        self,
        breaker_name: str = "pr_automation",
        *,
        table: str = "circuit_breaker_state",
        policy: dict[str, Any] | None = None,
    ) -> None:
        _validate_table(table)
        self.breaker_name = breaker_name
        self._table = table
        self._policy = {**DEFAULT_BREAKER_POLICY, **(policy or {})}

    @property
    def policy(self) -> dict[str, Any]:
        return dict(self._policy)

    async def _read(self, org_id: str) -> Record:
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is None:
                return Record()
            async with client.acquire() as conn:
                row = await conn.fetchrow(
                    f"SELECT state, failure_count, rejection_count, "
                    f"opened_at, window_started_at "
                    f"FROM {self._table} "
                    f"WHERE org_id = $1 AND breaker_name = $2",
                    org_id,
                    self.breaker_name,
                )
        except Exception as exc:
            logger.debug(
                "circuit_breaker._read: %s (failing closed-by-default)",
                exc,
            )
            return Record()
        if row is None:
            return Record()
        try:
            state = str(row.get("state") or "closed")
            if state not in ("closed", "open", "half_open"):
                state = "closed"
            return Record(
                state=state,  # type: ignore[arg-type]
                failure_count=int(row.get("failure_count") or 0),
                rejection_count=int(row.get("rejection_count") or 0),
                opened_at=str(row.get("opened_at") or ""),
                window_started_at=str(
                    row.get("window_started_at") or ""
                ),
            )
        except Exception:
            return Record()

    async def _write(self, org_id: str, record: Record) -> bool:
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is None:
                return False
            async with client.acquire() as conn:
                await conn.execute(
                    f"INSERT INTO {self._table} "
                    f"(org_id, breaker_name, state, failure_count, "
                    f"rejection_count, opened_at, window_started_at, "
                    f"updated_at) "
                    f"VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) "
                    f"ON CONFLICT (org_id, breaker_name) DO UPDATE SET "
                    f"state = EXCLUDED.state, "
                    f"failure_count = EXCLUDED.failure_count, "
                    f"rejection_count = EXCLUDED.rejection_count, "
                    f"opened_at = EXCLUDED.opened_at, "
                    f"window_started_at = EXCLUDED.window_started_at, "
                    f"updated_at = NOW()",
                    org_id,
                    self.breaker_name,
                    record.state,
                    int(record.failure_count),
                    int(record.rejection_count),
                    record.opened_at or None,
                    record.window_started_at or datetime.now(UTC).isoformat(),
                )
            return True
        except Exception as exc:
            logger.debug("circuit_breaker._write: %s", exc)
            return False

    def _maybe_expire_window(
        self, record: Record,
    ) -> Record:
        """Reset counts if the rolling window has elapsed."""
        try:
            if not record.window_started_at:
                return record
            window_started = datetime.fromisoformat(
                record.window_started_at,
            )
            if window_started.tzinfo is None:
                window_started = window_started.replace(tzinfo=UTC)
            elapsed = (
                datetime.now(UTC) - window_started
            ).total_seconds()
            if elapsed > float(self._policy["window_seconds"]):
                return Record(state=record.state)
        except Exception:
            return record
        return record

    def _cooldown_elapsed(self, record: Record) -> bool:
        try:
            if record.state != "open" or not record.opened_at:
                return True
            opened = datetime.fromisoformat(record.opened_at)
            if opened.tzinfo is None:
                opened = opened.replace(tzinfo=UTC)
            elapsed = (
                datetime.now(UTC) - opened
            ).total_seconds()
            return elapsed >= float(self._policy["cooldown_seconds"])
        except Exception:
            return True

    async def should_allow(self, org_id: str) -> bool:
        """Return True if a PR attempt is allowed right now.

        Closed breakers always allow. Open breakers deny
        until the cooldown elapses, after which they
        transition to half_open and allow the next probe.
        Half-open breakers allow (they're testing).
        """
        record = await self._read(org_id)
        record = self._maybe_expire_window(record)
        if record.state == "closed":
            return True
        if record.state == "open":
            if self._cooldown_elapsed(record):
                record.state = "half_open"
                await self._write(org_id, record)
                return True
            return False
        # half_open: probe is allowed
        return True

    async def record_outcome(
        self,
        org_id: str,
        *,
        outcome: str,
    ) -> Record:
        """Record a breaker outcome.

        Outcomes:

        * ``"success"`` — half_open probe succeeded; close
          the breaker and reset counts.
        * ``"failure"`` — increment failure_count, possibly
          trip the breaker.
        * ``"rejection"`` — increment rejection_count,
          possibly trip the breaker (requires the threshold
          AND a minimum number of rejections).
        * ``"manual_reset"`` — force the breaker closed.

        Returns the updated :class:`Record`.

        F45: this method previously did
        ``read → mutate in Python → write`` outside any
        transaction. Concurrent calls would all read the
        same ``failure_count=0``, all bump to 1, and the
        last ``ON CONFLICT DO UPDATE`` would write 1 — the
        other N-1 increments were silently lost. The fix
        wraps the read+mutate+write in a single transaction
        with ``SELECT ... FOR UPDATE`` so concurrent
        callers serialize on the row.
        """
        if outcome not in ("success", "failure", "rejection", "manual_reset"):
            if outcome:
                logger.debug(
                    "circuit_breaker.record_outcome: unknown outcome %r",
                    outcome,
                )
            return await self._read(org_id)
        try:
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()
            if client is None:
                return Record()
            async with client.acquire() as conn, conn.transaction():
                # FOR UPDATE serializes concurrent
                # ``record_outcome`` calls on the same
                # (org_id, breaker_name) row.
                row = await conn.fetchrow(
                    f"SELECT state, failure_count, "
                    f"rejection_count, opened_at, "
                    f"window_started_at "
                    f"FROM {self._table} "
                    f"WHERE org_id = $1 "
                    f"  AND breaker_name = $2 "
                    f"FOR UPDATE",
                    org_id,
                    self.breaker_name,
                )
                record = self._row_to_record(row)
                record = self._maybe_expire_window(record)
                self._apply_outcome(record, outcome)
                await self._write_locked(
                    conn, org_id, record,
                )
                return record
        except Exception as exc:
            logger.debug(
                "circuit_breaker.record_outcome: %s "
                "(failing closed-by-default)",
                exc,
            )
            return Record()

    def _apply_outcome(
        self, record: Record, outcome: str,
    ) -> None:
        """Mutate ``record`` in place to reflect a new outcome.

        Split out from :meth:`record_outcome` so the
        transaction body reads as ``read → apply → write``
        and the mutation logic can be tested in isolation.
        """
        if outcome == "success" or outcome == "manual_reset":
            # success: half_open probe passed → close + reset
            # manual_reset: operator override → close + reset
            record.state = "closed"
            record.failure_count = 0
            record.rejection_count = 0
            record.opened_at = ""
        elif outcome == "failure":
            record.failure_count += 1
            if (
                record.failure_count
                >= int(self._policy["failure_threshold"])
            ):
                record.state = "open"
                record.opened_at = datetime.now(UTC).isoformat()
        elif outcome == "rejection":
            record.failure_count += 1
            record.rejection_count += 1
            if (
                record.failure_count
                >= int(self._policy["failure_threshold"])
                and record.rejection_count
                >= int(self._policy["min_rejections_to_trip"])
            ):
                record.state = "open"
                record.opened_at = datetime.now(UTC).isoformat()

    def _row_to_record(self, row: Any) -> Record:
        """Build a :class:`Record` from a fetched row (or
        ``None`` for the no-row-yet case).
        """
        if row is None:
            return Record()
        try:
            state = str(row.get("state") or "closed")
            if state not in ("closed", "open", "half_open"):
                state = "closed"
            return Record(
                state=state,  # type: ignore[arg-type]
                failure_count=int(row.get("failure_count") or 0),
                rejection_count=int(row.get("rejection_count") or 0),
                opened_at=str(row.get("opened_at") or ""),
                window_started_at=str(
                    row.get("window_started_at") or ""
                ),
            )
        except Exception:
            return Record()

    async def _write_locked(
        self, conn: Any, org_id: str, record: Record,
    ) -> None:
        """Write a :class:`Record` using the same connection
        that's holding the FOR UPDATE row lock.

        Same SQL as :meth:`_write` but takes an open
        connection (avoids re-acquiring from the pool, which
        would lose the row lock). The ``INSERT ... ON
        CONFLICT DO UPDATE`` form is the same so the
        row-not-yet-existing case still creates it.
        """
        await conn.execute(
            f"INSERT INTO {self._table} "
            f"(org_id, breaker_name, state, failure_count, "
            f"rejection_count, opened_at, window_started_at, "
            f"updated_at) "
            f"VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) "
            f"ON CONFLICT (org_id, breaker_name) DO UPDATE SET "
            f"state = EXCLUDED.state, "
            f"failure_count = EXCLUDED.failure_count, "
            f"rejection_count = EXCLUDED.rejection_count, "
            f"opened_at = EXCLUDED.opened_at, "
            f"window_started_at = EXCLUDED.window_started_at, "
            f"updated_at = NOW()",
            org_id,
            self.breaker_name,
            record.state,
            int(record.failure_count),
            int(record.rejection_count),
            record.opened_at or None,
            record.window_started_at
            or datetime.now(UTC).isoformat(),
        )

    async def status(self, org_id: str) -> dict[str, Any]:
        """Return the current breaker state for an org (read-only)."""
        record = await self._read(org_id)
        record = self._maybe_expire_window(record)
        return {
            "breaker_name": self.breaker_name,
            "org_id": org_id,
            "state": record.state,
            "failure_count": record.failure_count,
            "rejection_count": record.rejection_count,
            "opened_at": record.opened_at,
            "window_started_at": record.window_started_at,
            "policy": self.policy,
        }
