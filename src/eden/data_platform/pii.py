"""PII detection and masking for Eden data platform.

Provides regex-based and heuristic PII detection for events flowing through
the Bronze → Silver ETL pipeline. Masks detected PII before Silver storage
to comply with GDPR and SOC 2 requirements.

Phase 7.3a: per-tenant policy override. The default category list
is hard-coded below; tenants can override via ``org_pii_policies``
to disable specific categories, add custom redact keys, or enable
fail-closed mode for credential-like categories.

June 2026 hardening pass:
* Credit card regex tightened to brand-prefix-anchored Visa/MC/Amex/
  Discover patterns (was: any 13-16 digit run, which matched ISBNs,
  UUIDs without dashes, SKU codes, …).
* Credit card hits are post-validated with a Luhn check so synthetic
  16-digit strings that look like cards but don't checksum out are not
  redacted.
* SSN regex tightened with an area-code blocklist (000/666/9xx invalid),
  and the bare 9-digit form is now matched too (was: only dash form).
* Added ``aws_secret`` (AKIA…), ``private_key`` (-----BEGIN…),
  ``iban`` (country + 2 + 11-30), ``passport`` (letter + 8 digits)
  categories — consolidates the previously-duplicated `governance_intel`
  pattern set into a single source of truth.

Usage:
    from eden.data_platform.pii import PIIMasker, PIIPolicy
    masker = PIIMasker(policy=PIIPolicy(
        enabled_categories={"email", "phone", "ssn", ...},
        disabled_categories=set(),
        fail_closed_on_credentials=False,
        redact_keys_extra=set(),
    ))
    clean = masker.mask(event_payload)
"""

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class PIIPolicy:
    """Per-tenant PII policy. The default policy matches the
    hard-coded category list; tenants override via org_pii_policies."""

    enabled_categories: set[str] = field(default_factory=lambda: set(_DEFAULT_CATEGORIES))
    disabled_categories: set[str] = field(default_factory=set)
    fail_closed_on_credentials: bool = False
    redact_keys_extra: set[str] = field(default_factory=set)
    mask_token: str = "REDACTED"

    @classmethod
    def from_db_row(cls, row: dict[str, Any]) -> "PIIPolicy":
        return cls(
            enabled_categories=set(row.get("enabled_categories") or list(_DEFAULT_CATEGORIES)),
            disabled_categories=set(row.get("disabled_categories") or []),
            fail_closed_on_credentials=bool(row.get("fail_closed_on_credentials", False)),
            redact_keys_extra=set(row.get("redact_keys_extra") or []),
        )

    @property
    def active_categories(self) -> set[str]:
        return self.enabled_categories - self.disabled_categories

    @property
    def credential_categories(self) -> set[str]:
        return self.active_categories & _CREDENTIAL_CATEGORIES


_DEFAULT_CATEGORIES: tuple[str, ...] = (
    "url_with_creds", "jwt", "api_key", "email", "phone",
    "ssn", "credit_card", "ipv4", "ipv6", "password_field",
    # June 2026: newly hardened categories — credential-grade
    # patterns split out from `api_key` so they get the
    # fail-closed treatment when the policy is fail-closed.
    "aws_secret", "private_key", "iban", "passport",
)
_CREDENTIAL_CATEGORIES: frozenset[str] = frozenset({
    "url_with_creds", "jwt", "api_key", "password_field",
    "aws_secret", "private_key",
})


class PIIMaskingError(Exception):
    """Raised when fail-closed is on and a credential is detected."""


