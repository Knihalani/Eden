#!/usr/bin/env python3
"""Operator helper: export + document Tinybird GDPR tenant erasure.

Tinybird workspaces reject ``ALTER TABLE … DELETE`` via ``/v0/sql``.
App code therefore raises / reports incomplete erasure for Tinybird
hosts (see ``ClickHouseSink.delete_tenant_rows`` and
``DataRetentionManager._delete_from_clickhouse``).

This script does **not** auto-destroy production data. It:

1. Exports tenant rows from ``telemetry_events_ch`` (and optionally
   ``home_kpi_hourly``) via Tinybird ``/v0/sql`` for evidence / backup.
2. Prints the operator runbook for filter + ``tb deploy`` / re-ingest
   replace (the only durable Tinybird erasure path today).
3. Emits a clear **incomplete-erasure** warning unless the operator
   passes ``--i-understand-incomplete-erasure``.

Destructive replace steps require ``--confirm-replace`` **and**
``--tenant-id``; even then this script only prints the steps — it does
not call Tinybird delete/replace APIs.

Usage:
    export TINYBIRD_ADMIN_TOKEN=...
    export TINYBIRD_API_HOST=https://api.us-east.tinybird.co   # optional

    # Export only (safe default)
    python scripts/tinybird_gdpr_tenant_export_filter.py \\
        --tenant-id ORG_UUID --out /tmp/tenant_export.jsonl

    # Print replace runbook (still no network destroy)
    python scripts/tinybird_gdpr_tenant_export_filter.py \\
        --tenant-id ORG_UUID --confirm-replace \\
        --i-understand-incomplete-erasure
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

INCOMPLETE_WARNING = """
╔══════════════════════════════════════════════════════════════════╗
║  INCOMPLETE ERASURE WARNING                                      ║
║                                                                  ║
║  Tinybird cannot ALTER DELETE via /v0/sql. Exporting rows or     ║
║  printing a filter/replace runbook does NOT complete GDPR RTBF.  ║
║  Until you filter + redeploy/re-ingest the datasources below,    ║
║  tenant data remains in Tinybird. Do not mark erasure complete.  ║
╚══════════════════════════════════════════════════════════════════╝
""".strip()

REPLACE_RUNBOOK = """
Tinybird tenant erase runbook (manual — this script will not do it)
------------------------------------------------------------------
Datasources: telemetry_events_ch, home_kpi_hourly
(also review agent_performance / pipeline_stages / usage_trends /
benchmark_results if those unread ingest flags were ever enabled)

Recommended approach (replace, not in-place DELETE):

  1. Export full datasource (or use this script's JSONL export for the
     tenant slice as an audit artifact — keep a separate full backup).

  2. Filter out the tenant locally, e.g.:
       jq -c 'select(.tenant_id != "{tenant_id}")' full.jsonl \\
         > filtered.jsonl

  3. For AggregateFunction tables (home_kpi_hourly), prefer rebuilding
     from filtered telemetry via the existing MV pipe after replace,
     rather than hand-editing AggregateFunction state columns.

  4. Replace / truncate+re-ingest via Tinybird tooling:
       - tb datasource truncate <name>   # destructive; confirm workspace
       - tb datasource append <name> filtered.jsonl
     Or: create a replacement datasource, ``tb deploy``, cut readers
     over, then drop the old one.

  5. Re-verify with /v0/sql:
       SELECT count() FROM telemetry_events_ch
       WHERE tenant_id = '{tenant_id}'
     Expect 0 before marking erasure complete.

  6. Record the incomplete→complete transition in the GDPR ticket with
     export checksums and the SQL count proof.
