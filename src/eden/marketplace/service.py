"""Marketplace service — DB-backed CRUD + lifecycle.

This is the backend for the §5 marketplace items. The route
layer (see :mod:`eden.api.routes.marketplace`) is a thin
adapter over these functions.

State machine
-------------

    draft  --submit-->  submitted  --review-->  in_review
                                                      |
                                                  publish
                                                      v
                                                  published
                                                      |
                                       fork (creates new draft)
                                                      |
                                          archive / retire
"""
from __future__ import annotations

import logging
import re
from typing import Any
from uuid import UUID, uuid4

from eden.marketplace.models import (
    EnvCard,
    EnvCardState,
    EnvCardSummary,
    ForkRequest,
    QualityBand,
    SubmitRequest,
)

logger = logging.getLogger(__name__)


# ────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────


def _band_from_score(score: float | None) -> QualityBand | None:
    if score is None:
        return None
    if score >= 0.85:
        return QualityBand.HIGH
    if score >= 0.6:
        return QualityBand.MEDIUM
    return QualityBand.LOW


def _row_to_card(row: dict[str, Any]) -> EnvCard:
    score = row.get("quality_score")
    return EnvCard(
        id=row["id"],
        org_id=row["org_id"],
        author_id=row["author_id"],
        spec_id=row["spec_id"],
        parent_card_id=row.get("parent_card_id"),
        slug=row["slug"],
        title=row["title"],
        summary=row["summary"],
        description=row.get("description"),
        category=row["category"],
        tags=row.get("tags") or [],
        quality_score=float(score) if score is not None else None,
        quality_band=_band_from_score(float(score) if score is not None else None),
        outcome_tier=row.get("outcome_tier"),
        test_pass_rate=float(row["test_pass_rate"]) if row.get("test_pass_rate") is not None else None,
        mutation_score=float(row["mutation_score"]) if row.get("mutation_score") is not None else None,
        state=EnvCardState(row["state"]),
        published_at=row.get("published_at"),
        submitted_at=row.get("submitted_at"),
        is_featured=bool(row.get("is_featured")),
        license=row.get("license", "mit"),
        homepage_url=row.get("homepage_url"),
        repository_url=row.get("repository_url"),
        fork_count=int(row.get("fork_count") or 0),
        view_count=int(row.get("view_count") or 0),
        install_count=int(row.get("install_count") or 0),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def _row_to_summary(row: dict[str, Any]) -> EnvCardSummary:
    score = row.get("quality_score")
    return EnvCardSummary(
        id=row["id"],
        slug=row["slug"],
        title=row["title"],
        summary=row["summary"],
        category=row["category"],
        tags=row.get("tags") or [],
        quality_score=float(score) if score is not None else None,
        quality_band=_band_from_score(float(score) if score is not None else None),
        fork_count=int(row.get("fork_count") or 0),
        install_count=int(row.get("install_count") or 0),
        is_featured=bool(row.get("is_featured")),
        published_at=row.get("published_at"),
    )


async def _client() -> Any:
    from eden.storage.postgres import get_postgres_client
    return await get_postgres_client()


# ────────────────────────────────────────────────────────────────────────
# Public API
# ────────────────────────────────────────────────────────────────────────


async def create_card(
    *,
    org_id: UUID,
    author_id: UUID,
    req: SubmitRequest,
) -> EnvCard:
    """Create a draft card. Optionally submits for review in one call."""
    client = await _client()
    initial_state = EnvCardState.SUBMITTED if req.submit_for_review else EnvCardState.DRAFT
    row = await client.fetchrow(
        """
        INSERT INTO env_cards (
            org_id, author_id, spec_id, slug, title, summary, description,
            category, tags, license, homepage_url, repository_url, state,
            submitted_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                CASE WHEN $13 = 'submitted' THEN NOW() ELSE NULL END)
        RETURNING *
        """,
        org_id,
        author_id,
        req.spec_id,
        req.slug,
        req.title,
        req.summary,
        req.description,
        req.category,
        req.tags,
        req.license,
        req.homepage_url,
        req.repository_url,
        initial_state.value,
    )
    return _row_to_card(dict(row))


async def get_card(card_id: UUID) -> EnvCard | None:
    client = await _client()
    row = await client.fetchrow("SELECT * FROM env_cards WHERE id = $1", card_id)
    if not row:
        return None
    return _row_to_card(dict(row))


async def update_card(card_id: UUID, *, patch: dict[str, Any]) -> EnvCard | None:
    """Apply a partial update. Only allowed on draft / archived cards."""
    if not patch:
        return await get_card(card_id)
    client = await _client()
    # Whitelist updatable columns
    allowed = {"title", "summary", "description", "category", "tags", "license", "homepage_url", "repository_url"}
    safe = {k: v for k, v in patch.items() if k in allowed}
    if not safe:
        return await get_card(card_id)
    set_clauses = [f"{col} = ${i + 2}" for i, col in enumerate(safe.keys())]
    sql = f"UPDATE env_cards SET {', '.join(set_clauses)} WHERE id = $1 AND state IN ('draft', 'archived') RETURNING *"
    row = await client.fetchrow(sql, card_id, *safe.values())
    if not row:
        return None
    return _row_to_card(dict(row))


async def submit_card(card_id: UUID) -> EnvCard | None:
    client = await _client()
    row = await client.fetchrow(
        """
        UPDATE env_cards
        SET state = 'submitted', submitted_at = NOW()
        WHERE id = $1 AND state = 'draft'
        RETURNING *
        """,
        card_id,
    )
    return _row_to_card(dict(row)) if row else None


async def publish_card(card_id: UUID) -> EnvCard | None:
    client = await _client()
    row = await client.fetchrow(
        """
        UPDATE env_cards
        SET state = 'published', published_at = NOW()
        WHERE id = $1 AND state IN ('submitted', 'in_review')
        RETURNING *
        """,
        card_id,
    )
    return _row_to_card(dict(row)) if row else None


async def retire_card(card_id: UUID) -> EnvCard | None:
    client = await _client()
    row = await client.fetchrow(
        """
        UPDATE env_cards
        SET state = 'retired', retired_at = NOW()
        WHERE id = $1
        RETURNING *
        """,
        card_id,
    )
    return _row_to_card(dict(row)) if row else None


async def fork_card(
    *,
    parent_card_id: UUID,
    new_org_id: UUID,
    new_author_id: UUID,
    req: ForkRequest,
) -> EnvCard | None:
    """Create a new draft card that is a fork of ``parent_card_id``."""
    client = await _client()
    parent = await client.fetchrow("SELECT * FROM env_cards WHERE id = $1", parent_card_id)
    if not parent or parent["state"] != EnvCardState.PUBLISHED.value:
        return None
    new_card_id = uuid4()
    new_slug = req.slug
    new_title = req.title or f"{parent['title']} (fork)"
    new_summary = req.summary or parent["summary"]
    row = await client.fetchrow(
        """
        INSERT INTO env_cards (
            id, org_id, author_id, spec_id, parent_card_id,
            slug, title, summary, description, category, tags,
            license, homepage_url, repository_url, state
        )
        VALUES ($1, $2, $3, $4, $5,
                $6, $7, $8, $9, $10, $11,
                $12, $13, $14, 'draft')
        RETURNING *
        """,
        new_card_id,
        new_org_id,
        new_author_id,
        parent["spec_id"],
        parent_card_id,
        new_slug,
        new_title,
        new_summary,
        parent.get("description"),
        parent["category"],
        parent.get("tags") or [],
        parent.get("license", "mit"),
        parent.get("homepage_url"),
        parent.get("repository_url"),
    )
    return _row_to_card(dict(row))


async def list_published(
    *,
    category: str | None = None,
    tag: str | None = None,
    quality_band: QualityBand | None = None,
    limit: int = 24,
    offset: int = 0,
) -> list[EnvCardSummary]:
    """List published env cards with optional filters."""
    client = await _client()
    where = ["state = 'published'"]
    params: list[Any] = []
    if category:
        params.append(category)
        where.append(f"category = ${len(params)}")
    if tag:
        params.append(tag)
        where.append(f"${len(params)} = ANY(tags)")
    if quality_band is not None:
        score_filter = {QualityBand.HIGH: ">= 0.85", QualityBand.MEDIUM: ">= 0.6 AND < 0.85", QualityBand.LOW: "< 0.6"}[quality_band]
        where.append(f"quality_score {score_filter}")
    params.append(limit)
    params.append(offset)
    sql = f"""
        SELECT id, slug, title, summary, category, tags, quality_score,
               fork_count, install_count, is_featured, published_at
        FROM env_cards
        WHERE {' AND '.join(where)}
        ORDER BY is_featured DESC, published_at DESC NULLS LAST
        LIMIT ${len(params) - 1} OFFSET ${len(params)}
    """
    rows = await client.fetch(sql, *params)
    return [_row_to_summary(dict(r)) for r in rows]


async def list_featured(*, limit: int = 6) -> list[EnvCardSummary]:
    client = await _client()
    rows = await client.fetch(
        """
        SELECT id, slug, title, summary, category, tags, quality_score,
               fork_count, install_count, is_featured, published_at
        FROM env_cards
        WHERE state = 'published' AND is_featured = TRUE
        ORDER BY published_at DESC NULLS LAST
        LIMIT $1
        """,
        limit,
    )
    return [_row_to_summary(dict(r)) for r in rows]


# Slug validation: lower-case, digits, dashes only.
SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
