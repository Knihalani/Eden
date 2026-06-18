from __future__ import annotations

from typing import cast

"""Agent Intelligence services (Cat 6) — lazy re-exports.

The five real services shipped in the v1 implementation:

* :class:`AgentPerformanceScorer` — per-agent success / cost /
  latency / judge averages over a time window
* :class:`AgentRelationshipGraph` — multi-agent handoff
  graph builder
* :class:`HandoffAnalyzer` — bottleneck / error-hotspot /
  drift classifier on the relationship graph
* :class:`AgentBenchmarkRunner` — deterministic synthetic
  benchmark runner
* :class:`AgentFleetService` — LangSmith-Fleet-style agent
  identity + permissions (with the closed-loop
  re-registration drift hook)

Mirrors the layout of :mod:`eden.kb.retrieval_intel`,
:mod:`eden.kb.episodic.memory_intel`, and
:mod:`eden.services.cost_intel`. Each service class is
re-exported at package import time; the import of the
``performance`` module triggers the real implementations.
"""

# Lazy re-exports — keep the package cold-path cheap.
# Mirror the Cat 4 / Cat 5 / Cat 8 / Cat 16 pattern.
__all__ = [
    "AgentPerformanceScorer",
    "AgentRelationshipGraph",
    "HandoffAnalyzer",
    "AgentBenchmarkRunner",
    "AgentFleetService",
]


def __getattr__(name: str) -> None:
    """Lazy re-export. The 5 service classes all live in
    :mod:`.performance`; importing that module here triggers
    the package's hot path (Postgres + OpenRouter imports).
    Kept lazy so the package can be imported in test fixtures
    that mock the underlying client without triggering the
    real imports."""
    if name in __all__:
        from . import performance

        return cast(None, getattr(performance, name))
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(set(list(globals().keys()) + __all__))
