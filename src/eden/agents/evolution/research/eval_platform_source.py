"""Agent evaluation platform source for the Research Harvester."""

import logging
import hashlib
from datetime import datetime

from eden.agents.evolution.research.base import BaseResearchSource, Paper, FrameworkChange

logger = logging.getLogger(__name__)

PLATFORMS = ["AgentBench", "TAU-bench", "WebArena", "SWE-bench"]


class EvalPlatformSource(BaseResearchSource):
    """Research source for agent evaluation platform updates.

    Monitors AgentBench, TAU-bench, WebArena, and SWE-bench for new benchmarks,
    tasks, and evaluation methodologies.
    """

    @property
    def source_name(self) -> str:
        return "Agent Eval Platforms"

    @property
    def source_url(self) -> str:
        return "https://github.com"

    async def fetch_new_papers(self, since: datetime) -> list[Paper]:
        """Fetch eval platform updates since given date."""
        papers = []
        seen_ids = set()

        for platform in PLATFORMS:
            platform_papers = await self._search_platform(platform, since)
            for paper in platform_papers:
                paper_id = self._dedup_id(paper.title, [platform])
                if paper_id not in seen_ids:
                    seen_ids.add(paper_id)
                    papers.append(paper)

        return papers

    async def _search_platform(self, platform: str, since: datetime) -> list[Paper]:
        """Search for updates from a specific platform."""
        try:
            from mcp__exa__web_search_exa import web_search_exa

            query = f"{platform} benchmark evaluation agent 2024 2025 site:github.com OR site:arxiv.org"
            result = web_search_exa(num_results=10, query=query)

            papers = []
            if result and hasattr(result, "results") and result.results:
                for item in result.results[:10]:
                    title = item.get("title", "")
                    url = item.get("url", "")
                    description = item.get("description", "")

                    if not title or platform.lower() not in title.lower():
                        continue

                    paper = Paper(
                        id=self._generate_id(title, platform),
                        title=title,
                        abstract=description,
                        url=url,
                        published_date=self._parse_date(item),
                        source=platform,
                        categories=["evaluation_benchmark", "agent_evaluation"],
                    )
                    papers.append(paper)

            return papers
        except Exception as e:
            logger.debug(f"Platform search error for {platform}: {e}")
            return []

    def _generate_id(self, title: str, platform: str) -> str:
        """Generate unique ID for platform update."""
        key = f"{platform}:{title}"
        return hashlib.sha256(key.encode()).hexdigest()[:16]

    def _parse_date(self, item: dict) -> datetime:
        """Parse date from search result item."""
        date_str = item.get("published_date") or item.get("date", "")
        if date_str:
            try:
                return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            except ValueError:
                pass
        return datetime.utcnow()

    def _dedup_id(self, title: str, categories: list[str]) -> str:
        """Generate deduplication ID."""
        key = f"{title}:{','.join(categories)}"
        return hashlib.sha256(key.encode()).hexdigest()[:16]

    async def detect_framework_changes(
        self, previous_versions: dict[str, str]
    ) -> list[FrameworkChange]:
        """Eval platforms don't provide framework changes."""
        return []

    async def extract_findings(self, paper: Paper) -> list[dict]:
        """Extract research findings from an eval platform update."""
        try:
            finding = {
                "finding_type": "BenchmarkMethod",
                "source": paper.source,
                "source_id": paper.id,
                "title": paper.title,
                "abstract_summary": paper.abstract[:500] if paper.abstract else "",
                "platform_name": paper.source,
                "url": paper.url,
                "published_date": paper.published_date.isoformat(),
                "implications": "Consider for Eden benchmark suite expansion",
            }
            return [finding]
        except Exception as e:
            logger.debug(f"Failed to extract findings from paper: {e}")
            return []