"""Pydantic models for the marketplace API surface."""
from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class EnvCardState(StrEnum):
    """Lifecycle states for an env card.

    See ``migrations/022_marketplace.sql`` for the canonical
    constraint; the enum here is the API-side mirror.
    """

    DRAFT = "draft"
    SUBMITTED = "submitted"
    IN_REVIEW = "in_review"
    PUBLISHED = "published"
    ARCHIVED = "archived"
    RETIRED = "retired"


class QualityBand(StrEnum):
    """Quality bands used in listings + filters."""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


def _band_from_score(score: float | None) -> QualityBand:
    if score is None:
        return QualityBand.LOW
    if score >= 0.85:
        return QualityBand.HIGH
    if score >= 0.6:
        return QualityBand.MEDIUM
    return QualityBand.LOW


class EnvCard(BaseModel):
    """Public-facing env card."""

    id: UUID
    org_id: UUID
    author_id: UUID
    spec_id: UUID
    parent_card_id: UUID | None = None
    slug: str
    title: str
    summary: str
    description: str | None = None
    category: str
    tags: list[str] = Field(default_factory=list)
    quality_score: float | None = None
    quality_band: QualityBand | None = None
    outcome_tier: str | None = None
    test_pass_rate: float | None = None
    mutation_score: float | None = None
    state: EnvCardState
    published_at: datetime | None = None
    submitted_at: datetime | None = None
    is_featured: bool = False
    license: str = "mit"
    homepage_url: str | None = None
    repository_url: str | None = None
    fork_count: int = 0
    view_count: int = 0
    install_count: int = 0
    created_at: datetime
    updated_at: datetime

    @field_validator("tags", mode="before")
    @classmethod
    def _ensure_list(cls, v: Any) -> list[str]:
        return list(v or [])


class EnvCardSummary(BaseModel):
    """Listing-shaped projection (used in search results / featured rows)."""

    id: UUID
    slug: str
    title: str
    summary: str
    category: str
    tags: list[str] = Field(default_factory=list)
    quality_score: float | None = None
    quality_band: QualityBand | None = None
    fork_count: int = 0
    install_count: int = 0
    is_featured: bool = False
    published_at: datetime | None = None


class SubmitRequest(BaseModel):
    """Request to create a draft card and (optionally) submit it for review."""

    spec_id: UUID
    slug: str = Field(min_length=3, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    title: str = Field(min_length=3, max_length=120)
    summary: str = Field(min_length=10, max_length=400)
    description: str | None = None
    category: str = Field(min_length=2, max_length=40)
    tags: list[str] = Field(default_factory=list, max_length=20)
    license: str = "mit"
    homepage_url: str | None = None
    repository_url: str | None = None
    submit_for_review: bool = False


class ForkRequest(BaseModel):
    """Request to fork a published env into a new draft owned by the caller."""

    slug: str = Field(min_length=3, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")
    title: str | None = Field(default=None, max_length=120)
    summary: str | None = Field(default=None, max_length=400)
