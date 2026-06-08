"""Critic agent — adversarial review of Environment Design Plans.

Reviews the EDP from the Planner across 8 critique dimensions and routes
the job forward (approve with notes), back to Planner (targeted replan),
or triggers full re-research.
"""

import json
import logging
from typing import Optional

from eden.llm.client import OpenRouterClient
from eden.config import get_settings
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


class CriticAgent(PromptLoader):
    """Critic agent that adversarially reviews Environment Design Plans.

    The Critic performs 8-dimension critique:
    1. Reward pathology risk (6 hacking categories)
    2. Observation sufficiency
    3. Action space validity
    4. Termination logic
    5. Framework API integrity
    6. Difficulty calibration
    7. Specification completeness
    8. KB conflict check

    Routing:
    - approve: Forward to Refiner with notes
    - targeted_replan: Send specific sections back to Planner
    - full_reresearch: Planner restarts from web search
    """

    AGENT_NAME = "critic"

    SYSTEM_PROMPT = """You are the Critic for Eden, an AI-native environment generation system.

Your role is to adversarially review the Environment Design Plan (EDP) produced by the Planner.
Find every flaw BEFORE code is written. Be thorough — downstream failures cost 10x more.

You must evaluate the EDP across 8 dimensions:

1. REWARD PATHOLOGY RISK: Check all 6 reward hacking categories:
   - specification_gaming: agent satisfies literal spec but violates intent
   - reward_tampering: direct interference with reward computation
   - proxy_optimization: optimizing poorly-correlated proxy metrics
   - objective_misalignment: systematic behavioral deviation
   - exploitation_patterns: exploiting environmental bugs
   - wireheading: modifying own reward processing

2. OBSERVATION SUFFICIENCY: Can an agent solve the task from what it observes?
   Are there information asymmetries? Hidden states?

3. ACTION SPACE VALIDITY: Are all actions meaningful?
   Is any single action dominant? Are there degenerate actions?

4. TERMINATION LOGIC: Is at least one termination path reachable from a valid initial state?
   Are there dead-end states? Infinite episode risks?

5. FRAMEWORK API INTEGRITY: Every referenced method/class must exist in the declared
   framework version. Check against Gymnasium 0.29, PettingZoo 1.24, etc.

6. DIFFICULTY CALIBRATION: Is the task learnable? Too easy? Completable within max_steps?
   Are difficulty parameters properly calibrated?

7. SPECIFICATION COMPLETENESS: Any design decisions left ambiguous for the Executor?
   Vague parameters, unspecified edge cases?

8. KB CONFLICT CHECK: Does this EDP reproduce a pattern that has caused failures
   for similar environment types in the past?

Output a CRITIQUE with:
- Overall assessment (approve/reject/escalate)
- Score per dimension (1-5, 5=perfect)
- Specific issues found per dimension
- Routing recommendation with explicit justification
- For rejections: specific sections to revise

Output as structured JSON with clear routing decision."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or OpenRouterClient()
        self.max_tokens = settings.max_tokens_critic
        self.max_turns = settings.max_turns_critic
        # ``SYSTEM_PROMPT`` is the class-level prompt; ``system_prompt``
        # is the per-instance attribute the rest of the file uses.
        # Alias so both spellings resolve to the same string.
        self.system_prompt = type(self).SYSTEM_PROMPT
        self._load_prompt()

    async def run(self, state: dict) -> dict:
        """Run the Critic agent on the current EDP.

        Args:
            state: EdenJobState with edp_history[-1]

        Returns:
            dict with critic_decision and routing
        """
        job_id = state["job_id"]
        edp = state.get("edp_history", [{}])[-1]

        logger.info(f"Critic running for job {job_id}")

        # Check for novelty/low-confidence triggering Devil's Advocate
        novelty = edp.get("meta", {}).get("novelty_assessment", "standard")
        confidence = edp.get("meta", {}).get("design_confidence", 1.0)

        needs_devil_advocate = (
            novelty == "novel" or confidence < 0.7
        )

        # Build prompt with EDP
        prompt = self._build_critique_prompt(edp)

        # Spawn Devil's Advocate for novel/low-confidence EDPs
        if needs_devil_advocate:
            logger.info(f"Devil's Advocate triggered for job {job_id}: novelty={novelty}, confidence={confidence}")
            devil_advocate = DevilAdvocateAgent(self.llm)
            contrarian_review = await devil_advocate.run(edp)
            prompt += "\n\n## DEVIL'S ADVOCATE CONTRARIAN REVIEW\n\n"
            prompt += f"The following issues were raised by the Devil's Advocate:\n{json.dumps(contrarian_review, indent=2)}\n\n"
            prompt += "Synthesize both reviews and provide a final routing decision."

        # Make LLM call
        response = self.llm.call(
            agent="critic",
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        # Parse critique
        critique = self._parse_critique(response.content)

        # Update routing based on critique
        routing = critique.get("routing", "approve")
        dimension_scores = critique.get("dimensions", {})

        # Track iteration counts
        updates = {
            "critic_decisions": [{
                **critique,
                "novelty_assessment": novelty,
                "design_confidence": confidence,
                "needs_devil_advocate": needs_devil_advocate,
            }],
            "routing_history": [{
                "from": "critic",
                "to": routing,
                "reason": critique.get("routing_reason", ""),
            }],
        }

        if routing == "targeted_replan":
            updates["critic_replan_count"] = state.get("critic_replan_count", 0) + 1
            updates["current_stage"] = "planning"
        elif routing == "full_reresearch":
            updates["critic_reresearch_count"] = state.get("critic_reresearch_count", 0) + 1
            updates["current_stage"] = "planning"
        elif routing == "approve":
            updates["current_stage"] = "refining"
        else:  # reject or escalate
            updates["current_stage"] = "human_review"

        logger.info(f"Critic decision for job {job_id}: {routing} (replan={updates.get('critic_replan_count', 0)}, reresearch={updates.get('critic_reresearch_count', 0)})")
        logger.info(f"Critic dimension scores for job {job_id}: {dimension_scores}")
        logger.info(f"Critic DevilAdvocate trigger: novelty={novelty}, confidence={confidence}, triggered={needs_devil_advocate}")

        return updates

    def _build_critique_prompt(self, edp: dict) -> str:
        """Build the critique prompt from the EDP."""
        import json

        return f"""## ENVIRONMENT DESIGN PLAN TO REVIEW

