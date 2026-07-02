"""Password hashing and JWT utilities."""

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, UTC

import bcrypt
from jose import JWTError, jwt

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

ALGORITHM = "HS256"

# bcrypt has a hard 72-byte limit on the password input. Pre-fix
# was a silent UTF-8 byte-truncate (S-19 audit) — two distinct
# passwords sharing their first 72 bytes collided, AND a multi-byte
# UTF-8 character straddling byte 72 could be split mid-codepoint.
# The fix: SHA-256 pre-hash to 32 bytes, then zero-pad to 72 bytes.
# The pre-hash is deterministic (so verification works) and
# preserves the full entropy of the password (no collision
# surface).
_BCRYPT_MAX_BYTES = 72
_SHA256_DIGEST_LEN = 32

# Work factor for new hashes (rounds). 12 is the bcrypt default and
# gives ~250ms on a modern CPU — slow enough to resist brute force,
# fast enough to keep logins responsive. Bump together with the
# transparent upgrade path in :func:`needs_rehash` if you raise it.
_BCRYPT_ROUNDS = 12


def _pre_hash(password: str) -> bytes:
    """Pre-hash a password to bcrypt's 72-byte input limit.

    Audit 2026-07-02 S-19 — replaces the old ``[:72]`` UTF-8 byte
    slice. Returns exactly 72 bytes: the first 32 bytes are the
    SHA-256 digest of the password; the remaining 40 are zero
    padding. The digest is deterministic (no salt) so the same
    password always maps to the same 32 bytes — bcrypt then adds
    its own per-hash salt on top.
    """
    digest = hashlib.sha256(password.encode("utf-8")).digest()
    return digest + b"\x00" * (_BCRYPT_MAX_BYTES - _SHA256_DIGEST_LEN)


def _truncate(password: str) -> bytes:
    """Backwards-compat alias for :func:`_pre_hash`.

    The old name ``_truncate`` lingered; new code should use
    :func:`_pre_hash` directly. The semantics changed (no longer
    a raw byte-truncate) so this alias avoids breaking any other
    in-tree call sites.
    """
    return _pre_hash(password)


def hash_password(password: str) -> str:
    """Hash a password using bcrypt with the configured work factor.

    Audit 2026-07-02 S-19 — uses :func:`_pre_hash` so long /
    unicode passwords are NOT silently truncated.
    """
    return bcrypt.hashpw(
        _pre_hash(password),
        bcrypt.gensalt(rounds=_BCRYPT_ROUNDS),
    ).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash.

    Audit 2026-07-02 S-19 — uses :func:`_pre_hash` to match the
    hash path.
    """
    try:
        return bcrypt.checkpw(_pre_hash(plain_password), hashed_password.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def needs_rehash(hashed_password: str) -> bool:
    """Return True when a stored hash should be re-derived at next login.

    Catches three cases:
      1. Non-bcrypt hashes (legacy pbkdf2 / sha256 from before the
         bcrypt cutover — should never happen now, but the guard
         makes the upgrade path safe if it does).
      2. bcrypt $2a$ — older variant, prefer to roll forward.
      3. bcrypt rounds < current ``_BCRYPT_ROUNDS`` — bump the
         work factor without forcing a password reset.
    """
    if not hashed_password:
        return False
    parts = hashed_password.split("$")
    # bcrypt format: $2b$rounds$salt+hash  → 4 $-separated parts.
    if len(parts) != 4 or parts[1] not in ("2b", "2y"):
        return True
    try:
        rounds = int(parts[2])
    except ValueError:
        return True
    return rounds < _BCRYPT_ROUNDS


def create_access_token(
    data: dict,
    expires_delta: timedelta | None = None,
    token_version: int = 0,
) -> str:
    """Create a JWT access token.

    Every token gets:
      * a fresh ``jti`` (random 128-bit URL-safe string) so each
        token is uniquely identifiable for future revocation;
      * the user's current ``token_version`` so ``get_current_user``
        can reject any pre-login JWTs on the next request
        (anti-fixation).

    Pass ``token_version`` from the DB at the moment of issuance so
    the token is bound to that exact generation. A login flow
    should bump the DB version BEFORE calling this so any older
    tokens immediately fail their next auth check.
    """
    to_encode = data.copy()

    expire = datetime.now(UTC) + (
        expires_delta or timedelta(days=settings.jwt_exp_days)
    )
    to_encode.update({
        "exp": expire,
        "iat": datetime.now(UTC),
        "jti": secrets.token_urlsafe(16),
        "token_version": token_version,
    })
    # Stamp ``aud``/``iss`` when configured. Tokens issued before
    # these settings existed are still accepted by ``decode_access_token``
    # because the validation is only enforced when the values are set.
    if settings.jwt_audience:
        to_encode["aud"] = settings.jwt_audience
    if settings.jwt_issuer:
        to_encode["iss"] = settings.jwt_issuer

    return jwt.encode(
        to_encode,
        settings.jwt_secret,
        algorithm=ALGORITHM,
    )


def decode_access_token(token: str) -> dict | None:
    """Decode and validate a JWT access token.

    Validation applied on EVERY decode (defence-in-depth, regardless
    of configured audience/issuer):
      * Signature is verified with the configured secret.
      * Algorithm is locked to ``ALGORITHM`` (HS256) — no alg
        confusion (see security 17).
      * ``exp`` (expiration) is required; expired tokens rejected.
      * ``iat`` is required (we set it on every Eden-issued token).
      * ``nbf`` is honoured when present.
      * ``sub`` is required — anonymous tokens are useless.

    When ``settings.jwt_audience`` or ``settings.jwt_issuer`` is set,
    those claims are enforced too. Otherwise they're optional
    (legacy behaviour, preserved so existing sessions are not
    invalidated by a config flip).
    """
    decode_kwargs: dict = {
        "algorithms": [ALGORITHM],
        # python-jose's options namespace. Each ``require_*`` is
        # true → the corresponding claim MUST be present.
        "options": {
            "require_exp": True,
            "require_iat": True,
            "require_sub": True,
            "verify_exp": True,
            "verify_iat": True,
            "verify_nbf": True,
        },
    }
    if settings.jwt_audience:
        decode_kwargs["audience"] = settings.jwt_audience
    if settings.jwt_issuer:
        decode_kwargs["issuer"] = settings.jwt_issuer
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            **decode_kwargs,
        )
        return payload
    except JWTError as exc:
        # Signature failure against the primary key — try the
        # previous key (rotation window). If that also fails, the
        # token is invalid.
        if settings.jwt_secret_previous:
            try:
                payload = jwt.decode(
                    token,
                    settings.jwt_secret_previous,
                    **decode_kwargs,
                )
                return payload
            except JWTError:
                pass
        # Log only at debug — invalid tokens are routine (expired
        # sessions, manual API calls) and would flood the warning
        # stream if logged higher.
        logger.debug("decode_access_token failed: %s", exc)
        return None
