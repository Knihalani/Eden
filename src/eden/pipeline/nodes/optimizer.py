"""Optimizer node for LangGraph pipeline."""

from eden.agents.optimizer.agent import OptimizerAgent
from eden.pipeline.state import EdenJobState


async def optimizer_node(state: EdenJobState) -> dict:
    """Run the Optimizer agent and update state with optimized code.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Optimizer agent
    """
    agent = OptimizerAgent()
    result = await agent.run(state)
    return result