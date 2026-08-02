"""Base protocol + registry for AI Gateway filters.

Filters transform a ``ModelRequest`` in place. The gateway's filter
pipeline runs them in registration order, fail-open, and is the only
extension point for new request-time concerns (PII, prompt-injection
detection, content-policy guard, secret-redaction, etc.).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)


@runtime_checkable
class GatewayFilter(Protocol):
    """A single transformation applied to a ModelRequest.

    Implementations should be idempotent and side-effect free. A filter
    that needs to be disabled for a particular request should respect
    ``request.pii_filter_enabled`` (or a similar per-request toggle) and
    return the request unchanged.
    """

    name: str

    def enabled(self, request: Any) -> bool:
        """Return True if this filter should run for this request."""
        ...

    def apply(self, request: Any) -> tuple[Any, list[str]]:
        """Apply the filter; return (possibly-mutated request, findings).

        ``findings`` is a list of human-readable descriptions of what the
        filter did (e.g. "redacted 2 emails"). The gateway uses this for
        logging and metrics.
        """
        ...


@dataclass
class FilterRegistry:
    """Ordered, mutable collection of ``GatewayFilter``s.

    The registry is a plain dataclass rather than a subclass of ``list``
    so it can be attached to a gateway without subclassing the gateway
    itself, and so that its state is introspectable from tests.
    """

    filters: list[GatewayFilter] = field(default_factory=list)
    fail_open: bool = True
    invocations: int = 0
    findings: int = 0
    errors: int = 0

    def register(self, f: GatewayFilter) -> None:
        """Append a filter. Later filters see the request as mutated by
        earlier ones (e.g. the secret-redactor runs after the PII
        filter, not before)."""
        self.filters.append(f)

    def unregister(self, name: str) -> int:
        """Remove all filters with the given name. Returns the count
        removed. Used by tests and runtime config-reload."""
        before = len(self.filters)
        self.filters = [f for f in self.filters if f.name != name]
        return before - len(self.filters)

    def run(self, request: Any) -> tuple[Any, list[str]]:
        """Run every enabled filter, in order. Returns the final request
        and a flat list of all findings.

        If ``fail_open`` is True (default), exceptions raised by an
        individual filter are logged and the request is passed to the
        next filter unchanged. If ``fail_open`` is False, the first
        exception propagates.
        """
        all_findings: list[str] = []
        for f in self.filters:
            self.invocations += 1
            if not f.enabled(request):
                continue
            try:
                request, findings = f.apply(request)
                all_findings.extend(findings)
                self.findings += len(findings)
            except Exception as exc:  # noqa: BLE001 — filter isolation
                self.errors += 1
                # Wave 2: GuardrailBlockedError is fail-closed — never swallow.
                try:
                    from eden.llmops.filters.guardrail import GuardrailBlockedError

                    _blocked_types: tuple[type[BaseException], ...] = (
                        GuardrailBlockedError,
                    )
                except Exception:  # pragma: no cover
                    _blocked_types = ()
                if isinstance(exc, _blocked_types):
                    raise
                if not self.fail_open:
                    raise
                logger.warning(
                    "Filter %s raised %s; passing request through "
                    "unchanged (fail_open=True)",
                    f.name,
                    exc,
                )
        return request, all_findings

    def names(self) -> list[str]:
        return [f.name for f in self.filters]
