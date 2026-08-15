"""Agent package — the observability-driven agent surface.

Currently ships the :class:`PRSuggester` (Cat 23
"agent-in-the-portal" flow) and any future services that
take an observability event and produce a per-tenant
action (e.g. an "agent reports weekly" service, an
"agent suggests dataset" service, etc.).

The package uses lazy re-exports so that
``from eden.agent import PRSuggester`` does not eagerly
import the implementation.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "PRSuggestion",
    "PRSuggester",
    "VALID_TRIGGERS",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .pr_suggester import (
        VALID_TRIGGERS,
        PRSuggester,
        PRSuggestion,
    )


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "PRSuggestion": (".pr_suggester", "PRSuggestion"),
    "PRSuggester": (".pr_suggester", "PRSuggester"),
    "VALID_TRIGGERS": (".pr_suggester", "VALID_TRIGGERS"),
}


def __getattr__(name: str) -> Any:
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
