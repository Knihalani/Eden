"""Wave 3 (3.2/3.3) — per-agent detection threshold multiplier.

Pins: (a) confirm-heavy agents get <1.0 (more sensitive), (b)
dismiss-heavy agents get >1.0 (less sensitive), (c) neutral when too few
labels, (d) shadow-detector feedback counters feed the multiplier, (e)
the multiplier is TTL-cached, and (f) shadow feedback invalidates the
cache immediately (3.3).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest


class _PG:
    """Fake pg with programmable agent_issues + nl_signals rows."""

    def __init__(
        self,
        issue_counts: tuple[int, int] = (0, 0),
        shadow_counts: tuple[int, int] = (0, 0),
    ) -> None:
        self.issue_counts = issue_counts
        self.shadow_counts = shadow_counts
        self.queries: list[str] = []

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        self.queries.append(sql)
        if "FROM agent_issues" in sql:
            return {
                "confirms": self.issue_counts[0],
                "dismisses": self.issue_counts[1],
            }
        if "FROM nl_signals" in sql:
            return {
                "confirms": self.shadow_counts[0],
                "dismisses": self.shadow_counts[1],
            }
        return None


def _reset() -> None:
    from eden.issues import detection_settings as ds

    ds._clear_cache()


@pytest.mark.asyncio
async def test_dismiss_heavy_agent_gets_less_sensitive() -> None:
    _reset()
    # 12 dismissed issues, 2 confirmed → mostly false positives.
    pg = _PG(issue_counts=(2, 12))
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.issues.detection_settings import (
            resolve_agent_threshold_multiplier,
        )

        mult = await resolve_agent_threshold_multiplier("org1", "noisy-agent")
    assert mult == pytest.approx(1.5)


@pytest.mark.asyncio
async def test_confirm_heavy_agent_gets_more_sensitive() -> None:
    _reset()
    # 12 confirmed, 2 dismissed → real problems, detect more.
    pg = _PG(issue_counts=(12, 2))
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.issues.detection_settings import (
            resolve_agent_threshold_multiplier,
        )

        mult = await resolve_agent_threshold_multiplier("org1", "real-agent")
    assert mult == pytest.approx(0.7)


@pytest.mark.asyncio
async def test_too_few_labels_stays_neutral() -> None:
    _reset()
    pg = _PG(issue_counts=(1, 2))  # 3 labels < _AGENT_MIN_LABELS
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.issues.detection_settings import (
            resolve_agent_threshold_multiplier,
        )

        assert await resolve_agent_threshold_multiplier("org1", "new-agent") == 1.0


@pytest.mark.asyncio
async def test_none_agent_defaults_neutral_without_query() -> None:
    _reset()
    pg = _PG()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.issues.detection_settings import (
            resolve_agent_threshold_multiplier,
        )

        assert await resolve_agent_threshold_multiplier("org1", None) == 1.0
    assert pg.queries == []  # no DB read for a None agent


@pytest.mark.asyncio
async def test_shadow_detector_feedback_feeds_multiplier() -> None:
    """3.3: shadow-detector operator counters count toward the agent's
    threshold — a detector that keeps getting dismissed makes the agent
    less sensitive even with few agent_issues labels."""
    _reset()
    # 0 issue labels but 8 shadow dismisses → dismiss-heavy overall.
    pg = _PG(issue_counts=(0, 0), shadow_counts=(1, 8))
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.issues.detection_settings import (
            resolve_agent_threshold_multiplier,
        )

        mult = await resolve_agent_threshold_multiplier("org1", "shadow-noisy")
    assert mult == pytest.approx(1.5)


@pytest.mark.asyncio
async def test_multiplier_cached_then_invalidated_on_feedback() -> None:
    """3.3: record_shadow_feedback invalidates the cached multiplier so the
    next scan reflects the decision instead of the stale 30s cache."""
    _reset()
    pg = _PG(issue_counts=(2, 12))
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        from eden.issues.detection_settings import (
            resolve_agent_threshold_multiplier,
        )

        await resolve_agent_threshold_multiplier("org1", "noisy-agent")
        queries_before = len(pg.queries)

        # Cache hit: second call adds no queries.
        await resolve_agent_threshold_multiplier("org1", "noisy-agent")
        assert len(pg.queries) == queries_before

    # Feedback (a confirm) lands via record_shadow_feedback → invalidate.
    from eden.services.soft_issue_review import _invalidate_agent_multiplier

    _invalidate_agent_multiplier("org1", "noisy-agent")
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        await resolve_agent_threshold_multiplier("org1", "noisy-agent")
        # Re-queried after invalidation.
        assert len(pg.queries) > queries_before
