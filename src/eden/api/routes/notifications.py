"""Notification routes for Eden API."""

import logging
from typing import Optional

from fastapi import APIRouter, Query, Cookie
from pydantic import BaseModel

from eden.api.deps import get_current_user
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/notifications", tags=["notifications"])


class Notification(BaseModel):
    """Single notification."""
    id: str
    user_id: str
    org_id: Optional[str]
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
    org_id: Optional[str] = None
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
    authorization: Optional[str] = Cookie(None),
):
    """List notifications for the authenticated user.

    Returns paginated notifications ordered by creation time (newest first).
    """
    user = await get_current_user(authorization)
    user_id = user["user_id"]

    client = await get_postgres_client()

    # Build query
    conditions = ["user_id = $1"]
    params = [user_id]
    param_idx = 2

    if unread_only:
        conditions.append("read_at IS NULL")

    where_clause = " AND ".join(conditions)

    # Get total count
    total_row = await client.fetchrow(
        f"SELECT COUNT(*) as count FROM notifications WHERE {where_clause}",
        *params
    )
    total = total_row["count"]

    # Get unread count
    unread_row = await client.fetchrow(
        "SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
        user_id
    )
    unread_count = unread_row["count"]

    # Get notifications
    rows = await client.fetch(
        f"""
        SELECT id, user_id, org_id, type, title, body, data, read_at, created_at
        FROM notifications
        WHERE {where_clause}
        ORDER BY created_at DESC
        LIMIT ${param_idx} OFFSET ${param_idx + 1}
        """,
        *params, limit, offset
    )

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
    authorization: Optional[str] = Cookie(None),
):
    """Create a new notification for the authenticated user."""
    user = await get_current_user(authorization)
    user_id = user["user_id"]

    client = await get_postgres_client()

    row = await client.fetchrow(
        """
        INSERT INTO notifications (user_id, org_id, type, title, message, metadata)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        """,
        user_id, request.org_id, request.type, request.title, request.message, request.metadata
    )

    return NotificationResponse(
        id=str(row["id"]),
        message="Notification created"
    )


@router.patch("/{notification_id}/read", response_model=dict)
async def mark_notification_read(
    notification_id: str,
    authorization: Optional[str] = Cookie(None),
):
    """Mark a notification as read."""
    user = await get_current_user(authorization)
    user_id = user["user_id"]

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
    authorization: Optional[str] = Cookie(None),
):
    """Mark all notifications as read for the authenticated user."""
    user = await get_current_user(authorization)
    user_id = user["user_id"]

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
    authorization: Optional[str] = Cookie(None),
):
    """Delete a notification."""
    user = await get_current_user(authorization)
    user_id = user["user_id"]

    client = await get_postgres_client()

    await client.execute(
        """
        DELETE FROM notifications
        WHERE id = $1 AND user_id = $2
        """,
        notification_id, user_id
    )

    return {"message": "Notification deleted"}
