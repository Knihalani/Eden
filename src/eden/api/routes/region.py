"""API routes for organization region / data residency (Phase 7.3c).

PUT /orgs/{org_id}/region — set the org's region (us, eu, ap, or null).
GET returns the current region. The actual cross-region routing is
deferred to a separate large project; this just plumbs the metadata
so the ``X-Region-Hint`` response header can be set and compliance
audits can read the value.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    require_org_permission,
    require_path_org_access,
)
from eden.api.utils.safe_error import safe_detail
from eden.storage.postgres import get_postgres_client
from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/region", tags=["region"])


# Allowed values: NULL (unset), 'us', 'eu'.
# Adding a new region requires a corresponding deployment of the
# backend — the metadata is the easy part. Multi-region is
# permanently out per commit 23f0605c; 'ap' was removed from
# the allowed set so the API surfaces a clean 422 instead of
# silently accepting a region with no infra behind it.
ALLOWED_REGIONS = {None, "us", "eu"}


class RegionIn(BaseModel):
    region: str | None = Field(
        default=None,
        description="One of 'us', 'eu', 'ap', or null to unset",
    )


class RegionOut(BaseModel):
    region: str | None
    updated_at: str | None = None


@router.get("", response_model=RegionOut)
async def get_region(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user)
) -> RegionOut:
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    row = await client.fetchrow(
        "SELECT region FROM organizations WHERE id = $1",
        org_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Org not found")
    return RegionOut(region=row["region"])


@router.put("", response_model=RegionOut)
async def put_region(
    body: RegionIn,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> RegionOut:
    # Pass path org_id + resolved JWT explicitly. A bare
    # ``await require_org_permission(..., x_org_id=org_id)`` leaves
    # ``payload`` as an unresolved ``Depends(...)`` sentinel → 500.
    await require_org_permission("settings:edit", org_id, payload)

    if body.region not in ALLOWED_REGIONS:
        raise HTTPException(
            status_code=422,
            detail=f"region must be one of {sorted(r for r in ALLOWED_REGIONS if r)} or null",
        )
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    try:
        await client.execute(
            "UPDATE organizations SET region = $1 WHERE id = $2",
            body.region, org_id,
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=409,
                detail="Region update conflict",
            ) from exc
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=400,
                detail="Invalid organization id",
            ) from exc
        if "foreign key" in msg:
            raise HTTPException(
                status_code=404,
                detail="Organization not found",
            ) from exc
        logger.warning("put_region failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to update region"),
        ) from exc

    # Audit log
    try:
        from eden.api.deps import log_audit_event
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=str(user.get("user_id") or "system"),
            action="region.updated",
            target_type="organization",
            target_id=org_id,
            metadata={"region": body.region},
        )
    except Exception:
        pass

    return RegionOut(region=body.region)
