#!/usr/bin/env python3
"""Operator helper: export + erase Tinybird tenant rows (GDPR / RTBF).

Tinybird rejects ``ALTER TABLE … DELETE`` via ``/v0/sql``. Erasure uses the
datasource Jobs API instead — the same path as::

    tb --cloud datasource delete <ds> --sql-condition "tenant_id='…'" --wait

This script can:

1. Count / export tenant rows (audit artifact).
2. Dry-run the delete Jobs API (``--dry-run-delete``).
3. Execute deletes and wait for jobs (``--execute-delete`` + confirm flags).

App code (``ClickHouseSink.delete_tenant_rows``) uses the same HTTP API so
production GDPR / RTBF fanout no longer reports Tinybird as permanently
unavailable.

Usage:
    export TINYBIRD_ADMIN_TOKEN=...   # or rely on ``tb`` / ``.tinyb``
    export TINYBIRD_API_HOST=https://api.us-east.tinybird.co   # optional

    # Count only
    python scripts/tinybird_gdpr_tenant_export_filter.py \\
        --tenant-id ORG_UUID --count-only

    # Export audit JSONL
    python scripts/tinybird_gdpr_tenant_export_filter.py \\
        --tenant-id ORG_UUID --out /tmp/tenant_export.jsonl --include-home-kpi

    # Dry-run delete (no mutation)
    python scripts/tinybird_gdpr_tenant_export_filter.py \\
        --tenant-id ORG_UUID --dry-run-delete

    # Execute delete (real erasure)
    python scripts/tinybird_gdpr_tenant_export_filter.py \\
        --tenant-id ORG_UUID --execute-delete --yes-delete-tenant-rows
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REQUIRED_DS = ("telemetry_events_ch", "home_kpi_hourly")
OPTIONAL_DS = (
    "agent_performance",
    "pipeline_stages",
    "usage_trends",
    "benchmark_results",
)

DELETE_API_NOTE = """
Tinybird erase uses POST /v0/datasources/{name}/delete (Jobs API),
equivalent to: tb --cloud datasource delete <name> --sql-condition "…" --wait
ALTER DELETE via /v0/sql remains unsupported and is not used here.
""".strip()


def _host() -> str:
    return (
        os.environ.get("TINYBIRD_API_HOST")
        or os.environ.get("CLICKHOUSE_URL")
        or "https://api.us-east.tinybird.co"
    ).rstrip("/")


def _token() -> str:
    token = (
        os.environ.get("TINYBIRD_ADMIN_TOKEN")
        or os.environ.get("TINYBIRD_BRANCH_TOKEN")
        or os.environ.get("CLICKHOUSE_PASSWORD")
        or ""
    )
    if token:
        return token
    # Fall back to .tinyb workspace token (local operator machine).
    tinyb = Path.home() / ".tinyb"
    # Also try repo .tinyb when run from Eden checkout.
    for candidate in (Path.cwd() / ".tinyb", Path.cwd().parent / ".tinyb", tinyb):
        if not candidate.is_file():
            continue
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        host = _host()
        tokens = data.get("tokens") or {}
        if isinstance(tokens, dict) and host in tokens:
            return str(tokens[host])
        if data.get("token"):
            return str(data["token"])
    return ""


def _sql_literal(value: str) -> str:
    return value.replace("'", "''")


def _request(
    method: str,
    url: str,
    *,
    token: str,
    data: dict[str, str] | None = None,
    timeout: float = 120.0,
) -> tuple[int, str]:
    body = urllib.parse.urlencode(data).encode() if data else None
    headers = {"Authorization": f"Bearer {token}"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", errors="replace")


def _run_sql(sql: str, *, token: str, host: str) -> dict:
    url = f"{host}/v0/sql?{urllib.parse.urlencode({'q': sql})}"
    status, body = _request("GET", url, token=token)
    if status >= 400:
        raise SystemExit(f"Tinybird /v0/sql HTTP {status}: {body[:800]}")
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


def _wait_job(host: str, token: str, job_id: str, *, timeout_s: float = 300.0) -> None:
    deadline = time.monotonic() + timeout_s
    url = f"{host}/v0/jobs/{job_id}"
    while time.monotonic() < deadline:
        status, body = _request("GET", url, token=token)
        if status >= 400:
            raise SystemExit(f"job {job_id} HTTP {status}: {body[:300]}")
        try:
            payload = json.loads(body) if body else {}
        except json.JSONDecodeError as exc:
            raise SystemExit(f"job {job_id} bad JSON: {body[:200]}") from exc
        st = str(payload.get("status") or "")
        if st == "done":
            return
        if st == "error":
            raise SystemExit(f"job {job_id} error: {payload.get('error') or body[:300]}")
        time.sleep(1.0)
    raise SystemExit(f"job {job_id} timed out after {timeout_s}s")


def _delete_ds(
    ds: str,
    tenant_id: str,
    *,
    token: str,
    host: str,
    dry_run: bool,
    wait: bool,
) -> dict:
    safe = _sql_literal(tenant_id)
    condition = f"tenant_id = '{safe}'"
    url = f"{host}/v0/datasources/{ds}/delete"
    data = {"delete_condition": condition}
    if dry_run:
        data["dry_run"] = "true"
    status, body = _request("POST", url, token=token, data=data)
    if status == 404:
        return {"datasource": ds, "status": "missing", "detail": body[:200]}
    if status >= 400:
        return {"datasource": ds, "status": "error", "detail": f"HTTP {status}: {body[:400]}"}
    try:
        payload = json.loads(body) if body else {}
    except json.JSONDecodeError:
        payload = {"raw": body}
    if dry_run:
        return {
            "datasource": ds,
            "status": "dry_run",
            "rows_to_be_deleted": payload.get("rows_to_be_deleted"),
            "payload": payload,
        }
    job_id = payload.get("job_id")
    if job_id and wait:
        _wait_job(host, token, str(job_id))
        return {"datasource": ds, "status": "done", "job_id": job_id}
    return {"datasource": ds, "status": "submitted", "payload": payload}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--tenant-id", required=True, help="Tenant / org id")
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Write JSONL export (telemetry_events_ch [+ home_kpi_hourly])",
    )
    parser.add_argument("--limit", type=int, default=100_000)
    parser.add_argument(
        "--include-home-kpi",
        action="store_true",
        help="Also export home_kpi_hourly for the tenant",
    )
    parser.add_argument(
        "--count-only",
        action="store_true",
        help="Only print SELECT count() for the tenant",
    )
    parser.add_argument(
        "--dry-run-delete",
        action="store_true",
        help="Call Tinybird delete Jobs API with dry_run=true (no mutation)",
    )
    parser.add_argument(
        "--execute-delete",
        action="store_true",
        help="Execute Tinybird datasource deletes and wait for jobs",
    )
    parser.add_argument(
        "--yes-delete-tenant-rows",
        action="store_true",
        help="Required with --execute-delete (explicit confirmation)",
    )
    parser.add_argument(
        "--include-optional-datasources",
        action="store_true",
        help="Also delete unread analytics DS (agent_performance, …)",
    )
    args = parser.parse_args(argv)

    print(DELETE_API_NOTE, file=sys.stderr)

    token = _token()
    if not token:
        print(
            "Set TINYBIRD_ADMIN_TOKEN (or login with `tb login` / .tinyb).",
            file=sys.stderr,
        )
        return 2
    host = _host()

    safe = _sql_literal(args.tenant_id)
    for table in REQUIRED_DS:
        count_sql = (
            f"SELECT count() AS c FROM {table} "
            f"WHERE tenant_id = '{safe}' FORMAT JSON"
        )
        payload = _run_sql(count_sql, token=token, host=host)
        rows = payload.get("data") if isinstance(payload, dict) else None
        c = rows[0].get("c") if rows else "?"
        print(f"{table} rows for tenant: {c}")

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

    targets = list(REQUIRED_DS)
    if args.include_optional_datasources:
        targets.extend(OPTIONAL_DS)

    if args.dry_run_delete:
        print("\n-- dry-run delete --")
        for ds in targets:
            result = _delete_ds(
                ds,
                args.tenant_id,
                token=token,
                host=host,
                dry_run=True,
                wait=False,
            )
            print(json.dumps(result, default=str))
        return 0

    if args.execute_delete:
        if not args.yes_delete_tenant_rows:
            print(
                "Refusing --execute-delete without --yes-delete-tenant-rows.",
                file=sys.stderr,
            )
            return 2
        print("\n-- execute delete --")
        failed = False
        for ds in targets:
            required = ds in REQUIRED_DS
            result = _delete_ds(
                ds,
                args.tenant_id,
                token=token,
                host=host,
                dry_run=False,
                wait=True,
            )
            print(json.dumps(result, default=str))
            if result.get("status") not in ("done", "submitted", "missing"):
                if required:
                    failed = True
            if result.get("status") == "missing" and required:
                failed = True
        # Re-count required tables
        print("\n-- post-delete counts --")
        for table in REQUIRED_DS:
            count_sql = (
                f"SELECT count() AS c FROM {table} "
                f"WHERE tenant_id = '{safe}' FORMAT JSON"
            )
            payload = _run_sql(count_sql, token=token, host=host)
            rows = payload.get("data") if isinstance(payload, dict) else None
            c = rows[0].get("c") if rows else "?"
            print(f"{table} rows for tenant: {c}")
            if c not in (0, "0", 0.0):
                failed = True
        return 1 if failed else 0

    if args.count_only or args.out:
        return 0

    print(
        "Nothing to do beyond counts. Use --out, --dry-run-delete, "
        "or --execute-delete --yes-delete-tenant-rows.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
