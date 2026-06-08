"""Environment Marketplace (closes §5 of the roadmap).

This package owns:

* :mod:`eden.marketplace.models` — Pydantic models for the API surface.
* :mod:`eden.marketplace.service` — DB-backed CRUD + lifecycle transitions.
* :mod:`eden.marketplace.search` — full-text + faceted search over env cards.
* :mod:`eden.marketplace.reviews` — ratings, reviews, and moderation queue
  (§5.5 + §5.6).

The HTTP surface is mounted at ``/marketplace`` from
:mod:`eden.api.routes.marketplace`. The schema lives in
``migrations/022_marketplace.sql``.
"""
from __future__ import annotations

from eden.marketplace.models import (
    EnvCard,
    EnvCardState,
    EnvCardSummary,
    ForkRequest,
    QualityBand,
    SubmitRequest,
)
from eden.marketplace.reviews import (
    Review,
    flag_review,
    list_reviews,
    moderate_review,
    moderation_queue,
    submit_review,
)
from eden.marketplace.search import search_cards
from eden.marketplace.service import (
    create_card,
    fork_card,
    get_card,
    list_featured,
    list_published,
    publish_card,
    retire_card,
    submit_card,
    update_card,
)

__all__ = [
    "EnvCard",
    "EnvCardState",
    "EnvCardSummary",
    "ForkRequest",
    "QualityBand",
    "Review",
    "SubmitRequest",
    "create_card",
    "flag_review",
    "fork_card",
    "get_card",
    "list_featured",
    "list_published",
    "list_reviews",
    "moderate_review",
    "moderation_queue",
    "publish_card",
    "retire_card",
    "search_cards",
    "submit_card",
    "submit_review",
    "update_card",
]
