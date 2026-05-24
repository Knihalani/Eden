"""Research Harvester orchestration engine."""

import logging
from datetime import datetime, timedelta
from typing import Optional

from eden.agents.evolution.research.base import BaseResearchSource, Paper, FrameworkChange
from eden.agents.evolution.research.arxiv_source import ArxivSource
from eden.agents.evolution.research.framework_source import FrameworkSource
from eden.agents.evolution.research.conference_source import ConferenceSource
from eden.agents.evolution.research.eval_platform_source import EvalPlatformSource
from eden.kb.research.client import ResearchProposalsClient, get_research_client
from eden.llm.client import OpenRouterClient

logger = logging.getLogger(__name__)


class ResearchHarvesterEngine:
    """Orchestrates research harvesting from multiple sources.

    Coordinates arXiv, framework releases, conference proceedings, and
    eval platform monitoring to populate the research proposal queue.
    """

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        self.llm = llm_client or OpenRouterClient()
        self.sources: list[BaseResearchSource] = [
            ArxivSource(),
            FrameworkSource(),
            ConferenceSource(),
            EvalPlatformSource(),
        ]

    async def harvest_all_sources(self, run_id: str) -> dict:
        """Harvest from all research sources.

        Args:
            run_id: Unique identifier for this harvest run

        Returns:
            Dict with papers_processed, findings_extracted, framework_changes, kb_updates
        """
        research_client = get_research_client()
        previous_versions = await research_client.get_framework_versions()

        papers_processed = 0
        findings_extracted = 0
        framework_changes: list[dict] = []
        kb_updates = 0

        since = datetime.utcnow() - timedelta(days=7)

        for source in self.sources:
            logger.info(f"Harvesting from {source.source_name}...")

            try:
                if isinstance(source, FrameworkSource):
                    changes = await source.detect_framework_changes(previous_versions)
                    for change in changes:
                        framework_changes.append({
                            "framework_name": change.framework_name,
                            "previous_version": change.previous_version,
                            "new_version": change.new_version,
                            "changelog_url": change.changelog_url,
                            "is_major": change.is_major,
                        })
                        await research_client.upsert_framework_version(
                            framework=change.framework_name,
                            version=change.new_version,
                            is_major=change.is_major,
                        )
                        kb_updates += 1
                else:
                    papers = await source.fetch_new_papers(since)
                    papers_processed += len(papers)

                    for paper in papers:
                        findings = await source.extract_findings(paper)
                        findings_extracted += len(findings)

                        proposal = self._build_proposal(
                            paper=paper,
                            findings=findings,
                            source=source,
                            run_id=run_id,
                        )
                        await research_client.insert_proposal(proposal)

            except Exception as e:
                logger.error(f"Error harvesting from {source.source_name}: {e}")

        return {
            "papers_processed": papers_processed,
            "findings_extracted": findings_extracted,
            "framework_changes": framework_changes,
            "kb_updates": kb_updates,
        }

    def _build_proposal(
        self,
        paper: Paper,
        findings: list[dict],
        source: BaseResearchSource,
        run_id: str,
    ) -> dict:
        """Build a research proposal from a paper and its findings."""
        return {
            "source_type": source.source_name.lower().replace(" ", "_"),
            "source_url": paper.url,
            "paper_id": paper.id,
            "title": paper.title,
            "abstract": paper.abstract,
            "findings": findings,
            "raw_content": "",
            "is_framework_change": False,
            "framework_name": None,
            "previous_version": None,
            "new_version": None,
            "status": "pending",
            "archivist_reviewed": False,
            "proposed_at": datetime.utcnow().isoformat(),
            "harvester_run_id": run_id,
        }