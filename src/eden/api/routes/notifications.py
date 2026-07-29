"""Notification routes for Eden API."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from eden.api.deps import eden_user_id_from_auth, get_current_user
from eden.api.utils.redact import redact_all
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications", tags=["notifications"])


class Notification(BaseModel):
    """Single notification."""
    id: str
    user_id: str
    org_id: str | None
    type: str
    title: str
    message: str
    metadata: dict
    is_read: bool
    created_at: str


class NotificationListResponse(BaseModel):
    """Paginated notification response."""
    notifications: list[Notification]
    total: int
    unread_count: int
    limit: int
    offset: int


class CreateNotificationRequest(BaseModel):
    """Request schema for creating a notification."""
    type: str
    title: str
    message: str
    org_id: str | None = None
    metadata: dict = {}


class NotificationResponse(BaseModel):
    """Response schema for notification operations."""
    id: str
    message: str


@router.get("", response_model=NotificationListResponse)
async def list_notifications(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    unread_only: bool = Query(False),
    user: dict = Depends(get_current_user),
):
    """List notifications for the authenticated user.

    Returns paginated notifications ordered by creation time (newest first).

    June 2026 fix: the prior signature took the raw cookie string
    via ``Cookie(None)`` and called ``await get_current_user(authorization)``
    — but ``get_current_user`` is a FastAPI dependency that takes a
    Depends-resolved payload dict, not a cookie string. Passing the
    cookie crashed ``payload.get("sub")`` with AttributeError → 500.
    Now wired through ``Depends(get_current_user)`` like the rest of
    the route layer.
    """
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        # Webhook /auth/me race: Clerk session is valid but Eden row
        # not synced yet — return an empty inbox instead of passing a
        # Clerk string into notifications.user_id (UUID) → 500.
        return NotificationListResponse(
            notifications=[],
            total=0,
            unread_count=0,
            limit=limit,
            offset=offset,
        )

    client = await get_postgres_client()

    # Build query
    conditions = ["user_id = $1"]
    params = [user_id]
    param_idx = 2

    if unread_only:
        conditions.append("read_at IS NULL")

    where_clause = " AND ".join(conditions)

    # Single windowed query replaces the old 3 sequential round-trips
    # (total count, unread count, page fetch): window functions attach
    # the matching-set totals to every returned row.
    rows = await client.fetch(
        f"""
        SELECT id, user_id, org_id, type, title, body, data, read_at, created_at,
               COUNT(*) OVER()::int AS total_count,
               COUNT(*) FILTER (WHERE read_at IS NULL) OVER()::int AS unread_count
        FROM notifications
        WHERE {where_clause}
        ORDER BY created_at DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """,
        *params, limit, offset
    )

    if rows:
        total = rows[0]["total_count"]
        unread_count = rows[0]["unread_count"]
    else:
        # Empty page — either no matches at all, or offset landed past the
        # last page. Window functions can't report a total with zero rows,
        # so fall back to explicit counts to keep pagination totals correct.
        total_row = await client.fetchrow(
            f"SELECT COUNT(*) as count FROM notifications WHERE {where_clause}",
            *params
        )
        total = total_row["count"]
        unread_row = await client.fetchrow(
            "SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
            user_id
        )
        unread_count = unread_row["count"]

    notifications = [
        Notification(
            id=str(row["id"]),
            user_id=str(row["user_id"]),
            org_id=str(row["org_id"]) if row["org_id"] else None,
            type=row["type"],
            title=row["title"],
            message=row["body"] or "",
            metadata=row["data"] or {},
            is_read=row["read_at"] is not None,
            created_at=row["created_at"].isoformat(),
        )
        for row in rows
    ]

    return NotificationListResponse(
        notifications=notifications,
        total=total,
        unread_count=unread_count,
        limit=limit,
        offset=offset,
    )


@router.post("", response_model=NotificationResponse)
async def create_notification(
    request: CreateNotificationRequest,
    user: dict = Depends(get_current_user),
):
    """Create a new notification for the authenticated user.

    Audit 2026-06-22 B1.16 — derive user_id from session; ignore body value
    to prevent any-user-to-any-user spam. Also enforce org_id matches the
    caller's memberships.
    """
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        raise HTTPException(status_code=404, detail="User not found")

    client = await get_postgres_client()

    if request.org_id:
        try:
            membership = await client.fetchrow(
                "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
                request.org_id,
                user_id,
            )
        except Exception as exc:
            msg = str(exc).lower()
            if "invalid input syntax for type uuid" in msg:
                raise HTTPException(
                    status_code=400,
                    detail="Invalid organization id",
                ) from exc
            logger.warning("create_notification membership check failed: %s", redact_all(str(exc)))
            raise HTTPException(
                status_code=503,
                detail="Failed to create notification",
            ) from exc
        if not membership:
            raise HTTPException(
                status_code=403,
                detail="Not a member of this organization",
            )

    # Schema is migration 001: body / data / read_at (not the legacy
    # 015_notifications.sql shape message / metadata / is_read).
    try:
        row = await client.fetchrow(
            """
            INSERT INTO notifications (user_id, org_id, type, title, body, data)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id
            """,
            user_id, request.org_id, request.type, request.title, request.message, request.metadata
        )
    except Exception as exc:
        msg = str(exc).lower()
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
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=409,
                detail="Notification already exists",
            ) from exc
        logger.warning("create_notification INSERT failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail="Failed to create notification",
        ) from exc
    if row is None:
        raise HTTPException(
            status_code=409,
            detail="Failed to create notification",
        )
    return NotificationResponse(
        id=str(row["id"]),
        message="Notification created"
    )


@router.patch("/{notification_id}/read", response_model=dict)
async def mark_notification_read(
    notification_id: str,
    user: dict = Depends(get_current_user),
):
    """Mark a notification as read."""
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        return {"message": "Notification marked as read"}

    client = await get_postgres_client()

    result = await client.execute(
        """
        UPDATE notifications
        SET read_at = NOW()
        WHERE id = $1 AND user_id = $2 AND read_at IS NULL
        """,
        notification_id, user_id
    )

    if result == "UPDATE 0":
        # No matching notification found - might already be read or doesn't exist.
        # Logged at info level so missing notifications are visible without
        # surfacing as a 404 to the client (idempotent reads are still 200).
        logger.info(
            "mark_read: no unread notification id=%s for user_id=%s",
            notification_id,
            user_id,
        )

    return {"message": "Notification marked as read"}


@router.patch("/read-all", response_model=dict)
async def mark_all_notifications_read(
    user: dict = Depends(get_current_user),
):
    """Mark all notifications as read for the authenticated user."""
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        return {"message": "All notifications marked as read"}

    client = await get_postgres_client()

    await client.execute(
        """
        UPDATE notifications
        SET read_at = NOW()
        WHERE user_id = $1 AND read_at IS NULL
        """,
        user_id
    )

    return {"message": "All notifications marked as read"}


@router.delete("/{notification_id}", response_model=dict)
async def delete_notification(
    notification_id: str,
    user: dict = Depends(get_current_user),
):
    """Delete a notification."""
    user_id = await eden_user_id_from_auth(user)
    if not user_id:
        return {"message": "Notification deleted"}

    client = await get_postgres_client()

    await client.execute(
        """
        DELETE FROM notifications
        WHERE id = $1 AND user_id = $2
        """,
        notification_id, user_id
    )

    return {"message": "Notification deleted"}
