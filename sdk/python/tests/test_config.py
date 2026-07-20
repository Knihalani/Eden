"""Tests for ``eden_sdk.config``."""

from __future__ import annotations

import eden
from eden_sdk import config as config_mod
from eden_sdk.config import EdenConfig


def test_default_config_loads_from_env(monkeypatch):
    monkeypatch.setenv("EDEN_ORG_ID", "env-org")
    monkeypatch.setenv("EDEN_API_KEY", "env-key")
    monkeypatch.setenv("EDEN_BASE_URL", "https://env.example")
    config_mod.reset_config()
    cfg = config_mod.get_config()
    assert cfg.org_id == "env-org"
    assert cfg.api_key == "env-key"
    assert cfg.base_url == "https://env.example"


def test_api_key_accepts_explicit_org_alias_env(monkeypatch):
    """The TS SDK uses ``EDEN_ORG_API_KEY`` as the explicit name;
    Python's canonical name is ``EDEN_API_KEY``. For symmetry we
    accept BOTH — ``EDEN_ORG_API_KEY`` wins when both are set so
    users migrating from TS land first.
    """
    monkeypatch.delenv("EDEN_API_KEY", raising=False)
    monkeypatch.setenv("EDEN_ORG_API_KEY", "ts-style-key")
    config_mod.reset_config()
    cfg = config_mod.get_config()
    assert cfg.api_key == "ts-style-key"


