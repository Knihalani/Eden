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

from dataclasses import dataclass, field

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
