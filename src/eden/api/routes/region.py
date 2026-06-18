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

from eden.api.deps import get_current_user
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/region", tags=["region"])


# Allowed values: NULL (unset), 'us', 'eu', 'ap'.
# Adding a new region requires a corresponding deployment of the
# backend — the metadata is the easy part.
ALLOWED_REGIONS = {None, "us", "eu", "ap"}


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
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> RegionOut:
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    row = await client.fetchrow(
        "SELECT region FROM organizations WHERE org_id = $1",
        org_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Org not found")
    return RegionOut(region=row["region"])


@router.put("", response_model=RegionOut)
async def put_region(
    body: RegionIn,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> RegionOut:
    from eden.api.deps import require_org_permission
    await require_org_permission("settings:edit", x_org_id=org_id)

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
            "UPDATE organizations SET region = $1 WHERE org_id = $2",
            body.region, org_id,
        )
    except Exception as exc:
        logger.warning(f"put_region failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))

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
