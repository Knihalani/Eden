"""Cat 20 — Time-Travel Debugging (v1.3).

Extends the existing Cat 1 :class:`CheckpointService` with
fork-and-replay semantics. Closes the agentoptics/rewind,
Laminar, agent-vcr gap. **10× debug cycle time reduction.**

Four services:

* :class:`TraceRecorder` — the instrument the
  :class:`eden.llmops.ai_gateway.AIGateway` calls on every
  LLM step. Decides cacheable vs not + computes the cache
  key the :class:`TraceReplayer` reads on a later fork.
* :class:`TraceForker` — branches a trace at step N,
  producing a new ``fork_id`` that inherits the cached
  payload of steps 1..N-1.
* :class:`TraceReplayer` — the "killer query". Serves
  steps 1..N-1 from cache (0 tokens, 0 ms) and re-executes
  step N live through the AIGateway (PII filter still
  applies). Emits the side-by-side diff and the
  tokens_saved / cost_saved_usd metrics.
* :class:`ReplayDiff` — side-by-side comparison of the
  original and replayed timelines (per-step + per-key).

The package uses **lazy re-exports** so that
``from eden.time_travel import TraceForker`` does not
eagerly import the replayer (which pulls in the
``cache_lookups`` + the AIGateway). Routes that need a
specific service should either rely on the lazy re-export
or import the service module directly:

    from eden.time_travel.forker import TraceForker

See ``docs/observability-gap/20-time-travel-debugging.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "ReplayDiff",
    "TraceForker",
    "TraceReplayer",
    "TraceRecorder",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .diff import ReplayDiff
    from .forker import TraceForker
    from .recorder import TraceRecorder
    from .replayer import TraceReplayer


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and
# the import spec stay in sync. Adding a new service
# means adding two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "ReplayDiff": (".diff", "ReplayDiff"),
    "TraceForker": (".forker", "TraceForker"),
    "TraceReplayer": (".replayer", "TraceReplayer"),
    "TraceRecorder": (".recorder", "TraceRecorder"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``TraceForker`` to the
    implementation in the corresponding submodule. The
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
    """Make ``dir(eden.time_travel)`` show the public surface —
    useful for REPL auto-completion and for the test
    suite's introspection.
    """
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
