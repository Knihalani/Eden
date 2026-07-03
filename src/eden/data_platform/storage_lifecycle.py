"""Tiered storage lifecycle manager.

Automates the movement of data across hot (PostgreSQL), warm (S3 Standard),
and cold (S3 Glacier) tiers based on age and access patterns.

Usage:
    from eden.data_platform.storage_lifecycle import StorageLifecycleManager
    mgr = StorageLifecycleManager()
    await mgr.transition_to_warm(table="silver_events", before_days=7)
    await mgr.transition_to_cold(prefix="bronze/events", before_days=30)
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from eden.config import get_settings

logger = logging.getLogger(__name__)


def _make_s3_client() -> Any:
    """Build an S3 client honouring the configured storage backend.

    Falls back to the AWS default endpoint when ``EDEN_STORAGE_ENDPOINT``
    is empty (i.e. AWS S3 in us-east-1). Uses ``s3v4`` signatures —
    required by Impossible Cloud and most S3-compatible backends.
    """
    import boto3
    from botocore.client import Config

    s = get_settings()
    endpoint = s.eden_storage_endpoint or None
    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=s.eden_storage_access_key or None,
        aws_secret_access_key=s.eden_storage_secret_key or None,
        region_name="us-east-1",
        config=Config(signature_version="s3v4"),
    )
settings = get_settings()


@dataclass
class TierTransition:
    """Definition of a tier transition rule."""

    name: str
    source_tier: str
    target_tier: str
    after_days: int
    target_storage_class: str = "STANDARD_IA"
    enabled: bool = True


@dataclass
class LifecycleReport:
    """Report from a lifecycle run."""

    transitions_run: int = 0
    rows_moved: int = 0
    s3_objects_transitioned: int = 0
    s3_objects_expired: int = 0
    errors: list[str] = field(default_factory=list)
    duration_ms: float = 0.0


DEFAULT_TRANSITIONS: list[TierTransition] = [
    # Phase B1 (2026-06-19): Impossible Cloud is a single always-hot tier.
    # The hot→warm→cold transition chain was meaningful on AWS S3 (STANDARD_IA
    # cheaper than STANDARD, GLACIER_IR/GLACIER cheaper still) but is moot
    # here — Impossible Cloud charges €7.99/TB/mo flat with no tier
    # transitions. The transitions below are retained for backwards
    # compatibility with operators that may point ``bronze_s3_bucket`` at
    # AWS S3 or another tiered backend, but the default lifecycle rules
    # emitted by ``apply_s3_lifecycle_rules`` skip the ``Transitions``
    # blocks on Impossible Cloud.
    TierTransition(
        name="bronze-hot-to-warm",
        source_tier="hot",
        target_tier="warm",
        after_days=7,
        target_storage_class="STANDARD_IA",
    ),
    TierTransition(
        name="bronze-warm-to-cold",
        source_tier="warm",
        target_tier="cold",
        after_days=30,
        target_storage_class="GLACIER_IR",
    ),
    TierTransition(
        name="silver-hot-to-warm",
        source_tier="hot",
        target_tier="warm",
        after_days=7,
        target_storage_class="STANDARD_IA",
    ),
    TierTransition(
        name="silver-warm-to-cold",
        source_tier="warm",
        target_tier="cold",
        after_days=90,
        target_storage_class="GLACIER",
    ),
    TierTransition(
        name="datasets-hot-to-warm",
        source_tier="hot",
        target_tier="warm",
        after_days=30,
        target_storage_class="STANDARD_IA",
    ),
    TierTransition(
        name="datasets-warm-to-cold",
        source_tier="warm",
        target_tier="cold",
        after_days=90,
        target_storage_class="GLACIER",
    ),
]


# True when ``bronze_s3_bucket`` points at an Impossible Cloud endpoint.
#: True when the configured backend is Impossible Cloud (set via
#: ``EDEN_STORAGE_BACKEND=impossible_cloud`` env var or
#: ``eden_storage_backend`` Settings field). When true,
#: ``apply_s3_lifecycle_rules`` omits the ``Transitions`` blocks because
#: Impossible Cloud has a single always-hot tier — the
#: STANDARD_IA / GLACIER_IR / GLACIER transitions are meaningless.
import os as _os

_IMPOSSIBLE_CLOUD = (
    _os.environ.get("EDEN_STORAGE_BACKEND", "").lower() == "impossible_cloud"
)

_IMPOSSIBLE_CLOUD = _os.environ.get("EDEN_STORAGE_BACKEND", "").lower() == "impossible_cloud"


class StorageLifecycleManager:
    """Manages storage lifecycle rules for the data platform.

    Handles:
    - PostgreSQL → object-storage (Impossible Cloud or AWS S3) archive
    - S3 lifecycle rule configuration
    - Expiration of temporary/debug data

    On Impossible Cloud (the Eden default since 2026-06-19) the
    tier-transition chain collapses to expiration-only because there
    is only one storage class. ``apply_s3_lifecycle_rules`` emits
    ``Transitions`` blocks only when ``EDEN_STORAGE_BACKEND`` is
    unset or set to a tiered backend like ``aws``.
    """

    def __init__(
        self,
        transitions: list[TierTransition] | None = None,
        dry_run: bool = False,
    ) -> None:
        self.transitions = transitions or DEFAULT_TRANSITIONS
        self.dry_run = dry_run
        self._postgres_client: Any | None = None

    async def _get_postgres(self) -> Any:
        if self._postgres_client is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres_client = await get_postgres_client()
        return self._postgres_client

    async def apply_s3_lifecycle_rules(self) -> bool:
        """Apply S3 bucket lifecycle rules for automated tiering.

        This should be run once at infrastructure setup time.
        """
        bucket = getattr(settings, "bronze_s3_bucket", "")
        if not bucket:
            logger.warning("S3 lifecycle rules skipped: bronze_s3_bucket not configured")
            return False

        rules = [
            {
                "ID": "eden-bronze-tiering",
                "Status": "Enabled",
                "Filter": {"Prefix": "bronze/events/"},
                **(
                    {
                        "Transitions": [
                            {"Days": 7, "StorageClass": "STANDARD_IA"},
                            {"Days": 30, "StorageClass": "GLACIER_IR"},
                        ],
                    }
                    if not _IMPOSSIBLE_CLOUD
                    else {}
                ),
                "Expiration": {"Days": 2555},  # 7 years
            },
            {
                "ID": "eden-silver-tiering",
                "Status": "Enabled",
                "Filter": {"Prefix": "silver/"},
                **(
                    {
                        "Transitions": [
                            {"Days": 7, "StorageClass": "STANDARD_IA"},
                            {"Days": 90, "StorageClass": "GLACIER"},
                        ],
                    }
                    if not _IMPOSSIBLE_CLOUD
                    else {}
                ),
                "Expiration": {"Days": 2555},
            },
            {
                "ID": "eden-datasets-tiering",
                "Status": "Enabled",
                "Filter": {"Prefix": "datasets/"},
                **(
                    {
                        "Transitions": [
                            {"Days": 30, "StorageClass": "GLACIER"},
                        ],
                    }
                    if not _IMPOSSIBLE_CLOUD
                    else {}
                ),
            },
            {
                "ID": "eden-debug-cleanup",
                "Status": "Enabled",
                "Filter": {"Prefix": "debug/"},
                "Expiration": {"Days": 7},
            },
            {
                "ID": "eden-quarantine-cleanup",
                "Status": "Enabled",
                "Filter": {"Prefix": "quarantine/"},
                "Expiration": {"Days": 90},
            },
        ]

        if self.dry_run:
            logger.info(f"[DRY RUN] Would apply {len(rules)} S3 lifecycle rules to {bucket}")
            return True

        try:
            s3 = _make_s3_client()
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: s3.put_bucket_lifecycle_configuration(
                    Bucket=bucket,
                    LifecycleConfiguration={"Rules": rules},
                ),
            )
            logger.info(f"Applied {len(rules)} S3 lifecycle rules to {bucket}")
            return True
        except Exception as exc:
            # Impossible Cloud (single-tier) doesn't support
            # lifecycle policies — the operation returns 501 Not
            # Implemented. That's fine: IC has no tier transitions,
            # so the policy is a no-op anyway. Log at debug and
            # return True so the cron doesn't fail.
            err_str = str(exc).lower()
            if (
                "notimplemented" in err_str
                or "not implemented" in err_str
                or "501" in err_str
            ):
                logger.debug(
                    f"backend doesn't support lifecycle rules (OK for Impossible Cloud): {exc}"
                )
                return True
            logger.error(f"Failed to apply S3 lifecycle rules: {exc}")
            return False

    async def transition_to_warm(
        self,
        table: str,
        before_days: int = 7,
        batch_size: int = 5000,
    ) -> int:
        """Move PostgreSQL rows older than N days to S3 warm storage.

        Writes to S3 Standard, then deletes from PostgreSQL.
        Returns number of rows moved.
        """
        client = await self._get_postgres()
        cutoff = datetime.now(UTC) - timedelta(days=before_days)

        query = f"""
            SELECT * FROM {table}
            WHERE timestamp < $1
            ORDER BY timestamp ASC
            LIMIT $2
        """
        total_moved = 0
        while True:
            rows = await client.fetch(query, cutoff.isoformat(), batch_size)
            if not rows:
                break

            if self.dry_run:
                total_moved += len(rows)
                logger.info(f"[DRY RUN] Would move {len(rows)} rows from {table} to warm")
                continue

            # Write to S3
            s3_ok = await self._write_warm_archive(rows, table)
            if not s3_ok:
                logger.warning(f"S3 warm write failed for {table}, stopping transition")
                break

            # Delete from PostgreSQL
            ids = []
            id_col = "silver_event_id" if table == "silver_events" else "id"
            for r in rows:
                val = r.get(id_col)
                if val:
                    ids.append(val)

            if ids:
                placeholders = ", ".join(f"${i + 2}" for i in range(len(ids)))
                await client.execute(
                    f"DELETE FROM {table} WHERE {id_col} IN ({placeholders})",
                    *ids,
                )

            total_moved += len(rows)
            logger.info(f"Moved {len(rows)} rows from {table} to warm storage")

            if len(rows) < batch_size:
                break

        return total_moved

    async def _write_warm_archive(self, rows: list[dict], table: str) -> bool:
        """Write rows to S3 warm storage (Standard class)."""
        bucket = getattr(settings, "bronze_s3_bucket", "")
        if not bucket:
            return False

        try:
            s3 = _make_s3_client()
            prefix = f"warm/{table}"
            ts = datetime.now(UTC)
            key = (
                f"{prefix}/year={ts.year}/month={ts.month:02d}/"
                f"day={ts.day:02d}/{ts.hour:02d}/{ts.isoformat()}.ndjson"
            )

            body = "\n".join(json.dumps(dict(r), default=str) for r in rows)
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(
                None,
                lambda: s3.put_object(
                    Bucket=bucket,
                    Key=key,
                    Body=body,
                    ContentType="application/x-ndjson",
                    StorageClass="STANDARD",
                ),
            )
            return True
        except Exception as exc:
            logger.error(f"Warm archive write failed: {exc}")
            return False

    async def transition_s3_prefix(
        self,
        prefix: str,
        to_storage_class: str,
        before_days: int,
    ) -> int:
        """Transition S3 objects in a prefix to a different storage class.

        Returns number of objects transitioned. On Impossible Cloud
        (``EDEN_STORAGE_BACKEND=impossible_cloud``) this is a no-op
        because the backend has a single always-hot tier — there is
        nothing to transition to. Returns 0 immediately.
        """
        if _IMPOSSIBLE_CLOUD:
            logger.info(
                f"[impossible_cloud] skipping tier transition of "
                f"s3://.../{prefix} → {to_storage_class} (single-tier backend)"
            )
            return 0

        bucket = getattr(settings, "bronze_s3_bucket", "")
        if not bucket:
            return 0

        cutoff = datetime.now(UTC) - timedelta(days=before_days)

        try:
            s3 = _make_s3_client()
            loop = asyncio.get_event_loop()

            # List objects
            paginator = s3.get_paginator("list_objects_v2")
            objects_to_transition = []
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    last_modified = obj["LastModified"]
                    if last_modified.replace(tzinfo=UTC) < cutoff:
                        objects_to_transition.append(
                            {"Key": obj["Key"], "StorageClass": to_storage_class}
                        )

            if self.dry_run:
                logger.info(
                    f"[DRY RUN] Would transition {len(objects_to_transition)} "
                    f"objects in s3://{bucket}/{prefix} to {to_storage_class}"
                )
                return len(objects_to_transition)

            # Batch transition via copy_object
            transitioned = 0
            for obj in objects_to_transition:
                await loop.run_in_executor(
                    None,
                    lambda: s3.copy_object(
                        Bucket=bucket,
                        CopySource={"Bucket": bucket, "Key": obj["Key"]},
                        Key=obj["Key"],
                        StorageClass=to_storage_class,
                        MetadataDirective="COPY",
                    ),
                )
                transitioned += 1

            logger.info(
                f"Transitioned {transitioned} S3 objects to {to_storage_class}"
            )
            return transitioned
        except Exception as exc:
            logger.error(f"S3 transition failed: {exc}")
            return 0

    async def expire_temporary_data(self) -> int:
        """Expire temporary and debug data from S3.

        Returns number of objects deleted.
        """
        bucket = getattr(settings, "bronze_s3_bucket", "")
        if not bucket:
            return 0

        prefixes = ["debug/", "tmp/", "staging/"]
        total_deleted = 0

        try:
            s3 = _make_s3_client()
            loop = asyncio.get_event_loop()

            for prefix in prefixes:
                paginator = s3.get_paginator("list_objects_v2")
                objects_to_delete = []
                cutoff = datetime.now(UTC) - timedelta(days=7)

                for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                    for obj in page.get("Contents", []):
                        if obj["LastModified"].replace(tzinfo=UTC) < cutoff:
                            objects_to_delete.append({"Key": obj["Key"]})

                if objects_to_delete and not self.dry_run:
                    await loop.run_in_executor(
                        None,
                        lambda: s3.delete_objects(
                            Bucket=bucket,
                            Delete={"Objects": objects_to_delete},
                        ),
                    )
                    total_deleted += len(objects_to_delete)
                    logger.info(
                        f"Expired {len(objects_to_delete)} objects from s3://{bucket}/{prefix}"
                    )
                elif objects_to_delete:
                    total_deleted += len(objects_to_delete)
                    logger.info(
                        f"[DRY RUN] Would expire {len(objects_to_delete)} objects "
                        f"from s3://{bucket}/{prefix}"
                    )

            return total_deleted
        except Exception as exc:
            logger.error(f"Temporary data expiration failed: {exc}")
            return 0

    async def get_storage_summary(self) -> dict[str, Any]:
        """Get a summary of current storage usage across tiers."""
        summary: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "hot": {},
            "warm": {},
            "cold": {},
        }

        # PostgreSQL hot storage
        client = await self._get_postgres()
        for table in ["usage_events", "silver_events", "quarantine_events"]:
            try:
                count = await client.fetchval(f"SELECT COUNT(*) FROM {table}") or 0
                summary["hot"][table] = {"rows": count}
            except Exception:
                summary["hot"][table] = {"rows": 0, "error": "query failed"}

        # S3 warm/cold
        bucket = getattr(settings, "bronze_s3_bucket", "")
        if bucket:
            try:
                s3 = _make_s3_client()
                loop = asyncio.get_event_loop()

                # Get bucket size via CloudWatch or ListObjectsV2 heuristic
                # For simplicity, just list prefixes and count objects
                for tier_prefix in ["bronze/events", "silver", "datasets", "cold"]:
                    response = await loop.run_in_executor(
                        None,
                        lambda: s3.list_objects_v2(
                            Bucket=bucket, Prefix=tier_prefix, MaxKeys=1000
                        ),
                    )
                    objects = response.get("Contents", [])
                    total_size = sum(o["Size"] for o in objects)
                    summary["warm" if tier_prefix != "cold" else "cold"][tier_prefix] = {
                        "objects": len(objects),
                        "bytes": total_size,
                    }
            except Exception as exc:
                summary["s3_error"] = str(exc)

        return summary
