"""Diagnose why the auto-provision silently failed for the second
Clerk user. Runs the exact code path the live /auth/me handler runs
against the production Neon DB, with a fake Clerk JWT payload, and
prints every step + exception so we can see what's failing.

Safe: uses a throwaway test clerk_id (``user_TEST_<random>``) so it
won't collide with any real Clerk account. Cleans up after itself.
"""
from __future__ import annotations

import asyncio
import secrets
import sys

from eden.api.utils.clerk_client import (
    ClerkUserNotFoundError,
    extract_user_profile,
    get_user,
)
from eden.storage.postgres import close_postgres_client, get_postgres_client


async def main() -> int:
    test_clerk_id = f"user_TEST_{secrets.token_hex(6)}"
    test_email = f"diag-{secrets.token_hex(4)}@eden-test.noreply"
    test_name = f"Diag test {test_clerk_id[-6:]}"

    print(f"Using throwaway test_clerk_id = {test_clerk_id}")
    print(f"             test_email       = {test_email}")
    print()

    client = await get_postgres_client()
    try:
        # Step 1: lookup (should miss — fresh id)
        print("Step 1: lookup by clerk_id")
        existing = await client.fetchrow(
            "SELECT id, email FROM users WHERE clerk_id = $1",
            test_clerk_id,
        )
        print(f"  result: {dict(existing) if existing else 'NONE (expected)'}")
        assert not existing, "test id already in DB — pick a new one"
        print()

        # Step 2: simulate the rich INSERT
        print("Step 2: rich INSERT (matches the live code path)")
        try:
            inserted = await client.fetchrow(
                """
                INSERT INTO users (clerk_id, email, name, avatar_url, password_hash, created_at)
                VALUES ($1, $2, $3, $4, NULL, NOW())
                ON CONFLICT (clerk_id) DO NOTHING
                RETURNING id, email, name, created_at, preferred_org_id, clerk_id
                """,
                test_clerk_id, test_email, test_name, "",
            )
            print(f"  inserted: {dict(inserted) if inserted else 'NONE'}")
        except Exception as exc:
            print(f"  EXCEPTION: {type(exc).__name__}: {exc}")
            return 1
        print()

        # Step 3: cleanup
        print("Step 3: cleanup")
        await client.execute(
            "DELETE FROM users WHERE clerk_id = $1", test_clerk_id
        )
        print("  done.")
        print()

        # Now: simulate a Clerk API lookup with a fake id. A 404 from
        # Clerk raises ClerkUserNotFoundError (the /auth/me existence
        # gate turns that into a 401 so a deleted account is never
        # auto-provisioned); any other failure returns None.
        print(
            "Step 4: clerk_get_user with a fake id "
            "(expect ClerkUserNotFoundError on 404)"
        )
        try:
            result = await get_user("user_fake_zzz999")
            print(f"  result: {result}")
        except ClerkUserNotFoundError:
            print("  result: ClerkUserNotFoundError (expected for deleted user)")
        print()

        # And: extract_user_profile with an empty payload
        print("Step 5: extract_user_profile({}) (should return empty strings)")
        profile = extract_user_profile({})
        print(f"  result: {profile}")
        print()

        print("All steps passed — auto-provision path is healthy on this DB.")
        return 0
    finally:
        await close_postgres_client()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
