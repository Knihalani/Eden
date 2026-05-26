"""Eden LangGraph pipeline definition."""

import logging
from typing import Literal, Optional

from langgraph.graph import StateGraph, END, Command

from eden.pipeline.state import EdenJobState, create_initial_state
from eden.pipeline.nodes import (
    planner_node,
    critic_node,
    refiner_node,
    fact_checker_node,
    executor_node,
    code_quality_node,
    verifier_node,
    tester_node,
    archivist_node,
)
from eden.pipeline.chain_builder import (
    register_node,
    register_router,
    build_chain,
    build_graph_from_chain,
    NODE_REGISTRY,
    ROUTER_REGISTRY,
    ChainConfig,
)

logger = logging.getLogger(__name__)

# Define pipeline stages for routing
STAGES = Literal[
    "planning",
    "criticizing",
    "refining",
    "fact_checking",
    "executing",
    "code_quality",
    "verifying",
    "testing",
    "archiving",
    "completed",
    "failed",
    "human_review",
]


def _register_core_nodes():
    """Register all core pipeline nodes with the chain builder."""
    register_node("planner", planner_node)
    register_node("critic", critic_node)
    register_node("refiner", refiner_node)
    register_node("fact_checker", fact_checker_node)
    register_node("executor", executor_node)
    register_node("code_quality", code_quality_node)
    register_node("verifier", verifier_node)
    register_node("tester", tester_node)
    register_node("archivist", archivist_node)


def _register_routers():
    """Register all routers with the chain builder."""
    register_router("critic_router", critic_router)
    register_router("code_quality_router", code_quality_router)
    register_router("verifier_router", verifier_router)
    register_router("tester_router", tester_router)


def critic_router(state: EdenJobState) -> str:
    """Route after Critic decision."""
    if not state.get("critic_decisions"):
        return "refining"

    last_decision = state["critic_decisions"][-1]
    routing = last_decision.get("routing", "approve")

    if routing == "approve":
        return "refining"
    elif routing == "targeted_replan":
        if state["critic_replan_count"] >= 3:
            logger.warning(f"Job {state['job_id']}: exceeded replan limit, escalating")
            return "human_review"
        return "planning"
    else:  # full_reresearch
        if state["critic_reresearch_count"] >= 2:
            logger.warning(f"Job {state['job_id']}: exceeded re-research limit, escalating")
            return "human_review"
        return "planning"


def code_quality_router(state: EdenJobState) -> str:
    """Route after Code Quality Pipeline."""
    if not state.get("quality_reports"):
        return "verifying"

    last_report = state["quality_reports"][-1]
    if last_report.get("passed"):
        return "verifying"
    else:
        if state["code_quality_iterations"] >= 8:
            logger.error(f"Job {state['job_id']}: exceeded code quality iterations")
            return "human_review"
        return "executing"


def verifier_router(state: EdenJobState) -> str:
    """Route after Verifier decision."""
    if not state.get("verifier_report"):
        return "testing"

    report = state["verifier_report"]
    if report.get("passed"):
        return "testing"
    else:
        if state["executor_iterations"] >= 5:
            logger.warning(f"Job {state['job_id']}: exceeded executor iterations")
            # Check if it's design-level
            if report.get("design_level"):
                return "verifier"  # Go back to verifier which escalates
            return "human_review"
        return "executing"


def tester_router(state: EdenJobState) -> str:
    """Route after Tester results."""
    if not state.get("tester_results"):
        return "archiving"

    results = state["tester_results"]
    category = results.get("category", "passed")

    if category == "patch_level":
        if state["executor_iterations"] >= 5:
            return "human_review"
        return "executing"

    elif category == "design_level":
        if state["executor_iterations"] >= 3:
            return "human_review"
        return "verifier"

    elif category == "fundamental":
        # Loops back to Planner with failure analysis
        return "planning"

    else:  # passed or archiving
        return "archiving"


def build_eden_graph(config: Optional[ChainConfig] = None):
    """Build the Eden pipeline graph using chain builder pattern.

    Args:
        config: Optional ChainConfig to customize the graph construction.
                If None, uses default edges.

    Returns:
        StateGraph instance (uncompiled).
    """
    # Register core nodes and routers
    _register_core_nodes()
    _register_routers()

    # Build chain from config or use default
    chain = build_chain(config)

    # Build graph from chain
    graph = build_graph_from_chain(chain)

    return graph


def compile_eden_graph(
    checkpointer=None,
    interrupt_before_nodes: Optional[list[str]] = None,
    config: Optional[ChainConfig] = None,
):
    """Compile the Eden graph with checkpointer and interrupts.

    Args:
        checkpointer: Optional checkpointer for state persistence.
        interrupt_before_nodes: Optional list of node names to interrupt before.
        config: Optional ChainConfig to customize the graph construction.
                If None, uses default edges.

    Returns:
        Compiled graph ready for execution.
    """
    # Register core nodes and routers
    _register_core_nodes()
    _register_routers()

    # Build chain from config or use default
    chain = build_chain(config)

    # Build graph from chain
    graph = build_graph_from_chain(chain, checkpointer, interrupt_before_nodes)

    # Compile with checkpointer
    compiled = graph.compile(checkpointer=checkpointer)

    return compiled


# Default chain configuration for backward compatibility
DEFAULT_CHAIN_CONFIG = ChainConfig(
    edges=[
        ("planner", "critic"),
        ("critic", "critic_router"),
        ("refiner", "fact_checker"),
        ("fact_checker", "executor"),
        ("executor", "code_quality"),
        ("code_quality", "code_quality_router"),
        ("verifier", "verifier_router"),
        ("tester", "tester_router"),
        ("archivist", END),
    ],
    entry_point="planner",
)