def _luhn_check(digits: str) -> bool:
    """Validate a string of digits with the Luhn algorithm.

    Rejects synthetic 16-digit runs that happen to match a brand prefix
    but aren't valid card numbers (the dashboard-noise problem).
    """
    cleaned = re.sub(r"[\s-]", "", digits)
    if not cleaned.isdigit() or len(cleaned) < 13:
        return False
    total = 0
    for i, ch in enumerate(reversed(cleaned)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


class PIIMasker:
    """Detects and masks PII in event payloads using regex and heuristic patterns.

    Supports both synchronous and async usage. The masking is conservative:
    it prefers false positives (over-masking) over false negatives (leaking PII).

    When constructed with a ``policy=PIIPolicy(...)``, the active
    category set, credential categories, and extra redact keys are
    taken from the policy instead of the defaults.
    """

    # Regex patterns for common PII types.
    # Order matters: more specific / composite patterns (e.g. URLs with creds)
    # must appear before sub-patterns (e.g. email) they contain.
    #
    # June 2026: tightened set — see module docstring for the diff against
    # the May 2026 baseline. Source-of-truth alignment with
    # ``eden.services.governance_intel._common.DEFAULT_PII_PATTERNS``: the
    # two modules used to drift; this pass collapses them.
    PATTERNS: dict[str, re.Pattern] = {
        "url_with_creds": re.compile(
            r"\b(?:https?|ftp)://[^:]+:[^@]+@\S+\b"
        ),
        "jwt": re.compile(
            r"\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b"
        ),
        # Generic API key — sk_/pk_/api_key= followed by ≥20 chars.
        # Widened from `(sk-|pk-|rk-)[a-zA-Z0-9_-]{24,64}` so we also
        # catch the `api_key=...` form that shows up in URL queries
        # and dotenv files.
        "api_key": re.compile(
            r"\b(?:sk|pk|api[_-]?key)[_-]?(?:live|test)?[_=]?"
            r"[A-Za-z0-9]{20,}\b"
        ),
        # AWS access key ids — AKIA + 16 upper alphanumerics.
        "aws_secret": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
        # RSA/EC private key block header.
        "private_key": re.compile(
            r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----"
        ),
        "email": re.compile(
            r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
        ),
        "phone": re.compile(
            r"\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b"
        ),
        # SSN with area-code blocklist: 000/666/9xx invalid; group 00
        # invalid; serial 0000 invalid. Accepts both the dash form
        # (XXX-XX-XXXX) and the bare 9-digit form (XXXXXXXXX) and
        # any single-space separator.
        "ssn": re.compile(
            r"\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0000)\d{4}\b"
        ),
        # Major credit cards — Visa/MC/Amex/Discover prefixes only.
        # Allows optional space/dash separators between digit groups;
        # Luhn-validates the stripped digits to filter false positives.
        # Visa: 13 or 16 digits starting with 4
        # Mastercard: 16 digits starting with 51-55
        # Amex: 15 digits starting with 34 or 37
        # Discover: 16 digits starting with 6011 or 65xx
        "credit_card": re.compile(
            r"\b(?:"
            r"4\d{3}(?:[ -]?\d{4}){3}"            # Visa 16 (with optional separators)
            r"|4\d{12}"                            # Visa 13 (no separators)
            r"|5[1-5]\d{2}(?:[ -]?\d{4}){3}"      # Mastercard 16
            r"|3[47]\d{2}[ -]?\d{6}[ -]?\d{5}"    # Amex 15 (4-6-5)
            r"|3[47]\d{13}"                        # Amex 15 (solid)
            r"|6(?:011|5\d{2})(?:[ -]?\d{4}){3}"  # Discover 16
            r")\b"
        ),
        # IBAN — country (2 letters) + 2 check digits + 11-30 alphanumerics.
        "iban": re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b"),
        # US passport — letter + 8 digits.
        "passport": re.compile(r"\b[A-Z]\d{8}\b"),
        "ipv4": re.compile(
            r"\b(?:\d{1,3}\.){3}\d{1,3}\b"
        ),
        "ipv6": re.compile(
            r"\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b"
        ),
        "password_field": re.compile(
            r'(?i)("password"|"passwd"|"secret"|"token"|"api_key")\s*[:=]\s*"[^"]{4,}"'
        ),
    }

    # Heuristic: keys that suggest sensitive values
    SENSITIVE_KEYS: set[str] = {
        "password",
        "passwd",
        "secret",
        "api_key",
        "apikey",
        "auth_token",
        "access_token",
        "refresh_token",
        "private_key",
        "client_secret",
        "credentials",
        "ssn",
        "social_security",
        "credit_card",
        "cvv",
    }

    def __init__(
        self,
        mask_token: str = "REDACTED",
        *,
        policy: PIIPolicy | None = None,
    ) -> None:
        self.mask_token = mask_token
        self.policy = policy or PIIPolicy(mask_token=mask_token)
        # Active regex subset: only the categories enabled by the
        # policy and not disabled.
        self._active_patterns: dict[str, re.Pattern] = {
            cat: pat
            for cat, pat in self.PATTERNS.items()
            if cat in self.policy.active_categories
        }
        # Build the full set of sensitive keys (built-in + tenant extras).
        self._sensitive_keys = set(self.SENSITIVE_KEYS) | set(self.policy.redact_keys_extra)

    def mask(self, text: str | dict[str, Any]) -> str | dict[str, Any]:
        """Mask PII in a string or dict payload.

        Returns the same type as input (str → str, dict → dict).

        Raises ``PIIMaskingError`` if the policy is fail-closed and a
        credential is detected (the caller is expected to convert
        this to a 422 response).
        """
        if isinstance(text, dict):
            return self._mask_dict(text)
        if isinstance(text, str):
            return self._mask_string(text, check_credentials=True)
        return text

    def _mask_string(self, text: str, *, check_credentials: bool = False) -> str:
        """Apply regex-based PII masking to a string. If
        ``check_credentials`` is True and the policy is fail-closed,
        raise on a credential hit before applying redactions."""
        if check_credentials and self.policy.fail_closed_on_credentials:
            for cat in self.policy.credential_categories:
                if self._active_patterns[cat].search(text):
                    raise PIIMaskingError(
                        f"Credential-like PII detected (category={cat}) "
                        f"and fail_closed_on_credentials=True"
                    )
        for pii_type, pattern in self._active_patterns.items():
            if pii_type == "credit_card":
                # Luhn-validated substitution — skip matches that don't
                # checksum. Synthetic / sequential 16-digit runs that
                # happen to begin with a brand prefix (`4111111111111111`
                # without the real algorithm) shouldn't get redacted.
                # Bind `pii_type` at function-def time (default arg
                # trick) so the lambda doesn't close over the loop
                # variable (B023).
                placeholder = f"[{pii_type.upper()}_{self.mask_token}]"
                text = pattern.sub(
                    lambda m, p=placeholder: (
                        p if _luhn_check(m.group(0)) else m.group(0)
                    ),
                    text,
                )
                continue
            text = pattern.sub(f"[{pii_type.upper()}_{self.mask_token}]", text)
        return text

    def _mask_dict(self, data: dict[str, Any]) -> dict[str, Any]:
        """Recursively mask PII in a dictionary, including sensitive keys."""
        result: dict[str, Any] = {}
        for key, value in data.items():
            key_lower = key.lower()
            if key_lower in self._sensitive_keys:
                result[key] = f"[{key.upper()}_{self.mask_token}]"
            elif isinstance(value, str):
                result[key] = self._mask_string(value, check_credentials=True)
            elif isinstance(value, dict):
                result[key] = self._mask_dict(value)
            elif isinstance(value, list):
                result[key] = self._mask_list(value)
            else:
                result[key] = value
        return result

    def _mask_list(self, items: list[Any]) -> list[Any]:
        """Recursively mask PII in list items."""
        result: list[Any] = []
        for item in items:
            if isinstance(item, str):
                result.append(self._mask_string(item))
            elif isinstance(item, dict):
                result.append(self._mask_dict(item))
            elif isinstance(item, list):
                result.append(self._mask_list(item))
            else:
                result.append(item)
        return result

    def scan(self, text: str | dict[str, Any]) -> list[dict[str, Any]]:
        """Scan for PII and return a list of detections without masking.

        Each detection includes: type, count, sample (first match).
        Credit-card hits are Luhn-validated; non-checksumming matches
        are not reported.
        """
        if isinstance(text, dict):
            text = json.dumps(text)

        detections: list[dict[str, Any]] = []
        for pii_type, pattern in self.PATTERNS.items():
            matches = pattern.findall(text)
            if pii_type == "credit_card":
                matches = [m for m in matches if _luhn_check(m)]
            if matches:
                detections.append({
                    "type": pii_type,
                    "count": len(matches),
                    "sample": matches[0][:50] if matches else None,
                })
        return detections

    def has_pii(self, text: str | dict[str, Any]) -> bool:
        """Quick check: does this payload contain any detectable PII?"""
        if isinstance(text, dict):
            text = json.dumps(text)
        for pii_type, pattern in self.PATTERNS.items():
            m = pattern.search(text)
            if not m:
                continue
            if pii_type == "credit_card" and not _luhn_check(m.group(0)):
                continue
            return True
        return False


def _sanitize_for_sql(value: Any) -> Any:
    """Sanitize a value for safe SQL usage — strip control chars."""
    if isinstance(value, str):
        # Remove null bytes and control characters except newline/tab
        return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", value)
    return value
