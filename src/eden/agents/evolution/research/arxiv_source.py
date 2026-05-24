"""arXiv research source for the Research Harvester."""

import logging
import hashlib
from datetime import datetime, timedelta
from typing import Optional

from eden.agents.evolution.research.base import BaseResearchSource, Paper, FrameworkChange

logger = logging.getLogger(__name__)

CATEGORIES = [
    "reinforcement learning",
    "multi-agent systems",
    "robotics",
    "reinforcement learning from human feedback",
    "reward design",
    "agent evaluation",
    "curriculum learning",
]


class ArxivSource(BaseResearchSource):
    """Research source for arXiv papers.

    Monitors cs.AI, cs.LG, cs.RO for relevant RL/agent publications.
    """

    @property
    def source_name(self) -> str:
        return "arXiv"

    @property
    def source_url(self) -> str:
        return "https://arxiv.org"

    async def fetch_new_papers(self, since: datetime) -> list[Paper]:
        """Fetch arXiv papers in relevant categories since given date."""
        papers = []
        seen_ids: set[str] = set()

        for category_query in CATEGORIES:
            query = f"site:arxiv.org {category_query} 2024 2025"
            new_papers = await self._search_arxiv(query, since)
            for paper in new_papers:
                paper_id = self._dedup_id(paper.title, paper.categories)
                if paper_id not in seen_ids:
                    seen_ids.add(paper_id)
                    papers.append(paper)

        return papers

    async def _search_arxiv(self, query: str, since: datetime) -> list[Paper]:
        """Search arXiv for papers matching query."""
        try:
            from mcp__exa__web_search_exa import web_search_exa

            result = web_search_exa(num_results=10, query=query)
            papers = []

            if result and hasattr(result, "results") and result.results:
                for item in result.results:
                    title = item.get("title", "")
                    url = item.get("url", "")
                    description = item.get("description", "")

                    if not title or "arxiv.org" not in url:
                        continue

                    paper_id = self._extract_arxiv_id(url)
                    if not paper_id:
                        continue

                    published = self._parse_arxiv_date(item)
                    if published and published < since:
                        continue

                    paper = Paper(
                        id=paper_id,
                        title=title,
                        abstract=description,
                        url=url,
                        published_date=published or datetime.utcnow(),
                        source="arXiv",
                        categories=[query.split(" ")[-1]],
                    )
                    papers.append(paper)

            return papers
        except Exception as e:
            logger.debug(f"arXiv search error: {e}")
            return []

    def _extract_arxiv_id(self, url: str) -> Optional[str]:
        """Extract arXiv ID from URL."""
        import re
        match = re.search(r"arxiv\.org/abs/([0-9.]+)", url)
        return match.group(1) if match else None

    def _parse_arxiv_date(self, item: dict) -> Optional[datetime]:
        """Parse date from search result item."""
        date_str = item.get("published_date") or item.get("date", "")
        if date_str:
            try:
                return datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            except ValueError:
                pass
        return None

    def _dedup_id(self, title: str, categories: list[str]) -> str:
        """Generate deduplication ID from title and categories."""
        key = f"{title}:{','.join(categories)}"
        return hashlib.sha256(key.encode()).hexdigest()[:16]

    async def detect_framework_changes(
        self, previous_versions: dict[str, str]
    ) -> list[FrameworkChange]:
        """arXiv doesn't provide framework changes."""
        return []

    async def extract_findings(self, paper: Paper) -> list[dict]:
        """Extract research findings from an arXiv paper.

        Returns structured findings about RL/agent techniques.
        """
        try:
            findings = []
            categories_str = ", ".join(paper.categories)

            finding = {
                "finding_type": "ResearchPaper",
                "source": "arXiv",
                "source_id": paper.id,
                "title": paper.title,
                "abstract_summary": paper.abstract[:500] if paper.abstract else "",
                "categories": categories_str,
                "url": paper.url,
                "published_date": paper.published_date.isoformat(),
                "implications": "Monitor for integration into Eden environment designs",
            }
            findings.append(finding)
            return findings
        except Exception as e:
            logger.debug(f"Failed to extract findings from paper: {e}")
            return []