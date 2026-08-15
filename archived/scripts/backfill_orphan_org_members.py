"""Repair organizations that have no rows in ``org_members``.

An org reaches this state when Clerk's JWT carries no ``o.rol`` claim:
``ensure_clerk_membership`` used to skip the membership write entirely,
while ``get_current_org`` still granted access via a synthesized
``_pending_sync`` context. The org therefore works for its creator but
is invisible to ``GET /orgs`` and ``/auth/me``, both of which INNER JOIN
``org_members``.

The code path is fixed; this repairs the rows already stranded.

Usage:
    python scripts/backfill_orphan_org_members.py            # report only
    python scripts/backfill_orphan_org_members.py --apply    # write
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

import asyncpg

FIND_ORPHANS = """
SELECT o.id::text          AS org_id,
       o.name              AS name,
       o.owner_id::text    AS owner_id,
       u.id IS NOT NULL    AS owner_exists,
       (SELECT count(*) FROM org_api_keys k WHERE k.org_id = o.id)      AS api_keys,
       (SELECT count(*) FROM telemetry_events t WHERE t.tenant_id::text = o.id::text) AS events
FROM organizations o
LEFT JOIN users u ON u.id = o.owner_id
WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id)
ORDER BY o.created_at
"""

INSERT_OWNER = """
INSERT INTO org_members (org_id, user_id, role, last_active_at, joined_at)
VALUES ($1::uuid, $2::uuid, 'owner', NOW(), NOW())
ON CONFLICT (org_id, user_id) DO NOTHING
"""


async def main(apply: bool) -> int:
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(FIND_ORPHANS)
        if not rows:
            print("No orgs without members. Nothing to do.")
            return 0

        print(f"Found {len(rows)} org(s) with zero members:\n")
        repairable = []
        for r in rows:
            flag = "" if r["owner_exists"] else "  <-- OWNER ROW MISSING, skipping"
            print(
                f"  {r['org_id']}  {r['name']!r}\n"
                f"      owner={r['owner_id']} api_keys={r['api_keys']} "
                f"events={r['events']}{flag}"
            )
            if r["owner_exists"] and r["owner_id"]:
                repairable.append(r)

        if not apply:
            print(
                f"\n{len(repairable)} repairable. Re-run with --apply to insert "
                f"the owner membership row."
            )
            return 0

        # One transaction: either every org is repaired or none is.
        async with conn.transaction():
            for r in repairable:
                await conn.execute(INSERT_OWNER, r["org_id"], r["owner_id"])
                print(f"  repaired {r['org_id']} -> owner {r['owner_id']}")

        left = await conn.fetchval(
            "SELECT count(*) FROM organizations o WHERE NOT EXISTS "
            "(SELECT 1 FROM org_members m WHERE m.org_id = o.id)"
        )
        print(f"\nDone. Orgs still without members: {left}")
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the rows")
    args = ap.parse_args()
    raise SystemExit(asyncio.run(main(args.apply)))
