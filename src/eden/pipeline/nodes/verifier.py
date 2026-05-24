"""Verifier node for LangGraph pipeline."""

from eden.agents.verifier.agent import VerifierAgent
from eden.pipeline.state import EdenJobState


async def verifier_node(state: EdenJobState) -> dict:
    """Run the Verifier agent and update state with verification report.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Verifier agent
    """
    agent = VerifierAgent()
    result = await agent.run(state)
    return result