def test_org_id_accepts_default_org_alias_env(monkeypatch):
    """``EDEN_DEFAULT_ORG`` is the TS SDK's fallback for ``EDEN_ORG_ID``.
    We accept it too so a single .env file works for both SDKs.
    """
    monkeypatch.delenv("EDEN_ORG_ID", raising=False)
    monkeypatch.setenv("EDEN_DEFAULT_ORG", "env-org-from-ts")
    config_mod.reset_config()
    cfg = config_mod.get_config()
    assert cfg.org_id == "env-org-from-ts"


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

    def test_optimization_defaults_emit_no_headers(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="org-123", api_key="sk-eden")
        headers = cfg.gateway_headers()
        assert "X-Eden-Exact-Cache" not in headers
        assert "X-Eden-Coalesce" not in headers
        assert "X-Eden-Provider-Cache-Layout" not in headers
        assert "X-Eden-Response-Repair" not in headers

    def test_optimization_opt_out_headers(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(
            org_id="org-123",
            api_key="sk-eden",
            exact_cache=False,
            response_repair=False,
        )
        headers = cfg.gateway_headers()
        assert headers["X-Eden-Exact-Cache"] == "false"
        assert headers["X-Eden-Response-Repair"] == "false"
        assert "X-Eden-Coalesce" not in headers


class TestGatewayURLField:
    """The ``gateway_url`` field on ``EdenConfig`` is the OpenAI-
    compatible gateway base URL. Defaults are derived from
    ``base_url``; explicit values win."""

    def test_default_uses_base_url_with_v1_suffix(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(org_id="o", api_key="k")
        assert cfg.gateway_url is None
        assert cfg.resolved_gateway_url() == "https://api.edenobservability.com/gateway/v1"

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
        assert cfg.resolved_gateway_url() == "https://api.example.com/gateway/v1"

    def test_base_url_already_has_v1(self):
        from eden_sdk.config import EdenConfig

        cfg = EdenConfig(
            org_id="o", api_key="k",
            base_url="https://api.example.com/v1",
        )
        assert cfg.resolved_gateway_url() == "https://api.example.com/v1"


def test_configure_redact_on_client_default_is_false() -> None:
    """Client-side PII redact is off by default (gateway authoritative)."""
    eden.reset_config()
    eden.configure(org_id="o", api_key="k")
    cfg = eden.get_config()
    assert cfg.redact_on_client is False


def test_configure_redact_on_client_can_be_enabled() -> None:
    """Operators can opt into client-side redact via configure()."""
    eden.reset_config()
    eden.configure(org_id="o", api_key="k", redact_on_client=True)
    assert eden.get_config().redact_on_client is True


def test_configure_redact_on_client_incremental_update() -> None:
    """Calling configure() twice should update the field, not
    require a reset_config() in between."""
    eden.reset_config()
    eden.configure(org_id="o", api_key="k")
    assert eden.get_config().redact_on_client is False
    eden.configure(redact_on_client=True)
    assert eden.get_config().redact_on_client is True
    eden.configure(redact_on_client=False)
    assert eden.get_config().redact_on_client is False


def test_configure_batch_size_default_is_50() -> None:
    eden.reset_config()
    eden.configure(org_id="o", api_key="k")
    assert eden.get_config().batch_size == 50


def test_configure_capture_chunk_text_default_is_false() -> None:
    eden.reset_config()
    eden.configure(org_id="o", api_key="k")
    assert eden.get_config().capture_chunk_text is False


def test_configure_accepts_transport_field():
    """``configure(transport=...)`` is stored on the config so the
    EdenClient singleton picks it up on first use.
    """
    import httpx
    sentinel = httpx.MockTransport(lambda r: httpx.Response(202))
    eden.configure(org_id="o", api_key="k", transport=sentinel)
    cfg = config_mod.get_config()
    assert cfg.transport is sentinel


def test_configure_accepts_filters_kwarg():
    """``configure(filters=...)`` is stored on the config so every
    gateway call picks up the configured filter chain. Locks in
    the v0.2 contract that the README example uses:

        eden.configure(
            org_id="o", api_key="k",
            filters=FilterConfig(pii=PIIConfig(mode="fail_closed")),
        )
    """
    from eden_sdk.filters import FilterConfig, PIIConfig
    filters = FilterConfig(pii=PIIConfig(mode="fail_closed"))
    eden.configure(org_id="o", api_key="k", filters=filters)
    cfg = config_mod.get_config()
    assert cfg.filters is filters
    # PII headers render correctly.
    assert "X-PII-Mode" in filters.to_headers()
    assert filters.to_headers()["X-PII-Mode"] == "fail_closed"


def test_configure_accepts_gateway_url_and_timeout():
    """``configure(gateway_url=..., timeout_s=...)`` are stored on the
    config. Locks in the v0.2 contract for the gateway-side helpers.
    """
    eden.configure(
        org_id="o", api_key="k",
        gateway_url="https://custom-gateway.example/v1",
        timeout_s=12.5,
    )
    cfg = config_mod.get_config()
    assert cfg.gateway_url == "https://custom-gateway.example/v1"
    assert cfg.timeout_s == 12.5
    # Resolved gateway URL honours the explicit override.
    assert cfg.resolved_gateway_url() == "https://custom-gateway.example/v1"


def test_configure_does_not_overwrite_unset_kwargs_with_None():
    """``configure(org_id=None)`` must NOT clobber the previously set
    org_id — ``None`` means "no change", not "clear".
    """
    eden.configure(org_id="original")
    eden.configure(org_id=None)  # noqa: explicit None = no-op
    cfg = config_mod.get_config()
    assert cfg.org_id == "original"


# ── EdenConfig.validate() ──────────────────────────────────────────


def test_validate_raises_without_org_id():
    """When ``disabled=False`` and ``dry_run=False`` and no org_id is
    set, ``validate`` must raise loudly so misconfigurations don't
    silently drop events."""
    from eden_sdk.config import EdenConfig
    cfg = EdenConfig(org_id=None, dry_run=False, disabled=False)
    import pytest
    with pytest.raises(ValueError, match="org_id is required"):
        cfg.validate()


def test_validate_noop_when_disabled():
    cfg = EdenConfig(org_id=None, disabled=True)
    cfg.validate()  # must not raise


def test_validate_noop_when_dry_run():
    cfg = EdenConfig(org_id=None, dry_run=True)
    cfg.validate()  # must not raise


def test_validate_passes_when_org_id_set():
    cfg = EdenConfig(org_id="org_123")
    cfg.validate()  # must not raise


def test_validate_warns_when_api_key_missing(monkeypatch, caplog):
    """The absence of an api_key is permitted (gateway may use
    other auth schemes) but should log a warning so it's visible."""
    import logging

    from eden_sdk.config import EdenConfig
    cfg = EdenConfig(org_id="org_123", api_key=None, extra_headers={})
    with caplog.at_level(logging.WARNING, logger="eden_sdk.config"):
        cfg.validate()
    assert any("api_key is not set" in rec.message for rec in caplog.records)


def test_configure_raises_on_missing_org_id(monkeypatch):
    """``configure()`` propagates ``validate()`` so misconfigured
    process startup fails loudly at the explicit configuration
    point instead of silently dropping events."""
    import pytest

    from eden_sdk import config as config_mod
    monkeypatch.delenv("EDEN_ORG_ID", raising=False)
    monkeypatch.delenv("EDEN_DEFAULT_ORG", raising=False)
    config_mod.reset_config()
    with pytest.raises(ValueError, match="org_id is required"):
        config_mod.configure(org_id=None)


# ── Env-var aliasing for dry_run ──────────────────────────────────────
#
# The Python SDK historically used ``EDEN_DEBUG`` as the
# dry-run opt-in, which was a doc-vs-code mismatch (the SDK
# never mirrored to stderr). The canonical name is now
# ``EDEN_DRY_RUN``; ``EDEN_DEBUG`` is preserved as a back-compat
# alias so users that copied the older README into their
# ``.env`` keep working.


def test_eden_dry_run_env_var_enables_dry_run(monkeypatch):
    """``EDEN_DRY_RUN=1`` is the canonical opt-in for dry-run
    mode and must populate ``EdenConfig.dry_run=True``."""
    from eden_sdk import config as config_mod

    monkeypatch.delenv("EDEN_DEBUG", raising=False)
    monkeypatch.setenv("EDEN_DRY_RUN", "1")
    config_mod.reset_config()
    cfg = config_mod._from_env()
    assert cfg.dry_run is True


def test_eden_debug_env_var_still_enables_dry_run(monkeypatch):
    """``EDEN_DEBUG=1`` must still enable dry-run mode for
    back-compat with the older README."""
    from eden_sdk import config as config_mod

    monkeypatch.delenv("EDEN_DRY_RUN", raising=False)
    monkeypatch.setenv("EDEN_DEBUG", "1")
    config_mod.reset_config()
    cfg = config_mod._from_env()
    assert cfg.dry_run is True


def test_eden_dry_run_wins_over_eden_debug(monkeypatch):
    """When both env vars are set, the canonical name wins
    (``EDEN_DRY_RUN=0`` with ``EDEN_DEBUG=1`` must mean
    ``dry_run=False``)."""
    from eden_sdk import config as config_mod

    monkeypatch.setenv("EDEN_DRY_RUN", "0")
    monkeypatch.setenv("EDEN_DEBUG", "1")
    config_mod.reset_config()
    cfg = config_mod._from_env()
    assert cfg.dry_run is False
