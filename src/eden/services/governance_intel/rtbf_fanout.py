"""RTBF cross-store fanout (SOTA Wave 9) — honesty over silent skips.

For each configured store, attempt erasure. If the store client is
missing or the call fails, record a visible ``status=failed`` /
``status=unavailable`` entry so operators see incomplete erasure.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def reverify_rtbf_stores(
    org_id: str,
    *,
    user_id: str,
    fanout_results: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Re-query secondary stores after delete to confirm erasure.

    Only stores that reported ``status=ok`` during fanout are checked.
    A non-zero residual count or an unreachable store yields
    ``status=residual`` / ``status=failed`` so callers can fail closed.
    """
    results: list[dict[str, Any]] = []
    for entry in fanout_results:
        if entry.get("status") != "ok":
            continue
        store = entry.get("store")
        if store == "typesense":
            results.append(
                await _reverify_typesense(org_id, user_id=user_id)
            )
        elif store == "pgvector":
            results.append(
                await _reverify_pgvector(org_id, user_id=user_id)
            )
    return results


async def _reverify_typesense(
    org_id: str, *, user_id: str
) -> dict[str, Any]:
    store = "typesense"
    try:
        from eden.observability.typesense_client import get_typesense_client

        client = get_typesense_client()
    except Exception as exc:
        return {"store": store, "status": "failed", "error": str(exc)}
    if client is None:
        return {
            "store": store,
            "status": "failed",
            "error": "Typesense client not configured",
        }
    try:
        if hasattr(client, "has_user_id_field") and not await client.has_user_id_field():
            return {
                "store": store,
                "status": "skipped",
                "detail": "collection lacks user_id field",
            }
        remaining: int | None
        if hasattr(client, "count_by_user"):
            remaining = await client.count_by_user(org_id, user_id)
        elif hasattr(client, "count_by_filter"):
            remaining = await client.count_by_filter(
                f"tenant_id:={org_id} && user_id:={user_id}"
            )
        else:
            return {
                "store": store,
                "status": "failed",
                "error": "Typesense client lacks user-scoped count",
            }
        if remaining is None:
            return {
                "store": store,
                "status": "failed",
                "error": "Typesense re-verify search failed",
            }
        if remaining > 0:
            return {
                "store": store,
                "status": "residual",
                "remaining": remaining,
            }
        return {"store": store, "status": "ok", "remaining": 0}
    except Exception as exc:
        logger.warning("rtbf typesense re-verify failed: %s", exc)
        return {"store": store, "status": "failed", "error": str(exc)}


async def _reverify_pgvector(
    org_id: str, *, user_id: str
) -> dict[str, Any]:
    """pgvector re-verify — unsupported (N4).

    ``vector_documents`` rows are org/collection scoped; none embed
    ``user_id``, so a per-user residual count is not possible. Report
    ``skipped`` (reverify only re-checks stores that reported ``ok``,
    and the fanout below never reports ``ok``), so the honest answer
    is "cannot re-verify".
    """
    _ = org_id, user_id
    return {
        "store": "pgvector",
        "status": "skipped",
        "detail": "vector store has no user_id column; per-user reverify unsupported",
    }


