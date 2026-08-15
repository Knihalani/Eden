"""eden-mcp — standalone Eden MCP server.

Thin wrapper around ``eden.mcp_server`` when the full Eden platform is
installed, or self-contained via the vendored ``_core`` sub-package when
running as a standalone ``uvx eden-mcp`` install (httpx-only).

Capabilities:
* Tools   — ``tools/list`` + ``tools/call``
* Resources — ``resources/list`` + ``resources/read`` (eden:// URIs)
* Prompts — ``prompts/list`` + ``prompts/get``
"""

from __future__ import annotations

__version__ = "0.2.0"

# Prefer the full eden.mcp_server when the platform is available so that
# both packages stay in sync and there is only one code path to maintain.
try:
    from eden.mcp_server import (  # type: ignore[import-not-found]
        PROMPT_CATALOG,
        RESOURCE_TEMPLATE_CATALOG,
        TOOL_CATALOG,
        call_tool,
        get_prompt,
        list_prompts,
        list_resource_templates,
        list_tools,
        read_resource,
    )

    __all__ = [
        "TOOL_CATALOG",
        "call_tool",
        "list_tools",
        "RESOURCE_TEMPLATE_CATALOG",
        "list_resource_templates",
        "read_resource",
        "PROMPT_CATALOG",
        "get_prompt",
        "list_prompts",
    ]
except ImportError:
    # Standalone (no eden platform) — fall back to vendored core.
    from eden_mcp._core.server import TOOL_CATALOG, call_tool, list_tools  # type: ignore[no-redef]
    from eden_mcp._core.resources import (  # type: ignore[no-redef]
        RESOURCE_TEMPLATE_CATALOG,
        list_resource_templates,
        read_resource,
    )
    from eden_mcp._core.prompts import (  # type: ignore[no-redef]
        PROMPT_CATALOG,
        get_prompt,
        list_prompts,
    )

    __all__ = [
        "TOOL_CATALOG",
        "call_tool",
        "list_tools",
        "RESOURCE_TEMPLATE_CATALOG",
        "list_resource_templates",
        "read_resource",
        "PROMPT_CATALOG",
        "get_prompt",
        "list_prompts",
    ]
