"""Eden Python SDK — pure stdlib client for the hosted runtime.

Public surface:

- :class:`EdenClient` — HTTP client (base_url + api_key from args or env).
- :class:`EdenError`, :class:`EdenTimeoutError` — clear failures.
- :func:`wrap_tools` — wrap tool callables so model calls route onto
  compiled tools, falling back to the original on any failure.
- :func:`run_tool` — execute an approved compiled tool via /v1/play.

Nothing in this package can approve anything; approval happens only on the
Eden website. Ordinary wrapped calls never wait on Eden beyond a bounded
timeout before falling back to the original callable.
"""

from __future__ import annotations

from .client import DEFAULT_BASE_URL, EdenClient, EdenError, EdenTimeoutError
from .run import run_tool
from .wrap import AGENT_ID, wrap_tools

__all__ = [
    "AGENT_ID",
    "DEFAULT_BASE_URL",
    "EdenClient",
    "EdenError",
    "EdenTimeoutError",
    "run_tool",
    "wrap_tools",
]

__version__ = "0.1.0"
