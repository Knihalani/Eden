"""Ratings & reviews (§5.6) + community submission queue (§5.5).

These features share the same DB tables (added in
``migrations/022_marketplace.sql``) and the same moderation
flow, so they live in the same module.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any
from uuid import UUID

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Review:
    id: UUID
    card_id: UUID
    user_id: UUID
    rating: int  # 1 - 5
    title: str | None
    body: str
    flagged: bool
    created_at: str


async def _client() -> Any:
    from eden.storage.postgres import get_postgres_client
    return await get_postgres_client()


async def submit_review(
    *,
    card_id: UUID,
    user_id: UUID,
    rating: int,
    title: str | None,
    body: str,
) -> Review | None:
    """Upsert a star rating + review. One review per (card, user)."""
    if not 1 <= rating <= 5:
        return None
    if not body or not body.strip():
        return None
    client = await _client()
    rating_row = await client.fetchrow(
        """
        INSERT INTO env_card_ratings (card_id, user_id, rating)
        VALUES ($1, $2, $3)
        ON CONFLICT (card_id, user_id)
        DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()
        RETURNING id
        """,
        card_id,
        user_id,
        rating,
    )
    review_row = await client.fetchrow(
        """
        INSERT INTO env_card_reviews (card_id, user_id, rating_id, title, body)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (card_id, user_id) DO UPDATE
        SET title = EXCLUDED.title, body = EXCLUDED.body, updated_at = NOW()
        RETURNING id, flagged, created_at
        """,
        card_id,
        user_id,
        rating_row["id"],
        title,
        body.strip(),
    )
    return Review(
        id=review_row["id"],
        card_id=card_id,
        user_id=user_id,
        rating=rating,
        title=title,
        body=body.strip(),
        flagged=bool(review_row["flagged"]),
        created_at=review_row["created_at"].isoformat() if review_row["created_at"] else "",
    )


async def list_reviews(card_id: UUID, *, limit: int = 20, offset: int = 0) -> list[dict[str, Any]]:
    client = await _client()
    rows = await client.fetch(
        """
        SELECT r.id, r.card_id, r.user_id, r.title, r.body, r.flagged, r.created_at,
               rt.rating
        FROM env_card_reviews r
        JOIN env_card_ratings rt ON rt.id = r.rating_id
        WHERE r.card_id = $1 AND r.flagged = FALSE
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3
        """,
        card_id,
        limit,
        offset,
    )
    return [dict(r) for r in rows]


async def moderation_queue(*, limit: int = 50) -> list[dict[str, Any]]:
    """List flagged reviews for the moderation UI (§5.5)."""
    client = await _client()
    rows = await client.fetch(
        """
        SELECT r.id, r.card_id, r.user_id, r.title, r.body, r.flag_reason,
               r.created_at, rt.rating
        FROM env_card_reviews r
        JOIN env_card_ratings rt ON rt.id = r.rating_id
        WHERE r.flagged = TRUE
        ORDER BY r.created_at ASC
        LIMIT $1
        """,
        limit,
    )
    return [dict(r) for r in rows]


async def flag_review(*, review_id: UUID, reason: str) -> bool:
    client = await _client()
    result = await client.execute(
        "UPDATE env_card_reviews SET flagged = TRUE, flag_reason = $1 WHERE id = $2",
        reason,
        review_id,
    )
    return result != "UPDATE 0"


async def moderate_review(*, review_id: UUID, moderator_id: UUID, approve: bool) -> bool:
    """Approve (un-flag) or hide (mark flagged) a review."""
    client = await _client()
    flagged = not approve
    result = await client.execute(
        """
        UPDATE env_card_reviews
        SET flagged = $1, moderated_by = $2, moderated_at = NOW()
        WHERE id = $3
        """,
        flagged,
        moderator_id,
        review_id,
    )
    return result != "UPDATE 0"


__all__ = [
    "Review",
    "flag_review",
    "list_reviews",
    "moderate_review",
    "moderation_queue",
    "submit_review",
]
