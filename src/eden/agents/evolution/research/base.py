"""Base classes for research sources."""

from abc import ABC, abstractmethod
from datetime import datetime
from typing import NamedTuple, Optional


class Paper(NamedTuple):
    """Represents a research paper or publication."""

    id: str
    title: str
    abstract: str
    url: str
    published_date: datetime
    source: str
    categories: list[str]


class FrameworkChange(NamedTuple):
    """Represents a detected framework version change."""

    framework_name: str
    previous_version: Optional[str]
    new_version: str
    changelog_url: str
    is_major: bool


class BaseResearchSource(ABC):
    """Abstract base class for research sources.

    Implementations must provide methods for fetching papers and detecting
    framework changes, using web search for data gathering.
    """

    @property
    @abstractmethod
    def source_name(self) -> str:
        """Return the name of this research source."""
        pass

    @property
    def source_url(self) -> str:
        """Return the base URL of this research source."""
        return ""

    @abstractmethod
    async def fetch_new_papers(self, since: datetime) -> list[Paper]:
        """Fetch papers published since the given date.

        Args:
            since: Fetch papers published after this datetime

        Returns:
            List of Paper objects
        """
        pass

    @abstractmethod
    async def detect_framework_changes(
        self, previous_versions: dict[str, str]
    ) -> list[FrameworkChange]:
        """Detect framework version changes.

        Args:
            previous_versions: Dict of framework_name -> known version

        Returns:
            List of FrameworkChange objects for detected updates
        """
        pass

    @abstractmethod
    async def extract_findings(self, paper: Paper) -> list[dict]:
        """Extract structured findings from a paper.

        Args:
            paper: The paper to analyze

        Returns:
            List of finding dicts with category, summary, implications
        """
        pass