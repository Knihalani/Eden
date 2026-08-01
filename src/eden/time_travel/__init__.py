"""Cat 20 — Time-Travel Debugging (v1.3).

Extends Cat 1 checkpointing with fork / record / diff, and
an optional live re-execute path gated by
``time_travel_replay_enabled``.

Four services:

* :class:`TraceRecorder` — gateway hook that persists
  ``agent.step`` events (recording stays on by default).
* :class:`TraceForker` — branches a trace at step N into
  ``trace_fork_branches``.
* :class:`TraceReplayer` — live re-exec from a fork through
  the AIGateway. Disabled until prompt content is recorded,
  edits land in ``payload``, and tests prove a changed
  ``response_hash``. See ``docs/ops/disabled-features.md``.
* :class:`ReplayDiff` — side-by-side original vs replayed
  timeline comparison.

The package uses **lazy re-exports** so that
``from eden.time_travel import TraceForker`` does not
eagerly import the replayer (which pulls in the
``cache_lookups`` + the AIGateway). Routes that need a
specific service should either rely on the lazy re-export
or import the service module directly:

    from eden.time_travel.forker import TraceForker

See ``docs/docs/observability/20-time-travel-debugging.md``.
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
