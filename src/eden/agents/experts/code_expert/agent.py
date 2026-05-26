"""Code Expert agent — provides deep Python/NumPy code quality expertise.

Provides expertise on:
- Python and NumPy optimization suggestions
- Gymnasium/PettingZoo API idioms and best practices
- Performance-critical code patterns
- Code style and maintainability recommendations
- Type hints and documentation improvements

Assists executor and code_quality agents with code optimization.
"""

import hashlib
import logging
import struct
from typing import Optional

from eden.llm.client import OpenRouterClient, get_llm_client
from eden.config import get_settings
from eden.kb.episodic.client import get_episodic_client
from eden.kb.semantic.graph_client import get_graph_client
from eden.kb.procedural.client import get_procedural_client
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


class CodeExpertAgent(PromptLoader):
    """Code Expert agent for Python/NumPy code quality.

    The Code Expert provides deep expertise on:
    1. Python and NumPy optimization patterns
    2. Gymnasium/PettingZoo API idioms
    3. Performance-critical code patterns
    4. Code style and maintainability
    5. Type hints and documentation
    """

    AGENT_NAME = "code_expert"

    SYSTEM_PROMPT = """You are the Code Expert for Eden, an AI-native environment generation system.

Your role is to provide deep expertise on Python/NumPy code quality:

1. PYTHON AND NUMPY OPTIMIZATION:
   - Vectorization strategies using NumPy
   - Memory-efficient data structures
   - JIT compilation opportunities with numba
   - Avoiding common performance pitfalls

2. GYMNASIUM/PETTINGZOO API IDIOMS:
   - Correct usage of spaces (Box, Discrete, Dict, Tuple)
   - Proper reset/step/close lifecycle
   - Wrapper composition patterns
   - Vectorized environments (gymnasium.vector)

3. PERFORMANCE-CRITICAL CODE PATTERNS:
   - Efficient reward computation
   - Fast observation processing
   - Avoiding unnecessary copies
   - Profiling and optimization strategies

4. CODE STYLE AND MAINTAINABILITY:
   - PEP 8 compliance
   - Clear naming conventions
   - Modular code structure
   - Error handling best practices

5. TYPE HINTS AND DOCUMENTATION:
   - Comprehensive type annotations
   - docstring formats (Google, NumPy, Sphinx)
   - Example usage in docstrings
   - README and inline comments

Assist executor and code_quality agents with code optimization decisions."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_code_expert
        self.max_turns = settings.max_turns_code_expert
        self._episodic = None
        self._graph = None
        self._procedural = None
        self._load_prompt()

    @property
    def episodic(self):
        """Lazy load episodic client."""
        if self._episodic is None:
            self._episodic = get_episodic_client()
        return self._episodic

    @property
    def graph(self):
        """Lazy load graph client."""
        if self._graph is None:
            self._graph = get_graph_client()
        return self._graph

    @property
    def procedural(self):
        """Lazy load procedural client."""
        if self._procedural is None:
            self._procedural = get_procedural_client()
        return self._procedural

    async def _generate_query_embedding(self, text: str) -> list[float]:
        """Generate a pseudo-embedding from text using bag-of-characters."""
        hash_digest = hashlib.sha256(text.encode()).digest()
        seed = struct.unpack('<Q', hash_digest[:8])[0]

        import random
        rng = random.Random(seed)
        vector = [rng.gauss(0, 1) for _ in range(128)]

        # L2 normalize
        norm = sum(x*x for x in vector) ** 0.5
        return [x/norm for x in vector]

    async def run(self, state: dict) -> dict:
        """Run the Code Expert agent on the current job context.

        Args:
            state: EdenJobState with job_id, code_context, and optimization goals

        Returns:
            dict with current_stage for pipeline continuation
        """
        job_id = state["job_id"]
        code_context = state.get("code_context", {})
        optimization_goal = state.get("optimization_goal", "general")
        request = state.get("request", {})

        logger.info(f"Code Expert running for job {job_id}")

        # Track KB reads for provenance
        kb_reads = []

        # Query KB sources for relevant context
        episodic_context = await self._query_episodic(request, kb_reads)
        graph_context = await self._query_graph(request, kb_reads)
        skill_context = await self._query_skills(request, kb_reads)

        # Build context for code expertise
        prompt = self._build_code_expertise_prompt(
            code_context, optimization_goal,
            episodic_context=episodic_context,
            graph_context=graph_context,
            skill_context=skill_context,
        )

        # Make LLM call
        response = self.llm.call(
            agent="code_expert",
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        # Parse expertise recommendations
        recommendations = self._parse_recommendations(response.content)

        # Determine next stage based on context
        if state.get("current_stage") == "code_quality":
            next_stage = "executing"
        else:
            next_stage = "executing"

        logger.info(f"Code Expert completed for job {job_id}")

        return {
            "code_expertise": recommendations,
            "current_stage": next_stage,
            "kb_reads": kb_reads,
        }

    def _build_code_expertise_prompt(
        self, code_context: dict, optimization_goal: str,
        episodic_context: str = "", graph_context: str = "", skill_context: str = ""
    ) -> str:
        """Build the code expertise prompt from context."""
        import json

        code_snippet = code_context.get("snippet", "No code snippet provided")
        language = code_context.get("language", "python")
        framework = code_context.get("framework", "gymnasium")

        prompt_parts = ["""## CODE CONTEXT

