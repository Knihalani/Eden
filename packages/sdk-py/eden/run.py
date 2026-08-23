"""run_tool: execute a compiled (state='on') tool on the hosted runtime.

This is the explicit path — the caller *asks* for execution, so unlike
:mod:`eden.wrap` there is no silent fallback; failures raise
:class:`~eden.client.EdenError` so callers see them.

Honesty invariants: this module can only run tools a human already approved
on the Eden website, and it never changes any tool's state.
"""

from __future__ import annotations

from typing import Any

from .client import EdenClient


def run_tool(
    name: str,
    args: dict[str, Any] | None = None,
    *,
    client: EdenClient | None = None,
) -> dict[str, Any]:
    """Execute compiled tool ``name`` via ``POST /v1/play``.

    ``client`` defaults to an :class:`EdenClient` built from the environment
    (``EDEN_PLANE_URL`` / ``EDEN_API_KEY``). Returns the runtime receipt as a
    dict.
    """
    client = client or EdenClient()
    return client.play(name, args)


__all__ = ["run_tool"]