{json.dumps(edp, indent=2)}

## YOUR TASK

Review this EDP across all 8 critique dimensions.
Produce a structured critique with:
- Overall assessment
- Per-dimension scores (1-5) and issues
- Routing decision (approve/targeted_replan/full_reresearch/reject)
- Explicit justification for routing

If novelty_assessment='novel' or design_confidence < 0.7, recommend Devil's Advocate review.

Output as valid JSON only."""

    def _parse_critique(self, content: str) -> dict:
        """Parse critique from LLM response."""
        import json
        import re

        # Try to extract JSON from markdown code blocks
        json_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", content)
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Try to find raw JSON
        json_match = re.search(r"\{[\s\S]*\}", content)
        if json_match:
            try:
                return json.loads(json_match.group(0))
            except json.JSONDecodeError:
                pass

        logger.error(f"Failed to parse critique from response: {content[:200]}...")
        return {
            "routing": "approve",  # Default to approval on parse failure
            "routing_reason": "Parse failure, defaulting to approval",
            "dimensions": {},
            "issues": [],
        }


class DevilAdvocateAgent:
    """Devil's Advocate for novel/low-confidence EDPs.

    Spawned by the Critic to provide contrarian review.
    Both critiques are synthesized before routing decision.
    """

    SYSTEM_PROMPT = """You are a Devil's Advocate for Eden's environment generation pipeline.

Your role is to argue AGAINST the proposed Environment Design Plan.
Find every possible way the plan could fail, every assumption that might be wrong,
every risk that might be understated.

Be adversarial. Play devil's advocate. Challenge the Planner's assumptions.

Consider:
- What if the reward is hackable in ways not considered?
- What if the difficulty is miscalibrated for the target agent?
- What if framework APIs change or have undocumented behavior?
- What if the environment description was misinterpreted?
- What if similar past jobs failed for reasons not addressed here?

Output your contrarian critique as structured JSON with:
- Specific counterarguments
- Alternative interpretations
- Risks that might be understated
- Scenarios where this design would fail

Be specific, not generic. Find REAL issues, not nitpicks."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        self.llm = llm_client or OpenRouterClient()
        self.max_tokens = settings.max_tokens_critic
        # Alias for SYSTEM_PROMPT (see CriticAgent for the rationale).
        self.system_prompt = type(self).SYSTEM_PROMPT

    async def run(self, edp: dict) -> dict:
        """Run Devil's Advocate on the EDP."""
        prompt = f"""## ENVIRONMENT DESIGN PLAN

{self._edp_to_text(edp)}

## YOUR TASK

Provide a contrarian review. Find every way this plan could fail.
Be specific and adversarial.

Output as valid JSON only."""

        response = self.llm.call(
            agent="critic_devil_advocate",
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        return self._parse_contrarian_review(response.content)

    def _edp_to_text(self, edp: dict) -> str:
        """Convert EDP to text for prompt."""
        import json
        return json.dumps(edp, indent=2, default=str)

    def _parse_contrarian_review(self, content: str) -> dict:
        """Parse contrarian review from response."""
        import json
        import re

        json_match = re.search(r"\{[\s\S]*\}", content)
        if json_match:
            try:
                return json.loads(json_match.group(0))
            except json.JSONDecodeError:
                pass

        return {"issues": [], "risks": []}