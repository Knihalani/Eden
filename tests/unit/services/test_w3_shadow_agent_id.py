"""Wave 3 (3.1/3.3) — nl_signals.agent_id column + shadow feedback.

Pins: (a) ``_create_shadow_detector`` writes the queryable agent_id
column (not just the ``[auto:]`` description prefix), (b) the weekly
promote sweep selects + reports agent_id, (c) ``record_shadow_feedback``
invalidates the per-agent threshold cache, and (d) the agent_id backfill
regex from migration 168 extracts the agent from the legacy prefix.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest


class _ShadowPG:
    def __init__(self) -> None:
        self.executes: list[tuple[str, tuple[Any, ...]]] = []
        self.rows: list[dict[str, Any]] = []

    async def fetchval(self, sql: str, *args: Any) -> Any:
        return None  # never a dupe

    async def execute(self, sql: str, *args: Any) -> str:
        self.executes.append((sql, args))
        return "OK"

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        # RETURNING row from record_shadow_feedback
        if "RETURNING" in sql and "nl_signals" in sql:
            return {
                "id": "sig-1",
                "org_id": "org1",
                "description": "[auto:checkout-agent] some pattern",
                "rule": {},
                "match_count": 5,
                "cluster_id": "auto:abc",
                "enabled": False,
                "agent_id": "checkout-agent",
            }
        return None

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        return self.rows


@pytest.mark.asyncio
async def test_create_shadow_detector_writes_agent_id_column() -> None:
    from eden.services.soft_issue_review import SoftIssueReviewer

    pg = _ShadowPG()
    reviewer = SoftIssueReviewer()

    class _Rule:
        def to_dict(self) -> dict[str, Any]:
            return {"match": "all"}

    with patch(
        "eden.services.cat2_intel.signals.compile_signal", return_value=_Rule()
    ), patch(
        "eden.services.cat2_intel.signals.signal_signature", return_value="sig123"
    ), patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        made = await reviewer._create_shadow_detector(
            pg, "org1", "checkout-agent", "agent re-asks for info"
        )
    assert made is True
    assert len(pg.executes) == 1
    sql, args = pg.executes[0]
    assert "INSERT INTO nl_signals" in sql
    assert "agent_id" in sql  # column written
    # args: id, org_id, description, rule, cluster_id, agent_id
    # (enabled=FALSE and created_by=NULL are inlined in the SQL).
    assert args[4] == "auto:sig123"  # cluster_id
    assert args[5] == "checkout-agent"  # agent_id column value
    assert "[auto:checkout-agent]" in args[2]  # prefix preserved


@pytest.mark.asyncio
async def test_promote_job_selects_and_reports_agent_id() -> None:
    from eden.services.soft_issue_review import SoftIssueReviewer

    pg = _ShadowPG()
    # One shadow detector, no operator labels, too young to delete → hold.
    pg.rows = [
        {
            "id": "sig-1",
            "org_id": "org1",
            "description": "[auto:planner] loops on tool call",
            "rule": {},
            "match_count": 3,
            "cluster_id": "auto:xyz",
            "created_at": None,
            "updated_at": None,
            "agent_id": "planner",
        }
    ]
    reviewer = SoftIssueReviewer()

    with patch(
        "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)
    ):
        out = await reviewer.promote_shadow_detectors(
            dry_run=True  # avoids DB writes; still runs evaluate
        )
    assert out["inspected"] == 1
    assert out["details"][0]["agent_id"] == "planner"


@pytest.mark.asyncio
async def test_record_shadow_feedback_invalidates_agent_cache() -> None:
    """3.3: operator confirm/dismiss on a shadow detector drops the cached
    per-agent threshold multiplier immediately."""
    from eden.issues import detection_settings as ds
    from eden.services.soft_issue_review import record_shadow_feedback

    ds._clear_cache()
    # Prime the cache with a known value.
    ds._agent_cache["org1"] = {"checkout-agent": (999999.0, 1.5)}
    pg = _ShadowPG()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        ok = await record_shadow_feedback("org1", "sig-1", confirm=True)
    assert ok is True
    assert "checkout-agent" not in ds._agent_cache.get("org1", {})


def test_agent_id_backfill_regex() -> None:
    """3.1: the migration 168 backfill regex extracts the agent from the
    legacy ``[auto:{agent}]`` description prefix."""
    import re

    pattern = r"^\[auto:([^\]]+)\].*$"

    assert re.sub(pattern, r"\1", "[auto:checkout-agent] re-asks for info") == (
        "checkout-agent"
    )
    assert re.sub(pattern, r"\1", "[auto:planner-7] loops") == "planner-7"
    # Non-auto descriptions are untouched by the WHERE clause.
    assert not re.match(pattern, "manual signal description")
