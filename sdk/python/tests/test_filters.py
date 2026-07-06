"""Tests for the per-filter SDK configuration.

Covers:
  * PIIConfig validation + header rendering
  * FilterConfig dispatching to per-filter headers
  * EdenConfig.filters field + gateway_headers integration
  * resolved_gateway_url helper
"""

from __future__ import annotations

import pytest

from eden_sdk.config import EdenConfig
from eden_sdk.filters import FILTER_NAMES, FilterConfig, PIIConfig


class TestPIIConfig:
    def test_defaults(self):
        c = PIIConfig()
        assert c.mode == "redact"
        assert c.disabled_categories == []
        assert c.bypass is False

    def test_invalid_mode_raises(self):
        with pytest.raises(ValueError):
            PIIConfig(mode="bogus")

    def test_all_modes_accepted(self):
        for mode in ("off", "redact", "fail_closed"):
            assert PIIConfig(mode=mode).mode == mode

    def test_to_headers_minimal(self):
        """Default config emits just ``X-PII-Mode`` (no bypass,
        no disabled categories)."""
        h = PIIConfig().to_headers()
        assert h == {"X-PII-Mode": "redact"}

    def test_to_headers_with_bypass(self):
        h = PIIConfig(mode="redact", bypass=True).to_headers()
        assert h["X-PII-Bypass"] == "true"
        assert h["X-PII-Mode"] == "redact"

    def test_to_headers_with_disabled_categories(self):
        h = PIIConfig(
            mode="redact",
            disabled_categories=["api_key", "url_with_creds"],
        ).to_headers()
        assert h["X-PII-Disabled-Categories"] == "api_key,url_with_creds"

    def test_to_headers_full(self):
        h = PIIConfig(
            mode="fail_closed",
            bypass=True,
            disabled_categories=["ssn"],
        ).to_headers()
        assert h["X-PII-Mode"] == "fail_closed"
        assert h["X-PII-Bypass"] == "true"
        assert h["X-PII-Disabled-Categories"] == "ssn"

    def test_to_headers_off_mode_still_emits_header(self):
        """``mode='off'`` must still emit ``X-PII-Mode`` so the
        gateway can distinguish 'tenant policy is off' from 'no
        header at all'."""
        h = PIIConfig(mode="off").to_headers()
        assert h["X-PII-Mode"] == "off"


class TestFilterConfig:
    def test_empty_emits_nothing(self):
        assert FilterConfig().to_headers() == {}

    def test_only_pii_routed(self):
        h = FilterConfig(pii=PIIConfig(mode="fail_closed")).to_headers()
        assert h == {"X-PII-Mode": "fail_closed"}

    def test_filter_names_known(self):
        """The set of filter names exposed on the SDK must match
        what the gateway's FilterRegistry accepts, so adding a
        new server-side filter is a one-line change here."""
        assert "pii" in FILTER_NAMES


class TestEdenConfigFilters:
    def test_filters_default_none(self):
        cfg = EdenConfig(org_id="o", api_key="k")
        assert cfg.filters is None

    def test_gateway_headers_omits_filter_headers_when_unset(self):
        """When no filter config is set, no ``X-PII-*`` headers
        leak into the default_headers — the gateway falls back to
        the tenant policy."""
        cfg = EdenConfig(org_id="o", api_key="k")
        h = cfg.gateway_headers()
        assert "X-PII-Mode" not in h
        assert "X-PII-Bypass" not in h
        assert "X-PII-Disabled-Categories" not in h

    def test_gateway_headers_renders_filters(self):
        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )
        h = cfg.gateway_headers()
        assert h["X-PII-Mode"] == "fail_closed"
        assert h["X-Org-Api-Key"] == "k"

    def test_gateway_headers_per_call_filter_override(self):
        """A ``filters=`` kwarg to ``gateway_headers`` overrides
        ``config.filters`` for one call."""
        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="redact")),
        )
        # Default uses redact...
        h = cfg.gateway_headers()
        assert h["X-PII-Mode"] == "redact"
        # ...but the per-call override wins.
        h2 = cfg.gateway_headers(
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )
        assert h2["X-PII-Mode"] == "fail_closed"

    def test_pii_bypass_kwarg_works_alongside_filters(self):
        cfg = EdenConfig(
            org_id="o",
            api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )
        h = cfg.gateway_headers(pii_bypass=True)
        # ``pii_bypass=True`` adds X-PII-Bypass: true even though
        # the process-wide filter says fail_closed.
        assert h["X-PII-Bypass"] == "true"
        assert h["X-PII-Mode"] == "fail_closed"


class TestGatewayURL:
    def test_default_base_url_appends_v1(self):
        cfg = EdenConfig(org_id="o", api_key="k")
        assert cfg.resolved_gateway_url() == "http://localhost:8000/v1"

    def test_explicit_gateway_url_wins(self):
        cfg = EdenConfig(
            org_id="o", api_key="k",
            gateway_url="https://gateway.eden.ai/v1",
        )
        assert cfg.resolved_gateway_url() == "https://gateway.eden.ai/v1"

    def test_base_url_already_ends_with_v1(self):
        cfg = EdenConfig(
            org_id="o", api_key="k",
            base_url="https://api.example.com/v1",
        )
        assert cfg.resolved_gateway_url() == "https://api.example.com/v1"

    def test_base_url_with_trailing_slash(self):
        cfg = EdenConfig(
            org_id="o", api_key="k",
            base_url="https://api.example.com/",
        )
        assert cfg.resolved_gateway_url() == "https://api.example.com/v1"
