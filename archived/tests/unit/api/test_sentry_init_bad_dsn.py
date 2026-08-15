"""Sentry init must never crash the API process on a bad DSN.

Northflank production crash-looped with::

    sentry_sdk.utils.BadDsn: Unsupported scheme ''

when ``SENTRY_DSN`` was set to an empty-scheme / placeholder value.
``_init_sentry`` runs at import time in ``eden.api.app``, so a raised
exception takes the whole container down and the ingress returns
``no healthy upstream``.
"""

from __future__ import annotations

import importlib
import logging
import sys
from unittest.mock import MagicMock, patch

import pytest


def _reload_init(monkeypatch: pytest.MonkeyPatch, dsn: str | None):
    """Call ``_init_sentry`` in isolation with a controlled env."""
    # Import the function without executing the module-level call by
    # pulling the source function after a controlled reload is too
    # heavy (app.py pulls half the world). Instead, exec just the
    # function body by importing the already-loaded module and
    # rebinding env.
    if dsn is None:
        monkeypatch.delenv("SENTRY_DSN", raising=False)
    else:
        monkeypatch.setenv("SENTRY_DSN", dsn)

    # Ensure a fresh lookup of the function from the loaded module.
    import eden.api.app as app_mod

    _ = importlib.reload  # keep importlib referenced for clarity
    return app_mod._init_sentry


def test_init_sentry_skips_empty(monkeypatch: pytest.MonkeyPatch):
    init = _reload_init(monkeypatch, "")
    with patch.dict(sys.modules, {"sentry_sdk": MagicMock()}):
        init()  # must not raise


def test_init_sentry_skips_missing_scheme(monkeypatch: pytest.MonkeyPatch, caplog):
    init = _reload_init(monkeypatch, "o123.ingest.sentry.io/456")
    with caplog.at_level(logging.WARNING):
        init()
    assert any("missing scheme" in r.message for r in caplog.records)


def test_init_sentry_skips_placeholder(monkeypatch: pytest.MonkeyPatch, caplog):
    init = _reload_init(monkeypatch, "none")
    with caplog.at_level(logging.WARNING):
        init()
    assert any("placeholder" in r.message for r in caplog.records)


def test_init_sentry_swallows_bad_dsn(monkeypatch: pytest.MonkeyPatch, caplog):
    """Even if validation misses, BadDsn from sentry-sdk must not escape."""
    init = _reload_init(monkeypatch, "https://bad@example/1")

    class _BadDsnError(Exception):
        pass

    fake_sdk = MagicMock()
    fake_sdk.init.side_effect = _BadDsnError("Unsupported scheme ''")
    fake_utils = MagicMock()
    fake_utils.BadDsn = _BadDsnError
    fake_fastapi = MagicMock()
    fake_starlette = MagicMock()

    with (
        patch.dict(
            sys.modules,
            {
                "sentry_sdk": fake_sdk,
                "sentry_sdk.integrations.fastapi": fake_fastapi,
                "sentry_sdk.integrations.starlette": fake_starlette,
                "sentry_sdk.utils": fake_utils,
            },
        ),
        caplog.at_level(logging.ERROR),
    ):
        init()  # must not raise

    assert any("invalid" in r.message.lower() or "SENTRY_DSN" in r.message for r in caplog.records)
