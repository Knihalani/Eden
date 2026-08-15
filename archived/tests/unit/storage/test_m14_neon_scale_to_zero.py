"""M14 (§8.1) — EDEN_NEON_SCALE_TO_ZERO flag gating."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from eden.config import get_settings
from eden.storage.empty_cooldown import neon_scale_to_zero_enabled


def test_neon_scale_to_zero_default_off() -> None:
    """Prod warm-demo: flag unset/False by default."""
    assert get_settings().neon_scale_to_zero is False
    assert neon_scale_to_zero_enabled() is False


def test_neon_scale_to_zero_enabled_when_flag_true() -> None:
    with patch(
        "eden.config.get_settings",
        return_value=MagicMock(neon_scale_to_zero=True),
    ):
        assert neon_scale_to_zero_enabled() is True


def test_neon_scale_to_zero_forces_pool_min_size_zero() -> None:
    """When flag is on, PostgresClient forces min_size=0 (scale-to-zero)."""
    from eden.storage.postgres import PostgresClient

    with patch(
        "eden.storage.empty_cooldown.neon_scale_to_zero_enabled",
        return_value=True,
    ):
        # Bypass real settings / DSN parsing with explicit overrides.
        with patch("eden.storage.postgres.get_settings") as gs:
            gs.return_value = MagicMock(
                postgres_host="localhost",
                postgres_port=5432,
                postgres_db="eden",
                postgres_user="eden",
                postgres_password="",
                postgres_min_pool_size=5,  # would stay warm without the gate
                postgres_pool_size=10,
                database_url=None,
            )
            client = PostgresClient(min_pool_size=5)
    assert client.config.min_size == 0


def test_neon_scale_to_zero_off_keeps_configured_min_size() -> None:
    from eden.storage.postgres import PostgresClient

    with patch(
        "eden.storage.empty_cooldown.neon_scale_to_zero_enabled",
        return_value=False,
    ):
        with patch("eden.storage.postgres.get_settings") as gs:
            gs.return_value = MagicMock(
                postgres_host="localhost",
                postgres_port=5432,
                postgres_db="eden",
                postgres_user="eden",
                postgres_password="",
                postgres_min_pool_size=0,
                postgres_pool_size=10,
                database_url=None,
            )
            client = PostgresClient(min_pool_size=3)
    assert client.config.min_size == 3


def test_test_gate_synthesis_still_false() -> None:
    """Preserve M8/M14 constraint: synthesis stays default-off."""
    assert get_settings().test_gate_synthesis_v1 is False
