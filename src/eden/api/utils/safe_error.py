"""Safe error message helpers for client-facing HTTP responses.

Raw ``str(exc)`` text from upstream SDKs and asyncpg can leak:

- Database schema names, table/column/constraint names
- Provider API URLs (api.openai.com, api.anthropic.com)
- API-key prefixes embedded in error messages
  (``sk-ant-..._REST_``, ``sk-proj-...``)
- Model-name fingerprints
  (``gpt-4o-2024-08-06-preview-ft-fb789a2c``)
- SDK traceback tails

None of that belongs in an HTTP response body. Log the full
exception with its traceback via ``logger.exception(...)`` at the
catch site and surface a generic, non-leaking string instead.
Clients can use the ``request_id`` from the surrounding envelope
to triage.

Two helpers live here:

- ``safe_detail(exc, *, fallback=None)`` — for HTTP ``detail=``
  fields. Returns the ``fallback`` string (or a sensible default
  if ``None``) so the response body carries a static,
  pre-vetted message.

- ``redact_upstream_error(exc)`` — for 502 / 504 ``Upstream
  provider returned an error`` text. Identical intent but a
  different default string so the client can distinguish
  gateway-down from server-side faults.

Both intentionally return ``str`` (never ``None`` or the raw
exception) so the caller can drop them straight into
``HTTPException(detail=...)``.

July 2026 site-wide hardening (companion to the gateway + prompt
canary redactors landed on July 6).
"""

from __future__ import annotations

from typing import Final

# Default safe detail text when the caller doesn't pass a
# domain-specific fallback. Keep this short, neutral, and free
# of any reference to internal systems so it never leaks a
# fingerprint.
_DEFAULT_DETAIL: Final[str] = "Internal server error"

# Default safe detail text for upstream-provider 502s. Slightly
# more informative (``Upstream provider`` instead of
# ``Internal server error``) so a gateway-outage client can
# distinguish "I can't reach the model" from "my code broke".
_DEFAULT_UPSTREAM: Final[str] = "Upstream provider returned an error"


def safe_detail(
    exc: BaseException,
    *,
    fallback: str | None = None,
) -> str:
    """Return a non-leaking detail string for an HTTP error response.

    The ``exc`` argument is accepted only for API symmetry and to
    make it easy to spot leak sites during code review (every
    ``safe_detail(exc)`` call is one we *know* is sanitised).
    The returned string never includes the exception text.

    Args:
      exc: The exception that was caught. Used only for the
        call-site review pattern; the value is never embedded
        in the returned string.
      fallback: Optional domain-specific override. When ``None``,
        a generic ``"Internal server error"`` is returned.
    """
    del exc  # explicitly discarded — see module docstring
    return fallback if fallback else _DEFAULT_DETAIL


def redact_upstream_error(exc: BaseException) -> str:
    """Return a non-leaking detail string for an upstream-provider 502.

    Identical contract to :func:`safe_detail` but defaults to a
    more informative message so clients can distinguish gateway
    outages from server-side faults. The exception is accepted
    only for symmetry with :func:`safe_detail`.
    """
    del exc
    return _DEFAULT_UPSTREAM
