"""Eden LangGraph pipeline definition."""

import logging
from typing import Literal

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


def build_eden_graph():
    """Build the Eden pipeline graph."""
    graph = StateGraph(EdenJobState)

    # Add all nodes using actual node functions
    graph.add_node("planner", planner_node)
    graph.add_node("critic", critic_node)
    graph.add_node("refiner", refiner_node)
    graph.add_node("fact_checker", fact_checker_node)
    graph.add_node("executor", executor_node)
    graph.add_node("code_quality", code_quality_node)
    graph.add_node("verifier", verifier_node)
    graph.add_node("tester", tester_node)
    graph.add_node("archivist", archivist_node)

    # Define edges
    graph.add_edge("planner", "critic")
    graph.add_conditional_edges("critic", critic_router)
    graph.add_edge("refiner", "fact_checker")
    graph.add_edge("fact_checker", "executor")
    graph.add_edge("executor", "code_quality")
    graph.add_conditional_edges("code_quality", code_quality_router)
    graph.add_conditional_edges("verifier", verifier_router)
    graph.add_conditional_edges("tester", tester_router)
    graph.add_edge("archivist", END)

    # Set entry point
    graph.set_entry_point("planner")

    return graph


def compile_eden_graph(checkpointer=None, interrupt_before_archivist=True):
    """Compile the Eden graph with checkpointer and interrupts."""
    graph = build_eden_graph()

    compiled = graph.compile(checkpointer=checkpointer)

    return compiled