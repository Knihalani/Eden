"""Tool Intelligence services — Cat 7 (optimization layer).

This module is the legacy Cat 7 entry point. All four service
classes now delegate to the live implementations in
:mod:`eden.services.tool_intel.services`, which are backed by
real ``telemetry_events`` queries. Routes already import from
``services/tool_intel``; this shim keeps old import paths working.

See ``docs/observability-gap/07-tool-intelligence.md``.
"""

from __future__ import annotations

from eden.services.tool_intel.services import (
    ToolAttributionScorer,
    ToolComparator,
    ToolRecommender,
    ToolRegistryTaxonomy,
)

__all__ = [
    "ToolAttributionScorer",
    "ToolComparator",
    "ToolRecommender",
    "ToolRegistryTaxonomy",
]
