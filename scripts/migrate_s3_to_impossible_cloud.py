"""Migrate objects from an existing S3 bucket to Impossible Cloud.

Phase B1 of the Eden app/storage plan (2026-06-19). One-shot script:
verify boto3 + Impossible Cloud endpoint works, then bulk-migrate the
existing ``bronze_s3_bucket`` contents to an Impossible Cloud bucket.

Why a separate script and not an alembic migration
--------------------------------------------------
S3→S3 migration is a data-plane operation, not a schema change.
Alembic runs at deploy time on the API server; this script runs
once out-of-band against the data platform. Matches the
``scripts/backfill_zstd_payloads.py`` pattern.

Usage:
    # Dry run — list objects that would be copied, do nothing
    uv run python scripts/migrate_s3_to_impossible_cloud.py --dry-run

    # Production — preflight + bulk copy + delete-from-source
    uv run python scripts/migrate_s3_to_impossible_cloud.py --no-dry-run

    # Skip preflight (when re-running an already-validated migration)
    uv run python scripts/migrate_s3_to_impossible_cloud.py --no-dry-run --skip-preflight

Env vars (set in the shell, not committed):
    OLD_BUCKET               — source S3 bucket (default: "eden-bronze")
    OLD_ENDPOINT_URL         — source S3 endpoint (default: AWS, unset)
    OLD_ACCESS_KEY / OLD_SECRET_KEY
    NEW_BUCKET               — target Impossible Cloud bucket (default: "eden-bronze")
    NEW_ENDPOINT_URL         — default "https://s3.impossiblecloud.net"
    NEW_ACCESS_KEY / NEW_SECRET_KEY
    COPY_DELETE_FROM_SOURCE  — "true" to delete from source after copy (default "false")
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import UTC, datetime

import boto3
from botocore.client import Config

logger = logging.getLogger(__name__)


# ── Config ────────────────────────────────────────────────────────────


def _cfg(name: str, default: str | None = None) -> str:
    val = os.environ.get(name, default)
    if val is None:
        logger.error(f"[config] missing required env var: {name}")
        sys.exit(2)
    return val


def _bool(name: str, default: bool) -> bool:
    return os.environ.get(name, str(default)).lower() == "true"


# ── Clients ───────────────────────────────────────────────────────────


def _make_client(endpoint_url: str | None, access_key: str, secret_key: str) -> any:
    """Build a boto3 S3 client. The boto3 signature is identical for
    AWS S3 and any S3-compatible backend; only ``endpoint_url`` differs.
    """
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="us-east-1",  # ignored by most S3-compatible backends
        config=Config(signature_version="s3v4"),
    )


# ── Pre-flight ────────────────────────────────────────────────────────


def preflight(client: any, bucket: str) -> bool:
    """1-row write + read + delete round-trip on the target bucket."""
    key = f"_preflight/{datetime.now(UTC).isoformat()}.txt"
    body = b"eden-impossible-cloud-preflight"
    try:
        client.put_object(Bucket=bucket, Key=key, Body=body)
        obj = client.get_object(Bucket=bucket, Key=key)
        if obj["Body"].read() != body:
            logger.error(f"[preflight] body mismatch on s3://{bucket}/{key}")
            return False
        client.delete_object(Bucket=bucket, Key=key)
        logger.info(f"[preflight] OK on s3://{bucket}/{key}")
        return True
    except Exception as exc:
        logger.error(f"[preflight] FAILED: {exc}")
        return False


# ── Bulk migration ────────────────────────────────────────────────────


def migrate(
    src: any,
    dst: any,
    src_bucket: str,
    dst_bucket: str,
    *,
    dry_run: bool,
    delete_from_source: bool,
) -> None:
    """List every object in the source bucket, copy to the target.

    For each object:
      - get_object from source
      - put_object on target with the same key + original metadata +
        ``x-eden-migrated-at`` marker
      - (if ``delete_from_source``) delete from source

    Skips objects already marked migrated (re-runs are idempotent).
    """
    paginator = src.get_paginator("list_objects_v2")
    listed = 0
    copied = 0
    skipped = 0
    failed = 0
    started = time.monotonic()

    for page in paginator.paginate(Bucket=src_bucket):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            listed += 1
            if listed % 1000 == 0:
                logger.info(
                    f"[progress] {listed} listed, {copied} copied, "
                    f"{skipped} skipped, {failed} failed"
                )
            try:
                if dry_run:
                    copied += 1
                    continue
                head = src.head_object(Bucket=src_bucket, Key=key)
                # Skip if already migrated
                if (
                    head.get("Metadata", {}).get("x-eden-migrated-at")
                    and not delete_from_source
                ):
                    skipped += 1
                    continue
                resp = src.get_object(Bucket=src_bucket, Key=key)
                new_meta = dict(resp.get("Metadata", {}))
                new_meta["x-eden-migrated-at"] = datetime.now(UTC).isoformat()
                dst.put_object(
                    Bucket=dst_bucket,
                    Key=key,
                    Body=resp["Body"].read(),
                    Metadata=new_meta,
                    ContentType=resp.get("ContentType", "application/octet-stream"),
                )
                copied += 1
                if delete_from_source:
                    src.delete_object(Bucket=src_bucket, Key=key)
            except Exception as exc:
                logger.error(f"[FAIL] {key}: {exc}")
                failed += 1

    elapsed = time.monotonic() - started
    logger.info(
        f"[done] {listed} listed, {copied} {'would copy' if dry_run else 'copied'}, "
        f"{skipped} skipped, {failed} failed, {elapsed:.1f}s"
    )


# ── Main ──────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--no-dry-run", dest="dry_run", action="store_false")
    parser.add_argument(
        "--skip-preflight",
        action="store_true",
        help="Skip the 1-row write/read/delete round-trip",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    src_bucket = _cfg("OLD_BUCKET", "eden-bronze")
    dst_bucket = _cfg("NEW_BUCKET", "eden-bronze")
    src_endpoint = os.environ.get("OLD_ENDPOINT_URL")  # AWS default: None
    dst_endpoint = _cfg("NEW_ENDPOINT_URL", "https://s3.impossiblecloud.net")
    src_key = _cfg("OLD_ACCESS_KEY")
    src_secret = _cfg("OLD_SECRET_KEY")
    dst_key = _cfg("NEW_ACCESS_KEY")
    dst_secret = _cfg("NEW_SECRET_KEY")
    delete_from_source = _bool("COPY_DELETE_FROM_SOURCE", False)

    src = _make_client(src_endpoint, src_key, src_secret)
    dst = _make_client(dst_endpoint, dst_key, dst_secret)

    if not args.skip_preflight:
        if not preflight(dst, dst_bucket):
            logger.error("[abort] preflight failed; refusing to migrate")
            return 1

    migrate(
        src,
        dst,
        src_bucket,
        dst_bucket,
        dry_run=args.dry_run,
        delete_from_source=delete_from_source,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
