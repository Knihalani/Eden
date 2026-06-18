"""Backfill script: create Clerk orgs for legacy Eden rows.

Finds rows in ``organizations`` where ``clerk_org_id IS NULL`` (i.e.
created by Eden's ``POST /orgs`` before the Clerk-Backend-API
integration in migrations/038_org_clerk_id.sql) and creates a
matching Clerk org via Clerk Backend API. Writes the returned
``clerk_org_id`` back to the row.

Idempotency: re-running on already-backfilled rows is a no-op
because the ``WHERE clerk_org_id IS NULL`` filter skips them.

Usage::

    # Dry-run first — prints what would change without writing.
    python -m eden.scripts.backfill_legacy_orgs --dry-run

    # Apply for real.
    python -m eden.scripts.backfill_legacy_orgs

    # Process at most N rows (useful for staging batches).
    python -m eden.scripts.backfill_legacy_orgs --limit 50
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from typing import Any

from eden.api.utils.clerk_client import (
    ClerkAPIError,
    create_organization,
)
from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


async def _fetch_legacy_orgs(limit: int | None) -> list[dict[str, Any]]:
    """Return Eden orgs with no Clerk linkage, oldest first."""
    client = await get_postgres_client()
    query = """
        SELECT id, name, slug
        FROM organizations
        WHERE clerk_org_id IS NULL
        ORDER BY created_at ASC
    """
    if limit is not None:
        query += " LIMIT $1"
        rows = await client.fetch(query, limit)
    else:
        rows = await client.fetch(query)
    return [dict(r) for r in rows]


async def _write_clerk_org_id(eden_org_id: str, clerk_org_id: str) -> None:
    """Update the Eden row with the new Clerk linkage."""
    client = await get_postgres_client()
    await client.execute(
        """
        UPDATE organizations
        SET clerk_org_id = $1, updated_at = NOW()
        WHERE id = $2 AND clerk_org_id IS NULL
        """,
        clerk_org_id,
        eden_org_id,
    )


async def run(dry_run: bool, limit: int | None) -> int:
    settings = get_settings()
    if not settings.clerk_secret_key and not dry_run:
        print("ERROR: CLERK_SECRET_KEY not configured.", file=sys.stderr)
        return 2

    orgs = await _fetch_legacy_orgs(limit)
    print(f"Found {len(orgs)} legacy org(s) without clerk_org_id.")

    if not orgs:
        return 0

    if dry_run:
        for org in orgs:
            print(f"  [dry-run] would create Clerk org for {org['id']}: "
                  f"name={org['name']!r} slug={org['slug']!r}")
        return 0

    succeeded = 0
    skipped = 0
    failed = 0
    for org in orgs:
        try:
            clerk_org = await create_organization(
                name=org["name"], slug=org["slug"],
            )
            clerk_org_id = str(clerk_org.get("id") or "")
            if not clerk_org_id:
                logger.warning(
                    "Clerk returned empty id for eden_org=%s slug=%s: %s",
                    org["id"], org["slug"], clerk_org,
                )
                failed += 1
                continue
            await _write_clerk_org_id(org["id"], clerk_org_id)
            print(f"  [ok]   eden={org['id']} → clerk={clerk_org_id} "
                  f"name={org['name']!r}")
            succeeded += 1
        except ClerkAPIError as exc:
            # 422 with a slug-collision is the most common failure:
            # the org already exists in Clerk under a different name.
            # Skip rather than fail so the operator can decide what
            # to do (often: link to the existing Clerk org manually).
            logger.warning(
                "Clerk create failed for eden_org=%s slug=%s: %s",
                org["id"], org["slug"], exc,
            )
            print(f"  [skip] eden={org['id']} slug={org['slug']!r}: {exc}")
            skipped += 1
        except Exception as exc:  # noqa: BLE001
            logger.exception(
                "Unexpected failure on eden_org=%s: %s", org["id"], exc,
            )
            print(f"  [err]  eden={org['id']}: {exc}")
            failed += 1

    print(f"\nDone. succeeded={succeeded} skipped={skipped} failed={failed}")
    return 0 if failed == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would change without writing.",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process at most N rows (default: all).",
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
    return asyncio.run(run(args.dry_run, args.limit))


if __name__ == "__main__":
    sys.exit(main())
