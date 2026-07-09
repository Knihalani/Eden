"""PII redaction helpers for log lines and error messages.

Used in the F65 audit pass to scrub email addresses, tokens,
and other PII from log statements. The pre-F65 codebase had
several ``logger.info(f"... {email}")`` call sites that wrote
plaintext PII to the log stream — a PII-in-logs violation
under both GDPR Art. 5 (data minimisation) and CCPA §1798.150.

The helpers here are pure-Python, allocation-light, and
preserves the diagnostic value of the log line (the prefix
is kept; only the PII portion is replaced with a token).
"""
from __future__ import annotations

import re

# Conservative email regex. Avoids matching arbitrary "a@b"
# inside code (e.g. function calls like ``foo@bar``); only
# matches when the local-part has at least one character class
# that looks email-ish (alphanumeric + at least one of . _ -).
_EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)

# Token-shaped secrets. We mask anything that looks like
# ``token=xxx`` or ``bearer xxx`` to keep the surrounding
# diagnostic context but scrub the credential.
_BEARER_RE = re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]{8,}")
_TOKEN_KV_RE = re.compile(
    r"(?i)\b(token|access_token|api_key|apikey|secret|password|"
    r"authorization|x-org-api-key|x-clerk-auth|x-api-key)"
    r"\s*[=:]\s*['\"]?([A-Za-z0-9._\-+/= ]{6,})['\"]?"
)


def redact_email(value: str) -> str:
    """Return ``value`` with email addresses replaced by ``***``.

    >>> redact_email("Email sent to alice@example.com")
    'Email sent to ***'
    >>> redact_email("no email here")
    'no email here'
    """
    if not value:
        return value
    return _EMAIL_RE.sub("***", value)


def redact_credentials(value: str) -> str:
    """Return ``value`` with bearer tokens + token= KV pairs masked.

    The diagnostic prefix is kept; only the credential portion
    is replaced with ``***``. Use this in error log paths where
    the upstream service may have embedded the credential in
    its error message.

    >>> redact_credentials("bearer abc123def456ghi789")
    'bearer ***'
    >>> redact_credentials("token=sk-live-abcdef")
    'token=***'
    """
    if not value:
        return value
    value = _BEARER_RE.sub(r"\1***", value)
    value = _TOKEN_KV_RE.sub(r"\1=***", value)
    return value


def redact_all(value: str) -> str:
    """Apply every redaction: emails + credentials."""
    if not value:
        return value
    value = redact_email(value)
    value = redact_credentials(value)
    return value
