"""Archivist node for LangGraph pipeline."""

from eden.agents.archivist.agent import ArchivistAgent
from eden.pipeline.state import EdenJobState


async def archivist_node(state: EdenJobState) -> dict:
    """Run the Archivist agent and update state with outcome.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Archivist agent
    """
    agent = ArchivistAgent()
    result = await agent.run(state)
    return result