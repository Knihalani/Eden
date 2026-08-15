#!/usr/bin/env python3
"""Backfill ``prev_hash`` and ``entry_hash`` for existing audit-log rows.

Idempotent. Run once after applying migration 021. Subsequent runs are
no-ops because the rows already have non-NULL hashes.

Usage:
    python docker/postgres/audit-backfill.py
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

# Add the project's src/ to sys.path so we can import eden modules
SRC = Path(__file__).resolve().parents[2] / "src"
sys.path.insert(0, str(SRC))

from eden.storage.postgres import get_postgres_client  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("audit-backfill")


async def backfill_org(org_id: str) -> int:
    """Backfill a single org's audit log. Returns the number of rows
    updated. Idempotent: rows that already have an entry_hash are
    skipped."""
    client = await get_postgres_client()
    # Order rows chronologically per-org and chain them.
    rows = await client.fetch(
        """
        SELECT id, prev_hash
        FROM org_audit_log
        WHERE org_id = $1
        ORDER BY created_at ASC, id ASC
        """,
        org_id,
    )
    if not rows:
        return 0
    updated = 0
    for row in rows:
        # Trigger would normally compute this on insert; for backfill
        # we use the same SQL function the trigger calls.
        result = await client.fetchrow(
            """
            WITH prev AS (
                SELECT entry_hash FROM org_audit_log
                 WHERE org_id = $1
                   AND (created_at, id) < (
                        SELECT created_at, id FROM org_audit_log WHERE id = $2
                   )
                 ORDER BY created_at DESC, id DESC
                 LIMIT 1
            )
            UPDATE org_audit_log oal
               SET prev_hash = COALESCE((SELECT entry_hash FROM prev), repeat('0', 64)),
                   entry_hash = encode(
                       digest(
                           COALESCE((SELECT entry_hash FROM prev), repeat('0', 64)) ||
                           audit_canonical_json(
                               oal.id, oal.org_id, oal.user_id, oal.action,
                               oal.target_type, oal.target_id,
                               COALESCE(oal.metadata, '{}'::jsonb),
                               oal.ip_address, oal.user_agent, oal.created_at
                           ),
                           'sha256'
                       ),
                       'hex'
                   )
             WHERE oal.id = $2
               AND oal.entry_hash IS NULL
            RETURNING id
            """,
            org_id,
            row["id"],
        )
        if result is not None:
            updated += 1
    return updated


async def main() -> int:
    client = await get_postgres_client()
    orgs = await client.fetch("SELECT id FROM organizations")
    total = 0
    for org in orgs:
        n = await backfill_org(str(org["id"]))
        if n:
            logger.info("Backfilled %d rows for org %s", n, org["id"])
        total += n
    logger.info("Done. Backfilled %d rows total across %d orgs.", total, len(orgs))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
