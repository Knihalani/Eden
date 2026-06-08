"""InterviewerAgent — conducts Socratic interviews and generates structured specs.

The InterviewerAgent is the pre-pipeline stage of Eden. It:
1. Conducts a conversational interview with the user
2. Uses a hybrid checklist + Socratic approach to gather requirements
3. Generates a structured Environment Design Plan (EDP) when ready
4. Hands off the spec to the Planner for execution

Usage:
    agent = InterviewerAgent()
    session = InterviewSession.create()
    result = await agent.process_turn(session, "I want a grid-world navigation env")
    # result.response — the agent's conversational reply
    # result.session — updated session with checklist state
"""

from __future__ import annotations

import json
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional, Any

from eden.llm.client import OpenRouterClient, get_llm_client, LLMResponse
from eden.config import get_settings
from eden.agents.base import PromptLoader
from eden.agents.interviewer.checklist import (
    ChecklistState,
    ChecklistField,
    FieldState,
    FieldStatus,
    FieldDepth,
    CHECKLIST_FIELDS,
    create_default_checklist_state,
    compute_readiness_score,
    is_ready_for_spec,
    get_next_priority_fields,
    update_field_from_llm,
    mark_field_clarification_needed,
)
from eden.agents.interviewer.prompts import (
    INTERVIEWER_SYSTEM_PROMPT,
    SPEC_GENERATOR_SYSTEM_PROMPT,
    FIELD_EXTRACTION_PROMPT,
    build_field_list_for_prompt,
    build_checklist_context_for_prompt,
)

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class ConversationTurn:
    """A single turn in the interview conversation."""

    role: str  # "user" | "assistant" | "system"
    content: str
    turn: int
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    # Structured data extracted from this turn (for assistant turns)
    extracted_fields: Optional[dict] = None
    # Readiness score at this turn
    readiness_score: Optional[float] = None


