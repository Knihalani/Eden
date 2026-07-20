"""Webhook management routes for Eden Public API.

Provides CRUD for organization webhooks and a test endpoint.
Webhook delivery and retry scheduling is handled by the
WebhookDeliveryService.
"""

# Audit 2026-06-22 B1.17 — block SSRF via webhooks.
# Refuses http://, userinfo tricks, and private/loopback/link-local IPs.
import ipaddress
import logging
import secrets
from datetime import UTC, datetime
from urllib.parse import urlparse
from uuid import uuid4

from fastapi import APIRouter, Body, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field

from eden.api.deps import get_current_org, get_current_user, require_org_admin, require_path_org_access
from eden.api.middleware.api_version import CURRENT_VERSION
from eden.api.middleware.correlation_id import get_correlation_id
from eden.api.schemas.envelope import APIEnvelope, PaginatedAPIEnvelope
from eden.api.utils.redact import redact_all
from eden.storage.postgres import get_postgres_client


def _validate_webhook_url(url: str) -> None:
    """Reject URLs that point at HTTPS-unreachable or internal addresses.

    Raises HTTPException 400 on any rejection. Intentionally strict —
    webhook targets are public services, not internal IPs.
    """
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Webhook URL must use HTTPS",
        )
    host = parsed.hostname
    if not host:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Webhook URL must include a hostname",
        )
    # Try to resolve as IP literal first; fall back to DNS resolve.
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        import socket
        try:
            infos = socket.getaddrinfo(host, None)
            ip = ipaddress.ip_address(infos[0][4][0])
        except (socket.gaierror, IndexError, ValueError):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Webhook URL hostname could not be resolved",
            ) from None
    # Block private, loopback, link-local, multicast, reserved.
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Webhook URL must point to a public IP address",
        )

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/orgs/{org_id}/webhooks", tags=["webhooks"], dependencies=[Depends(require_path_org_access)])

# Valid webhook event types
VALID_EVENTS = [
    "job.created",
    "job.completed",
    "job.failed",
    "job.cancelled",
    "benchmark.completed",
    "environment.published",
    "spec.generated",
]


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class WebhookCreateRequest(BaseModel):
    """Request schema for creating a webhook."""

    url: str = Field(..., description="HTTPS URL to deliver events to")
    description: str | None = Field(None, description="Human-readable description")
    events: list[str] = Field(..., description="Event types to subscribe to")
    active: bool = Field(True, description="Whether the webhook is active")


class WebhookUpdateRequest(BaseModel):
    """Request schema for updating a webhook."""

    url: str | None = Field(None, description="HTTPS URL to deliver events to")
    description: str | None = Field(None, description="Human-readable description")
    events: list[str] | None = Field(None, description="Event types to subscribe to")
    active: bool | None = Field(None, description="Whether the webhook is active")


class WebhookResponse(BaseModel):
    """Response schema for a webhook."""

    id: str
    org_id: str
    url: str
    description: str | None
    events: list[str]
    active: bool
    created_at: str
    updated_at: str


class WebhookTestResponse(BaseModel):
    """Response schema for webhook test."""

    success: bool
    http_status: int | None
    response_body: str | None
    error: str | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _get_webhook(org_id: str, webhook_id: str) -> dict:
    """Fetch a webhook by ID, verifying it belongs to the org."""
    # Reject non-UUID ids before Postgres so asyncpg DataError does not
    # surface as an unintended 500 on client typos / smoke placeholders.
    try:
        import uuid as _uuid

        _uuid.UUID(webhook_id)
        _uuid.UUID(org_id)
    except (ValueError, AttributeError, TypeError) as err:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook not found",
        ) from err
    client = await get_postgres_client()
    try:
        row = await client.fetchrow(
            "SELECT * FROM webhooks WHERE id = $1 AND org_id = $2",
            webhook_id, org_id,
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Webhook not found",
            ) from exc
        raise
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook not found",
        )
    return dict(row)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.post("", response_model=APIEnvelope)
