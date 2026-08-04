"""F12 tail-latency guard: SearchService must emit ``search_cutoff_ms``.

Regression coverage for the 1.1M-doc F12 tuning finding: adding Typesense's
``search_cutoff_ms`` param pulls keyword-search p95 from ~555ms to ~164ms
(< the 200ms GA gate) by returning best-ranked-so-far results once a query
exceeds the budget. These tests assert the param is actually emitted from the
production search path, is driven by the ``typesense_search_cutoff_ms``
setting, and is omitted when the cap is disabled (``0``).
"""

from __future__ import annotations

import types
from typing import Any

import pytest

from eden.observability.search_service import SearchService


class _CapturingClient:
    """Minimal stand-in for TypesenseClient that records the search params."""

    _schema_ready = True
    _collection = "eden_spans"

    def __init__(self) -> None:
        self.last_params: dict[str, Any] | None = None

    async def ensure_collection(self) -> None:  # pragma: no cover - not hit
        pass

    async def _request(self, method: str, path: str, params: dict[str, Any] | None = None):
        if "search" in path:
            self.last_params = dict(params or {})
        return 200, {"hits": [], "found": 0, "facet_counts": []}


def _patch_setting(monkeypatch: pytest.MonkeyPatch, value: int | None) -> None:
    """Point get_settings() at a namespace carrying (only) the cutoff attr."""
    attrs: dict[str, Any] = {"typesense_search_v1": True}
    if value is not None:
        attrs["typesense_search_cutoff_ms"] = value
    fake = types.SimpleNamespace(**attrs)
    import eden.config as cfg

    monkeypatch.setattr(cfg, "get_settings", lambda: fake, raising=True)


@pytest.mark.asyncio
async def test_search_emits_cutoff_from_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_setting(monkeypatch, 150)
    client = _CapturingClient()
    svc = SearchService(client=client)

    await svc.search(tenant_id="bench-org", query="latency", per_page=20)

    assert client.last_params is not None
    assert client.last_params.get("search_cutoff_ms") == 150


@pytest.mark.asyncio
async def test_search_cutoff_disabled_when_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_setting(monkeypatch, 0)
    client = _CapturingClient()
    svc = SearchService(client=client)

    await svc.search(tenant_id="bench-org", query="latency", per_page=20)

    assert client.last_params is not None
    assert "search_cutoff_ms" not in client.last_params


@pytest.mark.asyncio
async def test_search_cutoff_defaults_when_setting_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Setting missing entirely -> code falls back to the 150ms default.
    _patch_setting(monkeypatch, None)
    client = _CapturingClient()
    svc = SearchService(client=client)

    await svc.search(tenant_id="bench-org", query="latency", per_page=20)

    assert client.last_params is not None
    assert client.last_params.get("search_cutoff_ms") == 150
