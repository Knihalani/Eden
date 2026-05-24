"""Executor node for LangGraph pipeline."""

from eden.agents.executor.agent import ExecutorAgent
from eden.pipeline.state import EdenJobState


async def executor_node(state: EdenJobState) -> dict:
    """Run the Executor agent and update state with generated code.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Executor agent
    """
    agent = ExecutorAgent()
    result = await agent.run(state)
    return result