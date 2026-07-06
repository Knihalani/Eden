"""Repo-graph — code-understanding layer.

The brief was explicit: don't build a homemade hosted
code graph; ship something real and offline-first.
This package now ships:

* :class:`RepoGraphClient` — the protocol every backend
  must implement.
* :class:`SymbolGraph` — the new default. Real,
  in-process, persistent code-symbol index built with
  :mod:`ast` for Python files + regex scanners for
  TypeScript / JavaScript / Go / Java / Rust / Ruby.
  Ships with zero extra dependencies and zero external
  HTTP calls. Backed by SQLite so re-runs are cheap.
* :class:`GreptileRepoGraph` — the optional hosted
  fallback. Activates only when ``GREPTILE_API_KEY`` is
  set. The user told us Greptile was an example, so we
  no longer default to it; it's an opt-in upgrade.
* :class:`LocalRepoGraph` — the legacy no-graph
  fallback that only extracts path hints from the
  question. Kept for tests / callers that explicitly
  want "no graph".
* :func:`get_default_repo_graph` — the factory that
  picks the right implementation.

The graph answers four queries the discipline layer
needs:

* :meth:`RepoGraphClient.status` — is the repo indexed?
  What's the latest indexed commit SHA? When was it
  last refreshed?
* :meth:`RepoGraphClient.query` — query the indexed
  graph for symbols, references, file structure.
  Returns a structured payload that the context-
  gathering agent feeds into the LLM.
* :meth:`RepoGraphClient.find_affected_areas` —
  given an incident signature (e.g. error type +
  trace ids), find the most likely affected files
  + symbols. Returns a ranked list of
  ``(path, symbol, confidence)``.
* :meth:`RepoGraphClient.request_index` — kick off
  indexing (or a re-index) for a repo.

Every method is best-effort and degrades to ``None``
or empty lists on failure. The brief explicitly says
the system should not be a source of operational
noise, so a graph outage degrades to "we don't have
graph context for this candidate" — the gate still
runs, just with a lower evidence_count.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "AffectedArea",
    "GreptileRepoGraph",
    "GraphQueryResult",
    "IndexStatus",
    "LocalRepoGraph",
    "RepoGraphClient",
    "SymbolGraph",
    "get_default_repo_graph",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .factory import get_default_repo_graph
    from .greptile import GreptileRepoGraph, IndexStatus
    from .local import LocalRepoGraph
    from .protocol import RepoGraphClient
    from .symbol_graph import SymbolGraph


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "AffectedArea": (".protocol", "AffectedArea"),
    "GreptileRepoGraph": (".greptile", "GreptileRepoGraph"),
    "GraphQueryResult": (".protocol", "GraphQueryResult"),
    "IndexStatus": (".greptile", "IndexStatus"),
    "LocalRepoGraph": (".local", "LocalRepoGraph"),
    "RepoGraphClient": (".protocol", "RepoGraphClient"),
    "SymbolGraph": (".symbol_graph", "SymbolGraph"),
    "get_default_repo_graph": (".factory", "get_default_repo_graph"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access."""
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module
        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
