"""API routes for per-tenant PII policy (Phase 7.3a).

PUT /orgs/{org_id}/pii-policy replaces the active policy (or
creates a new effective row). GET returns the current policy.

The route is gated by the ``pii:edit`` permission (added in
Phase 7.3d) — owners and admins can change the policy; viewers
can only read it.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.observability.ingestion.pii_policy import invalidate_policy
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/pii-policy", tags=["pii-policy"])


class PIIPolicyIn(BaseModel):
    enabled_categories: list[str] = Field(default_factory=list)
    disabled_categories: list[str] = Field(default_factory=list)
    fail_closed_on_credentials: bool = False
    redact_keys_extra: list[str] = Field(default_factory=list)
    notes: Optional[str] = None


class PIIPolicyOut(BaseModel):
    policy_id: str
    tenant_id: str
    enabled_categories: list[str]
    disabled_categories: list[str]
    fail_closed_on_credentials: bool
    redact_keys_extra: list[str]
    effective_from: str
    effective_until: Optional[str] = None
    created_by: Optional[str] = None
    notes: Optional[str] = None


@router.get("", response_model=PIIPolicyOut)
async def get_pii_policy(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> PIIPolicyOut:
    """Return the current PII policy for the org, or the default
    policy if no override is set."""
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    row = await client.fetchrow(
        """
        SELECT policy_id, tenant_id, enabled_categories, disabled_categories,
               fail_closed_on_credentials, redact_keys_extra,
               effective_from, effective_until, created_by, notes
        FROM org_pii_policies
        WHERE tenant_id = $1
          AND effective_from <= NOW()
          AND (effective_until IS NULL OR effective_until > NOW())
        ORDER BY effective_from DESC
        LIMIT 1
        """,
        org_id,
    )
    if not row:
        return PIIPolicyOut(
            policy_id="default",
            tenant_id=org_id,
            enabled_categories=[
                "url_with_creds", "jwt", "api_key", "email", "phone",
                "ssn", "credit_card", "ipv4", "ipv6", "password_field",
            ],
            disabled_categories=[],
            fail_closed_on_credentials=False,
            redact_keys_extra=[],
            effective_from=datetime.now(timezone.utc).isoformat(),
            effective_until=None,
            created_by=None,
            notes="default policy",
        )
    return PIIPolicyOut(
        policy_id=str(row["policy_id"]),
        tenant_id=str(row["tenant_id"]),
        enabled_categories=list(row["enabled_categories"] or []),
        disabled_categories=list(row["disabled_categories"] or []),
        fail_closed_on_credentials=bool(row["fail_closed_on_credentials"]),
        redact_keys_extra=list(row["redact_keys_extra"] or []),
        effective_from=row["effective_from"].isoformat() if hasattr(row["effective_from"], "isoformat") else str(row["effective_from"]),
        effective_until=row["effective_until"].isoformat() if row["effective_until"] and hasattr(row["effective_until"], "isoformat") else None,
        created_by=row["created_by"],
        notes=row["notes"],
    )


@router.put("", response_model=PIIPolicyOut)
async def put_pii_policy(
    body: PIIPolicyIn,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> PIIPolicyOut:
    """Replace the active PII policy. The previous policy row is
    closed (effective_until = NOW()) and a new one is inserted.

    Gated by the ``pii:edit`` permission. Owners and admins can
    change the policy; viewers and members get 403.
    """
    from eden.api.deps import require_org_permission
    await require_org_permission("pii:edit", x_org_id=org_id)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    new_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    try:
        await client.execute(
            """
            UPDATE org_pii_policies
            SET effective_until = $1
            WHERE tenant_id = $2 AND effective_until IS NULL
            """,
            now, org_id,
        )
        await client.execute(
            """
            INSERT INTO org_pii_policies (
                policy_id, tenant_id, enabled_categories, disabled_categories,
                fail_closed_on_credentials, redact_keys_extra,
                created_by, notes, effective_from
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            """,
            new_id,
            org_id,
            body.enabled_categories,
            body.disabled_categories,
            body.fail_closed_on_credentials,
            body.redact_keys_extra,
            str(user.get("user_id") or "system"),
            body.notes,
            now,
        )
    except Exception as exc:
        logger.warning(f"put_pii_policy failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc))

    # Drop the in-process cache so the new policy takes effect
    # immediately on the next ingest event.
    invalidate_policy(org_id)

    # Audit log
    try:
        from eden.api.deps import log_audit_event
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=str(user.get("user_id") or "system"),
            action="pii_policy.updated",
            target_type="pii_policy",
            target_id=new_id,
            metadata={
                "enabled_categories": body.enabled_categories,
                "disabled_categories": body.disabled_categories,
                "fail_closed_on_credentials": body.fail_closed_on_credentials,
            },
        )
    except Exception:
        pass

    return PIIPolicyOut(
        policy_id=new_id,
        tenant_id=org_id,
        enabled_categories=body.enabled_categories,
        disabled_categories=body.disabled_categories,
        fail_closed_on_credentials=body.fail_closed_on_credentials,
        redact_keys_extra=body.redact_keys_extra,
        effective_from=now.isoformat(),
        effective_until=None,
        created_by=str(user.get("user_id") or "system"),
        notes=body.notes,
    )
