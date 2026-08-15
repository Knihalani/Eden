"""FEAT-134: suppression-rule repo helpers."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_list_enabled_suppression_patterns_returns_enabled_only(
    mock_postgres_client: MagicMock,
) -> None:
    from eden.alerts import repo

    mock_postgres_client.fetch = AsyncMock(
        return_value=[
            {
                "pattern": r"tuesday.?batch",
                "reason": "Known noisy Tuesday job",
                "window_hours": 24,
            }
        ]
    )

    patterns = await repo.list_enabled_suppression_patterns("org-1")

    assert patterns == [
        {
            "pattern": r"tuesday.?batch",
            "reason": "Known noisy Tuesday job",
            "window_hours": 24,
        }
    ]
    mock_postgres_client.fetch.assert_awaited_once()
    assert "enabled = TRUE" in mock_postgres_client.fetch.await_args.args[0]


@pytest.mark.asyncio
async def test_create_suppression_rule_persists_and_returns_row(
    mock_postgres_client: MagicMock,
) -> None:
    from eden.alerts import repo

    mock_postgres_client._fetchrow_overrides.append(
        (
            "FROM alert_suppression_rules",
            {
                "id": "rule-1",
                "org_id": "org-1",
                "pattern": "batch",
                "reason": "nightly job",
                "window_hours": None,
                "enabled": True,
                "created_by_user_id": "user-1",
                "created_at": None,
                "updated_at": None,
            },
        )
    )

    created = await repo.create_suppression_rule(
        org_id="org-1",
        pattern="batch",
        reason="nightly job",
        created_by_user_id="user-1",
    )

    assert created["pattern"] == "batch"
    assert created["reason"] == "nightly job"
    mock_postgres_client.execute.assert_awaited_once()


def test_validate_suppression_pattern_rejects_empty() -> None:
    from eden.alerts.repo import validate_suppression_pattern

    assert validate_suppression_pattern("   ") == "Pattern is required"
