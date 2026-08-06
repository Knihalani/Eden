"""One-time RTBF Typesense ``user_id`` backfill script.

Spans/events indexed into Typesense before the ``user_id`` field
existed on the search schema are not scoped by identity, so a
per-user RTBF erasure request (see
``eden.services.governance_intel.gdpr``) can't remove them from
Typesense today — the fanout reports ``status: "unsupported"`` for
that store until this script has been run once against production
(see ``docs/docs/explanation/security-model.md``).

This script keyset-scans ``telemetry_events`` in Postgres (oldest
``event_id`` first, so it's safe to stop/resume), extracts a known
user-identity value from each row's ``attributes`` JSONB (mirroring
the decoder-specific keys used across ingesters — see
``eden.services.governance_intel.gdpr._TELEMETRY_USER_KEYS``), and
patches the matching Typesense documents with that ``user_id``. Rows
with no known identity key are left untouched (Typesense simply won't
be able to scope them to a user later; that's expected for anonymous
telemetry).

Idempotency: safe to re-run. Rows that already carry a Typesense
``user_id`` are just re-written with the same value.

Usage::

    # Dry-run first — counts matches without writing to Typesense.
    python -m eden.scripts.typesense_backfill_user_id --dry-run

    # Apply for real.
    python -m eden.scripts.typesense_backfill_user_id

    # Scan at most N rows (useful for staging batches).
    python -m eden.scripts.typesense_backfill_user_id --limit 50000
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from typing import Any

logger = logging.getLogger(__name__)

#: Known user-identity keys on span/event ``attributes``, checked in
#: order. Mirrors the plain ``user_id`` key first-party ingestion
#: should use, plus the Langfuse / Helicone decoder-specific keys and
#: the OTel ``enduser.id`` convention.
_SPAN_USER_KEYS: tuple[str, ...] = (
    "user_id",
    "langfuse.user_id",
    "helicone.user_id",
    "enduser.id",
)


def _extract_user_id(attrs: dict[str, Any] | None) -> str:
    """Return the first known user-identity value found in ``attrs``.

    Checks ``_SPAN_USER_KEYS`` in order and returns the first
    non-blank string value found. Returns ``""`` if ``attrs`` is
    ``None``/empty, has no known key, or every known key is blank.
    """
    if not attrs:
        return ""
    for key in _SPAN_USER_KEYS:
        value = attrs.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


async def _fetch_batch(
    client: Any, after_event_id: str | None, limit: int
) -> list[dict[str, Any]]:
    """Fetch the next page of ``telemetry_events``, ``event_id`` ascending.

    Keyset (cursor) pagination on ``event_id`` rather than
    ``OFFSET``/page-number so the scan is stable under concurrent
    inserts and cheap to resume.
    """
    if after_event_id is None:
        sql = """
            SELECT event_id, tenant_id, attributes
            FROM telemetry_events
            ORDER BY event_id
            LIMIT $1
        """
        return await client.fetch(sql, limit)

    sql = """
        SELECT event_id, tenant_id, attributes
        FROM telemetry_events
        WHERE event_id > $1
        ORDER BY event_id
        LIMIT $2
    """
    return await client.fetch(sql, after_event_id, limit)


async def run(dry_run: bool, limit: int | None, batch_size: int) -> int:
    """Backfill Typesense ``user_id`` for spans indexed before it existed.

    Returns ``0`` on success (including a no-op dry-run) and ``2`` if
    a live (non-dry-run) invocation can't proceed because Typesense
    isn't configured.
    """
    from eden.observability.typesense_client import get_typesense_client

    ts = get_typesense_client()
    if not dry_run and ts is None:
        print(
            "ERROR: Typesense is not configured; nothing to backfill.",
            file=sys.stderr,
        )
        return 2

    from eden.storage.postgres import get_postgres_client

    pg = await get_postgres_client()

    scanned = 0
    matched = 0
    pairs: list[tuple[str, str]] = []
    after_event_id: str | None = None

    while True:
        remaining = None if limit is None else limit - scanned
        if remaining is not None and remaining <= 0:
            break
        page_size = batch_size if remaining is None else min(batch_size, remaining)

        rows = await _fetch_batch(pg, after_event_id, page_size)
        if not rows:
            break

        for row in rows:
            scanned += 1
            user_id = _extract_user_id(row.get("attributes"))
            if user_id:
                matched += 1
                pairs.append((f"{row['tenant_id']}:{row['event_id']}", user_id))

        after_event_id = rows[-1]["event_id"]

        if len(rows) < page_size:
            break

    print(f"Scanned {scanned} row(s); {matched} carried a known user_id.")

    if dry_run:
        print(f"[dry-run] would patch {matched} Typesense document(s).")
        return 0

    if pairs:
        patched = await ts.backfill_user_ids(pairs)
        print(f"Patched {patched} Typesense document(s).")
    else:
        print("Nothing to patch.")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Count matches without writing to Typesense.",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Scan at most N telemetry_events rows (default: all).",
    )
    parser.add_argument(
        "--batch-size", type=int, default=500,
        help="Rows fetched from Postgres per page (default: 500).",
    )
    parser.add_argument(
        "--log-level", default="WARNING",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(message)s",
    )
    return asyncio.run(run(args.dry_run, args.limit, args.batch_size))


if __name__ == "__main__":
    sys.exit(main())
