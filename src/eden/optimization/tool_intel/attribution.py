"""Tool Intelligence services (Cat 7).

Four services:
* ``ToolAttributionScorer`` — did this tool improve the outcome?
* ``ToolComparator`` — Tool A vs Tool B in production.
* ``ToolRecommender`` — suggest a tool swap given recent failures.
* ``ToolRegistryTaxonomy`` — categorized list of tools.

See ``docs/observability-gap/07-tool-intelligence.md``.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.intelligence_envelope import not_implemented

logger = logging.getLogger(__name__)


class ToolAttributionScorer:
    name = "tool_attribution"

    def score(
        self,
        org_id: str,
        *,
        trace_id: str,
        tool_id: str,
    ) -> dict[str, Any]:
        return not_implemented(
            self.name,
            message=(
                f"Attribution for {tool_id} in trace {trace_id} "
                "is not yet implemented"
            ),
        )


class ToolComparator:
    name = "tool_compare"

    def compare(
        self,
        org_id: str,
        *,
        tool_a: str,
        tool_b: str,
        window: str = "7d",
    ) -> dict[str, Any]:
        return not_implemented(
            self.name,
            message=(
                f"Comparison {tool_a} vs {tool_b} over {window} "
                "is not yet implemented"
            ),
        )


class ToolRecommender:
    name = "tool_recommend"

    def recommend(
        self,
        org_id: str,
        *,
        agent_id: str,
    ) -> dict[str, Any]:
        return not_implemented(
            self.name,
            message=(
                f"Tool recommendations for agent {agent_id} "
                "are not yet implemented"
            ),
        )


class ToolRegistryTaxonomy:
    name = "tool_taxonomy"

    def taxonomy(
        self,
        org_id: str,
    ) -> dict[str, Any]:
        return not_implemented(
            self.name,
            message="Tool taxonomy listing is not yet implemented",
        )
