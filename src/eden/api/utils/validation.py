"""Input validation utilities for the Eden API.

Provides password strength validation, input sanitization, and
defense-in-depth checks for API inputs.
"""

import logging
import re

logger = logging.getLogger(__name__)

# ============================================================================
# Password Strength Validation
# ============================================================================

# Common weak passwords that should be rejected immediately
COMMON_PASSWORDS: set[str] = {
    "password", "password123", "12345678", "123456789", "qwerty123",
    "admin123", "letmein", "welcome", "monkey", "dragon",
    "master", "shadow", "sunshine", "princess", "football",
    "passw0rd", "changeme", "secret", "abc123", "test123",
    "password1", "Password1", "Password123", "pass1234",
    # Top breached/common passwords (RockYou-derivative, NIST guidance).
    "iloveyou", "trustno1", "superman", "batman", "starwars",
    "computer", "michael", "ashley", "jessica", "111111",
    "000000", "654321", "qwertyuiop", "asdfghjkl",
}


class PasswordValidationError(ValueError):
    """Raised when a password fails validation."""
    pass


def validate_password_strength(password: str) -> None:
    """Validate password strength against policy requirements.

    Policy:
    - Minimum 12 characters
    - At least one uppercase letter (A-Z)
    - At least one lowercase letter (a-z)
    - At least one digit (0-9)
    - At least one special character (!@#$%^&*()_+-=[]{}|;':\",./<>?`~)
    - Not a common/known weak password

    Args:
        password: The password to validate.

    Raises:
        PasswordValidationError: If the password does not meet requirements.
    """
    if not password:
        raise PasswordValidationError(
            "Password must be at least 12 characters long"
        )

    if password.lower() in COMMON_PASSWORDS:
        raise PasswordValidationError(
            "This password is too common. Please choose a stronger password."
        )

    if len(password) < 12:
        raise PasswordValidationError(
            "Password must be at least 12 characters long"
        )

    if len(password) > 128:
        raise PasswordValidationError(
            "Password must not exceed 128 characters"
        )

    checks = [
        (r"[A-Z]", "Password must contain at least one uppercase letter"),
        (r"[a-z]", "Password must contain at least one lowercase letter"),
        (r"\d", "Password must contain at least one digit"),
        (r"[!@#$%^&*()_+\-=\[\]{}|;':\",./<>?`~]", "Password must contain at least one special character"),
    ]

    for pattern, message in checks:
        if not re.search(pattern, password):
            raise PasswordValidationError(message)


# ============================================================================
# Input Sanitization
# ============================================================================

def sanitize_search_query(query: str) -> str:
    """Sanitize a search query string.

    Removes characters that could be used for injection or special
    interpretation in database queries.

    Args:
        query: Raw search query input.

    Returns:
        Sanitized query string.
    """
    if not query:
        return ""

    # Strip null bytes
    query = query.replace("\x00", "")

    # Limit length
    query = query[:500]

    # Strip control characters (except common whitespace)
    query = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", query)

    return query.strip()


def validate_date_string(date_str: str) -> bool:
    """Validate an ISO 8601 date string.

    Args:
        date_str: The date string to validate.

    Returns:
        True if the string is a valid ISO 8601 date/datetime.
    """
    if not date_str or len(date_str) > 30:
        return False

    # Accept ISO 8601 formats: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS...
    pattern = re.compile(
        r"^\d{4}-\d{2}-\d{2}"
        r"(T\d{2}:\d{2}:\d{2}"
        r"(\.\d+)?"
        r"(Z|[+-]\d{2}:\d{2})?)?$"
    )
    return bool(pattern.match(date_str))


def validate_identifier(identifier: str, max_length: int = 100) -> bool:
    """Validate that a string is a safe identifier (alphanumeric, underscore, hyphen).

    Args:
        identifier: The identifier string to validate.
        max_length: Maximum allowed length.

    Returns:
        True if the identifier is safe.
    """
    if not identifier or len(identifier) > max_length:
        return False
    return bool(re.match(r"^[a-zA-Z0-9_.\-]+$", identifier))
