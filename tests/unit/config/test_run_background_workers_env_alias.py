"""Regression test — ``EDEN_RUN_BACKGROUND_WORKERS`` env-var mapping.

Northflank/Helm (northflank.yml, helm/eden/templates/*-deployment.yaml)
set ``EDEN_RUN_BACKGROUND_WORKERS``. ``Settings`` has no ``env_prefix``
and the field was named ``run_background_workers`` with no
``validation_alias`` — pydantic-settings' default env-var form for
that field name is ``RUN_BACKGROUND_WORKERS``, not
``EDEN_RUN_BACKGROUND_WORKERS``, so the deployed env var was silently
ignored and the field always fell back to its ``False`` default
regardless of what infra set. ``AliasChoices`` (the same pattern
already used for ``jwt_secret``) fixes the mismatch.
"""

from __future__ import annotations


def test_eden_prefixed_env_var_sets_run_background_workers(monkeypatch):
    from eden.config import _build_settings_class

    monkeypatch.delenv("RUN_BACKGROUND_WORKERS", raising=False)
    monkeypatch.setenv("EDEN_RUN_BACKGROUND_WORKERS", "1")

    Settings = _build_settings_class()
    settings = Settings(_env_file=None)

    assert settings.run_background_workers is True


def test_unprefixed_env_var_still_sets_run_background_workers(monkeypatch):
    """Backward compat: the pre-fix env var form must keep working."""
    from eden.config import _build_settings_class

    monkeypatch.delenv("EDEN_RUN_BACKGROUND_WORKERS", raising=False)
    monkeypatch.setenv("RUN_BACKGROUND_WORKERS", "1")

    Settings = _build_settings_class()
    settings = Settings(_env_file=None)

    assert settings.run_background_workers is True


def test_default_is_false_when_neither_env_var_is_set(monkeypatch):
    from eden.config import _build_settings_class

    monkeypatch.delenv("EDEN_RUN_BACKGROUND_WORKERS", raising=False)
    monkeypatch.delenv("RUN_BACKGROUND_WORKERS", raising=False)

    Settings = _build_settings_class()
    settings = Settings(_env_file=None)

    assert settings.run_background_workers is False
