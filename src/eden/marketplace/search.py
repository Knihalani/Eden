"""Search over marketplace env cards.

Two strategies, both backed by the Postgres ``search_vector``
column added in migration 022:

* :func:`search_cards` — full-text + faceted query (the default
  for the public ``/marketplace`` page).
* :func:`semantic_search` — placeholder that hooks into the
  existing Qdrant collection when the env-card embedder is
  configured. Until that's wired up, this is a thin wrapper
  over :func:`search_cards`.
"""
from __future__ import annotations

import logging
from typing import Any

from eden.marketplace.models import EnvCardSummary, QualityBand
from eden.marketplace.service import _row_to_summary

logger = logging.getLogger(__name__)


async def search_cards(
    *,
    q: str | None = None,
    category: str | None = None,
    tag: str | None = None,
    quality_band: QualityBand | None = None,
    limit: int = 24,
    offset: int = 0,
) -> list[EnvCardSummary]:
    """Full-text + faceted search over published env cards.

    When ``q`` is empty/None, this is identical to
    :func:`eden.marketplace.service.list_published` (a
    filter-only browse). When ``q`` is set, we OR a
    ``to_tsquery`` clause into the WHERE.
    """
    from eden.storage.postgres import get_postgres_client
    client = await get_postgres_client()
    where = ["state = 'published'"]
    params: list[Any] = []
    if q:
        params.append(q)
        where.append(
            f"search_vector @@ plainto_tsquery('english', ${len(params)})"
        )
    if category:
        params.append(category)
        where.append(f"category = ${len(params)}")
    if tag:
        params.append(tag)
        where.append(f"${len(params)} = ANY(tags)")
    if quality_band is not None:
        score_filter = {
            QualityBand.HIGH: ">= 0.85",
            QualityBand.MEDIUM: ">= 0.6 AND < 0.85",
            QualityBand.LOW: "< 0.6",
        }[quality_band]
        where.append(f"quality_score {score_filter}")
    params.append(limit)
    params.append(offset)
    sql = f"""
        SELECT id, slug, title, summary, category, tags, quality_score,
               fork_count, install_count, is_featured, published_at
        FROM env_cards
        WHERE {' AND '.join(where)}
        ORDER BY
            CASE WHEN $1::text IS NULL THEN 0
                 ELSE ts_rank(search_vector, plainto_tsquery('english', $1::text))
            END DESC,
            is_featured DESC,
            published_at DESC NULLS LAST
        LIMIT ${len(params) - 1} OFFSET ${len(params)}
    """
    # The ORDER BY reference to $1 means we always need to bind it
    params.insert(0, q)
    rows = await client.fetch(sql, *params)
    return [_row_to_summary(dict(r)) for r in rows]


async def semantic_search(
    *,
    query_embedding: list[float],
    limit: int = 10,
) -> list[EnvCardSummary]:
    """Semantic search via Qdrant. Stub that returns [] until the
    embedder + collection are wired up. The function exists so the
    route layer can call a stable interface today and switch to a
    real implementation later without changing the API surface.
    """
    logger.debug("semantic_search called but no Qdrant collection is wired up yet")
    return []
