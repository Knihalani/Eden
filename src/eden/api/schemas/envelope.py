"""Standard API response envelope for Eden Public API v1.

All v1 endpoints return a consistent envelope shape:

    {
        "data": <payload>,
        "meta": {
            "api_version": "2025-05-30",
            "request_id": "uuid",
            "timestamp": "2026-05-30T12:34:56Z",
            "total": 42,          # paginated lists only
            "page": 1,            # paginated lists only
            "per_page": 20,       # paginated lists only
        }
    }

The envelope is applied automatically by the APIVersionMiddleware
for all routes under /v1/.
"""

from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field


class APIMeta(BaseModel):
    """Base metadata included in every API response."""

    api_version: str = Field(..., description="Date-based API version")
    request_id: str = Field(..., description="Correlation ID for request tracing")
    timestamp: str = Field(..., description="ISO 8601 timestamp of response generation")


class PaginatedMeta(APIMeta):
    """Metadata for paginated list responses."""

    total: int = Field(..., description="Total number of items available")
    page: int = Field(..., description="Current page number (1-indexed)")
    per_page: int = Field(..., description="Number of items per page")


class APIEnvelope(BaseModel):
    """Standard API response envelope.

    Wraps any payload in a consistent envelope with metadata.
    Use `PaginatedAPIEnvelope` for list responses that include pagination.
    """

    data: dict = Field(..., description="Response payload")
    meta: APIMeta = Field(..., description="Response metadata")

    @classmethod
    def wrap(
        cls,
        data: dict,
        api_version: str,
        request_id: str,
    ) -> "APIEnvelope":
        """Wrap data in a standard envelope."""
        return cls(
            data=data,
            meta=APIMeta(
                api_version=api_version,
                request_id=request_id,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ),
        )


class PaginatedAPIEnvelope(BaseModel):
    """Paginated API response envelope for list endpoints."""

    data: list[dict] = Field(..., description="List of response items")
    meta: PaginatedMeta = Field(..., description="Response metadata with pagination")

    @classmethod
    def wrap(
        cls,
        data: list[dict],
        api_version: str,
        request_id: str,
        total: int,
        page: int,
        per_page: int,
    ) -> "PaginatedAPIEnvelope":
        """Wrap list data in a paginated envelope."""
        return cls(
            data=data,
            meta=PaginatedMeta(
                api_version=api_version,
                request_id=request_id,
                timestamp=datetime.now(timezone.utc).isoformat(),
                total=total,
                page=page,
                per_page=per_page,
            ),
        )


class ErrorEnvelope(BaseModel):
    """Standard API error envelope."""

    detail: str
    meta: APIMeta

    @classmethod
    def wrap(
        cls,
        detail: str,
        api_version: str,
        request_id: str,
    ) -> "ErrorEnvelope":
        """Wrap an error in a standard envelope."""
        return cls(
            detail=detail,
            meta=APIMeta(
                api_version=api_version,
                request_id=request_id,
                timestamp=datetime.now(timezone.utc).isoformat(),
            ),
        )
