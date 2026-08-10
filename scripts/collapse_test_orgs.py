#!/usr/bin/env python3
"""P3.5 — collapse duplicate/test organizations into one clean org.

Wave 3 (2026-08-10) measured 13 orgs in the live database where the
product expects one: 7× "Kaiav's Organization" (identical slug
``kaiav-s-organization-178`` — duplicated provisioning), 4×
"My workspace", 1× "Smoke Org" and 1× "Smoke Test Org". Each has
exactly one member.

Safety model
------------
* **Dry-run by default.** Without ``--apply`` the script prints exactly
  what it would delete and exits 0.
* **Zero-data gate.** An org is only auto-eligible for collapse when it
  holds **no** telemetry rows and **no** issues. Orgs with data are
  listed but skipped unless explicitly named with ``--force-org``.
* **Keeper.** The org that holds the real data (telemetry/issues) is
  preserved. If several have data, ``--keeper`` picks the winner;
  otherwise the first data-holding org wins and every other data-holding
  org is skipped (never guessed).
* **Clerk note.** ``organizations.clerk_org_id`` references a Clerk org
  record. Deleting the local row does not delete the Clerk org; the
  duplicate Clerk orgs are the caller's call (they are inert — no
  members in the product DB beyond the single row being deleted).

Usage
-----
    DATABASE_URL=... uv run python scripts/collapse_test_orgs.py          # dry run
    DATABASE_URL=... uv run python scripts/collapse_test_orgs.py --apply  # execute

Exit codes: 0 = done/skipped-safe, 2 = would have deleted data-holding
orgs without --force-org (nothing executed).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from typing import Any

import asyncpg

_KEEPERS_HINT = """\
Skipped data-holding org(s) — choose a keeper with --keeper and re-run.
Eligible zero-data orgs would still be collapsed once a keeper is set.
"""


async def _inventory(conn: asyncpg.Connection) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT o.id::text AS id, o.name, o.slug,
               o.clerk_org_id IS NOT NULL AS has_clerk,
               (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS members,
               (SELECT COUNT(*) FROM telemetry_events t WHERE t.tenant_id = o.id::text) AS events
        FROM organizations o
        ORDER BY o.name, o.id
        """
    )
    return [dict(r) for r in rows]


async def _count_issues(conn: asyncpg.Connection, org_id: str) -> int | None:
    """Count issues for an org; ``None`` when the count cannot be determined.

    Fail-closed: an undeterminable count must NOT be treated as zero — a
    destructive gate that silently treats "unknown" as "empty" can delete
    an org that actually holds data.
    """
    try:
        row = await conn.fetchrow(
            "SELECT COUNT(*) AS n FROM issues WHERE org_id = $1", org_id
        )
        return int(row["n"]) if row else 0
    except Exception:  # noqa: BLE001 - issue count is a safety gate
        return None


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="execute deletions")
    parser.add_argument(
        "--keeper",
        help="org id (prefix ok) to preserve when several orgs hold data",
    )
    parser.add_argument(
        "--force-org",
        action="append",
        default=[],
        help="collapse a data-holding org anyway (repeatable; requires --apply)",
    )
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2

    conn = await asyncpg.connect(dsn)
    try:
        orgs = await _inventory(conn)
        for o in orgs:
            o["issues"] = await _count_issues(conn, o["id"])
            if o["issues"] is None:
                print(
                    f"FAIL-CLOSED: cannot determine issue count for {o['id']} — "
                    "treating as data-holding; won't auto-collapse.",
                    file=sys.stderr,
                )
                o["issues"] = 1  # never auto-delete an org we can't audit

        data_orgs = [o for o in orgs if o["events"] > 0 or o["issues"] > 0]
        empty_orgs = [o for o in orgs if o not in data_orgs]

        if not data_orgs:
            # Nothing has data: keep the first org as the canonical one.
            keeper_id = (args.keeper or orgs[0]["id"]).lower()
            keeper = next(
                (o for o in orgs if o["id"].startswith(keeper_id)), None
            )
            if keeper is None:
                print(f"--keeper prefix not found: {args.keeper}", file=sys.stderr)
                return 2
            data_orgs = [keeper]
            empty_orgs = [o for o in orgs if o["id"] != keeper["id"]]
        else:
            keeper_prefix = (args.keeper or data_orgs[0]["id"]).lower()
            keeper = next(
                (o for o in data_orgs if o["id"].startswith(keeper_prefix)), None
            )
            if keeper is None:
                print(f"--keeper prefix not found in data orgs: {args.keeper}", file=sys.stderr)
                print(_KEEPERS_HINT, file=sys.stderr)
                return 2
            extra_data = [o for o in data_orgs if o["id"] != keeper["id"]]

        forced = {f.lower() for f in args.force_org}
        to_delete = list(empty_orgs)
        pending_data = [
            o for o in extra_data
            if not any(o["id"].startswith(p) for p in forced)
        ]

        if pending_data:
            print("DATA-HOLDING ORGS WOULD BE PRESERVED (not auto-collapsed):")
            for o in pending_data:
                print(
                    f"  {o['id']}  {o['name']}  events={o['events']} issues={o['issues']}"
                )
            print(_KEEPERS_HINT, file=sys.stderr)
            if not args.apply:
                print("(dry run — nothing executed)", file=sys.stderr)
            return 2

        # `forced` orgs with data are collapsed too (prefix match).
        for o in extra_data:
            if any(o["id"].startswith(p) for p in forced):
                to_delete.append(o)

        print(f"KEEPER:  {keeper['id']}  {keeper['name']}  "
              f"events={keeper['events']} issues={keeper['issues']}")
        print(f"DELETE:  {len(to_delete)} org(s)")
        for o in sorted(to_delete, key=lambda x: x["id"]):
            print(f"  {o['id']}  {o['name']:<24} slug={o['slug']:<28} "
                  f"members={o['members']} events={o['events']} clerk={o['has_clerk']}")

        if not args.apply:
            print("DRY RUN — re-run with --apply to execute.")
            return 0

        # Soft-delete first (archived/deleted flags) then hard-remove
        # members + the org row. CASCADE FKs on improvement_*/ai_*/etc.
        # remove their rows; telemetry_events has no FK (tenant_id text),
        # so its rows are removed explicitly for collapsed orgs (the
        # user-confirmed "data loss on those rows" per P3.5). Wrapped in
        # one explicit transaction so a mid-loop failure rolls back
        # everything.
        deleted = 0
        events_removed = 0
        async with conn.transaction():
            for o in to_delete:
                await conn.execute(
                    "UPDATE organizations SET deleted_at = NOW(), "
                    "archived_at = NOW() WHERE id = $1",
                    o["id"],
                )
                await conn.execute(
                    "DELETE FROM org_members WHERE org_id = $1", o["id"]
                )
                res = await conn.execute(
                    "DELETE FROM organizations WHERE id = $1", o["id"]
                )
                if res.endswith("1"):
                    deleted += 1
                ev = await conn.execute(
                    "DELETE FROM telemetry_events WHERE tenant_id = $1", o["id"]
                )
                events_removed += int(ev.split()[-1])
        print(
            f"APPLIED: deleted {deleted} org(s) + {events_removed} telemetry row(s); "
            f"keeper {keeper['id']} intact."
        )
        return 0
    finally:
        await conn.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
