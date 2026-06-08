"""Adversarial Tester node for LangGraph pipeline."""

from eden.agents.adversarial_tester.agent import AdversarialTesterAgent
from eden.pipeline.state import EdenJobState


async def adversarial_tester_node(state: EdenJobState) -> dict:
    """Run the Adversarial Tester agent and update state with findings.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Adversarial Tester agent
    """
    agent = AdversarialTesterAgent()
    result = await agent.run(state)
    return result