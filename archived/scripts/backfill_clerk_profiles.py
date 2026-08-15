"""One-shot backfill: enrich Clerk-managed users with real email/name/avatar.

The June 2026 Clerk cutover landed an /auth/me auto-provision path that
inserts a row from the Clerk session JWT alone. The default Clerk
session JWT does NOT include ``email`` / ``first_name`` / ``last_name`` /
``image_url`` — those have to be either added to a JWT template in the
Clerk dashboard or fetched from the Backend API. The auto-provision
inserted with empty ``email`` + ``name = "Eden user"`` for the first
signups because the Clerk webhook wasn't configured (missing
``CLERK_WEBHOOK_SIGNING_SECRET``).

This script backfills the existing Clerk-managed users (any row where
``clerk_id IS NOT NULL``) by calling Clerk's Backend API for each
missing profile field. It is idempotent: re-running is a no-op for
users who already have a real email.

Run once after deploy:

    uv run python scripts/backfill_clerk_profiles.py

Add ``--dry-run`` to preview without writing.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from eden.api.utils.clerk_client import (
    ClerkAPIError,
    extract_user_profile,
    get_user,
)
from eden.storage.postgres import close_postgres_client, get_postgres_client

logger = logging.getLogger("backfill_clerk_profiles")


async def main(dry_run: bool) -> int:
    client = await get_postgres_client()
    rows = await client.fetch(
        """
        SELECT id, email, name, avatar_url, clerk_id
        FROM users
        WHERE clerk_id IS NOT NULL AND deleted_at IS NULL
        ORDER BY created_at DESC
        """,
    )
    if not rows:
        print("No Clerk-managed users to backfill.")
        return 0
    print(f"Found {len(rows)} Clerk-managed user(s).")
    updated = 0
    for row in rows:
        clerk_id = row["clerk_id"]
        try:
            payload = await get_user(clerk_id)
        except ClerkAPIError as exc:
            print(f"  [{clerk_id}] Clerk API error: {exc}")
            continue
        if not payload:
            print(f"  [{clerk_id}] user not found in Clerk — skipped")
            continue
        profile = extract_user_profile(payload)
        new_email = profile["email"] or row["email"]
        new_name = profile["name"] if profile["name"] else row["name"]
        new_avatar = profile["avatar_url"] or row["avatar_url"]
        # Skip if nothing changed.
        if (
            new_email == row["email"]
            and new_name == row["name"]
            and new_avatar == row["avatar_url"]
        ):
            print(f"  [{clerk_id}] already up to date ({row['email']})")
            continue
        print(
            f"  [{clerk_id}] {row['email']!r} -> {new_email!r}, "
            f"{row['name']!r} -> {new_name!r}"
        )
        if dry_run:
            print("    (dry-run: no UPDATE issued)")
            continue
        await client.execute(
            """
            UPDATE users
            SET email = $1, name = $2, avatar_url = $3
            WHERE id = $4
            """,
            new_email,
            new_name,
            new_avatar,
            row["id"],
        )
        updated += 1
    await close_postgres_client()
    print(f"\nDone. Updated {updated} row(s).")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview the changes without writing to Postgres.",
    )
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.dry_run)))
