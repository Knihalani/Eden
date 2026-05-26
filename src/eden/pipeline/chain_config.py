"""Chain configuration for the Eden pipeline."""

from enum import Enum
from typing import Callable, Optional

from pydantic import BaseModel, Field


class AgentCategory(Enum):
    """Category classification for pipeline agents."""

    CORE = "core"  # Required agents, always part of the chain
    OPTIONAL = "optional"  # Toggleable expert agents
    BENCHMARK = "benchmark"  # Evaluation-only agents


class AgentDefinition(BaseModel):
    """Definition of a single agent in the chain configuration."""

    name: str = Field(..., description="Unique agent name")
    category: AgentCategory = Field(..., description="Agent category")
    node_function: Optional[Callable] = Field(None, description="Node function for the graph")
    is_mutable: bool = Field(False, description="Whether this agent can be toggled at runtime")
    position: int = Field(..., description="Execution order position in the chain")


class ChainConfig(BaseModel):
    """Mutable chain configuration for the Eden pipeline.

    This model allows runtime toggling of optional agents and supports
    the expert agent pattern where certain agents can be enabled/disabled
    based on job requirements.
    """

    version: str = Field("1.0", description="Configuration version")

    # Core agents - required, always part of the chain
    core_agents: list[str] = Field(
        default=[
            "planner",
            "critic",
            "refiner",
            "fact_checker",
            "executor",
            "optimizer",
            "code_quality",
            "verifier",
            "tester",
            "archivist",
        ],
        description="List of core agent names (always enabled)",
    )

    # Toggleable expert agents
    enabled_expert_agents: list[str] = Field(
        default=[],
        description="Expert agents to enable for this pipeline run",
    )

    # Optional agents that are disabled by default
    disabled_optional_agents: list[str] = Field(
        default=[],
        description="Optional agents explicitly disabled",
    )

    def get_active_agents(self) -> list[str]:
        """Get the list of currently active agent names.

        Returns:
            Combined list of core agents plus enabled expert agents,
            excluding any explicitly disabled agents.
        """
        # Start with core agents
        active = list(self.core_agents)

        # Add enabled expert agents that aren't already in core
        for expert in self.enabled_expert_agents:
            if expert not in active and expert not in self.disabled_optional_agents:
                active.append(expert)

        return active

    def enable_expert(self, agent_name: str) -> None:
        """Enable an expert agent.

        Args:
            agent_name: Name of the expert agent to enable
        """
        if agent_name not in self.enabled_expert_agents:
            self.enabled_expert_agents.append(agent_name)

    def disable_expert(self, agent_name: str) -> None:
        """Disable an expert agent.

        Args:
            agent_name: Name of the expert agent to disable
        """
        if agent_name in self.enabled_expert_agents:
            self.enabled_expert_agents.remove(agent_name)
        if agent_name not in self.disabled_optional_agents:
            self.disabled_optional_agents.append(agent_name)

    def is_agent_active(self, agent_name: str) -> bool:
        """Check if an agent is currently active.

        Args:
            agent_name: Name of the agent to check

        Returns:
            True if the agent is in the active chain
        """
        return agent_name in self.get_active_agents()