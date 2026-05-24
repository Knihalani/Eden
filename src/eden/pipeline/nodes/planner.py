"""Planner node for LangGraph pipeline."""

from eden.agents.planner.agent import PlannerAgent
from eden.pipeline.state import EdenJobState


async def planner_node(state: EdenJobState) -> dict:
    """Run the Planner agent and update state with EDP.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Planner agent
    """
    agent = PlannerAgent()
    result = await agent.run(state)
    return result