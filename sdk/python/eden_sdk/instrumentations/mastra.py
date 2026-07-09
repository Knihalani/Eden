"""Auto-instrumentation for Mastra (TypeScript-only framework).

Mastra is a Node.js framework — there is no Python SDK. We expose a
no-op install() so ``eden.instrument("mastra")`` does not raise, and
document the recommendation to use the TypeScript SDK
(``sdk/ts-ai``) for Mastra projects.

The Python SDK *can* still observe Mastra-emitted HTTP traffic: any
``httpx.Client`` patched via a downstream exporter will surface
requests to the gateway. That wiring lives in the gateway, not the
Python SDK, so this module is intentionally a stub.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("eden_sdk.instrumentation.mastra")


def install() -> None:
    """Mastra is a TypeScript framework — no-op on Python.

    Use ``sdk/ts-ai`` for Mastra projects. The Python SDK will still
    capture any HTTP calls your Mastra server makes through the
    gateway (``X-Mastra-*`` tags are added server-side).
    """
    logger.warning(
        "eden: mastra is a TypeScript framework; "
        "Python SDK install is a no-op. Use sdk/ts-ai for full support."
    )


def uninstall() -> None:
    """Symmetric no-op."""
    return