Language: {language}
Framework: {framework}
Optimization Goal: {optimization_goal}
"""]

        # Add KB context if available
        if episodic_context:
            prompt_parts.append("## Past Code Issues (Episodic Memory)")
            prompt_parts.append(episodic_context)
            prompt_parts.append("")

        if graph_context:
            prompt_parts.append("## Design Patterns (Graph)")
            prompt_parts.append(graph_context)
            prompt_parts.append("")

        if skill_context:
            prompt_parts.append("## Relevant Skills (Skill Library)")
            prompt_parts.append(skill_context)
            prompt_parts.append("")

        prompt_parts.append(f"""Code Snippet:
```{language}
{code_snippet}
```

---

## YOUR TASK

Provide expert recommendations for this code covering:

1. PERFORMANCE: Identify bottlenecks and optimization opportunities
2. CORRECTNESS: Ensure API usage is correct for {framework}
3. STYLE: Suggest improvements for readability and maintainability
4. TYPE HINTS: Recommend type annotations where missing
5. DOCUMENTATION: Suggest docstring improvements

Output recommendations as JSON:
{{
  "performance": ["recommendation1", "recommendation2"],
  "correctness": ["issue1 with fix"],
  "style": ["improvement1"],
  "type_hints": ["annotation1"],
  "documentation": ["docstring1"]
}}""")

        return "\n".join(prompt_parts)

    async def _query_episodic(self, request: dict, kb_reads: list) -> str:
        """Query episodic memory for past code issues."""
        try:
            description = request.get("description", "")
            search_text = f"code quality issue {description}"

            if not search_text.strip():
                return ""

            recent_jobs = await self.episodic.search_by_description(search_text, limit=5)
            recent = await self.episodic.get_recent(days=30, limit=10)

            all_jobs = {j["job_id"]: j for j in recent_jobs + recent}
            similar_jobs = list(all_jobs.values())[:5]

            context_parts = []
            for job in similar_jobs:
                code_issues = job.get("code_issues", [])
                if code_issues:
                    outcome = job.get("outcome_tier", "unknown")
                    context_parts.append(
                        f"- Job {job['job_id'][:8]}: outcome={outcome}\n"
                        f"  Issues: {code_issues[:3]}"
                    )
                    kb_reads.append({
                        "type": "episodic",
                        "job_id": job["job_id"],
                        "summary": f"code issues outcome={outcome}",
                    })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Episodic query failed: {e}")
            return ""

    async def _query_graph(self, request: dict, kb_reads: list) -> str:
        """Query semantic graph for design patterns."""
        try:
            pattern_entities = await self.graph.query_by_type(
                entity_type="DesignPattern",
                limit=10,
            )

            context_parts = []
            for entity in pattern_entities[:5]:
                props = entity.get("properties", {})
                context_parts.append(
                    f"- {entity['name']}: {props.get('description', 'No description')}\n"
                    f"  Best for: {props.get('use_cases', 'unknown')}"
                )
                kb_reads.append({
                    "type": "graph_pattern",
                    "entity_id": entity["id"],
                    "summary": entity["name"],
                })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Graph query failed: {e}")
            return ""

    async def _query_skills(self, request: dict, kb_reads: list) -> str:
        """Query procedural memory (Skill Library) for relevant skills."""
        try:
            env_class = request.get("environment_class", "")
            framework = request.get("framework", "")
            description = request.get("description", "")

            query_text = f"{description} {env_class} {framework}"
            query_vector = await self._generate_query_embedding(query_text)

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
                    f"  Template: {skill.get('code_template', '')[:200]}..."
                )
                kb_reads.append({
                    "type": "skill",
                    "skill_id": skill["id"],
                    "summary": skill["name"],
                })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Skill query failed: {e}")
            return ""

    def _parse_recommendations(self, content: str) -> dict:
        """Parse code expertise recommendations from LLM response."""
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

        logger.warning(f"Failed to parse code expertise recommendations, using fallback")
        return {
            "performance": [],
            "correctness": [],
            "style": [],
            "type_hints": [],
            "documentation": [],
            "raw_response": content[:500],
        }