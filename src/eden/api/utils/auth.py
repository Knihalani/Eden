"""Password hashing and JWT utilities."""

from datetime import datetime, timedelta
from typing import Optional

import bcrypt
from jose import JWTError, jwt

from eden.config import get_settings

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
    expires_delta: Optional[timedelta] = None,
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

    return jwt.encode(
        to_encode,
        settings.jwt_secret,
        algorithm=ALGORITHM,
    )


def decode_access_token(token: str) -> Optional[dict]:
    """Decode and validate a JWT access token."""
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[ALGORITHM],
        )
        return payload
    except JWTError:
        return None