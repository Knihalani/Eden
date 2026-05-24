"""Eden pipeline state definitions."""

from typing import TypedDict, Annotated, Optional
import operator


class EdenJobState(TypedDict):
    """Core state schema for the Eden pipeline.

    All pipeline agents read from and write to this state.
    Append-only lists use operator.add for thread-safe concurrent writes.
    """

    # Job identity
    job_id: str
    request: dict

    # Pipeline history (append-only, preserved for Archivist analysis)
    edp_history: Annotated[list[dict], operator.add]
    critic_decisions: Annotated[list[dict], operator.add]
    routing_history: Annotated[list[dict], operator.add]

    # Current working state
    res: Optional[dict]
    fact_check_report: Optional[dict]
    code_history: Annotated[list[str], operator.add]

    # Quality tracking (per-pass, per-iteration)
    quality_reports: Annotated[list[dict], operator.add]

    # Verification & testing
    verifier_report: Optional[dict]
    tester_results: Optional[dict]

    # KB provenance (for Archivist analysis)
    kb_reads: Annotated[list[dict], operator.add]
    agent_proposals: Annotated[list[dict], operator.add]

    # Outcome (set by Archivist)
    outcome_tier: Optional[str]
    archivist_summary: Optional[dict]

    # Iteration tracking
    executor_iterations: int
    code_quality_iterations: int
    critic_replan_count: int
    critic_reresearch_count: int

    # Routing context
    current_stage: str
    routing_target: Optional[str]
    routing_reason: Optional[str]


def create_initial_state(job_id: str, request: dict) -> EdenJobState:
    """Create initial state for a new job."""
    return EdenJobState(
        job_id=job_id,
        request=request,
        edp_history=[],
        critic_decisions=[],
        routing_history=[],
        res=None,
        fact_check_report=None,
        code_history=[],
        quality_reports=[],
        verifier_report=None,
        tester_results=None,
        kb_reads=[],
        agent_proposals=[],
        outcome_tier=None,
        archivist_summary=None,
        executor_iterations=0,
        code_quality_iterations=0,
        critic_replan_count=0,
        critic_reresearch_count=0,
        current_stage="planning",
        routing_target=None,
        routing_reason=None,
    )