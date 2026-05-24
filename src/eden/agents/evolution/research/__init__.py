"""Research sources for the Research Harvester."""

from eden.agents.evolution.research.base import BaseResearchSource, Paper, FrameworkChange
from eden.agents.evolution.research.arxiv_source import ArxivSource
from eden.agents.evolution.research.framework_source import FrameworkSource
from eden.agents.evolution.research.conference_source import ConferenceSource
from eden.agents.evolution.research.eval_platform_source import EvalPlatformSource
from eden.agents.evolution.research.harvester import ResearchHarvesterEngine

__all__ = [
    "BaseResearchSource",
    "Paper",
    "FrameworkChange",
    "ArxivSource",
    "FrameworkSource",
    "ConferenceSource",
    "EvalPlatformSource",
    "ResearchHarvesterEngine",
]