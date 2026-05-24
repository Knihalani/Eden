"""Refiner node for LangGraph pipeline."""

from eden.agents.refiner.agent import RefinerAgent
from eden.pipeline.state import EdenJobState


async def refiner_node(state: EdenJobState) -> dict:
    """Run the Refiner agent and update state with RES.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Refiner agent
    """
    agent = RefinerAgent()
    result = await agent.run(state)
    return result