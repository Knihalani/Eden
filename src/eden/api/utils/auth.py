"""Password hashing and JWT utilities."""

import logging
from datetime import datetime, timedelta

import bcrypt
from jose import JWTError, jwt

from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

ALGORITHM = "HS256"

# bcrypt has a hard 72-byte limit on the password input. We truncate
# silently to match the behaviour passlib used before its self-check
# started failing on modern bcrypt (5.x). See:
# https://github.com/pyca/bcrypt/issues/684
_BCRYPT_MAX_BYTES = 72


def _truncate(password: str) -> bytes:
    """Encode + truncate to bcrypt's 72-byte limit."""
    return password.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def hash_password(password: str) -> str:
    """Hash a password using bcrypt."""
    return bcrypt.hashpw(_truncate(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password against its hash."""
    try:
        return bcrypt.checkpw(_truncate(plain_password), hashed_password.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(
    data: dict,
    expires_delta: timedelta | None = None,
) -> str:
    """Create a JWT access token."""
    to_encode = data.copy()

    expire = datetime.utcnow() + (
        expires_delta or timedelta(days=settings.jwt_exp_days)
    )
    to_encode.update({
        "exp": expire,
        "iat": datetime.utcnow(),
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

    When ``settings.jwt_audience`` or ``settings.jwt_issuer`` is set,
    those claims are enforced; otherwise the token is accepted based
    on signature + ``exp`` alone (legacy behaviour, preserved so
    existing sessions are not invalidated).
    """
    decode_kwargs: dict = {
        "algorithms": [ALGORITHM],
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
        # Log only at debug — invalid tokens are routine (expired
        # sessions, manual API calls) and would flood the warning
        # stream if logged higher.
        logger.debug("decode_access_token failed: %s", exc)
        return None
