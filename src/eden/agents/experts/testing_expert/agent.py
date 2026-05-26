"""Testing Expert agent — provides deep expertise on test design for RL environments.

This agent assists the Tester agent when complex testing scenarios arise:
- Designing additional test cases beyond C1-C12
- Edge case coverage strategies
- Fuzzing recommendations
- Property-based testing approaches
- Test oracle generation
"""

import hashlib
import logging
import struct
from typing import Optional

from eden.llm.client import OpenRouterClient, get_llm_client
from eden.config import get_settings
from eden.kb.episodic.client import get_episodic_client
from eden.kb.semantic.graph_client import get_graph_client
from eden.kb.exploit.client import get_exploit_client
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


class TestingExpertAgent(PromptLoader):
    """Testing Expert agent that provides deep testing expertise.

    The Testing Expert:
    1. Advises on additional test cases beyond standard C1-C12 suite
    2. Recommends edge case coverage strategies
    3. Provides fuzzing recommendations
    4. Suggests property-based testing approaches
    5. Helps generate test oracles for complex scenarios

    This agent is consulted when the Tester agent encounters complex testing
    scenarios that require specialized testing expertise.
    """

    AGENT_NAME = "testing_expert"

    SYSTEM_PROMPT = """You are the Testing Expert for Eden.

Your role is to provide deep expertise on test design for RL environments:
- Designing additional test cases beyond C1-C12
- Edge case coverage strategies
- Fuzzing recommendations
- Property-based testing approaches
- Test oracle generation

Assist the tester agent when complex testing scenarios arise.

When consulted:
1. Analyze the current test results and environment characteristics
2. Identify gaps in test coverage
3. Recommend specific additional tests or testing strategies
4. Provide concrete test code snippets or property-based test ideas
5. Suggest fuzzing strategies appropriate for the environment type

Output your recommendations as structured guidance for the Tester agent."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_planner
        self.max_turns = settings.max_turns_planner
        self._episodic = None
        self._graph = None
        self._exploit = None
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
    def exploit(self):
        """Lazy load exploit client."""
        if self._exploit is None:
            self._exploit = get_exploit_client()
        return self._exploit

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
        """Run the Testing Expert agent on the current state.

        Args:
            state: EdenJobState with job_id, request, test_results, etc.

        Returns:
            dict with testing_expert_guidance and current_stage for pipeline continuation
        """
        job_id = state["job_id"]
        request = state.get("request", {})
        test_results = state.get("test_results", {})
        current_tests = state.get("tests", [])

        logger.info(f"TestingExpert running for job {job_id}")

        # Track KB reads for provenance
        kb_reads = []

        # Query KB sources for relevant context
        episodic_context = await self._query_episodic(request, kb_reads)
        graph_context = await self._query_graph(request, kb_reads)
        exploit_context = await self._query_exploits(request, kb_reads)

        # Build context for testing expertise
        context = self._build_testing_context(
            request, test_results, current_tests,
            episodic_context=episodic_context,
            graph_context=graph_context,
            exploit_context=exploit_context,
        )

        # Get testing recommendations
        guidance = await self._generate_testing_guidance(context)

        return {
            "testing_expert_guidance": guidance,
            "current_stage": "testing_expert",
            "kb_reads": kb_reads,
        }

    def _build_testing_context(
        self, request: dict, test_results: dict, current_tests: list,
        episodic_context: str = "", graph_context: str = "", exploit_context: str = ""
    ) -> str:
        """Build context string for testing expertise query."""
        env_class = request.get("environment_class", "unknown")
        framework = request.get("framework", "gymnasium")
        description = request.get("description", "")

        context_parts = [
            f"## Environment Context",
            f"Environment Class: {env_class}",
            f"Framework: {framework}",
            f"Description: {description}",
            "",
        ]

        # Add KB context if available
        if episodic_context:
            context_parts.append("## Past Test Failures (Episodic Memory)")
            context_parts.append(episodic_context)
            context_parts.append("")

        if graph_context:
            context_parts.append("## Testing Failure Modes (Graph)")
            context_parts.append(graph_context)
            context_parts.append("")

        if exploit_context:
            context_parts.append("## Exploits Tests Should Catch")
            context_parts.append(exploit_context)
            context_parts.append("")

        context_parts.append(f"## Current Test Coverage")
        context_parts.append(f"Tests run: {len(current_tests)}")

        # Add test results summary
        if test_results:
            passed = sum(1 for t in test_results.values() if t.get("passed", False))
            total = len(test_results)
            context_parts.append(f"Results: {passed}/{total} passed")

            # Add any failures for context
            failures = [
                f"- {name}: {result.get('error', 'failed')}"
                for name, result in test_results.items()
                if not result.get("passed", False)
            ]
            if failures:
                context_parts.append("Failures:")
                context_parts.extend(failures)

        context_parts.append("")
        context_parts.append("## Current Tests")
        if current_tests:
            for test in current_tests[:10]:  # Limit to first 10
                context_parts.append(f"- {test.get('name', 'unnamed')}: {test.get('category', 'unknown')}")
        else:
            context_parts.append("No tests executed yet.")

        return "\n".join(context_parts)

    async def _query_episodic(self, request: dict, kb_reads: list) -> str:
        """Query episodic memory for past test failures."""
        try:
            description = request.get("description", "")
            env_class = request.get("environment_class", "")
            search_text = f"test failure {env_class} {description}"

            if not search_text.strip():
                return ""

            recent_jobs = await self.episodic.search_by_description(search_text, limit=5)
            recent = await self.episodic.get_recent(days=30, limit=10)

            all_jobs = {j["job_id"]: j for j in recent_jobs + recent}
            similar_jobs = list(all_jobs.values())[:5]

            context_parts = []
            for job in similar_jobs:
                test_errors = job.get("test_errors", [])
                if test_errors:
                    outcome = job.get("outcome_tier", "unknown")
                    context_parts.append(
                        f"- Job {job['job_id'][:8]}: outcome={outcome}\n"
                        f"  Test errors: {test_errors[:3]}"
                    )
                    kb_reads.append({
                        "type": "episodic",
                        "job_id": job["job_id"],
                        "summary": f"test failure outcome={outcome}",
                    })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Episodic query failed: {e}")
            return ""

    async def _query_graph(self, request: dict, kb_reads: list) -> str:
        """Query semantic graph for testing-related failure modes."""
        try:
            failure_entities = await self.graph.query_by_type(
                entity_type="FailureMode",
                limit=10,
            )

            context_parts = []
            for entity in failure_entities[:5]:
                props = entity.get("properties", {})
                category = props.get("category", "")
                if category in ("testing", "test_oracle", "reward_hacking"):
                    context_parts.append(
                        f"- {entity['name']}: {props.get('description', 'No description')}\n"
                        f"  Severity: {props.get('severity', 'unknown')}"
                    )
                    kb_reads.append({
                        "type": "graph_failure",
                        "entity_id": entity["id"],
                        "summary": entity["name"],
                    })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Graph query failed: {e}")
            return ""

    async def _query_exploits(self, request: dict, kb_reads: list) -> str:
        """Query exploit library for exploits that tests should catch."""
        try:
            env_class = request.get("environment_class", "")

            exploits = await self.exploit.get_applicable(
                env_class=env_class or "rl_training",
                reward_types=["dense", "sparse"],
            )

            context_parts = []
            for exploit in exploits[:5]:
                context_parts.append(
                    f"- Exploit: {exploit['name']} ({exploit['category']})\n"
                    f"  Description: {exploit.get('description', 'No description')[:150]}"
                )
                kb_reads.append({
                    "type": "exploit",
                    "exploit_id": exploit["id"],
                    "summary": f"{exploit['name']} ({exploit['category']})",
                })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Exploit query failed: {e}")
            return ""

    async def _generate_testing_guidance(self, context: str) -> str:
        """Generate testing guidance based on context."""
        prompt = f"""## Context

{context}

---

## Task

As the Testing Expert, analyze this environment and test results to provide recommendations for additional testing approaches.

Consider:
1. What edge cases might be missed by standard C1-C12 tests?
2. What property-based tests would be valuable?
3. What fuzzing strategies fit this environment type?
4. Are there specific failure modes common to this environment class?

Provide concrete, actionable recommendations. Include test code snippets where helpful."""

        response = self.llm.call(
            agent=self.AGENT_NAME,
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        return response.content