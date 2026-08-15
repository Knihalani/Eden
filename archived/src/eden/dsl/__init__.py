"""Cat 19 — Trace Query DSL / EQL (v1.3).

Closes the Braintrust-BTQL / Honeycomb-relational-fields gap
with a typed service surface. Four services:

* :class:`EQLParser` — parse an EQL query and return the
  compiled ClickHouse SQL + the shape + the list of
  relational fields used. SQL only (no BTQL pipe syntax,
  per the 2026-06-11 decision).
* :class:`RelationalFieldResolver` — translate
  ``root.`` / ``parent.`` / ``any.`` prefixes into the
  underlying ClickHouse SQL (Honeycomb parity; the
  "killer feature" of EQL).
* :class:`EQLLinter` — raise the 4 Braintrust-parity
  warnings (``NO_FILTERS``, ``ANY_SPAN_OVERUSE``,
  ``MISSING_ORG``, ``SHAPE_MISMATCH``); the strict mode
  is enforced at the call site (the parser + resolver
  block on error-severity warnings in strict mode).
* :class:`AlertAsCode` — compile an EQL alert into a
  Cat 19 alert rule that fires on the configured
  interval. The "killer query" path per the appendix.

The package uses **lazy re-exports** so that
``from eden.dsl import EQLParser`` does not eagerly import
the alerts service (which pulls in the Postgres client +
the cron watchdog helpers). Routes that need a specific
service should either rely on the lazy re-export or
import the service module directly:

    from eden.dsl.alerts import AlertAsCode

See ``docs/observability-gap/19-trace-query-dsl.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "AlertAsCode",
    "EQLLinter",
    "EQLParser",
    "RelationalFieldResolver",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .alerts import AlertAsCode
    from .linter import EQLLinter
    from .parser import EQLParser
    from .relational_fields import RelationalFieldResolver


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and
# the import spec stay in sync. Adding a new service
# means adding two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "AlertAsCode": (".alerts", "AlertAsCode"),
    "EQLLinter": (".linter", "EQLLinter"),
    "EQLParser": (".parser", "EQLParser"),
    "RelationalFieldResolver": (".relational_fields", "RelationalFieldResolver"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``EQLParser`` to the
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
    """Make ``dir(eden.dsl)`` show the public surface —
    useful for REPL auto-completion and for the test
    suite's introspection.
    """
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
