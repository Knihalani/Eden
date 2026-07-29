"""Introducing ENCRYPTION_KEY must not orphan existing ciphertext.

When ``ENCRYPTION_KEY`` is unset, ``eden.api.utils.encryption`` derives
its Fernet key from ``JWT_SECRET``. Production ran that way, so values
already at rest are sealed under ``SHA256(jwt_secret)``.

``eden_production=True`` *requires* ``ENCRYPTION_KEY``, so turning on
production mode necessarily introduces a key — and without a fallback
that would permanently destroy every value encrypted before it. On
2026-07-29 that was one live user's 2FA secret.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from eden.api.utils import encryption

JWT = "prod-jwt-secret-that-is-long-enough-32"
NEW_KEY = "0" * 43 + "="  # placeholder; replaced with a real Fernet key below


def _settings(jwt: str, enc: str):
    class _S:
        jwt_secret = jwt
        encryption_key = enc
    return _S()


@pytest.fixture(autouse=True)
def _clear_cache():
    encryption.reset_encryption_cache()
    yield
    encryption.reset_encryption_cache()


def test_ciphertext_from_before_encryption_key_still_decrypts():
    """The regression this module exists for."""
    from cryptography.fernet import Fernet

    # 1. Encrypt the way production did: no ENCRYPTION_KEY, key from JWT.
    with patch.object(encryption, "get_settings", lambda: _settings(JWT, "")):
        sealed = encryption.encrypt_value("otp-seed-abc123")
    encryption.reset_encryption_cache()

    # 2. Now an ENCRYPTION_KEY is introduced (what eden_production needs).
    fresh = Fernet.generate_key().decode()
    with patch.object(encryption, "get_settings", lambda: _settings(JWT, fresh)):
        assert encryption.decrypt_value(sealed) == "otp-seed-abc123"


def test_new_writes_use_the_configured_key_not_the_legacy_one():
    from cryptography.fernet import Fernet

    fresh = Fernet.generate_key().decode()
    with patch.object(encryption, "get_settings", lambda: _settings(JWT, fresh)):
        sealed = encryption.encrypt_value("written-after-rotation")
    encryption.reset_encryption_cache()

    # The configured key alone must be able to read it.
    assert Fernet(fresh.encode()).decrypt(sealed.encode()).decode() == (
        "written-after-rotation"
    )


def test_round_trip_under_the_configured_key():
    from cryptography.fernet import Fernet

    fresh = Fernet.generate_key().decode()
    with patch.object(encryption, "get_settings", lambda: _settings(JWT, fresh)):
        assert encryption.decrypt_value(
            encryption.encrypt_value("hello")
        ) == "hello"


def test_genuinely_corrupt_ciphertext_still_raises():
    """The fallback must not turn corruption into silence."""
    from cryptography.fernet import Fernet

    fresh = Fernet.generate_key().decode()
    other = Fernet(Fernet.generate_key())
    junk = other.encrypt(b"sealed-with-an-unrelated-key").decode()

    with patch.object(encryption, "get_settings", lambda: _settings(JWT, fresh)):
        with pytest.raises(ValueError, match="Decryption failed"):
            encryption.decrypt_value(junk)


def test_no_legacy_fallback_when_encryption_key_is_unset():
    """With no ENCRYPTION_KEY the primary key IS the JWT-derived one,
    so there is nothing distinct to fall back to."""
    with patch.object(encryption, "get_settings", lambda: _settings(JWT, "")):
        assert encryption._get_legacy_fernet() is None


def test_no_legacy_fallback_when_key_derives_identically():
    """Setting ENCRYPTION_KEY to the JWT secret derives the same material;
    the fallback would just retry the identical key."""
    with patch.object(encryption, "get_settings", lambda: _settings(JWT, JWT)):
        assert encryption._get_legacy_fernet() is None
