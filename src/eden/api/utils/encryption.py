"""Encryption utilities for sensitive data at rest.

Uses Fernet (symmetric AES-128 in CBC mode with PKCS7 padding + HMAC)
from the cryptography library.  The encryption key is read from the
ENCRYPTION_KEY setting; if absent, a deterministic key is derived from
JWT_SECRET as a fallback (not recommended for production).
"""

import base64
import hashlib
import logging
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from eden.config import get_settings

logger = logging.getLogger(__name__)

# Lazy-loaded singleton
_fernet: Optional[Fernet] = None


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
    try:
        return fernet.decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except InvalidToken as e:
        raise ValueError("Decryption failed — invalid or corrupted ciphertext") from e
