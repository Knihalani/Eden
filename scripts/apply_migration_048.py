"""Apply migration 048 (users.avatar_url) to the live DB.

One-shot script. Safe to re-run: the column has IF NOT EXISTS
guards. Idempotent.
"""
from __future__ import annotations

import asyncio
import sys

from eden.storage.postgres import close_postgres_client, get_postgres_client


async def main() -> int:
    client = await get_postgres_client()
    try:
        # Show the column BEFORE
        before = await client.fetchval("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'users'
                  AND column_name = 'avatar_url'
            )
        """)
        print(f"users.avatar_url exists before: {before}")

        # Apply the migration
        await client.execute(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT"
        )
        print("ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT -- OK")

        # Show the column AFTER
        after = await client.fetchval("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_name = 'users'
                  AND column_name = 'avatar_url'
            )
        """)
        print(f"users.avatar_url exists after:  {after}")
        return 0
    finally:
        await close_postgres_client()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
