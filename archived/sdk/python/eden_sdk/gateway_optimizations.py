"""Gateway optimization opt-out headers for the Python SDK.

Mirrors ``src/eden/llmops/gateway_optimizations.py`` header names.
"""

from __future__ import annotations

HEADER_EXACT_CACHE = "X-Eden-Exact-Cache"
HEADER_COALESCE = "X-Eden-Coalesce"
HEADER_PROVIDER_CACHE_LAYOUT = "X-Eden-Provider-Cache-Layout"
HEADER_RESPONSE_REPAIR = "X-Eden-Response-Repair"


def optimization_opt_out_headers(
    *,
    exact_cache: bool = True,
    coalesce: bool = True,
    provider_cache_layout: bool = True,
    response_repair: bool = True,
) -> dict[str, str]:
    """Emit headers only for disabled features (quiet default-on path)."""
    headers: dict[str, str] = {}
    if not exact_cache:
        headers[HEADER_EXACT_CACHE] = "false"
    if not coalesce:
        headers[HEADER_COALESCE] = "false"
    if not provider_cache_layout:
        headers[HEADER_PROVIDER_CACHE_LAYOUT] = "false"
    if not response_repair:
        headers[HEADER_RESPONSE_REPAIR] = "false"
    return headers
