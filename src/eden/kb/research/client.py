"""Research proposals KB client."""

import logging
from datetime import UTC, datetime
from typing import Optional
from uuid import UUID, uuid4

from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

_client: Optional["ResearchProposalsClient"] = None


def get_research_client() -> "ResearchProposalsClient":
    """Get singleton research client."""
    global _client
    if _client is None:
        _client = ResearchProposalsClient()
    return _client


class ResearchProposalsClient:
    """Client for research_proposals and framework_versions tables.

    Handles batch research proposals from the Research Harvester and
    framework version tracking for KB invalidation.
    """

    async def insert_proposal(self, proposal: dict) -> str:
        """Insert a research proposal into the queue.

        Args:
            proposal: Dict with source_type, title, abstract, findings, etc.

        Returns:
            The UUID of the inserted proposal
        """
        db = await get_postgres_client()
        proposal_id = str(uuid4())

        await db.execute(
            """
            INSERT INTO research_proposals (
                id, source_type, source_url, paper_id, title, abstract,
                findings, raw_content, is_framework_change, framework_name,
                previous_version, new_version, status, archivist_reviewed,
                proposed_at, harvester_run_id
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
            )
            """,
            proposal_id,
            proposal.get("source_type"),
            proposal.get("source_url"),
            proposal.get("paper_id"),
            proposal.get("title"),
            proposal.get("abstract"),
            proposal.get("findings", []),
            proposal.get("raw_content"),
            proposal.get("is_framework_change", False),
            proposal.get("framework_name"),
            proposal.get("previous_version"),
            proposal.get("new_version"),
            proposal.get("status", "pending"),
            proposal.get("archivist_reviewed", False),
            datetime.fromisoformat(proposal["proposed_at"]) if isinstance(proposal.get("proposed_at"), str) else datetime.now(UTC),
            proposal.get("harvester_run_id"),
        )

        return proposal_id

    async def get_pending_proposals(self, limit: int = 50) -> list[dict]:
        """Get pending research proposals for Archivist review.

        Args:
            limit: Maximum number of proposals to return

        Returns:
            List of proposal dicts with status='pending'
        """
        db = await get_postgres_client()

        rows = await db.fetch(
            """
            SELECT id, source_type, source_url, paper_id, title, abstract,
                   findings, is_framework_change, framework_name, previous_version,
                   new_version, status, proposed_at, harvester_run_id
            FROM research_proposals
            WHERE status = 'pending' AND archivist_reviewed = FALSE
            ORDER BY proposed_at ASC
            LIMIT $1
            """,
            limit,
        )

        proposals = []
        for row in rows:
            proposal = dict(row)
            if proposal.get("findings"):
                proposal["findings"] = list(proposal["findings"])
            proposals.append(proposal)

        return proposals

    async def mark_reviewed(self, proposal_id: str, audn_action: str) -> None:
        """Mark a proposal as reviewed by the Archivist.

        Args:
            proposal_id: UUID of the proposal
            audn_action: AUDN action taken (ADD, UPDATE, DELETE, NONE, CONFLICT)
        """
        db = await get_postgres_client()

        await db.execute(
            """
            UPDATE research_proposals
            SET status = $1, archivist_reviewed = TRUE, audn_action = $2, reviewed_at = NOW()
            WHERE id = $3
            """,
            "reviewed",
            audn_action,
            UUID(proposal_id),
        )

    async def get_framework_versions(self) -> dict[str, str]:
        """Get known framework versions.

        Returns:
            Dict of framework_name -> current version
        """
        db = await get_postgres_client()

        rows = await db.fetch(
            """
            SELECT framework_name, version
            FROM framework_versions
            WHERE id IN (
                SELECT DISTINCT ON (framework_name) id
                FROM framework_versions
                ORDER BY framework_name, created_at DESC
            )
            """
        )

        return {row["framework_name"]: row["version"] for row in rows}

    async def upsert_framework_version(
        self,
        framework: str,
        version: str,
        is_major: bool = False,
        changelog_url: str = "",
    ) -> None:
        """Insert or update a framework version.

        Args:
            framework: Framework name (e.g., "Gymnasium")
            version: Version string (e.g., "0.29.1")
            is_major: Whether this is a major version bump
            changelog_url: URL to the changelog/release notes
        """
        db = await get_postgres_client()

        await db.execute(
            """
            INSERT INTO framework_versions (framework_name, version, is_major, changelog_url)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (framework_name, version) DO NOTHING
            """,
            framework,
            version,
            is_major,
            changelog_url,
        )

    async def mark_framework_change_proposal(self, proposal_id: str, change: dict) -> None:
        """Mark a proposal as a framework change.

        Args:
            proposal_id: UUID of the proposal
            change: FrameworkChange dict with framework_name, previous_version, new_version
        """
        db = await get_postgres_client()

        await db.execute(
            """
            UPDATE research_proposals
            SET is_framework_change = TRUE,
                framework_name = $1,
                previous_version = $2,
                new_version = $3
            WHERE id = $4
            """,
            change.get("framework_name"),
            change.get("previous_version"),
            change.get("new_version"),
            UUID(proposal_id),
        )
