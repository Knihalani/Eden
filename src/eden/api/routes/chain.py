"""Chain configuration routes for Eden API."""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from eden.api.deps import require_feature_flag
from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

router = APIRouter(
    prefix="/chain",
    tags=["chain"],
    dependencies=[Depends(require_feature_flag("enable_eval_pipeline"))],
)

# Core agents (always enabled, immutable)
CORE_AGENTS = ["planner", "critic", "refiner", "executor", "verifier", "tester", "archivist"]

# Optional expert agents (can be enabled/disabled)
EXPERT_AGENTS = [
    "fact_checker",
    "code_quality",
]


class ChainConfigResponse(BaseModel):
    """Response schema for chain configuration."""

    version: str
    core_agents: list[str]
    enabled_expert_agents: list[str]
    disabled_optional_agents: list[str]


class ChainConfigUpdate(BaseModel):
    """Request schema for updating chain configuration."""

    enabled_expert_agents: Optional[list[str]] = None
    disabled_optional_agents: Optional[list[str]] = None


class AgentInfo(BaseModel):
    """Schema for agent information."""

    name: str
    category: str
    is_mutable: bool
    position: int


@router.get("/config", response_model=ChainConfigResponse)
async def get_chain_config():
    """Get current chain configuration."""
    return ChainConfigResponse(
        version=settings.app_version,
        core_agents=CORE_AGENTS.copy(),
        enabled_expert_agents=settings.chain_enabled_experts.copy(),
        disabled_optional_agents=settings.chain_disabled_optional.copy(),
    )


@router.patch("/config", response_model=ChainConfigResponse)
async def update_chain_config(update: ChainConfigUpdate):
    """Update chain configuration (enable/disable optional agents)."""
    # Validate that enabled_expert_agents are valid expert agents
    if update.enabled_expert_agents is not None:
        for agent in update.enabled_expert_agents:
            if agent not in EXPERT_AGENTS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid expert agent: {agent}. Valid agents: {EXPERT_AGENTS}",
                )

    # Validate that disabled_optional_agents are valid expert agents
    if update.disabled_optional_agents is not None:
        for agent in update.disabled_optional_agents:
            if agent not in EXPERT_AGENTS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid expert agent: {agent}. Valid agents: {EXPERT_AGENTS}",
                )

    # In a real implementation, these would be stored in the database
    # For now, we just validate and return success
    logger.info(f"Chain config update requested: {update}")

    return ChainConfigResponse(
        version=settings.app_version,
        core_agents=CORE_AGENTS.copy(),
        enabled_expert_agents=settings.chain_enabled_experts.copy(),
        disabled_optional_agents=settings.chain_disabled_optional.copy(),
    )


@router.get("/agents", response_model=list[AgentInfo])
async def list_agents():
    """List all available agents with their categories."""
    agents = []

    # Add core agents
    for position, name in enumerate(CORE_AGENTS):
        agents.append(AgentInfo(
            name=name,
            category="core",
            is_mutable=False,
            position=position,
        ))

    # Add expert agents
    for position, name in enumerate(EXPERT_AGENTS):
        agents.append(AgentInfo(
            name=name,
            category="expert",
            is_mutable=True,
            position=position,
        ))

    return agents
