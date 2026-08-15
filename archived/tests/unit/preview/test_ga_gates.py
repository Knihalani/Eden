"""Unit tests for Artifacts/Ledger GA gates."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from eden.preview import gates


@pytest.fixture(autouse=True)
def _clear_flag_cache():
    gates._ORG_FLAG_CACHE.clear()
    yield
    gates._ORG_FLAG_CACHE.clear()


def _stub_features(payload: dict[str, Any]) -> Callable[[str], Awaitable[dict[str, Any]]]:
    async def _load(_org_id: str) -> dict[str, Any]:
        return payload

    return _load


@pytest.mark.asyncio
async def test_artifacts_enabled_missing_org_flag_defaults_on(monkeypatch):
    monkeypatch.setattr(gates, "_load_org_features", _stub_features({}))
    assert await gates.artifacts_enabled("org_x") is True


@pytest.mark.asyncio
async def test_ledger_enabled_missing_org_flag_defaults_on(monkeypatch):
    monkeypatch.setattr(gates, "_load_org_features", _stub_features({}))
    assert await gates.ledger_enabled("org_x") is True


@pytest.mark.asyncio
async def test_artifacts_explicit_org_false_kills(monkeypatch):
    monkeypatch.setattr(
        gates, "_load_org_features", _stub_features({"artifacts_v1": False})
    )
    assert await gates.artifacts_enabled("org_x") is False


@pytest.mark.asyncio
async def test_ledger_explicit_org_false_kills(monkeypatch):
    monkeypatch.setattr(
        gates, "_load_org_features", _stub_features({"ledger_v1": False})
    )
    assert await gates.ledger_enabled("org_x") is False


def test_artifacts_enabled_sync_defaults_on_without_cache():
    assert gates.artifacts_enabled_sync("org_uncached") is True


def test_ledger_enabled_sync_respects_cache_false():
    gates._ORG_FLAG_CACHE[("org_y", "ledger_v1")] = False
    assert gates.ledger_enabled_sync("org_y") is False


def test_preview_disabled_envelope_no_opt_in_copy():
    env = gates.preview_disabled_envelope("artifacts")
    msg = env["data"]["message"]
    assert "preview-only" not in msg.lower()
    assert "enable artifacts_v1" not in msg.lower()
    assert "disabled" in msg.lower()


def test_org_flag_ga_missing_true_preview_missing_false():
    assert gates._org_flag({}, "artifacts_v1") is True
    assert gates._org_flag({}, "ledger_v1") is True
    assert gates._org_flag({}, "artifacts_inrun_v1") is False
    assert gates._org_flag({"artifacts_v1": False}, "artifacts_v1") is False
