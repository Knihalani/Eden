"""Unit tests for authentication utilities.

Covers: password hashing/verification, JWT create/decode,
        token expiry, and invalid token handling.
"""

from datetime import timedelta

import pytest
from jose import jwt

from eden.api.utils.auth import (
    ALGORITHM,
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from eden.api.utils.validation import (
    COMMON_PASSWORDS,
    PasswordValidationError,
    validate_password_strength,
)

# ─────────────────────────────────────────────────────────────────────────────
# Password Hashing
# ─────────────────────────────────────────────────────────────────────────────

class TestPasswordHashing:
    def test_hash_password_returns_different_value(self):
        """Hashing produces a non-plaintext string."""
        hashed = hash_password("my-secret-password")
        assert hashed != "my-secret-password"
        assert hashed.startswith("$2")

    def test_verify_correct_password(self):
        """Verification succeeds with the original password."""
        plain = "my-secret-password"
        hashed = hash_password(plain)
        assert verify_password(plain, hashed) is True

    def test_verify_incorrect_password(self):
        """Verification fails with a different password."""
        plain = "my-secret-password"
        hashed = hash_password(plain)
        assert verify_password("wrong-password", hashed) is False

    def test_different_passwords_different_hashes(self):
        """Two passwords produce different hashes."""
        h1 = hash_password("password-one")
        h2 = hash_password("password-two")
        assert h1 != h2


# ─────────────────────────────────────────────────────────────────────────────
# JWT Tokens
# ─────────────────────────────────────────────────────────────────────────────

class TestJWTTokens:
    def test_create_token(self, test_settings):
        """Token creation produces a non-empty string."""
        token = create_access_token(data={"sub": "user-123"})
        assert isinstance(token, str)
        assert len(token) > 0

    def test_decode_valid_token(self, test_settings):
        """Decoding a valid token returns the original payload."""
        payload = {"sub": "user-123", "email": "test@example.com"}
        token = create_access_token(data=payload)
        decoded = decode_access_token(token)
        assert decoded is not None
        assert decoded["sub"] == "user-123"
        assert decoded["email"] == "test@example.com"

    def test_decode_invalid_token(self):
        """Decoding garbage returns None."""
        assert decode_access_token("not-a-token") is None

    def test_decode_expired_token(self, test_settings):
        """Expired tokens are rejected."""
        token = create_access_token(
            data={"sub": "user-123"},
            expires_delta=timedelta(seconds=-1),
        )
        decoded = decode_access_token(token)
        assert decoded is None

    def test_token_contains_exp_and_iat(self, test_settings):
        """Tokens include issued-at and expiration timestamps."""
        token = create_access_token(data={"sub": "user-123"})
        decoded = decode_access_token(token)
        assert "exp" in decoded
        assert "iat" in decoded

    def test_token_with_custom_expiry(self, test_settings):
        """Custom expiry is honoured."""
        token = create_access_token(
            data={"sub": "user-123"},
            expires_delta=timedelta(days=1),
        )
        decoded = decode_access_token(token)
        assert decoded is not None
        # Expiry should be roughly 1 day from now
        import time
        now = int(time.time())
        assert decoded["exp"] > now + 86000


# ─────────────────────────────────────────────────────────────────────────────
# Password Strength Validation
# ─────────────────────────────────────────────────────────────────────────────

class TestPasswordStrength:
    def test_too_short_password(self):
        """Passwords under 10 chars are rejected."""
        with pytest.raises(PasswordValidationError, match="at least 10 characters"):
            validate_password_strength("Short1!")

    def test_missing_uppercase(self):
        """Passwords without uppercase are rejected."""
        with pytest.raises(PasswordValidationError, match="uppercase"):
            validate_password_strength("lowercase123!")

    def test_missing_lowercase(self):
        """Passwords without lowercase are rejected."""
        with pytest.raises(PasswordValidationError, match="lowercase"):
            validate_password_strength("UPPERCASE123!")

    def test_missing_digit(self):
        """Passwords without digits are rejected."""
        with pytest.raises(PasswordValidationError, match="digit"):
            validate_password_strength("NoDigits!!")

    def test_missing_special(self):
        """Passwords without special chars are rejected."""
        with pytest.raises(PasswordValidationError, match="special character"):
            validate_password_strength("NoSpecial123")

    def test_common_password_rejected(self):
        """Known weak passwords are rejected."""
        for weak in ("password", "password123", "12345678"):
            with pytest.raises(PasswordValidationError, match="too common"):
                validate_password_strength(weak)

    def test_strong_password_accepted(self):
        """A strong password passes all checks."""
        validate_password_strength("Str0ng!Pass#2024")

    def test_too_long_password(self):
        """Passwords over 128 chars are rejected."""
        with pytest.raises(PasswordValidationError, match="not exceed 128"):
            validate_password_strength("A" * 129)

    def test_unicode_password(self):
        """Unicode passwords that meet criteria are accepted."""
        validate_password_strength("Str0ng!Päss#2024")
