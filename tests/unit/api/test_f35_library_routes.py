"""F35 — signal library enable/disable + backfill estimate routes (WP6)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from eden.api.routes import signals as signals_mod


def _user() -> dict:
    return {"id": "user-1", "user_id": "user-1", "sub": "user-1"}


@pytest.mark.asyncio
async def test_toggle_library_enable_returns_estimate() -> None:
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="UPDATE 1")
    pg.fetchrow = AsyncMock(return_value={"n": 42})

    with patch.object(
        signals_mod, "get_postgres_client", AsyncMock(return_value=pg)
    ):
        resp = await signals_mod.toggle_library_signal(
            body=signals_mod.LibraryToggleRequest(enabled=True),
            org_id="org-1",
            template_id="looping",
            user=_user(),
        )

    assert resp.template_id == "looping"
    assert resp.enabled is True
    assert resp.updated == 1
    assert resp.backfill_estimate == 42


@pytest.mark.asyncio
async def test_toggle_library_disable_skips_estimate() -> None:
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="UPDATE 1")
    pg.fetchrow = AsyncMock(return_value={"n": 99})

    with patch.object(
        signals_mod, "get_postgres_client", AsyncMock(return_value=pg)
    ):
        resp = await signals_mod.toggle_library_signal(
            body=signals_mod.LibraryToggleRequest(enabled=False),
            org_id="org-1",
            template_id="looping",
            user=_user(),
        )

    assert resp.enabled is False
    assert resp.backfill_estimate == 0


@pytest.mark.asyncio
async def test_toggle_unknown_template_404() -> None:
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="UPDATE 0")
    pg.fetchrow = AsyncMock(return_value={"n": 0})

    with patch.object(
        signals_mod, "get_postgres_client", AsyncMock(return_value=pg)
    ):
        with pytest.raises(HTTPException) as excinfo:
            await signals_mod.toggle_library_signal(
                body=signals_mod.LibraryToggleRequest(enabled=True),
                org_id="org-1",
                template_id="nope",
                user=_user(),
            )
    assert excinfo.value.status_code == 404


@pytest.mark.asyncio
async def test_backfill_estimate_route() -> None:
    pg = MagicMock()
    pg.fetchrow = AsyncMock(return_value={"n": 7})

    with patch.object(
        signals_mod, "get_postgres_client", AsyncMock(return_value=pg)
    ):
        resp = await signals_mod.library_backfill_estimate(
            org_id="org-1", user=_user()
        )
    assert resp.backfill_estimate == 7
    assert resp.window_days == signals_mod._BACKFILL_WINDOW_DAYS


@pytest.mark.asyncio
async def test_rows_affected_parsing() -> None:
    assert signals_mod._rows_affected("UPDATE 3") == 3
    assert signals_mod._rows_affected("UPDATE 0") == 0
    assert signals_mod._rows_affected(5) == 5
    assert signals_mod._rows_affected("garbage") == 0
