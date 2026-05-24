import json
import logging
import re
from typing import Optional

from eden.llm.client import OpenRouterClient, get_llm_client
from eden.config import get_settings
from eden.kb.procedural.client import get_procedural_client
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


class RefinerAgent(PromptLoader):
    """Refiner agent that produces implementation-ready specs.

    The Refiner:
    1. Resolves all EDP ambiguities with concrete values
    2. Expands reward function to pseudocode
    3. Audits reward shaping for potential-based validity
    4. Enumerates edge cases with handling spec
    5. Specifies output interface to method-signature level
    6. Specifies seeding/reproducibility strategy
    7. For agent/LLM eval envs: specifies observation/action format
    """

    AGENT_NAME = "refiner"

    SYSTEM_PROMPT = """You are the Refiner for Eden, an AI-native environment generation system.

Your role is to take an Environment Design Plan (EDP) that has passed Critic review
and produce a Refined Environment Spec (RES) — a complete, implementation-ready document.

The Executor should receive a document where every design decision is already made.
There should be no ambiguity, no vague parameters, no unspecified edge cases.

For the RES, you must:

1. RESOLVE ALL AMBIGUITIES: Every vague parameter gets a concrete, justified value.
   If a range was given, pick a specific value. If behavior was unspecified, define it.

2. EXPAND REWARD FUNCTION TO PSEUDOCODE: Precise formulae, exact bounds,
   component interaction explicitly resolved. Show the actual computation.

3. AUDIT REWARD SHAPING: If non-potential-based reward shaping is used, flag it
   and propose PBRS reformulation. Potential-based shaping halves return variance
   while preserving final performance.

4. ENUMERATE EDGE CASES: Every reachable edge case with explicit handling spec.
   What happens at boundary values? Invalid inputs? Mid-episode resets?

5. SPECIFY OUTPUT INTERFACE: Class names, parameter types, return types matched
   exactly to declared framework version. Include import statements.

6. SPECIFY SEEDING STRATEGY: Complete reproducibility — every source of randomness
   identified and seeded. Default seed handling, seed() method signature.

7. FOR AGENT/LLM EVAL ENVIRONMENTS: Specify observation format (token budget,
   system/user message structure), action format parsed from model outputs,
   evaluation metric computation, scorer implementation.

Output the complete RES as structured JSON. Include the original EDP for reference."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_refiner
        self.max_turns = settings.max_turns_refiner
        self._procedural = None
        self._load_prompt()

    @property
    def procedural(self):
        """Lazy load procedural client."""
        if self._procedural is None:
            self._procedural = get_procedural_client()
        return self._procedural

    async def run(self, state: dict) -> dict:
        """Run the Refiner agent on the approved EDP.

        Args:
            state: EdenJobState with edp_history[-1] from Planner/Critic

        Returns:
            dict with res added to state
        """
        job_id = state["job_id"]
        edp = state.get("edp_history", [{}])[-1]

        logger.info(f"Refiner running for job {job_id}")

        # Track KB reads for provenance
        kb_reads = []

        # Query Skill Library for similar RES patterns
        res_patterns = await self._query_res_patterns(edp, kb_reads)

        # Build refinement prompt
        prompt = self._build_refinement_prompt(edp, res_patterns)

        # Make LLM call
        response = self.llm.call(
            agent="refiner",
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        # Parse RES
        res = self._parse_res(response.content)

        # Validate RES structure
        if not self._validate_res(res):
            logger.warning(f"RES validation failed for job {job_id}, using fallback")
            res = self._create_fallback_res(edp)

        # Add meta info
        res.setdefault("meta", {})["source_edp"] = edp.get("meta", {}).get("environment_class", "unknown")

        logger.info(f"Refiner produced RES for job {job_id}")

        return {
            "res": res,
            "current_stage": "fact_checking",
            "routing_history": [{
                "from": "refiner",
                "to": "fact_checking",
                "reason": "RES produced, moving to fact checking",
            }],
            "kb_reads": kb_reads,
        }

    async def _query_res_patterns(self, edp: dict, kb_reads: list) -> str:
        """Query procedural memory (Skill Library) for similar RES patterns."""
        try:
            env_class = edp.get("meta", {}).get("environment_class", "")
            framework = edp.get("output_spec", {}).get("framework", "")

            query_text = f"{env_class} {framework} implementation pattern"
            query_vector = await self._generate_query_embedding(query_text)

            # Search skills by embedding
            skills = await self.procedural.search_by_embedding(
                query_vector=query_vector,
                env_class=env_class or None,
                framework=framework or None,
                limit=3,
            )

            context_parts = []
            for skill in skills:
                context_parts.append(
                    f"- Skill: {skill['name']}\n"
                    f"  Description: {skill.get('description', 'No description')}\n"
                    f"  Template: {skill.get('code_template', '')[:300]}..."
                )
                kb_reads.append({
                    "type": "skill",
                    "skill_id": skill["id"],
                    "summary": f"RES pattern: {skill['name']}",
                })

            return "\n".join(context_parts) if context_parts else "No relevant RES patterns found."
        except Exception as e:
            logger.warning(f"Skill query failed: {e}")
            return f"Skill query failed: {e}"

    async def _generate_query_embedding(self, text: str) -> list[float]:
        """Generate a pseudo-embedding for a text query."""
        try:
            # Use LLM to generate a pseudo-embedding (simplified - real impl would use embedding model)
            words = text.lower().split()
            vector = [0.0] * 1536
            for i, word in enumerate(words[:1536]):
                vector[i] = hash(word) % 100 / 100.0
            return vector
        except Exception as e:
            logger.debug(f"Embedding generation failed, using fallback: {e}")
            words = text.lower().split()
            vector = [0.0] * 1536
            for i, word in enumerate(words[:1536]):
                vector[i] = hash(word) % 100 / 100.0
            return vector

    def _build_refinement_prompt(self, edp: dict, res_patterns: str) -> str:
        """Build the refinement prompt from the EDP."""

        return f"""## ENVIRONMENT DESIGN PLAN (EDP) — Approved for Refinement