""".strip()


def _host() -> str:
    return (
        os.environ.get("TINYBIRD_API_HOST")
        or os.environ.get("CLICKHOUSE_URL")
        or "https://api.us-east.tinybird.co"
    ).rstrip("/")


def _token() -> str:
    return (
        os.environ.get("TINYBIRD_ADMIN_TOKEN")
        or os.environ.get("TINYBIRD_BRANCH_TOKEN")
        or os.environ.get("CLICKHOUSE_PASSWORD")
        or ""
    )


def _sql_literal(value: str) -> str:
    return value.replace("'", "''")


def _run_sql(sql: str, *, token: str, host: str) -> dict:
    url = f"{host}/v0/sql?{urllib.parse.urlencode({'q': sql})}"
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {token}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:800]
        raise SystemExit(f"Tinybird /v0/sql HTTP {exc.code}: {detail}") from exc
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {"raw": body}


def _export_table(
    table: str,
    tenant_id: str,
    *,
    token: str,
    host: str,
    limit: int,
) -> list[dict]:
    safe = _sql_literal(tenant_id)
    # Force JSON so we can write JSONL without parsing TSV.
    sql = (
        f"SELECT * FROM {table} "
        f"WHERE tenant_id = '{safe}' "
        f"LIMIT {int(limit)} "
        f"FORMAT JSON"
    )
    payload = _run_sql(sql, token=token, host=host)
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise SystemExit(f"unexpected response for {table}: {payload!r}"[:500])
    return [r for r in data if isinstance(r, dict)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--tenant-id", required=True, help="Tenant / org id to export")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write JSONL export (telemetry_events_ch [+ home_kpi_hourly])",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=100_000,
        help="Max rows per table (default 100000)",
    )
    parser.add_argument(
        "--include-home-kpi",
        action="store_true",
        help="Also export home_kpi_hourly for the tenant",
    )
    parser.add_argument(
        "--confirm-replace",
        action="store_true",
        help="Print the filter + tb deploy / re-ingest replace runbook",
    )
    parser.add_argument(
        "--i-understand-incomplete-erasure",
        action="store_true",
        help="Acknowledge that this script does not complete GDPR erasure",
    )
    parser.add_argument(
        "--count-only",
        action="store_true",
        help="Only print SELECT count() for the tenant (no export file)",
    )
    args = parser.parse_args(argv)

    print(INCOMPLETE_WARNING, file=sys.stderr)
    if not args.i_understand_incomplete_erasure:
        print(
            "\nPass --i-understand-incomplete-erasure to continue "
            "(export/runbook only; still incomplete erasure).\n",
            file=sys.stderr,
        )
        return 2

    token = _token()
    if not token:
        print(
            "Set TINYBIRD_ADMIN_TOKEN (or TINYBIRD_BRANCH_TOKEN).",
            file=sys.stderr,
        )
        return 2
    host = _host()
    if "tinybird.co" not in host.lower() and not os.environ.get("TINYBIRD_API_HOST"):
        print(
            f"Host {host!r} does not look like Tinybird; "
            "set TINYBIRD_API_HOST explicitly if intentional.",
            file=sys.stderr,
        )

    safe = _sql_literal(args.tenant_id)
    for table in ("telemetry_events_ch", "home_kpi_hourly"):
        count_sql = (
            f"SELECT count() AS c FROM {table} "
            f"WHERE tenant_id = '{safe}' FORMAT JSON"
        )
        payload = _run_sql(count_sql, token=token, host=host)
        rows = payload.get("data") if isinstance(payload, dict) else None
        c = rows[0].get("c") if rows else "?"
        print(f"{table} rows for tenant: {c}")

    if args.count_only and not args.out:
        if args.confirm_replace:
            print()
            print(REPLACE_RUNBOOK.format(tenant_id=args.tenant_id))
        return 0

    if args.out:
        tables = ["telemetry_events_ch"]
        if args.include_home_kpi:
            tables.append("home_kpi_hourly")
        args.out.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        with args.out.open("w", encoding="utf-8") as fh:
            for table in tables:
                rows = _export_table(
                    table,
                    args.tenant_id,
                    token=token,
                    host=host,
                    limit=args.limit,
                )
                for row in rows:
                    row["_eden_export_table"] = table
                    fh.write(json.dumps(row, default=str) + "\n")
                print(f"exported {len(rows)} rows from {table}")
                total += len(rows)
        print(f"wrote {total} lines → {args.out}")

    if args.confirm_replace:
        print()
        print(REPLACE_RUNBOOK.format(tenant_id=args.tenant_id))
        print(
            "\nNOTE: --confirm-replace only prints the runbook; "
            "no truncate/append was executed.",
            file=sys.stderr,
        )
    elif not args.out and not args.count_only:
        print(
            "Nothing to do beyond counts. Pass --out PATH and/or "
            "--confirm-replace / --count-only.",
            file=sys.stderr,
        )

    print(
        "\nErasure status: INCOMPLETE until filter+replace is verified "
        "with count() == 0.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
