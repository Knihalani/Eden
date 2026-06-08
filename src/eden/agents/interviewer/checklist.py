"""Interview checklist schema and state tracking.

Defines the structured fields that the InterviewerAgent must collect from the user
before generating a spec. Uses a hybrid approach: fixed checklist for required fields
plus Socratic depth probing for optional/depth fields.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional, Any

logger = logging.getLogger(__name__)


class FieldStatus(str, Enum):
    """Status of a checklist field."""

    PENDING = "pending"
    COLLECTED = "collected"
    NEEDS_CLARIFICATION = "needs_clarification"
    SKIPPED = "skipped"


class FieldDepth(str, Enum):
    """Depth level required for a field."""

    REQUIRED = "required"      # Must have before spec generation
    RECOMMENDED = "recommended"  # Strongly encouraged; blocks spec if missing
    OPTIONAL = "optional"        # Nice to have; spec can proceed without


@dataclass
class ChecklistField:
    """Definition of a single checklist field."""

    name: str
    description: str
    category: str
    depth: FieldDepth
    # Socratic probing: sub-questions to ask for depth
    depth_questions: list[str] = field(default_factory=list)
    # Example values to show the user
    examples: list[str] = field(default_factory=list)
    # Whether this field can be inferred from others
    inferrable: bool = False
    # Parser hint for extracting from conversation
    parser_hint: str = ""


@dataclass
class FieldState:
    """Runtime state of a single checklist field."""

    field_name: str
    status: FieldStatus = FieldStatus.PENDING
    # The collected value (can be any type)
    value: Any = None
    # Confidence 0.0-1.0 that we correctly understood the value
    confidence: float = 0.0
    # Which turn this field was collected on
    collected_at_turn: Optional[int] = None
    # Notes from Socratic probing
    depth_notes: list[str] = field(default_factory=list)
    # Whether the user explicitly confirmed this field
    user_confirmed: bool = False


@dataclass
class ChecklistState:
    """Complete state of the interview checklist."""

    fields: dict[str, FieldState] = field(default_factory=dict)
    # Overall readiness score 0.0-1.0
    readiness_score: float = 0.0
    # Number of turns so far
    turn_count: int = 0
    # Whether the user has explicitly said they're done
    user_marked_complete: bool = False
    # Which fields were explicitly skipped by the user
    skipped_fields: list[str] = field(default_factory=list)

    def _safe_value(self, value: Any) -> Any:
        """Coerce field values to JSON-serializable types."""
        if value is None:
            return None
        if isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, (list, tuple)):
            return [self._safe_value(v) for v in value]
        if isinstance(value, dict):
            return {str(k): self._safe_value(v) for k, v in value.items()}
        # Fallback: convert to string
        return str(value)

    def to_dict(self) -> dict:
        """Serialize to dict for API responses."""
        return {
            "fields": {
                name: {
                    "status": fs.status.value,
                    "value": self._safe_value(fs.value),
                    "confidence": fs.confidence,
                    "collected_at_turn": fs.collected_at_turn,
                    "depth_notes": fs.depth_notes,
                    "user_confirmed": fs.user_confirmed,
                }
                for name, fs in self.fields.items()
            },
            "readiness_score": self.readiness_score,
            "turn_count": self.turn_count,
            "user_marked_complete": self.user_marked_complete,
            "skipped_fields": list(dict.fromkeys(self.skipped_fields)),  # deduplicate, preserve order
        }

    @classmethod
    def from_dict(cls, data: dict) -> ChecklistState:
        """Deserialize from dict."""
        fields = {}
        for name, fs_data in data.get("fields", {}).items():
            fields[name] = FieldState(
                field_name=name,
                status=FieldStatus(fs_data.get("status", "pending")),
                value=fs_data.get("value"),
                confidence=fs_data.get("confidence", 0.0),
                collected_at_turn=fs_data.get("collected_at_turn"),
                depth_notes=fs_data.get("depth_notes", []),
                user_confirmed=fs_data.get("user_confirmed", False),
            )
        return cls(
            fields=fields,
            readiness_score=data.get("readiness_score", 0.0),
            turn_count=data.get("turn_count", 0),
            user_marked_complete=data.get("user_marked_complete", False),
            skipped_fields=data.get("skipped_fields", []),
        )


# ============================================================================
# CHECKLIST FIELD DEFINITIONS
# ============================================================================

CHECKLIST_FIELDS: list[ChecklistField] = [
    # ------------------------------------------------------------------------
    # CORE — Required for any spec
    # ------------------------------------------------------------------------
    ChecklistField(
        name="environment_class",
        description="The high-level category of environment to build. Examples: agent_sandbox, llm_agent_eval, tool_use, multi_agent, adversarial, simulation, or custom.",
        category="core",
        depth=FieldDepth.REQUIRED,
        examples=["agent_sandbox", "llm_agent_eval", "multi_agent", "simulation"],
        parser_hint="Look for a noun phrase describing the environment type or purpose.",
    ),
    ChecklistField(
        name="observation_modality",
        description="How the agent perceives the environment. Examples: discrete, continuous, image, language, graph, multimodal, or custom.",
        category="core",
        depth=FieldDepth.REQUIRED,
        examples=["discrete", "continuous", "image", "language", "graph", "multimodal"],
        parser_hint="Look for sensory or data-format descriptors.",
    ),
    ChecklistField(
        name="description",
        description="A clear, detailed description of what the environment should do, the problem it solves, and the desired behavior.",
        category="core",
        depth=FieldDepth.REQUIRED,
        examples=[
            "A grid-world navigation task where an agent must find the shortest path to a goal while avoiding dynamic obstacles.",
            "A turn-based strategy game where two agents compete to control territory on a hex grid.",
        ],
        parser_hint="This is usually the user's opening message. Extract the main intent and any constraints.",
    ),
    ChecklistField(
        name="framework",
        description="The RL framework or platform to target. Examples: gymnasium, pettingzoo, ml-agents, custom.",
        category="core",
        depth=FieldDepth.REQUIRED,
        examples=["gymnasium", "pettingzoo", "ml-agents", "custom"],
        parser_hint="Look for framework names or 'custom'.",
    ),
    ChecklistField(
        name="output_mode",
        description="How the output should be delivered. Examples: gymnasium_mode (single env class), pettingzoo_mode (multi-agent), api_mode (HTTP service), library_mode (pip-installable package).",
        category="core",
        depth=FieldDepth.REQUIRED,
        examples=["gymnasium_mode", "pettingzoo_mode", "api_mode", "library_mode"],
        parser_hint="Look for delivery-mode keywords.",
    ),

    # ------------------------------------------------------------------------
    # ENVIRONMENT DESIGN — Required for a complete EDP
    # ------------------------------------------------------------------------
    ChecklistField(
        name="observation_space",
        description="The structure of what the agent observes: type (Box, Discrete, Dict, Tuple, Graph), shape, bounds, and why this representation is sufficient for the task.",
        category="environment",
        depth=FieldDepth.REQUIRED,
        depth_questions=[
            "What information does the agent need to see to act optimally?",
            "Are there any partial observability concerns?",
            "Would a different representation (e.g., image vs. vector) be better?",
        ],
        examples=[
            "Box(continuous) shape=(84,84,3) for raw pixels",
            "Dict({'position': Box(2,), 'velocity': Box(2,), 'target': Box(2,)})",
        ],
        parser_hint="Look for shape, dimensions, data types, or sensor descriptions.",
    ),
    ChecklistField(
        name="action_space",
        description="The structure of what the agent can do: type (Discrete, Box, MultiDiscrete), dimensionality, bounds, and why these actions are meaningful for the task.",
        category="environment",
        depth=FieldDepth.REQUIRED,
        depth_questions=[
            "What are the atomic actions available to the agent?",
            "Are actions continuous or discrete?",
            "Is there a no-op / idle action?",
            "Can multiple actions be taken simultaneously?",
        ],
        examples=[
            "Discrete(4): up, down, left, right",
            "Box(-1.0, 1.0, (2,)) for continuous steering and throttle",
        ],
        parser_hint="Look for action verbs, control descriptions, or dimensionality info.",
    ),
    ChecklistField(
        name="reward_structure",
        description="How the agent is rewarded: type (dense, sparse, shaped, verifiable, none), components with formulas, and known reward-hacking risks with mitigations.",
        category="environment",
        depth=FieldDepth.REQUIRED,
        depth_questions=[
            "What behavior should be rewarded positively?",
            "What behavior should be penalized?",
            "Could the agent find a shortcut or loophole in the reward?",
            "Is the reward verifiable by an external oracle?",
        ],
        examples=[
            "Dense: -distance_to_goal per step + 100 on success",
            "Sparse: +1 only on task completion",
        ],
        parser_hint="Look for numeric formulas, scoring rules, or incentive descriptions.",
    ),
    ChecklistField(
        name="episode_dynamics",
        description="How episodes work: termination conditions, max steps, reset logic, stochasticity, and any special episode-level rules.",
        category="environment",
        depth=FieldDepth.REQUIRED,
        depth_questions=[
            "When does an episode end?",
            "Is there a maximum step count per episode?",
            "How is the initial state determined on reset?",
            "Is there randomness in the environment?",
            "Can the environment be multi-episode (e.g., curriculum)?",
        ],
        examples=[
            "Terminate on goal reached or max 1000 steps. Reset to random start position.",
            "Episode ends when health reaches 0. Stochastic enemy AI.",
        ],
        parser_hint="Look for termination words, step limits, reset descriptions, or randomness mentions.",
    ),

    # ------------------------------------------------------------------------
    # DIFFICULTY & CALIBRATION
    # ------------------------------------------------------------------------
    ChecklistField(
        name="difficulty_parameters",
        description="Adjustable axes of difficulty: what can be tuned, default values, and valid ranges.",
        category="difficulty",
        depth=FieldDepth.RECOMMENDED,
        depth_questions=[
            "Should difficulty be adjustable at runtime?",
            "What are the easiest and hardest valid settings?",
            "Should difficulty adapt automatically based on agent performance?",
        ],
        examples=[
            "{'map_size': {'default': 10, 'min': 5, 'max': 50}, 'obstacle_density': {'default': 0.2, 'min': 0.0, 'max': 0.8}}",
        ],
        inferrable=True,
        parser_hint="Look for tunable parameters, sliders, or difficulty settings.",
    ),

    # ------------------------------------------------------------------------
    # OUTPUT SPEC
    # ------------------------------------------------------------------------
    ChecklistField(
        name="language",
        description="Programming language for the generated environment. Usually python.",
        category="output",
        depth=FieldDepth.RECOMMENDED,
        examples=["python", "typescript", "c++"],
        inferrable=True,
        parser_hint="Look for programming language mentions.",
    ),
    ChecklistField(
        name="framework_version",
        description="Specific version of the target framework.",
        category="output",
        depth=FieldDepth.OPTIONAL,
        examples=["0.29", "1.0", "latest"],
        inferrable=True,
        parser_hint="Look for version numbers after framework names.",
    ),
    ChecklistField(
        name="interface_contract",
        description="Any specific API contract the environment must implement: method signatures, return types, or external interfaces.",
        category="output",
        depth=FieldDepth.OPTIONAL,
        depth_questions=[
            "Does the environment need to implement a specific base class?",
            "Are there required methods beyond reset() and step()?",
            "Does it need to expose additional APIs (e.g., render, close, seed)?",
        ],
        examples=["Must inherit from gymnasium.Env and implement render(mode='human')"],
        parser_hint="Look for class names, method requirements, or interface descriptions.",
    ),
    ChecklistField(
        name="entry_class",
        description="The main class name or entry point for the environment.",
        category="output",
        depth=FieldDepth.OPTIONAL,
        examples=["GridWorldEnv", "CombatArena", "TradingSimulator"],
        parser_hint="Look for proposed class names or capitalized nouns describing the environment.",
    ),

    # ------------------------------------------------------------------------
    # RISKS & DECISIONS
    # ------------------------------------------------------------------------
    ChecklistField(
        name="known_risks",
        description="Known risks or failure modes the user is aware of: reward hacking, sim-to-real gap, partial observability traps, etc.",
        category="risks",
        depth=FieldDepth.RECOMMENDED,
        depth_questions=[
            "Have you seen agents exploit shortcuts in similar environments?",
            "Is there a risk of the agent learning the wrong behavior?",
            "Are there real-world constraints not captured in simulation?",
        ],
        examples=["Reward hacking by looping near goal without completing task", "Agents may learn to stall rather than act"],
        parser_hint="Look for concern words, failure descriptions, or cautionary notes.",
    ),
    ChecklistField(
        name="design_decisions",
        description="Key design decisions the user has already made or has strong opinions about.",
        category="risks",
        depth=FieldDepth.OPTIONAL,
        depth_questions=[
            "Are there design choices you're committed to?",
            "Is there anything you explicitly do NOT want?",
            "Are there trade-offs you've already accepted?",
        ],
        examples=["Must use continuous action space, not discrete", "No image observations—vector state only"],
        parser_hint="Look for strong preference words, explicit exclusions, or trade-off mentions.",
    ),

    # ------------------------------------------------------------------------
    # USER CONTEXT — Helps tailor the interview and spec
    # ------------------------------------------------------------------------
    ChecklistField(
        name="user_intent",
        description="The underlying goal: what is the user trying to achieve with this environment? Research, production, education, benchmarking?",
        category="context",
        depth=FieldDepth.RECOMMENDED,
        depth_questions=[
            "What is the end goal of training an agent in this environment?",
            "Is this for research, production, or learning?",
            "What metric will tell you this environment is successful?",
        ],
        examples=["Research on emergent cooperation", "Production tool-use benchmark", "Curriculum learning baseline"],
        parser_hint="Look for purpose words, end goals, or success descriptions.",
    ),
    ChecklistField(
        name="constraints",
        description="Hard constraints: compute limits, latency requirements, licensing, external dependencies, etc.",
        category="context",
        depth=FieldDepth.OPTIONAL,
        depth_questions=[
            "Are there compute or latency constraints?",
            "Are there licensing or IP restrictions?",
            "Must the environment integrate with existing infrastructure?",
        ],
        examples=["Must run on CPU only", "Step latency < 10ms", "Must use only MIT-licensed dependencies"],
        parser_hint="Look for restriction words, performance requirements, or dependency mentions.",
    ),
    ChecklistField(
        name="success_criteria",
        description="How the user will judge whether the generated environment is good.",
        category="context",
        depth=FieldDepth.OPTIONAL,
        depth_questions=[
            "What does 'good' look like for this environment?",
            "Are there existing baselines you want to beat?",
            "Will you run A/B tests against a current environment?",
        ],
        examples=["Agent should reach 90% success rate within 1M steps", "Must be at least 2x faster than current env"],
        parser_hint="Look for metric targets, performance thresholds, or comparison descriptions.",
    ),
    ChecklistField(
        name="integration_requirements",
        description="How the environment fits into a larger system: data formats, APIs, orchestration tools, etc.",
        category="context",
        depth=FieldDepth.OPTIONAL,
        examples=["Must output trajectories in D4RL format", "Must expose a REST API for remote evaluation"],
        parser_hint="Look for system integration words, format requirements, or API descriptions.",
    ),
]


# Build lookup maps
FIELD_BY_NAME: dict[str, ChecklistField] = {f.name: f for f in CHECKLIST_FIELDS}
FIELDS_BY_CATEGORY: dict[str, list[ChecklistField]] = {}
for f in CHECKLIST_FIELDS:
    FIELDS_BY_CATEGORY.setdefault(f.category, []).append(f)


def create_default_checklist_state() -> ChecklistState:
    """Create a fresh checklist state with all fields pending."""
    fields = {
        f.name: FieldState(field_name=f.name, status=FieldStatus.PENDING)
        for f in CHECKLIST_FIELDS
    }
    return ChecklistState(fields=fields)


def compute_readiness_score(state: ChecklistState) -> float:
    """Compute how ready we are to generate a spec.

    Returns a score 0.0-1.0 based on:
    - All REQUIRED fields must be collected (50% of score)
    - RECOMMENDED fields contribute 30%
    - OPTIONAL fields contribute 20%
    """
    required_total = 0
    required_done = 0
    recommended_total = 0
    recommended_done = 0
    optional_total = 0
    optional_done = 0

    for field_def in CHECKLIST_FIELDS:
        fs = state.fields.get(field_def.name)
        if not fs:
            continue

        if field_def.depth == FieldDepth.REQUIRED:
            required_total += 1
            if fs.status == FieldStatus.COLLECTED:
                required_done += 1
        elif field_def.depth == FieldDepth.RECOMMENDED:
            recommended_total += 1
            if fs.status == FieldStatus.COLLECTED:
                recommended_done += 1
        elif field_def.depth == FieldDepth.OPTIONAL:
            optional_total += 1
            if fs.status == FieldStatus.COLLECTED:
                optional_done += 1

    req_score = required_done / required_total if required_total > 0 else 1.0
    rec_score = recommended_done / recommended_total if recommended_total > 0 else 1.0
    opt_score = optional_done / optional_total if optional_total > 0 else 1.0

    # Weighted: required=50%, recommended=30%, optional=20%
    return round(req_score * 0.5 + rec_score * 0.3 + opt_score * 0.2, 3)


def is_ready_for_spec(state: ChecklistState, min_score: float = 0.7) -> bool:
    """Check if the checklist has enough information to generate a spec.

    Args:
        state: Current checklist state
        min_score: Minimum readiness score (default 0.7 = all required + some recommended)

    Returns:
        True if ready to generate spec
    """
    score = compute_readiness_score(state)

    # Must have all required fields collected or explicitly skipped
    required_fields = [f for f in CHECKLIST_FIELDS if f.depth == FieldDepth.REQUIRED]
    all_required_collected = all(
        state.fields.get(f.name, FieldState(field_name=f.name)).status in (
            FieldStatus.COLLECTED,
            FieldStatus.SKIPPED,
        )
        for f in required_fields
    )

    # Either user says they're done AND all required are collected,
    # or readiness score exceeds threshold
    return all_required_collected and (state.user_marked_complete or score >= min_score)


def get_next_priority_fields(state: ChecklistState, limit: int = 3) -> list[ChecklistField]:
    """Get the next fields the interviewer should focus on.

    Priority order:
    1. REQUIRED fields that are still PENDING
    2. REQUIRED fields that need clarification
    3. RECOMMENDED fields that are PENDING
    4. OPTIONAL fields that are PENDING

    Args:
        state: Current checklist state
        limit: Max fields to return

    Returns:
        List of field definitions to focus on next
    """
    candidates = []

    for field_def in CHECKLIST_FIELDS:
        fs = state.fields.get(field_def.name)
        if not fs:
            continue

        if fs.status == FieldStatus.COLLECTED:
            continue
        if field_def.name in state.skipped_fields:
            continue

        # Priority scoring: lower = higher priority
        if field_def.depth == FieldDepth.REQUIRED:
            priority = 0 if fs.status == FieldStatus.PENDING else 1
        elif field_def.depth == FieldDepth.RECOMMENDED:
            priority = 2
        else:
            priority = 3

        candidates.append((priority, field_def))

    candidates.sort(key=lambda x: x[0])
    return [f for _, f in candidates[:limit]]


def update_field_from_llm(
    state: ChecklistState,
    field_name: str,
    value: Any,
    confidence: float = 0.8,
    notes: Optional[list[str]] = None,
) -> None:
    """Update a field in the checklist state from LLM extraction.

    Args:
        state: ChecklistState to mutate
        field_name: Name of the field to update
        value: Extracted value
        confidence: Confidence 0.0-1.0
        notes: Optional depth notes from Socratic probing
    """
    if field_name not in state.fields:
        logger.warning(f"Attempted to update unknown field: {field_name}")
        return

    fs = state.fields[field_name]
    fs.value = value
    fs.confidence = confidence
    fs.status = FieldStatus.COLLECTED
    fs.collected_at_turn = state.turn_count
    if notes:
        fs.depth_notes.extend(notes)

    # Recompute readiness
    state.readiness_score = compute_readiness_score(state)


def mark_field_clarification_needed(state: ChecklistState, field_name: str, reason: str) -> None:
    """Mark a field as needing clarification.

    Args:
        state: ChecklistState to mutate
        field_name: Field to mark
        reason: Why clarification is needed
    """
    if field_name not in state.fields:
        return

    fs = state.fields[field_name]
    fs.status = FieldStatus.NEEDS_CLARIFICATION
    fs.depth_notes.append(f"Clarification needed: {reason}")
