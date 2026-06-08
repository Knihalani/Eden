"""Eden — top-level import.

This module is the canonical user-facing entry point. It re-exports
the public API from :mod:`eden_sdk` so that ``import eden`` works
the way the README and examples show.

We keep the implementation in ``eden_sdk`` so the PyPI distribution
name stays ``eden-sdk`` (which is unique) while the import path is
the short, memorable ``eden`` (which is what users actually type).
"""

from __future__ import annotations

from eden_sdk import *  # noqa: F401,F403
from eden_sdk import __version__  # noqa: F401

__all__ = [
    # Configuration
    "EdenConfig",
    "configure",
    "get_config",
    "reset_config",
    # Public client
    "EdenClient",
    "get_default_client",
    # Tracing API
    "trace",
    "trace_agent",
    "Span",
    "TraceContext",
    "current_span",
    "current_trace",
    # Auto-instrumentation
    "instrument",
    "uninstrument",
    "__version__",
]
