"""Encryption utilities for sensitive data at rest.

Uses Fernet (symmetric AES-128 in CBC mode with PKCS7 padding + HMAC)
from the cryptography library.  The encryption key is read from the
ENCRYPTION_KEY setting; if absent, a deterministic key is derived from
JWT_SECRET as a fallback (not recommended for production).
"""

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from eden.config import get_settings

logger = logging.getLogger(__name__)

# Lazy-loaded singletons
_fernet: Fernet | None = None
_legacy_fernet: Fernet | None = None
_legacy_resolved = False


def _get_legacy_fernet() -> Fernet | None:
    """Fernet for ciphertext written before ``ENCRYPTION_KEY`` was set.

    When ``ENCRYPTION_KEY`` is empty this module derives its key from
    ``JWT_SECRET`` (see ``_get_fernet``). Production ran that way, so
    every value encrypted up to that point is sealed under
    ``SHA256(jwt_secret)``. Setting a real ``ENCRYPTION_KEY`` would
    otherwise make all of it permanently undecryptable — and because
    ``ENCRYPTION_KEY`` is what ``eden_production=True`` requires, you
    could not turn on production mode without silently destroying data.

    Returns ``None`` when no distinct legacy key exists (either no
    ``ENCRYPTION_KEY`` is configured, so the primary key already IS the
    JWT-derived one, or the two derive to the same value).
    """
    global _legacy_fernet, _legacy_resolved
    if _legacy_resolved:
        return _legacy_fernet

    _legacy_resolved = True
    settings = get_settings()
    raw_key = (settings.encryption_key or "").strip()
    if not raw_key:
        # No primary key configured — _get_fernet already derives from
        # JWT_SECRET, so there is nothing separate to fall back to.
        _legacy_fernet = None
        return None

    jwt_secret = settings.jwt_secret
    if not jwt_secret:
        _legacy_fernet = None
        return None

    legacy_key = _derive_fernet_key(jwt_secret)
    # If the configured key derives to the same material, the fallback
    # would be a pointless second attempt at the identical key.
    try:
        if _get_fernet()._signing_key == Fernet(legacy_key)._signing_key:  # type: ignore[attr-defined]
            _legacy_fernet = None
            return None
    except Exception:  # pragma: no cover - defensive
        pass

    try:
        _legacy_fernet = Fernet(legacy_key)
    except (ValueError, TypeError):  # pragma: no cover - derived key is always valid
        _legacy_fernet = None
    return _legacy_fernet


def _get_fernet() -> Fernet:
    """Get or create the Fernet instance.

    The key is loaded once and cached for the process lifetime.
    """
    global _fernet
    if _fernet is not None:
        return _fernet

    settings = get_settings()
    raw_key = settings.encryption_key

    if raw_key and raw_key.strip():
        key = raw_key.strip()
        # If the key is already a valid Fernet key (32 bytes base64url), use it
        try:
            _fernet = Fernet(key)
            return _fernet
        except (ValueError, TypeError):
            pass
        # Otherwise, derive a Fernet key from the provided string
        key = _derive_fernet_key(key)
    else:
        # Fallback: derive from JWT_SECRET. Logged as warning in config validator.
        jwt_secret = settings.jwt_secret
        key = _derive_fernet_key(jwt_secret)

    _fernet = Fernet(key)
    return _fernet


def _derive_fernet_key(secret: str) -> str:
    """Derive a Fernet-compatible key from an arbitrary secret string.

    Fernet requires a 32-byte base64url-encoded key.  We use SHA-256 to
    derive 32 raw bytes from the secret, then base64url-encode them.
    """
    digest = hashlib.sha256(secret.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii")


def encrypt_value(plaintext: str) -> str:
    """Encrypt a plaintext string. Returns a urlsafe base64 ciphertext.

    Args:
        plaintext: The sensitive value to encrypt (e.g., a TOTP secret).

    Returns:
        Encrypted ciphertext as a string.
    """
    if not plaintext:
        return ""
    fernet = _get_fernet()
    return fernet.encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt_value(ciphertext: str) -> str:
    """Decrypt a ciphertext string.

    Args:
        ciphertext: The encrypted value.

    Returns:
        The original plaintext.

    Raises:
        ValueError: If decryption fails (bad key or corrupted ciphertext).
    """
    if not ciphertext:
        return ""
    fernet = _get_fernet()
    raw = ciphertext.encode("utf-8")
    try:
        return fernet.decrypt(raw).decode("utf-8")
    except InvalidToken as e:
        # Fall back to the pre-ENCRYPTION_KEY key so that introducing one
        # does not orphan everything encrypted before it. Callers that
        # write the value back will re-seal it under the current key, so
        # this drains naturally without a migration.
        legacy = _get_legacy_fernet()
        if legacy is not None:
            try:
                plaintext = legacy.decrypt(raw).decode("utf-8")
            except InvalidToken:
                pass
            else:
                logger.info(
                    "decrypted a value under the legacy JWT-derived key; "
                    "it will be re-encrypted under ENCRYPTION_KEY on next write"
                )
                return plaintext
        raise ValueError("Decryption failed — invalid or corrupted ciphertext") from e


def reset_encryption_cache() -> None:
    """Drop the cached Fernet instances. Tests only."""
    global _fernet, _legacy_fernet, _legacy_resolved
    _fernet = None
    _legacy_fernet = None
    _legacy_resolved = False
