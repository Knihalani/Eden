"""Research Expert node for LangGraph pipeline."""

from eden.pipeline.state import EdenJobState


async def research_expert_node(state: EdenJobState) -> dict:
    """Run the Research Expert agent and update state with research findings.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Research Expert agent
    """
    from eden.agents.experts.research_expert.agent import ResearchExpertAgent

    agent = ResearchExpertAgent()
    result = await agent.run(state)
    return result