"""Cat 23 PR-discipline — non-naive gating for PR automation.

The v1.7 Cat 23 ship plan replaces the "fire patch on every
incident" pattern with an explicit discipline layer:

* :class:`ConfidenceGate` — multi-signal confidence score
  (RCA confidence, blast-radius, quality, evidence) that
  must clear a per-org threshold before a PR is allowed.
* :class:`DedupeIndex` — duplicate-detection against recent
  PRs / reports so the system doesn't re-fire the same
  recommendation repeatedly.
* :class:`CircuitBreaker` — a short-window circuit breaker
  that opens after too many failures or rejections and
  forces the report-only path until it cools down.
* :class:`RateLimiter` — per-repo / per-day PR creation
  caps on top of the existing per-day patch caps.

All four are pure functions over a small dataclass
:class:`Decision` that flows through the pipeline. The
DB is touched through the same best-effort helpers in
:mod:`eden.code_change._common` so a missing DB connection
never blocks PR gating.

The package uses **lazy re-exports** so that
``from eden.code_change.discipline import ConfidenceGate``
does not eagerly import the sibling submodules.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "Action",
    "CircuitBreaker",
    "ConfidenceGate",
    "Decision",
    "DedupeIndex",
    "RateLimiter",
    "Trigger",
    "compute_decision",
    "fingerprint_trigger",
    "record_outcome",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .circuit_breaker import CircuitBreaker, Record
    from .confidence_gate import ConfidenceGate, Decision, Trigger, compute_decision
    from .dedupe import DedupeIndex
    from .rate_limiter import Action, RateLimiter
    from .store import record_outcome


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "Action": (".rate_limiter", "Action"),
    "CircuitBreaker": (".circuit_breaker", "CircuitBreaker"),
    "ConfidenceGate": (".confidence_gate", "ConfidenceGate"),
    "Decision": (".confidence_gate", "Decision"),
    "DedupeIndex": (".dedupe", "DedupeIndex"),
    "RateLimiter": (".rate_limiter", "RateLimiter"),
    "Record": (".circuit_breaker", "Record"),
    "Trigger": (".confidence_gate", "Trigger"),
    "compute_decision": (".confidence_gate", "compute_decision"),
    "fingerprint_trigger": (".confidence_gate", "fingerprint_trigger"),
    "record_outcome": (".store", "record_outcome"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access."""
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module
        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
