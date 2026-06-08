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
