"""LP-13 — Signals route resilience.

The live Vercel 5xx spike was dominated by ``GET .../signals`` throwing
uncaught DB errors (missing ``nl_signals`` / transient Postgres). These
tests lock the defensive contract:

* list → empty list when the relation is missing
* list → 503 (not 500) on other DB failures
* create → 503 when storage is unavailable
* malformed rows are skipped, not fatal
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from eden.api.routes import signals as signals_mod


def _user() -> dict:
    return {"id": "user-1", "user_id": "user-1", "sub": "user-1"}


class _MissingTableError(Exception):
    sqlstate = "42P01"

    def __str__(self) -> str:
        return 'relation "nl_signals" does not exist'


@pytest.mark.asyncio
async def test_list_signals_missing_table_returns_empty() -> None:
    pg = MagicMock()
    pg.fetch = AsyncMock(side_effect=_MissingTableError())

    with patch.object(signals_mod, "get_postgres_client", AsyncMock(return_value=pg)):
        result = await signals_mod.list_signals(org_id="org-1", user=_user())

    assert result.signals == []


@pytest.mark.asyncio
async def test_list_signals_db_error_returns_503_not_500() -> None:
    pg = MagicMock()
    pg.fetch = AsyncMock(side_effect=RuntimeError("connection reset"))

    with patch.object(signals_mod, "get_postgres_client", AsyncMock(return_value=pg)):
        with pytest.raises(HTTPException) as excinfo:
            await signals_mod.list_signals(org_id="org-1", user=_user())

    assert excinfo.value.status_code == 503
    assert "Signals unavailable" in str(excinfo.value.detail)


@pytest.mark.asyncio
async def test_list_signals_skips_malformed_rows() -> None:
    good = {
        "id": "s1",
        "org_id": "org-1",
        "description": "refusal rate above 5%",
        "rule": {
            "metric": "refusal_rate",
            "op": ">",
            "threshold": 0.05,
            "window_hours": 24,
            "scope": {},
            "keywords": ["refusal"],
        },
        "enabled": True,
        "created_by": None,
        "cluster_id": "c1",
        "match_count": 2,
        "created_at": "2026-07-01T00:00:00Z",
        "updated_at": "2026-07-01T00:00:00Z",
    }
    # Broken rule payload must not abort the whole list.
    bad = {
        "id": "s2",
        "org_id": "org-1",
        "description": "broken",
        "rule": "not-json{{{",
        "enabled": True,
        "created_by": None,
        "cluster_id": None,
        "match_count": 0,
        "created_at": "2026-07-01T00:00:00Z",
        "updated_at": "2026-07-01T00:00:00Z",
    }
    pg = MagicMock()
    pg.fetch = AsyncMock(return_value=[good, bad])

    with patch.object(signals_mod, "get_postgres_client", AsyncMock(return_value=pg)):
        result = await signals_mod.list_signals(org_id="org-1", user=_user())

    assert len(result.signals) == 2
    assert result.signals[0].id == "s1"
    assert result.signals[0].match_count == 2
    assert result.signals[1].id == "s2"
    assert result.signals[1].rule.metric == "custom"


@pytest.mark.asyncio
async def test_create_signal_missing_table_returns_503() -> None:
    pg = MagicMock()
    pg.execute = AsyncMock(side_effect=_MissingTableError())

    with patch.object(signals_mod, "get_postgres_client", AsyncMock(return_value=pg)):
        with pytest.raises(HTTPException) as excinfo:
            await signals_mod.create_signal(
                body=signals_mod.CreateSignalRequest(
                    description="refusal rate above 5%",
                ),
                org_id="org-1",
                user=_user(),
            )

    assert excinfo.value.status_code == 503
    assert "nl_signals" in str(excinfo.value.detail).lower() or "unavailable" in str(
        excinfo.value.detail
    ).lower()


@pytest.mark.asyncio
async def test_seed_defaults_missing_table_returns_503() -> None:
    with patch(
        "eden.signals.defaults.seed_org_signals",
        AsyncMock(side_effect=_MissingTableError()),
    ):
        with pytest.raises(HTTPException) as excinfo:
            await signals_mod.seed_default_signals(
                body=signals_mod.SeedDefaultsRequest(profile="minimal"),
                org_id="org-1",
                user=_user(),
            )
    assert excinfo.value.status_code == 503


@pytest.mark.asyncio
async def test_seed_defaults_success() -> None:
    from eden.signals.defaults import SeedResult

    with patch(
        "eden.signals.defaults.seed_org_signals",
        AsyncMock(return_value=SeedResult(count=2, skipped=0, profile="minimal", signal_ids=["a", "b"])),
    ):
        res = await signals_mod.seed_default_signals(
            body=signals_mod.SeedDefaultsRequest(profile="minimal"),
            org_id="org-1",
            user=_user(),
        )
    assert res.count == 2
    assert res.signal_ids == ["a", "b"]


def test_is_missing_relation_detects_sqlstate() -> None:
    assert signals_mod._is_missing_relation(_MissingTableError()) is True
    assert signals_mod._is_missing_relation(RuntimeError("boom")) is False
    assert signals_mod._is_missing_relation(
        SimpleNamespace(sqlstate="42P01", __str__=lambda self: "x")
    ) is True
