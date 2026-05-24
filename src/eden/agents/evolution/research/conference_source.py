"""Conference proceedings source for the Research Harvester."""

import logging
import hashlib
from datetime import datetime

from eden.agents.evolution.research.base import BaseResearchSource, Paper, FrameworkChange

logger = logging.getLogger(__name__)

CONFERENCES = ["NeurIPS", "ICML", "ICLR", "ACL"]


class ConferenceSource(BaseResearchSource):
    """Research source for conference proceedings.

    Monitors top ML/AI conferences for RL, agent, and environment papers.
    """

    @property
    def source_name(self) -> str:
        return "Conference Proceedings"

    @property
    def source_url(self) -> str:
        return "https://papers.nips.cc"

    async def fetch_new_papers(self, since: datetime) -> list[Paper]:
        """Fetch conference papers since given date."""
        papers = []
        seen_ids = set()

        for conference in CONFERENCES:
            conf_papers = await self._search_conference(conference, since)
            for paper in conf_papers:
                paper_id = self._dedup_id(paper.title, [conference])
                if paper_id not in seen_ids:
                    seen_ids.add(paper_id)
                    papers.append(paper)

        return papers

    async def _search_conference(self, conference: str, since: datetime) -> list[Paper]:
        """Search for papers from a specific conference."""
        try:
            from mcp__exa__web_search_exa import web_search_exa

            query = f"site:papers.{conference.lower()}.cc OR site:openreview.net {conference} reinforcement learning agent environment 2024 2025"
            result = web_search_exa(num_results=10, query=query)

            papers = []
            if result and hasattr(result, "results") and result.results:
                for item in result.results[:10]:
                    title = item.get("title", "")
                    url = item.get("url", "")
                    description = item.get("description", "")

                    if not title:
                        continue

                    paper = Paper(
                        id=self._generate_id(title, conference),
                        title=title,
                        abstract=description,
                        url=url,
                        published_date=self._parse_date(item),
                        source=conference,
                        categories=["conference_paper"],
                    )
                    papers.append(paper)

            return papers
        except Exception as e:
            logger.debug(f"Conference search error for {conference}: {e}")
            return []

    def _generate_id(self, title: str, conference: str) -> str:
        """Generate unique ID for paper."""
        key = f"{conference}:{title}"
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
        """Conference proceedings don't provide framework changes."""
        return []

    async def extract_findings(self, paper: Paper) -> list[dict]:
        """Extract research findings from a conference paper."""
        try:
            finding = {
                "finding_type": "ConferencePaper",
                "source": paper.source,
                "source_id": paper.id,
                "title": paper.title,
                "abstract_summary": paper.abstract[:500] if paper.abstract else "",
                "venue": paper.source,
                "url": paper.url,
                "published_date": paper.published_date.isoformat(),
                "implications": "Relevant to Eden environment design and agent evaluation",
            }
            return [finding]
        except Exception as e:
            logger.debug(f"Failed to extract findings from paper: {e}")
            return []