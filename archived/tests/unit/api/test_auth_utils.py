"""Unit tests for authentication utilities.

Covers: password hashing/verification, JWT create/decode,
        token expiry, and invalid token handling.
"""

from datetime import timedelta

import jwt
import pytest

from eden.api.utils.auth import (
    _BCRYPT_ROUNDS,
    ALGORITHM,
    create_access_token,
    decode_access_token,
    hash_password,
    needs_rehash,
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

    def test_hash_uses_configured_rounds(self):
        """New hashes use the configured work factor."""
        hashed = hash_password("work-factor-check")
        # bcrypt format: $2b$<rounds>$...
        assert f"$2b${_BCRYPT_ROUNDS}$" in hashed

    def test_needs_rehash_for_current_hash_is_false(self):
        """A freshly hashed password does not need re-hashing."""
        assert needs_rehash(hash_password("fresh-hash")) is False

    def test_needs_rehash_for_legacy_sha256_is_true(self):
        """Legacy non-bcrypt hashes are flagged for upgrade."""
        # Pretend legacy SHA256 digest made it into the users table.
        legacy_sha = "sha256$abcd" + "f" * 64
        assert needs_rehash(legacy_sha) is True

    def test_needs_rehash_for_low_rounds_is_true(self):
        """bcrypt hashes below the configured rounds are upgraded."""
        import bcrypt

        weak = bcrypt.hashpw(b"old-but-known", bcrypt.gensalt(rounds=4)).decode()
        assert needs_rehash(weak) is True

    def test_needs_rehash_for_empty_hash_is_false(self):
        """NULL/empty hashes (Clerk users) are not flagged for rehash."""
        assert needs_rehash("") is False
        assert needs_rehash(None) is False


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

    def test_token_includes_jti(self, test_settings):
        """Every issued token has a unique jti claim."""
        token1 = create_access_token(data={"sub": "user-123"})
        token2 = create_access_token(data={"sub": "user-123"})
        d1 = decode_access_token(token1)
        d2 = decode_access_token(token2)
        assert "jti" in d1
        assert "jti" in d2
        assert d1["jti"] != d2["jti"], "two tokens minted back-to-back must have distinct jti"

    def test_token_carries_token_version(self, test_settings):
        """The token_version claim lets get_current_user reject
        pre-login JWTs (anti-fixation)."""
        token = create_access_token(
            data={"sub": "user-123"},
            token_version=7,
        )
        decoded = decode_access_token(token)
        assert decoded["token_version"] == 7

    def test_token_missing_sub_is_rejected(self, test_settings):
        """A token without a ``sub`` claim is rejected even if the
        signature is valid — required-claim enforcement."""
        token = jwt.encode(
            {"exp": 9999999999, "iat": 0},
            test_settings.jwt_secret,
            algorithm="HS256",
        )
        assert decode_access_token(token) is None

    def test_token_missing_exp_is_rejected(self, test_settings):
        """A token without an ``exp`` claim is rejected."""
        token = jwt.encode(
            {"sub": "user-123", "iat": 0},
            test_settings.jwt_secret,
            algorithm="HS256",
        )
        assert decode_access_token(token) is None

    def test_token_missing_iat_is_rejected(self, test_settings):
        """A token without an ``iat`` claim is rejected — the
        idle-timeout check in get_current_user depends on it."""
        token = jwt.encode(
            {"sub": "user-123", "exp": 9999999999},
            test_settings.jwt_secret,
            algorithm="HS256",
        )
        assert decode_access_token(token) is None

    def test_alg_none_token_is_rejected(self, test_settings):
        """An ``alg: none`` token is rejected even if the signature
        segment is empty — defence against the JWT 'none' confusion
        attack."""
        # Manually build a token with alg=none. python-jose refuses
        # to encode with alg=none, so the attack surface is only via
        # hand-crafted tokens. We just check the decoder rejects
        # a token whose alg header is not HS256.
        import base64
        import json

        header = base64.urlsafe_b64encode(
            json.dumps({"alg": "none", "typ": "JWT"}).encode()
        ).rstrip(b"=").decode()
        payload = base64.urlsafe_b64encode(
            json.dumps({"sub": "user-123", "exp": 9999999999, "iat": 0}).encode()
        ).rstrip(b"=").decode()
        # Signature is empty for alg=none.
        token = f"{header}.{payload}."
        assert decode_access_token(token) is None

    def test_alg_rs256_token_is_rejected(self, test_settings):
        """A token claiming RS256 is rejected — we only accept HS256.
        This is the classic asymmetric-vs-symmetric confusion attack."""
        import base64
        import json
        # Hand-craft an RS256-claimed token. The signature is junk
        # but the point is the decoder must reject on the alg
        # header before even attempting to verify the signature.
        header = base64.urlsafe_b64encode(
            json.dumps({"alg": "RS256", "typ": "JWT"}).encode()
        ).rstrip(b"=").decode()
        payload = base64.urlsafe_b64encode(
            json.dumps({"sub": "user-123", "exp": 9999999999, "iat": 0}).encode()
        ).rstrip(b"=").decode()
        token = f"{header}.{payload}.fake-signature-bytes"
        assert decode_access_token(token) is None

    def test_previous_secret_accepted_during_rotation(self, test_settings):
        """During a rotation window, tokens signed with the previous
        secret remain valid. New tokens are signed with the primary."""
        previous_secret = "an-old-secret-from-the-prior-deployment-window"
        token = jwt.encode(
            {"sub": "user-123", "exp": 9999999999, "iat": 0},
            previous_secret,
            algorithm="HS256",
        )
        # Simulate the rotation window: monkeypatch settings.
        from eden.api.utils import auth as auth_module
        original = auth_module.settings.jwt_secret_previous
        auth_module.settings.jwt_secret_previous = previous_secret
        try:
            decoded = decode_access_token(token)
            assert decoded is not None
            assert decoded["sub"] == "user-123"
        finally:
            auth_module.settings.jwt_secret_previous = original

    def test_token_version_mismatch_blocks_token(self):
        """The token_version claim is the revocation mechanism —
        if the DB version is higher than the one in the token, the
        request is rejected. This is exercised end-to-end in
        get_current_user; here we just confirm the claim is
        preserved through decode so the dep can compare it."""
        token = create_access_token(
            data={"sub": "user-123"},
            token_version=5,
        )
        decoded = decode_access_token(token)
        assert decoded["token_version"] == 5
        # The /auth/login flow bumps this on every successful login
        # and the /auth/logout flow bumps it for explicit revocation;
        # both call sites are wired and tested in security 7 + 15.


# ─────────────────────────────────────────────────────────────────────────────
# Password Strength Validation
# ─────────────────────────────────────────────────────────────────────────────

class TestPasswordStrength:
    def test_too_short_password(self):
        """Passwords under 12 chars are rejected."""
        with pytest.raises(PasswordValidationError, match="at least 12 characters"):
            validate_password_strength("Short1!Aa")

    def test_eleven_chars_rejected(self):
        """Eleven characters is still under the new 12-char minimum."""
        with pytest.raises(PasswordValidationError, match="at least 12 characters"):
            validate_password_strength("Aa1!abcdefg")

    def test_missing_uppercase(self):
        """Passwords without uppercase are rejected."""
        with pytest.raises(PasswordValidationError, match="uppercase"):
            validate_password_strength("lowercase123!aa")

    def test_missing_lowercase(self):
        """Passwords without lowercase are rejected."""
        with pytest.raises(PasswordValidationError, match="lowercase"):
            validate_password_strength("UPPERCASE123!A")

    def test_missing_digit(self):
        """Passwords without digits are rejected."""
        with pytest.raises(PasswordValidationError, match="digit"):
            validate_password_strength("NoDigits!!Aaa")

    def test_missing_special(self):
        """Passwords without special chars are rejected."""
        with pytest.raises(PasswordValidationError, match="special character"):
            validate_password_strength("NoSpecial123Aa")

    def test_common_password_rejected(self):
        """Known weak passwords are rejected."""
        for weak in ("password", "password123", "12345678", "qwerty123"):
            with pytest.raises(PasswordValidationError, match="too common"):
                validate_password_strength(weak)

    def test_extra_common_password_rejected(self):
        """Newly added common passwords from the expanded list."""
        for weak in ("iloveyou", "111111", "superman", "654321"):
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
