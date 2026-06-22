"""One-off: repoint an existing user row to a new Clerk id.

Used when the Clerk session the user is currently signed in with has
a different clerk_id than the Postgres row (typically because the
old Clerk account was deleted and a new one was created in its
place — the two systems don't auto-sync, and the Clerk webhook is
either misconfigured or missing the signing secret).

Usage:
    uv run python scripts/repoint_clerk_user.py <postgres_uuid> <new_clerk_id>
"""

from __future__ import annotations

import asyncio
import sys

from eden.storage.postgres import close_postgres_client, get_postgres_client


async def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    user_id, new_clerk_id = sys.argv[1], sys.argv[2]
    client = await get_postgres_client()
    try:
        # Show the row we're about to update so the operator can
        # verify the right one is being changed.
        before = await client.fetchrow(
            "SELECT id, email, clerk_id, created_at, deleted_at "
            "FROM users WHERE id = $1",
            user_id,
        )
        if not before:
            print(f"No user found with id={user_id}")
            return 1
        print(f"Before: {dict(before)}")
        # Sanity: don't silently overwrite a different live Clerk id.
        if before["clerk_id"] and before["clerk_id"] == new_clerk_id:
            print("clerk_id already matches; no-op")
            return 0
        after = await client.fetchrow(
            "UPDATE users SET clerk_id = $1 WHERE id = $2 "
            "RETURNING id, email, clerk_id, created_at",
            new_clerk_id, user_id,
        )
        print(f"After:  {dict(after) if after else None}")
    finally:
        await close_postgres_client()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
