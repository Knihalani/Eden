"""Eden Multi-Agent Environment Generation — v1.

Provides communication abstractions, agent roles, memory tiers, planning
frameworks, and test suites for multi-agent environments.

Architecture references:
    • eden-multi-agent-orchestration-architecture.md §2–8
    • eden-development-roadmap.md §6.8
"""

from eden.multi_agent.agent_roles import (
    ActionResult,
    ActionType,
    AgentObjective,
    AgentRole,
    HITLManager,
    RoleConfig,
    RoleHierarchy,
    RoleSystem,
)
from eden.multi_agent.communication import (
    Blackboard,
    BlackboardEntry,
    BlackboardEnvironment,
    Message,
    MessageBus,
    MessagePassingEnvironment,
    MessageType,
    SharedState,
    SharedStateManager,
)
from eden.multi_agent.memory_tiers import (
    EpisodicMemory,
    MemoryService,
    MemoryTier,
    Observation,
    SemanticMemory,
    WorkingMemory,
)
from eden.multi_agent.planning import (
    ChainOfThoughtEnvironment,
    EpisodeResult,
    PlanAndExecuteEnvironment,
    PlanningFramework,
    PlanStep,
    ReActEnvironment,
    ReflexionEnvironment,
    ThoughtNode,
    TreeOfThoughtsEnvironment,
)
from eden.multi_agent.test_suite import (
    AdversarialTest,
    ConsensusTest,
    DeterminismTest,
    MessageDeliveryTest,
    MultiAgentTestSuite,
    StateConsistencyTest,
    TestResult,
)

__all__ = [
    # Communication
    "Message",
    "MessageType",
    "MessageBus",
    "SharedState",
    "SharedStateManager",
    "BlackboardEntry",
    "Blackboard",
    "MessagePassingEnvironment",
    "BlackboardEnvironment",
    # Roles
    "AgentRole",
    "RoleConfig",
    "AgentObjective",
    "RoleSystem",
    "RoleHierarchy",
    "HITLManager",
    "ActionType",
    "ActionResult",
    # Memory
    "WorkingMemory",
    "EpisodicMemory",
    "SemanticMemory",
    "MemoryService",
    "Observation",
    "MemoryTier",
    # Planning
    "PlanningFramework",
    "ReActEnvironment",
    "TreeOfThoughtsEnvironment",
    "PlanAndExecuteEnvironment",
    "ReflexionEnvironment",
    "ChainOfThoughtEnvironment",
    "ThoughtNode",
    "PlanStep",
    "EpisodeResult",
    # Test Suite
    "MultiAgentTestSuite",
    "DeterminismTest",
    "MessageDeliveryTest",
    "StateConsistencyTest",
    "ConsensusTest",
    "AdversarialTest",
    "TestResult",
]
