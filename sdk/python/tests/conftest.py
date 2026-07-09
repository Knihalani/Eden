"""Shared pytest fixtures."""

from __future__ import annotations

import pytest

import eden
from eden_sdk import client as _client_mod
from eden_sdk import config as _config_mod


@pytest.fixture(autouse=True)
def _isolated_sdk(tmp_path, monkeypatch):
    """Each test starts with a clean, dry-run singleton.

    Dry-run keeps tests hermetic — nothing is sent to a real gateway.
    We also reset the config and the singleton between tests so order
    doesn't matter.
    """
    # Force a unique project per test.
    _config_mod.reset_config()
    _client_mod.reset_default_client()
    # Drop the global "already instrumented" registry so per-framework
    # uninstall() calls in test fakes are observed by the next test.
    from eden_sdk import INSTRUMENTED

    INSTRUMENTED.clear()
    eden.configure(
        org_id="test-org",
        api_key="test-key",
        base_url="http://test.invalid",
        project_id="pytest",
        dry_run=True,
    )
    # Don't actually start the async sender in dry-run mode.
    yield
    _client_mod.reset_default_client()
    _config_mod.reset_config()
    INSTRUMENTED.clear()
