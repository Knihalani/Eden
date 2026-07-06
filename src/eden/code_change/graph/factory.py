"""Factory — pick the right repo-graph implementation.

Selection priority (highest first):

1. **SymbolGraph** (the new default). Real, in-process,
   persistent code-symbol index built with Python's
   :mod:`ast` for Python files and lightweight regex
   scanners for TypeScript / JavaScript / Go / Java /
   Rust / Ruby. Ships with zero extra dependencies.
2. **GreptileRepoGraph** (optional hosted fallback) —
   activated only when ``GREPTILE_API_KEY`` is set. The
   user told us explicitly that Greptile was an example,
   so we keep it as an optional upgrade path but never
   default to it.
3. **LocalRepoGraph** (legacy path-extraction fallback) —
   retained for tests / callers that explicitly need
   "no graph, just regex on the question". Not the
   default anymore.

The factory is intentionally lazy — no client is
constructed until it's first used, so a missing / invalid
hosted key never crashes import.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def get_default_repo_graph() -> Any:
    """Return the best available :class:`RepoGraphClient` implementation.

    See module docstring for the priority order.
    """
    # Default: SymbolGraph (real, in-process, persistent).
    try:
        from .symbol_graph import SymbolGraph
        return SymbolGraph()
    except Exception as exc:
        logger.debug(
            "graph factory: SymbolGraph init failed (%s); "
            "trying Greptile fallback",
            exc,
        )

    # Optional hosted upgrade.
    api_key = os.getenv("GREPTILE_API_KEY", "").strip()
    if api_key:
        try:
            from .greptile import GreptileRepoGraph
            return GreptileRepoGraph(api_key=api_key)
        except Exception as exc:
            logger.debug(
                "graph factory: Greptile init failed (%s); "
                "falling back to LocalRepoGraph",
                exc,
            )

    # Legacy no-graph fallback.
    from .local import LocalRepoGraph
    return LocalRepoGraph()
