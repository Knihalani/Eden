"""Gateway overview single-scan ledger helpers."""

from __future__ import annotations

import inspect

import pytest


def test_gateway_ledger_overview_is_exported() -> None:
    from eden.llmops import cost_ledger

    assert callable(cost_ledger.gateway_ledger_overview)
    assert callable(cost_ledger.explorer_summary)


def test_gateway_analytics_router_path() -> None:
    from eden.api.routes.gateway_analytics import router

    paths = {getattr(r, "path", "") for r in router.routes}
    assert "/overview" in paths or any(
        str(getattr(r, "path", "")).endswith("/overview") for r in router.routes
    )


@pytest.mark.asyncio
async def test_gateway_ledger_overview_empty_without_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from eden.llmops import cost_ledger

    async def _none() -> None:
        return None

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client",
        _none,
    )
    out = await cost_ledger.gateway_ledger_overview("org_test", window_hours=24)
    assert out["total_cost_usd"] == 0.0
    assert out["by_model"] == []
    assert out["total_tokens"] == 0


def test_gateway_ledger_sql_is_single_scan() -> None:
    """Source must use one CTE window over customer_cost_events."""
    from eden.llmops import cost_ledger

    src = inspect.getsource(cost_ledger.gateway_ledger_overview)
    assert "WITH bounds AS" in src
    assert "windowed AS" in src
    assert src.count("FROM customer_cost_events") <= 3
