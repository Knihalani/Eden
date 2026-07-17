"""Per-framework auto-instrumentation modules.

Each module exposes ``install()`` and ``uninstall()``. The :mod:`eden_sdk`
top-level package imports them lazily by name (see :func:`eden.instrument`).

This package uses PEP 562 ``__getattr__`` to lazy-load each per-framework
submodule. Without this, a bare ``import eden`` (which the agent does at
startup) would eagerly import OpenAI, Anthropic, LangChain, LlamaIndex,
CrewAI, AutoGen, and Mastra's dependencies — even when the user only
wants to instrument one of them (or none). Empirically, the previous
eager-import design cost ~960 ms on a fresh Python process because
LangChain + LlamaIndex pull in numpy / pydantic / tiktoken transitively.

Lock-in: the eager-import test (``test_no_eager_imports_of_optional_deps``)
asserts that ``import eden`` does NOT pull in any framework dep.
"""

from __future__ import annotations

import importlib
from typing import Any

__all__ = [
    "openai",
    "anthropic",
    "langchain",
    "llama_index",
    "crewai",
    "autogen",
    "mastra",
    "pydantic_ai",
    "bedrock",
    "gemini",
]


def __getattr__(name: str) -> Any:
    """PEP 562 — lazy submodule attribute access.

    Resolves ``eden_sdk.instrumentations.openai`` (etc.) on first access,
    caches the module in :data:`sys.modules`, and returns it. Subsequent
    accesses are a single ``globals()`` lookup, so the lazy layer costs
    ~one dict lookup per framework — the same as the eager design paid
    upfront.
    """
    if name not in __all__:
        raise AttributeError(f"module 'eden_sdk.instrumentations' has no attribute {name!r}")
    import eden_sdk.instrumentations as _self
    module = importlib.import_module(f"{__name__}.{name}")
    # Bind to globals so subsequent attribute access is a dict lookup.
    setattr(_self, name, module)
    return module


def __dir__() -> list[str]:
    """Make ``dir(eden_sdk.instrumentations)`` show the public names."""
    return sorted(__all__)
