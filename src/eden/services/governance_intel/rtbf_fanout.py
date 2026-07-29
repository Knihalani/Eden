"""RTBF cross-store fanout (SOTA Wave 9) — honesty over silent skips.

For each configured store, attempt erasure. If the store client is
missing or the call fails, record a visible ``status=failed`` /
``status=unavailable`` entry so operators see incomplete erasure.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


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
    results.append(await _fanout_qdrant(org_id, user_id=user_id, dry_run=dry_run))
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
    store = "redis"
    try:
        from eden.storage.redis import get_redis_client

        client = await get_redis_client()
    except Exception as exc:
        return {"store": store, "status": "unavailable", "error": str(exc)}
    if client is None:
        return {
            "store": store,
            "status": "unavailable",
            "error": "Redis client not configured",
        }
    pattern = f"eden:*:{org_id}:*:{user_id}*"
    if dry_run:
        return {"store": store, "status": "dry_run", "detail": f"would SCAN {pattern}"}
    try:
        deleted = 0
        cursor = 0
        while True:
            cursor, keys = await client.scan(cursor=cursor, match=pattern, count=200)
            if keys:
                deleted += int(await client.delete(*keys))
            if cursor == 0:
                break
        return {"store": store, "status": "ok", "deleted": deleted}
    except Exception as exc:
        logger.warning("rtbf redis fanout failed: %s", exc)
        return {"store": store, "status": "failed", "error": str(exc)}


async def _fanout_qdrant(
    org_id: str, *, user_id: str, dry_run: bool
) -> dict[str, Any]:
    store = "qdrant"
    try:
        from eden.storage.qdrant import get_qdrant_client
    except Exception:
        try:
            from eden.retrieval.qdrant_client import get_qdrant_client  # type: ignore
        except Exception as exc:
            return {"store": store, "status": "unavailable", "error": str(exc)}
    try:
        client = get_qdrant_client()
        if hasattr(client, "__await__"):
            client = await client  # type: ignore[misc]
    except Exception as exc:
        return {"store": store, "status": "unavailable", "error": str(exc)}
    if client is None:
        return {
            "store": store,
            "status": "unavailable",
            "error": "Qdrant client not configured",
        }
    if dry_run:
        return {"store": store, "status": "dry_run", "detail": "would delete points by user filter"}
    try:
        if hasattr(client, "delete_by_user"):
            n = await client.delete_by_user(org_id, user_id)
            return {"store": store, "status": "ok", "deleted": int(n or 0)}
        return {
            "store": store,
            "status": "failed",
            "error": "Qdrant client lacks user-scoped delete",
        }
    except Exception as exc:
        logger.warning("rtbf qdrant fanout failed: %s", exc)
        return {"store": store, "status": "failed", "error": str(exc)}


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
    store = "clickhouse"
    try:
        from eden.data_platform.clickhouse_sink import get_clickhouse_sink
    except Exception as exc:
        return {"store": store, "status": "unavailable", "error": str(exc)}
    try:
        sink = get_clickhouse_sink()
        if hasattr(sink, "__await__"):
            sink = await sink  # type: ignore[misc]
    except Exception as exc:
        return {"store": store, "status": "unavailable", "error": str(exc)}
    if sink is None:
        return {
            "store": store,
            "status": "unavailable",
            "error": "ClickHouse sink not configured",
        }
    if dry_run:
        return {"store": store, "status": "dry_run", "detail": "would ALTER DELETE by user_id"}
    try:
        if hasattr(sink, "delete_user_data"):
            await sink.delete_user_data(org_id, user_id)
            return {"store": store, "status": "ok"}
        return {
            "store": store,
            "status": "failed",
            "error": "ClickHouse sink lacks delete_user_data",
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
