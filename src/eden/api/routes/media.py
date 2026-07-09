"""API routes for media blob storage.

Phase 7.2a: serves image / audio payloads captured by the provider
decoders. The ``telemetry_media_blobs`` table holds metadata; the
actual bytes live in MediaStore (local disk or S3).

The route is tenant-scoped: ``/orgs/{org_id}/media/{blob_id}`` only
returns blobs whose ``tenant_id`` matches the authenticated user's
``org_id``. A cross-tenant fetch returns 404, not 403, so we don't
leak the existence of other tenants' blobs.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Response
from fastapi.responses import Response as FastAPIResponse

from eden.api.deps import get_current_user
from eden.api.middleware.security_headers import apply_security_headers
from eden.observability.media_store import MediaStore, get_media_store
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/media", tags=["media"])


async def _load_blob(
    org_id: str,
    blob_id: str,
) -> dict[str, Any]:
    """Fetch the media blob metadata. Tenant-scoped: returns None
    (caller maps to 404) when the blob doesn't exist or belongs to
    another tenant."""
    client = await get_postgres_client()
    if not client:
        return None
    row = await client.fetchrow(
        """
        SELECT blob_id, tenant_id, event_id, media_type, content_type,
               storage_uri, size_bytes, sha256, metadata
        FROM telemetry_media_blobs
        WHERE blob_id = $1 AND tenant_id = $2
        """,
        blob_id,
        org_id,
    )
    if not row:
        return None
    return dict(row)


@router.get("/{blob_id}")
async def get_media(
    org_id: str,
    blob_id: str = Path(..., description="The blob UUID"),
    user: dict = Depends(get_current_user),
    store: MediaStore = Depends(get_media_store),
) -> FastAPIResponse:
    """Stream the bytes of a media blob. Returns 404 for unknown or
    cross-tenant blob IDs."""
    blob_row = await _load_blob(org_id, blob_id)
    if not blob_row:
        raise HTTPException(status_code=404, detail="Media blob not found")
    # Reconstruct a MediaBlob dataclass from the row.
    from eden.observability.media_store import MediaBlob
    blob = MediaBlob(
        blob_id=blob_row["blob_id"],
        tenant_id=blob_row["tenant_id"],
        event_id=blob_row["event_id"],
        media_type=blob_row["media_type"],
        content_type=blob_row["content_type"],
        storage_uri=blob_row["storage_uri"],
        size_bytes=blob_row["size_bytes"],
        sha256=blob_row["sha256"],
        metadata=blob_row.get("metadata") or {},
    )
    data = await store.get(blob)
    return Response(
        content=data,
        media_type=blob.content_type,
        # F69 — apply OWASP security headers (HSTS, X-Frame-Options,
        # CSP, etc.) to the blob response. ``apply_security_headers``
        # already sets X-Content-Type-Options: nosniff; the
        # ``headers=`` argument merges with our caller's extras
        # (Cache-Control, X-Sha256) so the blob-serving contract
        # is preserved.
        headers=apply_security_headers(
            {
                "Cache-Control": "private, max-age=86400",
                "X-Content-Type-Options": "nosniff",
                "X-Sha256": blob.sha256,
            }
        ),
    )


@router.get("/{blob_id}/info")
async def get_media_info(
    org_id: str,
    blob_id: str = Path(..., description="The blob UUID"),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Return blob metadata (size, content_type, sha256) without
    streaming the bytes. Used by the portal to render a thumbnail or
    decide whether to fetch."""
    blob_row = await _load_blob(org_id, blob_id)
    if not blob_row:
        raise HTTPException(status_code=404, detail="Media blob not found")
    return {
        "blob_id": blob_row["blob_id"],
        "event_id": blob_row["event_id"],
        "media_type": blob_row["media_type"],
        "content_type": blob_row["content_type"],
        "size_bytes": blob_row["size_bytes"],
        "sha256": blob_row["sha256"],
        "metadata": blob_row.get("metadata") or {},
    }
