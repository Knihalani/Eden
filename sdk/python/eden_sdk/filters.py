"""Per-filter configuration for Eden's gateway.

The gateway runs a chain of filters on every request before it
leaves the platform: PII redaction today, secret-redaction and
prompt-injection detection in upcoming releases. Each filter can
be enabled, disabled, or partially configured from the SDK.

Three things can be configured per filter:

  * ``enabled`` — boolean opt-out for this specific filter.
    Equivalent to ``X-Filter-<name>-Disabled: true`` on the wire.
  * ``mode`` — the filter-specific behaviour mode. PII supports
    ``"off"`` / ``"redact"`` / ``"fail_closed"``; other filters
    have their own modes (or no mode at all).
  * ``disabled_categories`` — for filters with multiple categories
    (PII: email/phone/SSN/...). Lets the customer opt out of a
    specific category without disabling the filter entirely.

Examples
--------

```python
from eden_sdk.filters import FilterConfig, PIIConfig

cfg = FilterConfig(
    pii=PIIConfig(mode="fail_closed"),
)
# → emits X-PII-Mode: fail_closed

cfg = FilterConfig(
    pii=PIIConfig(
        mode="redact",
        disabled_categories=["api_key", "url_with_creds"],
    ),
)
# → emits X-PII-Mode: redact, X-PII-Disabled-Categories: api_key,url_with_creds
```

The full set of filter names mirrors the gateway's
:mod:`eden.llmops.filters` registry. Adding a new server-side
filter is a one-liner here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# Filter names exposed on the wire. Keep in sync with the gateway's
# FilterRegistry.names() — see :mod:`eden.llmops.filters.base`.
FILTER_NAMES: tuple[str, ...] = ("pii",)


@dataclass
class PIIConfig:
    """Configuration for the PII redaction filter.

    ``mode`` is the per-tenant policy mode:
      * ``"off"`` — never mask (system designed to use the PII).
      * ``"redact"`` (default) — mask per the active category set.
      * ``"fail_closed"`` — redact + raise 422 on credential detection.

    ``disabled_categories`` is a per-call opt-out for specific
    categories. Useful when the system carries an internal API
    key in the prompt and you don't want the masker to redact it.
    Categories are matched by name against
    :data:`eden.data_platform.pii._DEFAULT_CATEGORIES`.

    ``bypass`` is the per-request opt-out: skip masking entirely
    for one call. Equivalent to setting ``pii_filter_enabled=False``
    on the request or sending ``X-PII-Bypass: true``.
    """

    mode: str = "redact"
    disabled_categories: list[str] = field(default_factory=list)
    bypass: bool = False

    def __post_init__(self) -> None:
        # Light validation — let the gateway do the strict check.
        if self.mode not in ("off", "redact", "fail_closed"):
            raise ValueError(
                f"PIIConfig.mode must be 'off', 'redact', or "
                f"'fail_closed'; got {self.mode!r}"
            )

    def to_headers(self) -> dict[str, str]:
        """Render as request headers for the gateway.

        Always emits ``X-PII-Mode`` so the gateway's per-request
        override is unambiguous (even when the tenant policy
        already matches). Only emits ``X-PII-Disabled-Categories``
        when the list is non-empty, to keep headers minimal in the
        common case.
        """
        headers: dict[str, str] = {"X-PII-Mode": self.mode}
        if self.disabled_categories:
            headers["X-PII-Disabled-Categories"] = ",".join(
                self.disabled_categories
            )
        if self.bypass:
            headers["X-PII-Bypass"] = "true"
        return headers


@dataclass
class FilterConfig:
    """Top-level filter configuration passed to :class:`EdenConfig`.

    Each attribute is the configuration for one filter. Filters
    that aren't set use the platform default (the tenant policy
    from ``org_pii_policies``, with the platform fallback when
    no row exists).

    Adding a new filter is two steps:

      1. Define a ``XxxConfig`` dataclass above.
      2. Add it as a field here with a default of ``None``.
    """

    pii: PIIConfig | None = None

    def to_headers(self) -> dict[str, str]:
        """Render every configured filter as request headers.

        Filters with no configuration are skipped — the gateway
        falls back to the tenant policy.
        """
        headers: dict[str, str] = {}
        if self.pii is not None:
            headers.update(self.pii.to_headers())
        return headers


# ── Client-side safety-net redactor ─────────────────────────────────
#
# This is a *small*, conservative regex pass over outgoing payloads
# designed to catch obvious PII before it leaves the process when
# the gateway is down, misconfigured, or simply not present in a
# local-dev setup. The gateway remains the authoritative redaction
# layer; this is a belt-and-suspenders safety net. Disable via
# ``EdenConfig(redact_on_client=False)`` when the gateway is the
# trusted redaction point and you don't want false positives.

# legitimate payloads (hex digests, model IDs, version strings).
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
# US-style phone numbers: must look like a phone — either a
# parenthesised area code ``(415) 555-2671`` or separators between
# the 3-3-4 groups (``415-555-2671``, ``415.555.2671``,
# ``+1 415 555 2671``).  Pure-digit runs of 10-11 characters are
# intentionally NOT matched here — they're far more likely to be
# numeric IDs, token counts, or Unix timestamps than phone
# numbers.  E.164 (``+14155552671``) is also excluded: the leading
# ``+`` plus the country code without separators is too easy to
# confuse with hash digests and other base-16 IDs.
_PHONE_RE = re.compile(
    r"(?<!\d)"
    r"(?:\+?1[-.\s]?)?"
    r"(?:"
    r"\(\d{3}\)\s*[-.]?\s*\d{3}[-.\s]?\d{4}"
    r"|\d{3}[-.\s]\d{3}[-.\s]\d{4}"
    r")"
    r"(?!\d)"
)
# US SSN: 3-2-4 with hyphens, anchored to word boundaries.
_SSN_RE = re.compile(r"(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)")
# Credit cards: 13-19 digits with optional spaces or hyphens
# between groups. We require the matched run to also pass a Luhn
# checksum, which dramatically reduces false positives on
# arbitrary numeric IDs, timestamps, and other long digit
# sequences that happen to live in payloads.
_CC_RE = re.compile(r"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)")

_MASK = "[REDACTED]"


def _luhn_ok(digits: str) -> bool:
    """Return True if ``digits`` passes the Luhn checksum.

    Luhn is the standard mod-10 check used by every major card
    network; running it on the candidate CC match drops the
    false-positive rate from "every 13-19 digit number" to roughly
    1-in-10, which is essential for not corrupting the many
    legitimate long-numeric values (timestamps, hashes, etc.) that
    flow through telemetry payloads.
    """
    if not (13 <= len(digits) <= 19):
        return False
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = ord(ch) - 48
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _redact_string(s: str) -> str:
    """Apply the four patterns to a single string in order.

    The CC pass runs each candidate through :func:`_luhn_ok` so
    long-numeric IDs (e.g. Unix timestamps) are not redacted.
    """

    def _cc_sub(m: re.Match[str]) -> str:
        candidate = m.group(0)
        if _luhn_ok(candidate.replace(" ", "").replace("-", "")):
            return _MASK
        return candidate

    s = _EMAIL_RE.sub(_MASK, s)
    s = _PHONE_RE.sub(_MASK, s)
    s = _SSN_RE.sub(_MASK, s)
    s = _CC_RE.sub(_cc_sub, s)
    return s


def _redact_value(v: Any) -> Any:
    """Recursively walk a JSON-ish value, redacting strings in place.

    Dicts and lists are descended into. String *keys* are also
    redacted, because some upstream LLM SDKs (and some
    application code) stash identifiers in dict keys. Everything
    else is returned unchanged.  The original objects are NOT
    mutated; we return new containers when we descend.
    """
    if isinstance(v, str):
        return _redact_string(v)
    if isinstance(v, dict):
        # When two distinct keys redact to the same value
        # (e.g. ``"a@example.com"`` and ``"b@example.com"`` both
        # become ``"[REDACTED]"``), a naive dict-comprehension
        # silently overwrites the first entry. The earlier
        # implementation was dropping one of the values on
        # every payload that carried multiple PII keys —
        # so an event with a per-user metrics dict would
        # collapse ``{"alice@...": 5, "bob@...": 3}`` to
        # ``{"[REDACTED]": 3}`` and lose Alice's value. We now
        # disambiguate by appending a numeric suffix on
        # collision (``[REDACTED]``, ``[REDACTED]_2``,
        # ``[REDACTED]_3`` …). The collision only happens when
        # the user has *legitimately* different keys that
        # happen to redact to the same string, so the
        # disambiguator is rare in practice and the cost is
        # O(n) on the dict's key set.
        out: dict[Any, Any] = {}
        for k, val in v.items():
            new_key = _redact_string(k) if isinstance(k, str) else k
            if new_key in out:
                i = 2
                while f"{new_key}_{i}" in out:
                    i += 1
                new_key = f"{new_key}_{i}"
            out[new_key] = _redact_value(val)
        return out
    if isinstance(v, list):
        return [_redact_value(item) for item in v]
    if isinstance(v, tuple):
        return tuple(_redact_value(item) for item in v)
    return v


def redact_payload(payload: Any) -> Any:
    """Run the client-side redactor over a single telemetry payload.

    Returns a NEW structure with masked strings. The original
    ``payload`` is not modified — important because the SDK keeps
    the original event in its queue for retry and we want the
    redacted version only on the wire.
    """
    return _redact_value(payload)
