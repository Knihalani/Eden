"""Tests for ``eden_sdk.config``."""

from __future__ import annotations

import os

import pytest

import eden
from eden_sdk import config as config_mod


def test_default_config_loads_from_env(monkeypatch):
    monkeypatch.setenv("EDEN_ORG_ID", "env-org")
    monkeypatch.setenv("EDEN_API_KEY", "env-key")
    monkeypatch.setenv("EDEN_BASE_URL", "https://env.example")
    config_mod.reset_config()
    cfg = config_mod.get_config()
    assert cfg.org_id == "env-org"
    assert cfg.api_key == "env-key"
    assert cfg.base_url == "https://env.example"


def test_configure_overrides_env(monkeypatch):
    monkeypatch.setenv("EDEN_ORG_ID", "env-org")
    config_mod.reset_config()
    cfg = eden.configure(org_id="explicit-org", batch_size=99)
    assert cfg.org_id == "explicit-org"
    assert cfg.batch_size == 99
    # Other env-derived fields still load.
    assert cfg.project_id == "default"


def test_ingest_url_shape():
    eden.configure(org_id="abc", base_url="https://api.eden.dev")
    cfg = config_mod.get_config()
    assert cfg.ingest_url("openai") == "https://api.eden.dev/orgs/abc/ingest/openai"
    assert cfg.ingest_url("anthropic") == "https://api.eden.dev/orgs/abc/ingest/anthropic"


def test_auth_headers_match_deps_signature():
    eden.configure(org_id="abc", api_key="k", project_id="p")
    headers = config_mod.get_config().auth_headers()
    assert headers["X-Org-Id"] == "abc"
    assert headers["X-Org-Api-Key"] == "k"
    assert headers["X-Project-Id"] == "p"


def test_disabled_kit_short_circuits():
    eden.configure(disabled=True)
    cfg = config_mod.get_config()
    assert cfg.enabled is False


class TestGatewayHeaders:
    """The gateway_headers() helper is the documented entry-point
    for SDK users who want to point an OpenAI client at Eden's
    OpenAI-compatible proxy. These tests pin the header shape."""

    def test_returns_auth_headers_when_no_upstream(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(
            org_id="org-123",
            api_key="sk-eden",
            project_id="proj-1",
        )
        headers = cfg.gateway_headers()
        assert headers["X-Org-Id"] == "org-123"
        assert headers["X-Org-Api-Key"] == "sk-eden"
        assert headers["X-Project-Id"] == "proj-1"
        # No upstream headers when none provided.
        assert "X-Upstream-Base-Url" not in headers
        assert "X-Upstream-Api-Key" not in headers
        assert "X-Upstream-Provider" not in headers

    def test_includes_upstream_headers_when_provided(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="org-123", api_key="sk-eden")
        headers = cfg.gateway_headers(
            upstream_base_url="https://my-internal.example.com/v1",
            upstream_api_key="sk-internal",
            upstream_provider="openai",
        )
        assert headers["X-Upstream-Base-Url"] == "https://my-internal.example.com/v1"
        assert headers["X-Upstream-Api-Key"] == "sk-internal"
        assert headers["X-Upstream-Provider"] == "openai"
        # Eden auth still present so the gateway knows which org the
        # call belongs to.
        assert headers["X-Org-Api-Key"] == "sk-eden"

    def test_partial_upstream_keeps_defaults(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="org-123", api_key="sk-eden")
        headers = cfg.gateway_headers(upstream_provider="anthropic")
        # Only provider provided — no URL or key leaked.
        assert headers["X-Upstream-Provider"] == "anthropic"
        assert "X-Upstream-Base-Url" not in headers
        assert "X-Upstream-Api-Key" not in headers

    def test_pii_bypass_true(self):
        """``pii_bypass=True`` adds ``X-PII-Bypass: true`` so the
        gateway skips PII redaction for this request."""
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="org-123", api_key="sk-eden")
        headers = cfg.gateway_headers(pii_bypass=True)
        assert headers["X-PII-Bypass"] == "true"

    def test_pii_bypass_false_explicit(self):
        """``pii_bypass=False`` adds ``X-PII-Bypass: false`` so the
        caller can force redaction on even when the tenant policy
        is mode=off."""
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="org-123", api_key="sk-eden")
        headers = cfg.gateway_headers(pii_bypass=False)
        assert headers["X-PII-Bypass"] == "false"

    def test_pii_bypass_unset_omits_header(self):
        """Default (no pii_bypass argument) doesn't add the header —
        the gateway falls back to the tenant's configured policy."""
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="org-123", api_key="sk-eden")
        headers = cfg.gateway_headers()
        assert "X-PII-Bypass" not in headers


class TestGatewayURLField:
    """The ``gateway_url`` field on ``EdenConfig`` is the OpenAI-
    compatible gateway base URL. Defaults are derived from
    ``base_url``; explicit values win."""

    def test_default_uses_base_url_with_v1_suffix(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="o", api_key="k")
        assert cfg.gateway_url is None
        assert cfg.resolved_gateway_url() == "http://localhost:8000/v1"

    def test_explicit_gateway_url(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(
            org_id="o", api_key="k",
            gateway_url="https://gateway.eden.ai/v1",
        )
        assert cfg.resolved_gateway_url() == "https://gateway.eden.ai/v1"

    def test_base_url_without_trailing_v1(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(
            org_id="o", api_key="k",
            base_url="https://api.example.com",
        )
        assert cfg.resolved_gateway_url() == "https://api.example.com/v1"

    def test_base_url_already_has_v1(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(
            org_id="o", api_key="k",
            base_url="https://api.example.com/v1",
        )
        assert cfg.resolved_gateway_url() == "https://api.example.com/v1"
