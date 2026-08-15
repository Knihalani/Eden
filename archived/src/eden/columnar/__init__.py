"""Cat 18 — Query Performance / Columnar Engine (v1.3).

Closes the Braintrust-Brainstore gap by wrapping the
existing :class:`eden.data_platform.clickhouse_sink.ClickHouseSink`
substrate in a typed service surface. Four services:

* :class:`ColumnarPartitionManager` — materialises a
  per-org ClickHouse partition and records the
  metadata in ``columnar_partitions`` (Brainstore
  per-customer partitioning; ``org_id`` as partition
  key per the 2026-06-11 decision).
* :class:`ColumnarAggregator` — pre-computes the
  (org, source_table, granularity, window) rollups
  the dashboards read instead of re-aggregating on
  every request. Persists to ``columnar_rollups``.
* :class:`ColumnarCompactor` — runs the background
  merge of small ClickHouse segments into large
  sorted ones (``OPTIMIZE TABLE ... FINAL``). Best-
  effort with a 4h SLA; fires the closed-loop
  :class:`ColumnarHook.on_compaction_drift` on
  breach. Persists to ``columnar_compaction_log``.
* :class:`ColumnarQueryEngine` — the headline API
  surface: a fast SQL path against ClickHouse with a
  deterministic Postgres fallback for the
  ``data_source: "postgres_fallback"`` code path.

The package uses **lazy re-exports** so that
``from eden.columnar import ColumnarAggregator`` does
not eagerly import the query engine (which pulls in the
Postgres client + the read-only SQL allowlist + the
closed-loop hook). Routes that need a specific service
should either rely on the lazy re-export or import the
service module directly:

    from eden.columnar.aggregations import ColumnarAggregator

See ``docs/observability-gap/18-query-performance.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "ColumnarAggregator",
    "ColumnarCompactor",
    "ColumnarPartitionManager",
    "ColumnarQueryEngine",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .aggregations import ColumnarAggregator
    from .compaction import ColumnarCompactor
    from .partitions import ColumnarPartitionManager
    from .query import ColumnarQueryEngine


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and
# the import spec stay in sync. Adding a new service
# means adding two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "ColumnarAggregator": (".aggregations", "ColumnarAggregator"),
    "ColumnarCompactor": (".compaction", "ColumnarCompactor"),
    "ColumnarPartitionManager": (".partitions", "ColumnarPartitionManager"),
    "ColumnarQueryEngine": (".query", "ColumnarQueryEngine"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``ColumnarAggregator`` to
    the implementation in the corresponding submodule.
    The submodule is imported on first access and cached
    in ``sys.modules``, so subsequent accesses are O(1).
    """
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module

        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value  # cache for next access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    """Make ``dir(eden.columnar)`` show the public surface —
    useful for REPL auto-completion and for the test
    suite's introspection.
    """
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
