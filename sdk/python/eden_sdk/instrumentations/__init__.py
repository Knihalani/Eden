"""Per-framework auto-instrumentation modules.

Each module exposes ``install()`` and ``uninstall()``. The :mod:`eden_sdk`
top-level package imports them lazily by name (see :func:`eden.instrument`).
"""

from __future__ import annotations

from eden_sdk.instrumentations import (
    anthropic,
    autogen,
    crewai,
    langchain,
    llama_index,
    mastra,
    openai,
)

__all__ = [
    "openai",
    "anthropic",
    "langchain",
    "llama_index",
    "crewai",
    "autogen",
    "mastra",
]
