"""Eden Multi-Agent Environment Generation — v1.

Provides communication abstractions, agent roles, memory tiers, planning
frameworks, and test suites for multi-agent environments.

Architecture references:
    • eden-multi-agent-orchestration-architecture.md §2–8
    • eden-development-roadmap.md §6.8
"""

from eden.multi_agent.communication import (
    Message,
    MessageType,
    MessageBus,
    SharedState,
    SharedStateManager,
    BlackboardEntry,
    Blackboard,
    MessagePassingEnvironment,
    BlackboardEnvironment,
)

from eden.multi_agent.agent_roles import (
    AgentRole,
    RoleConfig,
    AgentObjective,
    RoleSystem,
    RoleHierarchy,
    HITLManager,
    ActionType,
    ActionResult,
)

from eden.multi_agent.memory_tiers import (
    WorkingMemory,
    EpisodicMemory,
    SemanticMemory,
    MemoryService,
    Observation,
    MemoryTier,
)

from eden.multi_agent.planning import (
    PlanningFramework,
    ReActEnvironment,
    TreeOfThoughtsEnvironment,
    PlanAndExecuteEnvironment,
    ReflexionEnvironment,
    ChainOfThoughtEnvironment,
    ThoughtNode,
    PlanStep,
    EpisodeResult,
)

from eden.multi_agent.test_suite import (
    MultiAgentTestSuite,
    DeterminismTest,
    MessageDeliveryTest,
    StateConsistencyTest,
    ConsensusTest,
    AdversarialTest,
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
