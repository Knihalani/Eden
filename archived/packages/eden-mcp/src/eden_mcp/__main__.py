"""``eden-mcp`` / ``python -m eden_mcp`` entry point.

Delegates to ``eden.mcp_server.__main__:main`` when the full Eden platform is
installed, otherwise falls back to the vendored standalone stdio loop.

Usage:
  uvx eden-mcp                   # standalone — stdio MCP server
  EDEN_API_KEY=sk-… eden-mcp     # with API key — full tool access
  EDEN_BASE_URL=https://api.eden.ai eden-mcp
"""

from __future__ import annotations


def main() -> None:
    """Entry point for the ``eden-mcp`` console script."""
    try:
        from eden.mcp_server.__main__ import main as _platform_main  # type: ignore[import-not-found]

        _platform_main()
    except ImportError:
        from eden_mcp._core.__main__ import main as _core_main

        _core_main()


if __name__ == "__main__":
    main()