async def create_webhook(
    org_id: str = Depends(require_path_org_access),
    request: WebhookCreateRequest = Body(...),
    user: dict = Depends(get_current_user),
    _admin: dict = Depends(require_org_admin),
):
    """Create a new webhook for an organization.

    Returns the webhook configuration. The secret used for HMAC signature
    verification is NOT returned — it is shown only once in this response
    under `secret` inside the data payload (legacy compat) but should be
    copied immediately because it cannot be retrieved later.
    """

    # Validate events
    invalid = [e for e in request.events if e not in VALID_EVENTS]
    if invalid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid events: {invalid}. Valid: {VALID_EVENTS}",
        )

    # Validate URL is HTTPS and not pointing at a private/internal IP.
    # Audit 2026-06-22 B1.17 — block SSRF into cloud metadata + RFC1918.
    _validate_webhook_url(request.url)

    client = await get_postgres_client()
    webhook_id = str(uuid4())
    secret = secrets.token_hex(32)
    now = datetime.now(UTC).isoformat()

    try:
        await client.execute(
            """
            INSERT INTO webhooks (id, org_id, url, description, events, secret, active, created_by, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
            """,
            webhook_id, org_id, request.url, request.description,
            request.events, secret, request.active, user["user_id"], now,
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid organization id",
            ) from exc
        if "foreign key" in msg:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Organization not found",
            ) from exc
        logger.warning("create_webhook failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Failed to create webhook",
        ) from exc

    data = WebhookResponse(
        id=webhook_id,
        org_id=org_id,
        url=request.url,
        description=request.description,
        events=request.events,
        active=request.active,
        created_at=now,
        updated_at=now,
    )

    # Include secret in the raw data dict for one-time display
    resp_dict = data.model_dump()
    resp_dict["secret"] = secret  # One-time only

    return APIEnvelope.wrap(
        data=resp_dict,
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.get("", response_model=PaginatedAPIEnvelope)
async def list_webhooks(
    org_id: str = Depends(require_path_org_access),
    active_only: bool = False,
    limit: int = 20,
    offset: int = 0,
    user: dict = Depends(get_current_user),
    org: dict = Depends(get_current_org),
):
    """List webhooks for an organization."""
    if not org or str(org.get("org_id", "")) != org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )

    client = await get_postgres_client()

    conditions = ["org_id = $1"]
    params = [org_id]
    param_idx = 2

    if active_only:
        conditions.append(f"active = ${param_idx}")
        params.append(True)
        param_idx += 1

    where_clause = " AND ".join(conditions)

    rows = await client.fetch(
        f"""
        SELECT id, org_id, url, description, events, active, created_at, updated_at
        FROM webhooks
        WHERE {where_clause}
        ORDER BY created_at DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """,
        *params, limit, offset,
    )

    total = await client.fetchval(
        f"SELECT COUNT(*) FROM webhooks WHERE {where_clause}",
        *params,
    ) or 0

    data = [
        WebhookResponse(
            id=str(r["id"]),
            org_id=str(r["org_id"]),
            url=r["url"],
            description=r.get("description"),
            events=r["events"],
            active=r["active"],
            created_at=r["created_at"].isoformat() if r.get("created_at") else "",
            updated_at=r["updated_at"].isoformat() if r.get("updated_at") else "",
        )
        for r in rows
    ]

    return PaginatedAPIEnvelope.wrap(
        data=[d.model_dump() for d in data],
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
        total=total,
        page=(offset // limit) + 1,
        per_page=limit,
    )


@router.get("/{webhook_id}", response_model=APIEnvelope)
async def get_webhook(
    org_id: str = Depends(require_path_org_access),
    webhook_id: str = Path(...),
    user: dict = Depends(get_current_user),
    _admin: dict = Depends(require_org_admin),
):
    """Get a single webhook by ID."""
    row = await _get_webhook(org_id, webhook_id)

    data = WebhookResponse(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        url=row["url"],
        description=row.get("description"),
        events=row["events"],
        active=row["active"],
        created_at=row["created_at"].isoformat() if row.get("created_at") else "",
        updated_at=row["updated_at"].isoformat() if row.get("updated_at") else "",
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.patch("/{webhook_id}", response_model=APIEnvelope)
async def update_webhook(
    org_id: str = Depends(require_path_org_access),
    webhook_id: str = Path(...),
    request: WebhookUpdateRequest = Body(...),
    user: dict = Depends(get_current_user),
    _admin: dict = Depends(require_org_admin),
):
    """Update a webhook."""
    await _get_webhook(org_id, webhook_id)

    updates = []
    params = [webhook_id]
    param_idx = 2

    if request.url is not None:
        # Reuse the create-path validator: HTTPS-only + resolves to a
        # public IP. The pre-fix update path skipped this check, so
        # an org admin could store a webhook pointing at ``127.0.0.1``
        # or ``169.254.169.254`` (cloud metadata) for later delivery.
        _validate_webhook_url(request.url)
        updates.append(f"url = ${param_idx}")
        params.append(request.url)
        param_idx += 1

    if request.description is not None:
        updates.append(f"description = ${param_idx}")
        params.append(request.description)
        param_idx += 1

    if request.events is not None:
        invalid = [e for e in request.events if e not in VALID_EVENTS]
        if invalid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid events: {invalid}. Valid: {VALID_EVENTS}",
            )
        updates.append(f"events = ${param_idx}")
        params.append(request.events)
        param_idx += 1

    if request.active is not None:
        updates.append(f"active = ${param_idx}")
        params.append(request.active)
        param_idx += 1

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    updates.append(f"updated_at = ${param_idx}")
    params.append(datetime.now(UTC).isoformat())

    client = await get_postgres_client()
    await client.execute(
        f"UPDATE webhooks SET {', '.join(updates)} WHERE id = $1",
        *params,
    )

    # Re-fetch the updated webhook and return it
    row = await _get_webhook(org_id, webhook_id)
    data = WebhookResponse(
        id=str(row["id"]),
        org_id=str(row["org_id"]),
        url=row["url"],
        description=row.get("description"),
        events=row["events"],
        active=row["active"],
        created_at=row["created_at"].isoformat() if row.get("created_at") else "",
        updated_at=row["updated_at"].isoformat() if row.get("updated_at") else "",
    )

    return APIEnvelope.wrap(
        data=data.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.delete("/{webhook_id}", response_model=APIEnvelope)
async def delete_webhook(
    org_id: str = Depends(require_path_org_access),
    webhook_id: str = Path(...),
    user: dict = Depends(get_current_user),
    _admin: dict = Depends(require_org_admin),
):
    """Delete (revoke) a webhook."""
    await _get_webhook(org_id, webhook_id)

    client = await get_postgres_client()
    await client.execute("DELETE FROM webhooks WHERE id = $1", webhook_id)
    return APIEnvelope.wrap(
        data={"message": "Webhook deleted"},
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.post("/{webhook_id}/test", response_model=APIEnvelope)
async def test_webhook(
    org_id: str = Depends(require_path_org_access),
    webhook_id: str = Path(...),
    user: dict = Depends(get_current_user),
    _admin: dict = Depends(require_org_admin),
):
    """Send a test event to a webhook endpoint.

    Useful for verifying connectivity and signature validation.
    """
    row = await _get_webhook(org_id, webhook_id)

    from eden.services.webhook_delivery import WebhookDeliveryService

    service = WebhookDeliveryService()
    result = await service.deliver_test(
        webhook_id=webhook_id,
        url=row["url"],
        secret=row["secret"],
    )

    return APIEnvelope.wrap(
        data=result.model_dump(),
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


# ─── DLQ + Replay (D.13) ──────────────────────────────────────────────


@router.get("/dlq", response_model=APIEnvelope)
async def list_dlq(
    org_id: str = Depends(require_path_org_access),
    limit: int = 50,
    _user: dict = Depends(get_current_user),
):
    """List DLQ entries (terminal-state webhook deliveries)."""
    from eden.services.webhook_delivery import WebhookDeliveryService

    entries = await WebhookDeliveryService().list_dlq(
        org_id, limit=max(1, min(limit, 500))
    )
    return APIEnvelope.wrap(
        data={"entries": entries, "count": len(entries)},
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )


@router.post("/dlq/{dlq_id}/replay", response_model=APIEnvelope)
async def replay_dlq(
    org_id: str = Depends(require_path_org_access),
    dlq_id: str = Path(...),
    _user: dict = Depends(require_org_admin),
):
    """Re-fire a DLQ delivery (D.13)."""
    from eden.services.webhook_delivery import WebhookDeliveryService

    result = await WebhookDeliveryService().replay_dlq(dlq_id)
    return APIEnvelope.wrap(
        data=result,
        api_version=CURRENT_VERSION,
        request_id=get_correlation_id(),
    )
