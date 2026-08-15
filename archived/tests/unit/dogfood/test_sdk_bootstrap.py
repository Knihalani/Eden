"""Tests for dogfood SDK bootstrap (env-driven, no real network)."""

from __future__ import annotations

import eden.dogfood as dogfood


def test_bootstrap_skips_without_credentials(monkeypatch) -> None:
    monkeypatch.delenv("EDEN_API_KEY", raising=False)
    monkeypatch.delenv("EDEN_ORG_API_KEY", raising=False)
    monkeypatch.delenv("EDEN_ORG_ID", raising=False)
    monkeypatch.delenv("EDEN_DEFAULT_ORG", raising=False)
    dogfood._BOOTSTRAPPED = False
    assert dogfood.bootstrap_dogfood_sdk(force=True) is False


def test_bootstrap_skips_when_disabled(monkeypatch) -> None:
    monkeypatch.setenv("EDEN_API_KEY", "eden_api_key_test")
    monkeypatch.setenv("EDEN_ORG_ID", "org-test")
    monkeypatch.setenv("EDEN_DISABLED", "1")
    dogfood._BOOTSTRAPPED = False
    assert dogfood.bootstrap_dogfood_sdk(force=True) is False


def test_bootstrap_configures_when_sdk_present(monkeypatch) -> None:
    monkeypatch.setenv("EDEN_API_KEY", "eden_api_key_test")
    monkeypatch.setenv("EDEN_ORG_ID", "00000000-0000-4000-8000-000000000001")
    monkeypatch.setenv("EDEN_AGENT_ID", "eden-platform")
    monkeypatch.delenv("EDEN_DISABLED", raising=False)
    dogfood._BOOTSTRAPPED = False
    monkeypatch.setattr(dogfood, "_ensure_eden_sdk_on_path", lambda: None)

    calls: dict[str, object] = {}

    def _configure(**kwargs):
        calls["configure"] = kwargs
        return object()

    def _instrument(*args):
        calls["instrument"] = args

    import sys
    import types

    fake = types.ModuleType("eden_sdk")
    fake.__version__ = "test"
    fake.configure = _configure
    fake.instrument = _instrument
    monkeypatch.setitem(sys.modules, "eden_sdk", fake)
    assert dogfood.bootstrap_dogfood_sdk(force=True) is True
    assert calls["configure"]["org_id"] == "00000000-0000-4000-8000-000000000001"
    assert calls["configure"]["api_key"] == "eden_api_key_test"
    assert calls["configure"]["agent_id"] == "eden-platform"
    assert calls["instrument"] == ("openai", "anthropic")
    assert dogfood.dogfood_status()["bootstrapped"] is True
