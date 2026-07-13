"""Gateway filter protocol and registry for AI Gateway v2.

Filters are composable middleware applied to every LLM request before it
leaves the platform. The first filter shipped is the PII filter, but the
registry makes it trivial to add more (e.g. prompt-injection detector,
tenant content-policy guard, secret-redactor) without modifying the gateway
core.

Adding a new filter:
    1. Subclass ``GatewayFilter`` (or implement the protocol).
    2. Register it on the gateway: ``gateway.register_filter(MyFilter())``.

The gateway runs filters in registration order and is fail-open by default
(an exception in a filter is logged and the request passes through
unchanged) — this matches the behavior that was inlined in
``AIGateway.complete`` before the registry refactor.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .base import FilterRegistry, GatewayFilter
from .book import BookGatewayFilter
from .guardrail import GuardrailBlocked, GuardrailGatewayFilter, get_guardrail_filter
from .nudge import NudgeGatewayFilter
from .pii import PIIFilter, PIIFilterConfig

__all__ = [
    "BookGatewayFilter",
    "FilterRegistry",
    "GatewayFilter",
    "GuardrailBlocked",
    "GuardrailGatewayFilter",
    "NudgeGatewayFilter",
    "PIIFilter",
    "PIIFilterConfig",
    "get_guardrail_filter",
]


@dataclass
class _FilterMetrics:
    """Lightweight in-memory counter of filter invocations. Used for the
    gateway's own ``get_metrics()`` surface; flushed elsewhere by the
    observability layer."""

    invocations: int = 0
    findings: int = 0
    errors: int = 0
    per_filter: dict[str, dict[str, int]] = field(default_factory=dict)


# Re-export for tests so they can assert metric counters.
__all__.append("_FilterMetrics")
