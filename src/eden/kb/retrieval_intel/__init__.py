"""Retrieval Intelligence (Cat 4) — KB-side package.

Four services that turn raw retrieval logs into actionable
intelligence for the operator and the closed-loop:

* :class:`RetrievalUtilizationScorer` — which retrieved chunks
  were actually referenced in the final answer.
* :class:`KnowledgeGapDetector` — query patterns with low hit
  rate or low utilization (the "what's missing in my KB" view).
* :class:`ChunkAttribution` — per-chunk contribution to the
  final answer, normalized 0..1.
* :class:`RetrievalReorderer` — propose a new ordering for a
  collection by recent utilization, so the highest-impact
  chunks are surfaced first.

A real implementation reads from the existing ``retrieval_logs``
table (written by :class:`eden.kb.retrieval_logger.RetrievalLogger`)
and joins against :class:`eden.observability.telemetry_collector`'s
``response_body`` to attribute chunks to the final answer. Both
dependencies degrade gracefully — empty ``retrieval_logs`` gives
a "no retrieval logs" envelope; missing answer text falls back
to a chunk-id-presence heuristic.

The package uses **lazy re-exports** so that
``from eden.kb.retrieval_intel import RetrievalUtilizationScorer``
does not eagerly import the heavy transitive deps (Postgres
client, the shared helpers). Routes that need a specific service
can rely on the lazy re-export or import the service module
directly:

    from eden.kb.retrieval_intel.utilization import RetrievalUtilizationScorer

See ``docs/observability-gap/04-retrieval-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "ChunkAttribution",
    "KnowledgeGapDetector",
    "RetrievalReorderer",
    "RetrievalUtilizationScorer",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .utilization import (
        ChunkAttribution,
        KnowledgeGapDetector,
        RetrievalReorderer,
        RetrievalUtilizationScorer,
    )


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and the
# import spec stay in sync. Adding a new service means adding
# two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "ChunkAttribution": (".utilization", "ChunkAttribution"),
    "KnowledgeGapDetector": (".utilization", "KnowledgeGapDetector"),
    "RetrievalReorderer": (".utilization", "RetrievalReorderer"),
    "RetrievalUtilizationScorer": (
        ".utilization",
        "RetrievalUtilizationScorer",
    ),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``RetrievalUtilizationScorer``
    to the implementation in the corresponding submodule. The
    submodule is imported on first access and cached in
    ``sys.modules``, so subsequent accesses are O(1).
    """
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module

        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value  # cache for next access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    """Make ``dir(eden.kb.retrieval_intel)`` show the public
    surface — useful for REPL auto-completion and for the test
    suite's introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
