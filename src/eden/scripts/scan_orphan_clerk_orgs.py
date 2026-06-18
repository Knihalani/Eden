"""Scan Clerk orgs for orphans (no matching Eden row).

Lists every Clerk organisation via ``GET /v1/organizations`` and
flags the ones that have no ``organizations.clerk_org_id`` match in
Postgres. Useful for catching the inverse problem of the backfill
script: Eden-created Clerk orgs whose Eden insert failed (e.g.
network blip, DB outage mid-transaction) and now exist in Clerk
without a parent row.

Safety: this script NEVER deletes anything. Deletion is a separate
operator action. Use ``--report-json`` to pipe the orphan list into
your own ops tooling.

Usage::

    # Default: print a human-readable table to stdout.
    python -m eden.scripts.scan_orphan_clerk_orgs

    # JSON for piping into jq / ops tools.
    python -m eden.scripts.scan_orphan_clerk_orgs --report-json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from typing import Any

import httpx

from eden.config import get_settings
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

CLERK_API_BASE = "https://api.clerk.com/v1"


async def _list_clerk_orgs(secret_key: str) -> list[dict[str, Any]]:
    """Paginate through Clerk's ``/v1/organizations`` endpoint."""
    orgs: list[dict[str, Any]] = []
    offset = 0
    limit = 100
    headers = {
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        while True:
            response = await client.get(
                f"{CLERK_API_BASE}/organizations",
                params={"limit": limit, "offset": offset},
                headers=headers,
            )
            response.raise_for_status()
            page = response.json()
            orgs.extend(page)
            if len(page) < limit:
                break
            offset += limit
    return orgs


async def _fetch_known_clerk_ids() -> set[str]:
    """Return the set of all Eden-side ``clerk_org_id`` values."""
    client = await get_postgres_client()
    rows = await client.fetch(
        "SELECT clerk_org_id FROM organizations WHERE clerk_org_id IS NOT NULL",
    )
    return {str(r["clerk_org_id"]) for r in rows}


async def run(report_json: bool) -> int:
    settings = get_settings()
    if not settings.clerk_secret_key:
        print("ERROR: CLERK_SECRET_KEY not configured.", file=sys.stderr)
        return 2

    clerk_orgs = await _list_clerk_orgs(settings.clerk_secret_key)
    known_ids = await _fetch_known_clerk_ids()

    orphans = [o for o in clerk_orgs if str(o.get("id") or "") not in known_ids]

    if report_json:
        print(json.dumps(orphans, indent=2, default=str))
    else:
        print(f"Clerk orgs total: {len(clerk_orgs)}")
        print(f"Known in Eden:    {len(known_ids)}")
        print(f"Orphans:          {len(orphans)}")
        if orphans:
            print("\nOrphan Clerk orgs (no matching Eden row):")
            for o in orphans:
                print(f"  - {o.get('id')}  name={o.get('name')!r}  "
                      f"slug={o.get('slug')!r}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--report-json", action="store_true",
        help="Emit the orphan list as JSON to stdout (no header).",
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
    return asyncio.run(run(args.report_json))


if __name__ == "__main__":
    sys.exit(main())