{json.dumps(edp, indent=2)}

---

## RELEVANT RES PATTERNS FROM SKILL LIBRARY

{res_patterns}

---

## YOUR TASK

Take the EDP above and produce a Refined Environment Spec (RES) that is
implementation-ready. Every ambiguity must be resolved. Every edge case handled.

CRITICAL REQUIREMENTS:

1. RESOLVE ALL AMBIGUITIES: Go through the EDP and for every vague parameter,
   undefined behavior, or unspecified value, provide a concrete, justified value.
   Document what you chose and why.

2. EXPAND REWARD FUNCTION TO PSEUDOCODE: For each reward component, show the
   actual computation as Python pseudocode. Include exact bounds and formulas.

3. AUDIT REWARD SHAPING: Check if any reward shaping is not potential-based.
   If so, propose a PBRS reformulation. Potential-based shaping halves return
   variance while preserving final performance.

4. ENUMERATE EDGE CASES: List every edge case you can think of:
   - Boundary values for observations/actions
   - Invalid inputs to step/reset
   - Mid-episode termination scenarios
   - Reset during transition
   For each: describe the scenario and the explicit handling behavior.

5. SPECIFY OUTPUT INTERFACE: For the declared framework and version, specify:
   - Exact class name and module imports
   - Method signatures with parameter types and return types
   - Required methods: __init__, reset, step, close, seed
   - Any optional methods with their signatures

6. SPECIFY SEEDING STRATEGY: List every source of randomness in the environment.
   For each: what is the default seed behavior? How is seed() implemented?

7. FOR LLM/AGENT EVAL ENVIRONMENTS: Additional specification:
   - Observation format (token budget, message structure)
   - Action format (how model outputs are parsed)
   - Scorer implementation details

Output the complete RES as valid JSON only. Include the original EDP under key "edp" for reference."""

    def _parse_res(self, content: str) -> dict:
        """Parse RES from LLM response content."""
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

        logger.error(f"Failed to parse RES from response: {content[:200]}...")
        return self._create_fallback_res({})

    def _validate_res(self, res: dict) -> bool:
        """Validate RES has required structure."""
        required_keys = ["meta", "ambiguities_resolved", "reward_pseudocode", "output_interface"]
        for key in required_keys:
            if key not in res:
                logger.warning(f"RES missing required key: {key}")
                return False
        return True

    def _create_fallback_res(self, edp: dict) -> dict:
        """Create a fallback RES when parsing fails."""
        return {
            "meta": {
                "environment_class": edp.get("meta", {}).get("environment_class", "unknown"),
                "framework": edp.get("output_spec", {}).get("framework", "gymnasium"),
                "framework_version": edp.get("output_spec", {}).get("framework_version", "0.29"),
                "error": "Failed to parse RES from LLM response",
            },
            "ambiguities_resolved": [],
            "reward_pseudocode": {
                "components": [],
                "total_formula": "0.0",
            },
            "reward_shaping_audit": {
                "is_pbrs": True,
                "reformulations": [],
            },
            "edge_cases": [],
            "output_interface": {
                "class_name": "EdenEnvironment",
                "framework": "gymnasium",
                "methods": {},
            },
            "seeding_strategy": {
                "random_sources": [],
                "default_seed": 42,
            },
            "llm_eval_spec": None,
            "edp": edp,
        }