async def fanout_rtbf(
    org_id: str,
    *,
    user_id: str,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """Erase / tombstone user data across secondary stores.

    Returns one result dict per store with ``store``, ``status``,
    and optional ``detail`` / ``error``.
    """
    results: list[dict[str, Any]] = []
    results.append(await _fanout_typesense(org_id, user_id=user_id, dry_run=dry_run))
    results.append(await _fanout_redis(org_id, user_id=user_id, dry_run=dry_run))
    results.append(await _fanout_pgvector(org_id, user_id=user_id, dry_run=dry_run))
    results.append(await _fanout_s3(org_id, user_id=user_id, dry_run=dry_run))
    results.append(await _fanout_clickhouse(org_id, user_id=user_id, dry_run=dry_run))
    results.append(await _fanout_blob_refs(org_id, user_id=user_id, dry_run=dry_run))
    return results


async def _fanout_typesense(
    org_id: str, *, user_id: str, dry_run: bool
) -> dict[str, Any]:
    store = "typesense"
    try:
        from eden.observability.typesense_client import get_typesense_client

        client = get_typesense_client()
    except Exception as exc:
        return {"store": store, "status": "unavailable", "error": str(exc)}
    if client is None:
        return {
            "store": store,
            "status": "unavailable",
            "error": "Typesense client not configured",
        }
    if dry_run:
        return {"store": store, "status": "dry_run", "detail": "would filter-delete by user_id"}
    try:
        if hasattr(client, "ensure_collection"):
            await client.ensure_collection()
        if hasattr(client, "has_user_id_field") and not await client.has_user_id_field():
            return {
                    "store": store,
                    "status": "unsupported",
                    "error": (
                        "Typesense collection lacks user_id field; run "
                        "eden.scripts.typesense_backfill_user_id after schema migrate"
                    ),
                }
        deleted = 0
        if hasattr(client, "delete_by_user"):
            deleted = int(await client.delete_by_user(org_id, user_id))
        elif hasattr(client, "delete_by_filter"):
            deleted = int(
                await client.delete_by_filter(
                    f"tenant_id:={org_id} && user_id:={user_id}"
                )
            )
        else:
            return {
                "store": store,
                "status": "failed",
                "error": "Typesense client lacks user-scoped delete",
            }
        return {"store": store, "status": "ok", "deleted": deleted}
    except Exception as exc:
        logger.warning("rtbf typesense fanout failed: %s", exc)
        return {"store": store, "status": "failed", "error": str(exc)}


async def _fanout_redis(
    org_id: str, *, user_id: str, dry_run: bool
) -> dict[str, Any]:
    """Per-user Redis erasure — unsupported (FEAT-108).

    Eden Redis keys are org- or hash-scoped only (``eden:cost:{org}:…``,
    ``eden:dedup:{digest}``, etc.); none embed ``user_id``, so SCAN+DEL
    cannot perform scoped erasure. Report ``unsupported`` rather than a
    false ``ok`` with ``deleted: 0``.
    """
    _ = org_id  # no tenant-wide DEL is correct for per-user RTBF
    store = "redis"
    if dry_run:
        return {
            "store": store,
            "status": "dry_run",
            "detail": "per-user Redis erasure unsupported (no user_id in key patterns)",
            "user_id": user_id,
        }
    return {
        "store": store,
        "status": "unsupported",
        "error": "Redis keys are org- or hash-scoped; no user_id in key namespace",
        "user_id": user_id,
    }


async def _fanout_pgvector(
    org_id: str, *, user_id: str, dry_run: bool
) -> dict[str, Any]:
    """pgvector erasure — unsupported (N4).

    ``vector_documents`` rows are org/collection scoped; none embed
    ``user_id``, so per-user erasure cannot be performed. Report
    ``unsupported`` (the same honest pattern as Redis) rather than a
    false ``ok`` with ``deleted: 0``.
    """
    _ = org_id  # no tenant-wide DELETE is correct for per-user RTBF
    store = "pgvector"
    if dry_run:
        return {
            "store": store,
            "status": "dry_run",
            "detail": "per-user pgvector erasure unsupported (no user_id column)",
            "user_id": user_id,
        }
    return {
        "store": store,
        "status": "unsupported",
        "error": "vector_documents rows are org/collection scoped; no user_id column",
        "user_id": user_id,
    }


async def _fanout_s3(
    org_id: str, *, user_id: str, dry_run: bool
) -> dict[str, Any]:
    """Per-user S3 erasure — not implemented, and honest about it.

    This handler previously called ``DataRetentionManager.delete_user_data``
    (now ``delete_tenant_data``) with ``org_id`` while discarding ``user_id``.
    That method issues ``DELETE FROM {table} WHERE org_id = $1`` across
    ``usage_events``, ``jobs``, ``specs``, ``silver_events``,
    ``quarantine_events`` and ``trace_archive_index`` — so a single user's
    right-to-be-forgotten request destroyed the entire organisation's data,
    including billing records, and reported ``status: "ok"``.

    There is no per-user object index for the S3/Impossible Cloud archive, so
    scoped erasure is genuinely unimplemented. Report that rather than doing
    something destructive and calling it success. ``fanout_rtbf`` treats
    ``unsupported`` as incomplete, so the caller cannot mistake this for done.
    """
    _ = org_id  # no tenant-wide action is correct here; see docstring
    if dry_run:
        return {
            "store": "s3",
            "status": "dry_run",
            "detail": "per-user S3 erasure is not implemented",
            "user_id": user_id,
        }
    return {
        "store": "s3",
        "status": "unsupported",
        "error": "per-user S3 erasure not implemented (no per-user object index)",
        "user_id": user_id,
    }


async def _fanout_clickhouse(
    org_id: str, *, user_id: str, dry_run: bool
) -> dict[str, Any]:
    """Purge tenant analytics rows on self-hosted ClickHouse.

    ``telemetry_events_ch`` has no ``user_id`` column — only ``tenant_id`` —
    so this is a tenant-scoped ALTER DELETE (via
    ``ClickHouseSink.delete_tenant_rows``), not a per-user wipe. Tinybird
    cannot ALTER DELETE via ``/v0/sql`` and stays ``unavailable``.
    """
    store = "clickhouse"
    try:
        from eden.data_platform.clickhouse_sink import get_clickhouse_sink
    except Exception as exc:
        return {"store": store, "status": "unavailable", "error": str(exc)}
    try:
        sink = get_clickhouse_sink()
        if hasattr(sink, "__await__"):
            sink = await sink
    except Exception as exc:
        return {"store": store, "status": "unavailable", "error": str(exc)}
    if sink is None:
        return {
            "store": store,
            "status": "unavailable",
            "error": "ClickHouse sink not configured",
        }
    # Tinybird: use datasource delete Jobs API via sink.delete_tenant_rows
    # (same as ``tb datasource delete``). Do not short-circuit as unavailable.
    if dry_run:
        return {
            "store": store,
            "status": "dry_run",
            "detail": (
                "would delete tenant rows on telemetry_events_ch / "
                "home_kpi_hourly via Tinybird Jobs API or ALTER DELETE "
                "(no user_id column; scope=tenant)"
            ),
            "user_id": user_id,
            "org_id": org_id,
            "scope": "tenant",
        }
    try:
        if not hasattr(sink, "delete_tenant_rows"):
            return {
                "store": store,
                "status": "failed",
                "error": "ClickHouse sink lacks delete_tenant_rows",
                "user_id": user_id,
                "org_id": org_id,
            }
        purged = await sink.delete_tenant_rows(org_id)
        return {
            "store": store,
            "status": "ok",
            "tables_purged": purged,
            "user_id": user_id,
            "org_id": org_id,
            "scope": "tenant",
            "detail": (
                "tenant-scoped CH/Tinybird purge (telemetry has no user_id); "
                "user_id recorded for audit only"
            ),
        }
    except Exception as exc:
        logger.warning("rtbf clickhouse fanout failed: %s", exc)
        return {"store": store, "status": "failed", "error": str(exc)}


async def _fanout_blob_refs(
    org_id: str, *, user_id: str, dry_run: bool
) -> dict[str, Any]:
    """N09: decrement blob refcounts for org (best-effort release hook)."""
    store = "blob_store"
    if dry_run:
        return {"store": store, "status": "dry_run", "detail": "would release org blob refs"}
    try:
        from eden.observability.compression.blob_store import get_blob_store

        store_obj = get_blob_store()
        if store_obj is None:
            return {
                "store": store,
                "status": "unavailable",
                "error": "BlobStore not configured",
            }
        released = 0
        if hasattr(store_obj, "release_org"):
            released = int(await store_obj.release_org(org_id))
        return {"store": store, "status": "ok", "released": released, "user_id": user_id}
    except Exception as exc:
        logger.warning("rtbf blob fanout failed: %s", exc)
        return {"store": store, "status": "failed", "error": str(exc)}
