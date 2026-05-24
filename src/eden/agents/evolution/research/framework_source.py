"""Framework release monitoring source for the Research Harvester."""

import logging
from datetime import datetime
from typing import Optional

from eden.agents.evolution.research.base import BaseResearchSource, Paper, FrameworkChange

logger = logging.getLogger(__name__)

FRAMEWORKS = {
    "Gymnasium": "https://gymnasium.farama.org/release_notes/",
    "PettingZoo": "https://pettingzoo.farama.org/release_notes/",
    "MuJoCo": "https://mujoco.org/release_notes/",
    "Isaac Lab": "https://isaac-sim.readthedocs.io/en/latest/",
}


class FrameworkSource(BaseResearchSource):
    """Research source for framework release notes.

    Monitors Gymnasium, PettingZoo, MuJoCo, and Isaac Lab for version changes.
    """

    def __init__(self):
        self._framework_search_queries = {
            "Gymnasium": "site:gymnasium.farama.org OR site:github.com/Farama-Foundation/Gymnasium release notes 2024 2025",
            "PettingZoo": "site:pettingzoo.farama.org OR site:github.com/Farama-Foundation/PettingZoo release notes 2024 2025",
            "MuJoCo": "site:mujoco.org release notes 2024 2025",
            "Isaac Lab": "site:isaac-sim.readthedocs.io release notes 2024 2025",
        }

    @property
    def source_name(self) -> str:
        return "Framework Releases"

    @property
    def source_url(self) -> str:
        return "https://gymnasium.farama.org"

    async def fetch_new_papers(self, since: datetime) -> list[Paper]:
        """FrameworkSource doesn't produce papers, only version changes."""
        return []

    async def detect_framework_changes(
        self, previous_versions: dict[str, str]
    ) -> list[FrameworkChange]:
        """Detect framework version changes by searching release notes."""
        changes = []

        for framework_name, search_query in self._framework_search_queries.items():
            change = await self._check_framework_version(framework_name, search_query, previous_versions)
            if change:
                changes.append(change)

        return changes

    async def _check_framework_version(
        self, framework: str, search_query: str, previous_versions: dict[str, str]
    ) -> Optional[FrameworkChange]:
        """Check if a framework has released a new version."""
        try:
            from mcp__exa__web_search_exa import web_search_exa

            result = web_search_exa(num_results=5, query=search_query)

            if result and hasattr(result, "results") and result.results:
                for item in result.results[:3]:
                    title = item.get("title", "")
                    url = item.get("url", "")

                    new_version = self._extract_version(title, framework)
                    if not new_version:
                        continue

                    previous = previous_versions.get(framework)
                    if previous and new_version == previous:
                        continue

                    is_major = self._is_major_version(new_version, previous)

                    return FrameworkChange(
                        framework_name=framework,
                        previous_version=previous,
                        new_version=new_version,
                        changelog_url=url,
                        is_major=is_major,
                    )

            return None
        except Exception as e:
            logger.debug(f"Framework version check failed for {framework}: {e}")
            return None

    def _extract_version(self, title: str, framework: str) -> Optional[str]:
        """Extract version number from release note title."""
        import re

        if framework in title:
            match = re.search(r"v?(\d+\.\d+(?:\.\d+)?)", title)
            if match:
                return match.group(1)
        return None

    def _is_major_version(self, new_version: str, previous: Optional[str]) -> bool:
        """Determine if version bump is a major release."""
        if not previous:
            return False

        try:
            new_parts = [int(x) for x in new_version.split(".")]
            prev_parts = [int(x) for x in previous.split(".")]

            if new_parts[0] > prev_parts[0]:
                return True
            if new_parts[0] == prev_parts[0] and len(new_parts) > 1 and len(prev_parts) > 1:
                return new_parts[1] > prev_parts[1]
            return False
        except (ValueError, IndexError):
            return False

    async def extract_findings(self, paper: Paper) -> list[dict]:
        """FrameworkSource doesn't produce papers."""
        return []