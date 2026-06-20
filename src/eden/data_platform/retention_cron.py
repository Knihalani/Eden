"""Daily retention cron entry point.

Phase B1 of the Eden app/storage plan (2026-06-19). Runs all 7
retention policies from ``DataRetentionManager.DEFAULT_POLICIES``
plus the S3 lifecycle rule application and the temp-data sweep.

Phase B3 (2026-06-19) addition: also runs the
:class:`ArchiveService` to move Postgres ``telemetry_events`` rows
older than 90 days to Impossible Cloud cold storage.

Wire into:
- Northflank: a daily scheduled job (cron: ``0 2 * * *``)
- Local dev: ``python -m eden.data_platform.retention_cron``
- Tests: ``await retention_cron.run()`` from a pytest fixture

Order matters: archive before delete. Lifecycle rules before
expiration checks. Per-tenant retention overrides (from
``org_retention_policies``) layer on top of the global defaults.

Idempotent: re-running with ``--dry-run`` (default) lists what would
happen without changing anything; re-running after a partial run
picks up where the previous run left off.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from eden.data_platform.retention import DataRetentionManager
from eden.data_platform.storage_lifecycle import StorageLifecycleManager
from eden.services.data_platform import ArchiveService, PartitionManager

logger = logging.getLogger(__name__)


async def run(dry_run: bool = False) -> dict:
    """Execute all retention + lifecycle + cold-archive policies.

    Returns a dict ``{policy_name: RetentionReport}`` from the
    retention manager plus lifecycle metrics. Pass through to a
    log shipper / Northflank job summary as needed.
    """
    results: dict = {}

    # 1. PII redaction + archival for every default policy
    retention = DataRetentionManager(dry_run=dry_run)
    for policy in retention.policies:
        logger.info(f"[retention] running {policy.data_type}")
        try:
            results[policy.data_type] = await retention.run_retention_policy(policy)
        except Exception as exc:
            logger.error(f"[retention] {policy.data_type} failed: {exc}")
            results[policy.data_type] = {"errors": [str(exc)]}

    # 2. Apply S3 lifecycle rules (idempotent; on Impossible Cloud
    #    the Transitions blocks are skipped — see storage_lifecycle.py).
    lifecycle = StorageLifecycleManager(dry_run=dry_run)
    applied = await lifecycle.apply_s3_lifecycle_rules()
    results["lifecycle_rules_applied"] = applied

    # 3. Sweep tmp/debug/quarantine
    expired = await lifecycle.expire_temporary_data()
    results["expired_objects"] = expired

    # 4. Cold-archive telemetry_events older than 90d (Phase B3).
    #    Per-org loop so one tenant's slow archive doesn't block others.
    archive = ArchiveService()
    orgs = await _list_orgs_with_old_traces(archive)
    cold_results: dict[str, dict] = {}
    for org_id in orgs:
        try:
            cold_results[org_id] = await archive.archive_old_rows(
                org_id, dry_run=dry_run,
            )
        except Exception as exc:
            logger.error(f"[cold_archive] {org_id} failed: {exc}")
            cold_results[org_id] = {"errors": [str(exc)]}
    results["cold_archive"] = cold_results

    # 5. Phase B4 — orphan-message GC. Catches any trace_messages
    #    rows whose trace has no remaining telemetry_events row
    #    (failed archives, manual SQL, replays).
    try:
        from eden.observability.message_store import get_message_store
        results["trace_messages_gc"] = await get_message_store().gc_orphans()
    except Exception as exc:
        logger.error(f"[trace_messages_gc] failed: {exc}")
        results["trace_messages_gc"] = {"errors": [str(exc)]}

    # 6. Phase B5 — partition manager. Ensures ``usage_events`` (and
    #    any other natively-partitioned tables) have the next 3
    #    months of partitions and drops anything past retention.
    pm = PartitionManager(
        retention_months=24,
        forward_months=3,
        dry_run=dry_run,
    )
    try:
        results["partition_manager"] = await pm.run()
    except Exception as exc:
        logger.error(f"[partition_manager] failed: {exc}")
        results["partition_manager"] = {"errors": [str(exc)]}

    return results


async def _list_orgs_with_old_traces(archive: ArchiveService) -> list[str]:
    """List orgs that have at least one trace eligible for cold archive.

    Cheap query — the index on ``(org_id, timestamp)`` makes this an
    index-only scan.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return []

    client = await get_postgres_client()
    if client is None:
        return []
    rows = await client.fetch(
        """
        SELECT DISTINCT tenant_id FROM telemetry_events
        WHERE timestamp < NOW() - INTERVAL '90 days'
        LIMIT 1000
        """
    )
    return [r["tenant_id"] for r in rows]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--no-dry-run", dest="dry_run", action="store_false")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    results = asyncio.run(run(dry_run=args.dry_run))
    summary_keys = [
        k for k in results.keys() if k not in {"lifecycle_rules_applied", "expired_objects"}
    ]
    logger.info(
        f"[retention_cron] dry_run={args.dry_run}; "
        f"{len(summary_keys)} retention policies; "
        f"{results.get('expired_objects', 0)} objects expired; "
        f"{len(results.get('cold_archive', {}))} orgs scanned for cold archive"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