@dataclass
class InterviewSession:
    """Full state of an interview session.

    This is the data structure stored by the API layer and passed to the agent.
    """

    session_id: str
    org_id: Optional[str] = None
    user_id: Optional[str] = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    conversation: list[ConversationTurn] = field(default_factory=list)
    checklist_state: ChecklistState = field(default_factory=create_default_checklist_state)
    spec: Optional[dict] = None
    status: str = "interviewing"  # interviewing, spec_ready, spec_generated, converted_to_job
    # Track if the user has been offered spec generation
    spec_offered: bool = False
    # Track which fields were probed with Socratic depth questions
    socratic_probes_sent: list[str] = field(default_factory=list)

    @classmethod
    def create(
        cls,
        org_id: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> InterviewSession:
        """Create a new interview session."""
        return cls(
            session_id=f"int_{uuid.uuid4().hex[:12]}",
            org_id=org_id,
            user_id=user_id,
        )

    def to_dict(self) -> dict:
        """Serialize to dict for storage/transfer."""
        return {
            "session_id": self.session_id,
            "org_id": self.org_id,
            "user_id": self.user_id,
            "created_at": self.created_at.isoformat(),
            "updated_at": self.updated_at.isoformat(),
            "conversation": [
                {
                    "role": t.role,
                    "content": t.content,
                    "turn": t.turn,
                    "timestamp": t.timestamp.isoformat(),
                    "extracted_fields": t.extracted_fields,
                    "readiness_score": t.readiness_score,
                }
                for t in self.conversation
            ],
            "checklist_state": self.checklist_state.to_dict(),
            "spec": self.spec,
            "status": self.status,
            "spec_offered": self.spec_offered,
            "socratic_probes_sent": self.socratic_probes_sent,
        }

    @classmethod
    def from_dict(cls, data: dict) -> InterviewSession:
        """Deserialize from dict."""
        return cls(
            session_id=data["session_id"],
            org_id=data.get("org_id"),
            user_id=data.get("user_id"),
            created_at=datetime.fromisoformat(data["created_at"].replace("Z", "+00:00")),
            updated_at=datetime.fromisoformat(data["updated_at"].replace("Z", "+00:00")),
            conversation=[
                ConversationTurn(
                    role=t["role"],
                    content=t["content"],
                    turn=t["turn"],
                    timestamp=datetime.fromisoformat(t["timestamp"].replace("Z", "+00:00")),
                    extracted_fields=t.get("extracted_fields"),
                    readiness_score=t.get("readiness_score"),
                )
                for t in data.get("conversation", [])
            ],
            checklist_state=(
                ChecklistState.from_dict(data["checklist_state"])
                if data.get("checklist_state") and data["checklist_state"].get("fields")
                else create_default_checklist_state()
            ),
            spec=data.get("spec"),
            status=data.get("status", "interviewing"),
            spec_offered=data.get("spec_offered", False),
            socratic_probes_sent=data.get("socratic_probes_sent", []),
        )

    def add_turn(self, role: str, content: str, extracted_fields: Optional[dict] = None) -> int:
        """Add a conversation turn and return the turn number."""
        turn = self.checklist_state.turn_count
        self.conversation.append(
            ConversationTurn(
                role=role,
                content=content,
                turn=turn,
                extracted_fields=extracted_fields,
                readiness_score=self.checklist_state.readiness_score,
            )
        )
        self.updated_at = datetime.now(timezone.utc)
        return turn


@dataclass
class TurnResult:
    """Result of processing a single turn."""

    response: str  # The conversational reply to show the user
    session: InterviewSession  # Updated session state
    ready_for_spec: bool  # Whether we have enough info for a spec
    extracted_fields: dict[str, dict]  # Fields extracted from this turn
    next_priority_fields: list[str]  # What to focus on next


class InterviewerAgent(PromptLoader):
    """Agent that interviews users and generates structured environment specs.

    The InterviewerAgent is a stateless service: it takes an InterviewSession
    and a user message, and returns an updated InterviewSession + response.
    The caller is responsible for persisting the session.
    """

    AGENT_NAME = "interviewer"

    SYSTEM_PROMPT = INTERVIEWER_SYSTEM_PROMPT

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens_interview = getattr(settings, "max_tokens_interviewer", 4000)
        self.max_tokens_spec = getattr(settings, "max_tokens_interviewer_spec", 8000)
        # Eagerly load system prompt to avoid async property issues in PromptLoader
        self._system_prompt = self.SYSTEM_PROMPT

    # ========================================================================
    # PUBLIC API
    # ========================================================================

    async def process_turn(
        self,
        session: InterviewSession,
        user_message: str,
    ) -> TurnResult:
        """Process a single user turn in the interview.

        This is the main entry point. It:
        1. Adds the user message to conversation history
        2. Extracts fields from the user message
        3. Updates the checklist
        4. Determines if ready for spec
        5. Generates the agent's next response

        Args:
            session: Current interview session state
            user_message: The user's latest message

        Returns:
            TurnResult with response, updated session, and metadata
        """
        logger.info(f"Processing turn {session.checklist_state.turn_count} for session {session.session_id}")

        # Step 1: Increment turn and record user message
        session.checklist_state.turn_count += 1
        session.add_turn("user", user_message)

        # Step 2: Extract fields from user message
        extracted = await self._extract_fields(user_message, session)
        logger.debug(f"Extracted fields: {list(extracted.keys())}")

        # Step 3: Apply extracted fields to checklist
        for field_name, field_data in extracted.items():
            update_field_from_llm(
                session.checklist_state,
                field_name,
                field_data.get("value"),
                confidence=field_data.get("confidence", 0.5),
                notes=field_data.get("notes", []),
            )

        # Step 4: Handle explicit skip/done signals
        self._handle_explicit_signals(session, user_message)

        # Step 5: Check readiness
        ready = is_ready_for_spec(session.checklist_state, min_score=0.7)

        # Step 6: Generate agent response
        if ready and not session.spec_offered:
            # First time ready — offer spec generation
            response = self._build_spec_offer_message(session)
            session.spec_offered = True
            session.status = "spec_ready"
        elif ready and session.spec_offered and self._user_confirms_done(user_message):
            # User confirmed they want the spec
            response = (
                "I'll generate your environment spec now — one moment. "
                "You'll be able to review it before we start building."
            )
            # Spec generation happens via a separate API call so the user sees it immediately
        elif ready and session.spec_offered and self._user_refuses_spec(user_message):
            # User wants to add more info before generating
            session.spec_offered = False
            session.status = "interviewing"
            response = await self._generate_next_question(session)
        else:
            # Normal interview turn
            response = await self._generate_next_question(session)

        # Step 7: Record assistant response
        session.add_turn("assistant", response, extracted_fields=extracted)

        # Get next priority fields for the caller
        priority_fields = get_next_priority_fields(session.checklist_state, limit=3)

        return TurnResult(
            response=response,
            session=session,
            ready_for_spec=ready,
            extracted_fields=extracted,
            next_priority_fields=[f.name for f in priority_fields],
        )

    async def generate_spec(self, session: InterviewSession) -> dict:
        """Generate a structured spec from the completed interview.

        Args:
            session: Interview session with collected fields

        Returns:
            Structured EDP spec dict
        """
        logger.info(f"Generating spec for session {session.session_id}")

        prompt = self._build_spec_prompt(session)

        try:
            response: LLMResponse = await self.llm.acall(
                agent="interviewer",
                prompt=prompt,
                slot="reasoning",
                system_prompt=SPEC_GENERATOR_SYSTEM_PROMPT,
                max_tokens=self.max_tokens_spec,
            )
        except Exception as e:
            logger.error(f"Spec generation LLM call failed: {e}")
            # Return a minimal fallback spec
            return self._create_fallback_spec(session)

        spec = self._parse_spec_response(response.content, session)
        session.spec = spec
        session.status = "spec_generated"

        logger.info(f"Spec generated for session {session.session_id}")
        return spec

    async def regenerate_spec(self, session: InterviewSession, feedback: str) -> dict:
        """Regenerate the spec based on user feedback.

        Args:
            session: Interview session with previous spec
            feedback: User's feedback on what to change

        Returns:
            Updated spec dict
        """
        logger.info(f"Regenerating spec for session {session.session_id} with feedback")

        previous_spec = session.spec or {}
        collected = self._build_collected_fields_summary(session)

        prompt = f"""The user has reviewed the previous spec and provided feedback.

## PREVIOUS SPEC
```json
{json.dumps(previous_spec, indent=2)}
```

## COLLECTED INTERVIEW DATA
{collected}

## USER FEEDBACK
{feedback}

Please regenerate the spec, incorporating the user's feedback while preserving
correct information from the previous version. Address every point in the feedback.

Output valid JSON only, following the same EDP schema.
"""

        try:
            response: LLMResponse = await self.llm.acall(
                agent="interviewer",
                prompt=prompt,
                slot="reasoning",
                system_prompt=SPEC_GENERATOR_SYSTEM_PROMPT,
                max_tokens=self.max_tokens_spec,
            )
        except Exception as e:
            logger.error(f"Spec regeneration LLM call failed: {e}")
            return previous_spec

        spec = self._parse_spec_response(response.content, session)
        session.spec = spec
        return spec

    # ========================================================================
    # FIELD EXTRACTION
    # ========================================================================

    async def _extract_fields(
        self,
        user_message: str,
        session: InterviewSession,
    ) -> dict[str, dict]:
        """Extract structured fields from the user's message.

        Uses an LLM call with a structured extraction prompt for reliability.
        Falls back to simple pattern matching if the LLM call fails.

        Args:
            user_message: The user's message
            session: Current session for context

        Returns:
            Dict of field_name -> {value, confidence, notes}
        """
        # Quick heuristic extraction for common patterns (fast path)
        heuristic_extracts = self._heuristic_extraction(user_message)

        # Build extraction prompt
        checklist_context = build_checklist_context_for_prompt(session.checklist_state)
        field_list = build_field_list_for_prompt()

        prompt = FIELD_EXTRACTION_PROMPT.format(
            field_list=field_list,
            checklist_state=checklist_context,
        ) + f"\n\n## USER MESSAGE\n{user_message}"

        try:
            response: LLMResponse = await self.llm.acall(
                agent="interviewer",
                prompt=prompt,
                slot="fast",
                max_tokens=2000,
            )
        except Exception as e:
            logger.warning(f"LLM field extraction failed, using heuristics only: {e}")
            return heuristic_extracts

        # Parse LLM extraction
        llm_extracts = self._parse_extraction_response(response.content)

        # Merge: LLM takes precedence, but include heuristics for fields LLM missed
        merged = {**heuristic_extracts, **llm_extracts}
        return merged

    def _heuristic_extraction(self, message: str) -> dict[str, dict]:
        """Fast heuristic extraction without LLM call.

        Uses simple keyword matching for common fields.
        """
        msg_lower = message.lower()
        extracts = {}

        # Framework detection
        frameworks = {
            "gymnasium": ["gymnasium", "gym"],
            "pettingzoo": ["pettingzoo", "petting zoo", "multi-agent"],
            "ml-agents": ["ml-agents", "mlagents", "unity"],
        }
        for fw, keywords in frameworks.items():
            if any(kw in msg_lower for kw in keywords):
                extracts["framework"] = {
                    "value": fw,
                    "confidence": 0.6,
                    "notes": [f"Detected keyword match for {fw}"],
                }
                break

        # Environment class detection
        env_classes = {
            "agent_sandbox": ["sandbox", "test bed", "testbed"],
            "llm_agent_eval": ["llm", "language model", "agent eval"],
            "tool_use": ["tool use", "tool-use", "api calling"],
            "multi_agent": ["multi-agent", "multi agent", "multiple agents"],
            "adversarial": ["adversarial", "attack", "defense"],
            "simulation": ["simulation", "simulator", "simulate"],
        }
        for ec, keywords in env_classes.items():
            if any(kw in msg_lower for kw in keywords):
                extracts["environment_class"] = {
                    "value": ec,
                    "confidence": 0.5,
                    "notes": [f"Detected keyword match for {ec}"],
                }
                break

        # Observation modality detection
        modalities = {
            "image": ["image", "pixel", "visual", "screen", "camera"],
            "language": ["text", "language", "nlp", "linguistic"],
            "continuous": ["continuous", "vector", "float"],
            "discrete": ["discrete", "categorical", "grid"],
            "graph": ["graph", "network", "node", "edge"],
            "multimodal": ["multimodal", "multi-modal", "both image and"],
        }
        for mod, keywords in modalities.items():
            if any(kw in msg_lower for kw in keywords):
                extracts["observation_modality"] = {
                    "value": mod,
                    "confidence": 0.5,
                    "notes": [f"Detected keyword match for {mod}"],
                }
                break

        # Output mode detection
        output_modes = {
            "gymnasium_mode": ["gymnasium mode", "single env", "single agent"],
            "pettingzoo_mode": ["pettingzoo mode", "parallel env"],
            "api_mode": ["api", "rest", "http", "endpoint"],
            "library_mode": ["library", "pip", "package", "installable"],
        }
        for om, keywords in output_modes.items():
            if any(kw in msg_lower for kw in keywords):
                extracts["output_mode"] = {
                    "value": om,
                    "confidence": 0.5,
                    "notes": [f"Detected keyword match for {om}"],
                }
                break

        # Description: if message is long (>20 words), it's likely the description
        words = message.split()
        if len(words) > 20 and "description" not in extracts:
            extracts["description"] = {
                "value": message,
                "confidence": 0.7,
                "notes": ["Long message treated as environment description"],
            }

        return extracts

    @staticmethod
    def _strip_markdown_fences(content: str) -> str:
        """Remove markdown code block fences from LLM output."""
        content = content.strip()
        if content.startswith("```"):
            lines = content.split("\n")
            if lines:
                lines = lines[1:]  # Remove opening fence
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]  # Remove closing fence
            content = "\n".join(lines).strip()
        return content

    def _parse_extraction_response(self, content: str) -> dict[str, dict]:
        """Parse the LLM extraction response into structured field data."""
        content = self._strip_markdown_fences(content)

        try:
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                logger.warning(f"Extraction response is not a dict: {type(parsed)}")
                return {}

            # Normalize to expected format
            result = {}
            for field_name, field_data in parsed.items():
                if isinstance(field_data, dict) and "value" in field_data:
                    result[field_name] = {
                        "value": field_data["value"],
                        "confidence": field_data.get("confidence", 0.5),
                        "notes": field_data.get("notes", []),
                    }
                elif field_data is not None:
                    # Simple value format
                    result[field_name] = {
                        "value": field_data,
                        "confidence": 0.6,
                        "notes": ["Extracted from structured response"],
                    }
            return result
        except json.JSONDecodeError as e:
            logger.debug(f"Failed to parse extraction response as JSON: {e}")
            return {}

    # ========================================================================
    # QUESTION GENERATION
    # ========================================================================

    async def _generate_next_question(self, session: InterviewSession) -> str:
        """Generate the agent's next conversational question.

        Builds a rich prompt with full context and asks the LLM to produce
        the next question + any extractions.

        Args:
            session: Current interview session

        Returns:
            Conversational response string
        """
        # Build context
        checklist_context = build_checklist_context_for_prompt(session.checklist_state)
        priority_fields = get_next_priority_fields(session.checklist_state, limit=3)
        priority_names = [f.name for f in priority_fields]

        # Build conversation history (last 6 turns for context window)
        recent_turns = session.conversation[-6:]
        conversation_history = "\n\n".join(
            f"{t.role.upper()}: {t.content}" for t in recent_turns
        )

        # Build the prompt (system prompt is passed separately to llm.acall)
        priority_fields_str = "\n".join(
            f"- {f.name} ({f.depth.value}): {f.description}" for f in priority_fields
        )
        prompt = f"""## CURRENT CHECKLIST STATE
{checklist_context}

## PRIORITY FIELDS TO FOCUS ON
{priority_fields_str}

## DEPTH QUESTIONS FOR PRIORITY FIELDS
{self._build_depth_questions_context(priority_fields)}

## CONVERSATION HISTORY (last {len(recent_turns)} turns)
{conversation_history}

## YOUR TURN
Generate your next response as the JSON object described in your system instructions.
Focus on the highest-priority pending field. Ask ONE clear question.
"""

        try:
            response: LLMResponse = await self.llm.acall(
                agent="interviewer",
                prompt=prompt,
                slot="fast",
                system_prompt=self.system_prompt,
                max_tokens=self.max_tokens_interview,
            )
        except Exception as e:
            logger.error(f"Question generation failed: {e}")
            # Fallback to a generic question
            return self._fallback_question(session)

        # Parse the structured response
        parsed = self._parse_interviewer_response(response.content)

        # If the LLM extracted additional fields, apply them
        for field_name, field_data in parsed.get("extracted_fields", {}).items():
            update_field_from_llm(
                session.checklist_state,
                field_name,
                field_data.get("value"),
                confidence=field_data.get("confidence", 0.5),
                notes=field_data.get("notes", []),
            )

        # Track Socratic probes
        for probe in parsed.get("socratic_probes", []):
            if probe not in session.socratic_probes_sent:
                session.socratic_probes_sent.append(probe)

        return parsed.get("response", self._fallback_question(session))

    def _parse_interviewer_response(self, content: str) -> dict:
        """Parse the structured interviewer response.

        Expected format: JSON with keys:
        - response: conversational reply
        - extracted_fields: dict of field extractions
        - ready_for_spec: bool
        - suggested_priority: list of field names
        - notes: internal reasoning
        """
        content = self._strip_markdown_fences(content)

        try:
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                logger.warning(f"Interviewer response is not a dict: {type(parsed)}")
                return {"response": content}
            return parsed
        except json.JSONDecodeError:
            # The LLM didn't return JSON — use the raw text as response
            logger.debug("Interviewer response was not valid JSON, using raw text")
            return {"response": content}

    def _build_depth_questions_context(self, priority_fields: list[ChecklistField]) -> str:
        """Build context with Socratic depth questions for priority fields."""
        lines = []
        for f in priority_fields:
            if f.depth_questions:
                lines.append(f"### {f.name}")
                for q in f.depth_questions:
                    lines.append(f"- {q}")
        return "\n".join(lines) if lines else "No specific depth questions available."

    def _fallback_question(self, session: InterviewSession) -> str:
        """Generate a fallback question when the LLM fails."""
        priority = get_next_priority_fields(session.checklist_state, limit=1)
        if not priority:
            if session.checklist_state.readiness_score >= 0.7:
                return (
                    "I think I have a good understanding of what you're looking for. "
                    "Would you like me to generate the environment spec now, or is there anything else you'd like to clarify?"
                )
            return (
                "Could you tell me a bit more about the environment you want to build? "
                "For example, what should the agent be able to do?"
            )

        field = priority[0]
        if field.name == "environment_class":
            return "What kind of environment are you looking to build? For example, is it for training RL agents, evaluating them, or something else?"
        elif field.name == "observation_modality":
            return "How should the agent observe the environment? Will it see raw pixels, numeric state vectors, text, or something else?"
        elif field.name == "description":
            return "Could you describe in a bit more detail what the environment should do and what problem it solves?"
        elif field.name == "framework":
            return "Which RL framework would you like to target? Gymnasium, PettingZoo, or something custom?"
        elif field.name == "observation_space":
            return "What information does the agent need to see in order to make good decisions?"
        elif field.name == "action_space":
            return "What actions can the agent take? For example, move in four directions, apply continuous forces, or something else?"
        elif field.name == "reward_structure":
            return "How should the agent be rewarded? What behavior should be encouraged and what should be discouraged?"
        elif field.name == "episode_dynamics":
            return "When should an episode end? Is there a maximum number of steps, or does it end when a goal is reached?"
        else:
            return f"Could you tell me more about {field.name.replace('_', ' ')}?"

    # ========================================================================
    # SPEC OFFER / COMPLETION
    # ========================================================================

    def _build_spec_offer_message(self, session: InterviewSession) -> str:
        """Build the message offering to generate the spec."""
        collected = [
            f.name.replace("_", " ") for f in CHECKLIST_FIELDS
            if session.checklist_state.fields.get(f.name, FieldState(field_name=f.name)).status == FieldStatus.COLLECTED
        ]

        msg = (
            f"Great! I've collected enough information to generate a spec. "
            f"Here's what I understand so far:\n\n"
        )

        # Summarize key collected fields
        key_fields = ["environment_class", "observation_modality", "framework", "description"]
        for kf in key_fields:
            fs = session.checklist_state.fields.get(kf)
            if fs and fs.value:
                label = kf.replace("_", " ").title()
                val_str = str(fs.value)[:80]
                if len(str(fs.value)) > 80:
                    val_str += "..."
                msg += f"- **{label}**: {val_str}\n"

        pending = [
            f.name.replace("_", " ") for f in CHECKLIST_FIELDS
            if session.checklist_state.fields.get(f.name, FieldState(field_name=f.name)).status == FieldStatus.PENDING
            and f.depth == FieldDepth.RECOMMENDED
        ]

        # Also exclude fields the user already skipped
        skipped = set(session.checklist_state.skipped_fields)
        pending = [p for p in pending if p.replace(" ", "_") not in skipped]

        if pending:
            msg += f"\nI could also ask about: {', '.join(pending[:3])}.\n"

        msg += (
            "\nWould you like me to generate the environment spec now? "
            "Just say **yes** and I'll produce it. Or tell me what you'd like to change first."
        )

        return msg

    def _user_confirms_done(self, message: str) -> bool:
        """Check if the user is confirming they want the spec."""
        confirm_phrases = [
            "yes", "yeah", "yep", "sure", "go ahead", "generate", "make it",
            "let's do it", "do it", "proceed", "continue", "ok", "okay",
            "that looks good", "looks good", "sounds good", "perfect",
            "generate the spec", "create the spec", "i'm ready",
        ]
        msg_lower = message.lower().strip()
        return any(phrase in msg_lower for phrase in confirm_phrases)

    def _user_refuses_spec(self, message: str) -> bool:
        """Check if the user is refusing the spec offer and wants to continue interviewing."""
        refuse_phrases = [
            "no", "not yet", "not now", "hold on", "wait", "later",
            "i want to change", "change something", "modify", "edit",
            "let me think", "not ready", "go back", "ask me more",
            "more questions", "keep interviewing",
        ]
        msg_lower = message.lower().strip()
        return any(phrase in msg_lower for phrase in refuse_phrases)

    def _handle_explicit_signals(self, session: InterviewSession, message: str) -> None:
        """Handle explicit user signals like 'skip', 'done', 'I don't know'."""
        msg_lower = message.lower().strip()

        # Skip signal
        skip_phrases = ["skip", "skip this", "i don't care", "not important", "doesn't matter"]
        if any(sp in msg_lower for sp in skip_phrases):
            # Try to figure out which field they're skipping
            priority = get_next_priority_fields(session.checklist_state, limit=1)
            if priority:
                field_name = priority[0].name
                if field_name not in session.checklist_state.skipped_fields:
                    session.checklist_state.skipped_fields.append(field_name)
                fs = session.checklist_state.fields.get(field_name)
                if fs:
                    fs.status = FieldStatus.SKIPPED
                    logger.info(f"User skipped field: {field_name} (status set to SKIPPED)")
                # Recompute readiness since a field was skipped
                session.checklist_state.readiness_score = compute_readiness_score(session.checklist_state)

        # Done signal
        done_phrases = ["i'm done", "that's all", "that's it", "no more", "i'm good", "that's enough"]
        if any(dp in msg_lower for dp in done_phrases):
            session.checklist_state.user_marked_complete = True
            logger.info("User marked interview as complete")

        # Uncertainty signal — mark current focus field as needs clarification
        uncertain_phrases = ["i don't know", "not sure", "no idea", "maybe", "unsure"]
        if any(up in msg_lower for up in uncertain_phrases):
            priority = get_next_priority_fields(session.checklist_state, limit=1)
            if priority:
                mark_field_clarification_needed(
                    session.checklist_state,
                    priority[0].name,
                    "User expressed uncertainty",
                )

    # ========================================================================
    # SPEC GENERATION
    # ========================================================================

    def _build_spec_prompt(self, session: InterviewSession) -> str:
        """Build the prompt for spec generation from collected fields."""
        collected_summary = self._build_collected_fields_summary(session)
        conversation_summary = self._build_conversation_summary(session)

        return f"""## COLLECTED INTERVIEW DATA

{collected_summary}

## CONVERSATION SUMMARY

{conversation_summary}

## YOUR TASK

Synthesize the above into a complete Environment Design Plan (EDP) as structured JSON.
Follow the EDP schema exactly. Every field must be present.
"""

    def _build_collected_fields_summary(self, session: InterviewSession) -> str:
        """Build a summary of all collected fields for the spec prompt."""
        lines = []
        for field_def in CHECKLIST_FIELDS:
            fs = session.checklist_state.fields.get(field_def.name)
            if not fs or fs.status != FieldStatus.COLLECTED:
                continue

            lines.append(f"### {field_def.name}")
            safe_val = session.checklist_state._safe_value(fs.value)
            lines.append(f"Value: {json.dumps(safe_val) if safe_val is not None else 'Not specified'}")
            lines.append(f"Confidence: {fs.confidence}")
            if fs.depth_notes:
                lines.append(f"Notes: {'; '.join(fs.depth_notes)}")
            lines.append("")

        # Also include fields that need clarification
        for field_def in CHECKLIST_FIELDS:
            fs = session.checklist_state.fields.get(field_def.name)
            if not fs or fs.status != FieldStatus.NEEDS_CLARIFICATION:
                continue
            lines.append(f"### {field_def.name} (NEEDS CLARIFICATION)")
            if fs.depth_notes:
                lines.append(f"Notes: {'; '.join(fs.depth_notes)}")
            lines.append("")

        return "\n".join(lines) if lines else "No fields collected."

    def _build_conversation_summary(self, session: InterviewSession) -> str:
        """Build a concise summary of the conversation for the spec prompt."""
        # Take first user message (usually the main description)
        # and key turns
        key_turns = []
        for turn in session.conversation:
            if turn.role == "user" and len(turn.content) > 10:
                key_turns.append(f"User: {turn.content[:200]}")

        return "\n".join(key_turns[:10]) if key_turns else "No conversation recorded."

    def _parse_spec_response(self, content: str, session: InterviewSession) -> dict:
        """Parse the spec generation response into a structured dict."""
        content = self._strip_markdown_fences(content)

        try:
            parsed = json.loads(content)
            if isinstance(parsed, dict):
                return parsed
            logger.warning(f"Spec response is not a dict: {type(parsed)}")
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse spec response as JSON: {e}")

        return self._create_fallback_spec_from_content(content, session)

    def _create_fallback_spec(self, session: InterviewSession) -> dict:
        """Create a minimal fallback spec when generation fails."""
        # Extract what we know from the interview session
        desc_fs = session.checklist_state.fields.get("description")
        env_class_fs = session.checklist_state.fields.get("environment_class")
        framework_fs = session.checklist_state.fields.get("framework")
        obs_mod_fs = session.checklist_state.fields.get("observation_modality")

        return {
            "meta": {
                "environment_class": env_class_fs.value if env_class_fs else "agent_sandbox",
                "observation_modality": obs_mod_fs.value if obs_mod_fs else "discrete",
                "novelty_assessment": "standard",
                "design_confidence": 0.5,
                "spec_version": "1.0",
                "generated_from_interview": True,
                "fallback": True,
            },
            "environment": {
                "observation_space": {
                    "type": "Box",
                    "shape": "",
                    "bounds": "",
                    "sufficiency_rationale": "",
                },
                "action_space": {
                    "type": "Discrete",
                    "dimensionality": "",
                    "bounds": "",
                    "meaningfulness_rationale": "",
                },
                "reward_structure": {
                    "type": "dense",
                    "components": [],
                    "shaping_approach": "none",
                    "hacking_risk_per_category": {},
                },
                "episode_dynamics": {
                    "termination_conditions": [],
                    "max_steps": 1000,
                    "reset_logic": "",
                    "stochasticity": "",
                },
                "difficulty_parameters": {
                    "axes": [],
                    "defaults": {},
                    "ranges": {},
                },
            },
            "output_spec": {
                "language": "python",
                "framework": framework_fs.value if framework_fs else "gymnasium",
                "framework_version": "0.29",
                "interface_contract": "",
                "entry_class": "",
            },
            "known_risks": [],
            "design_decisions": [],
            "user_intent": {
                "goal": desc_fs.value if desc_fs else "",
                "context": "",
                "success_criteria": "",
                "constraints": [],
            },
        }

    def _create_fallback_spec_from_content(self, content: str, session: InterviewSession) -> dict:
        """Try to salvage a partial spec from non-JSON content."""
        # Last resort: return a fallback with the raw content attached
        spec = self._create_fallback_spec(session)
        spec["_raw_content"] = content[:2000]
        return spec
