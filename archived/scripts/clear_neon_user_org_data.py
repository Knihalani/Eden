"""Clear stale user/org rows on Neon staging (schema + indexes preserved).

Deletes portal identity data so a fresh Clerk signup can self-provision
cleanly. Does NOT drop tables, indexes, or run migrations.

Usage (from API container with DATABASE_URL):
    python scripts/clear_neon_user_org_data.py --confirm
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys


TABLES_IN_DELETE_ORDER = [
    # Children first — org/user scoped app data
    "notifications",
    "org_invitations",
    "org_members",
    "onboarding_state",
    "sidebar_prefs",
    "api_keys",
    "sessions",
    "organizations",
    "users",
]


async def main(confirm: bool) -> int:
    if not confirm:
        print("Refusing to run without --confirm", file=sys.stderr)
        return 2

    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    deleted: dict[str, int] = {}

    for table in TABLES_IN_DELETE_ORDER:
        try:
            result = await client.execute(f"DELETE FROM {table}")
            # asyncpg returns 'DELETE N'
            count = int(str(result).split()[-1]) if result else 0
            deleted[table] = count
            print(f"DELETE {table}: {count} rows")
        except Exception as exc:
            # Table may not exist on older DBs — skip
            if "does not exist" in str(exc):
                print(f"SKIP {table}: not present")
                continue
            raise

    print("Done. Alembic version and indexes unchanged.")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Required flag — deletes user/org data irreversibly",
    )
    args = parser.parse_args()
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    raise SystemExit(asyncio.run(main(args.confirm)))
