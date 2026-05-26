"""Benchmark agent — creates benchmark definitions for agent performance evaluation."""

import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Optional, Any

from eden.llm.client import OpenRouterClient
from eden.config import get_settings
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class BenchmarkTask:
    """A single task within a benchmark definition."""
    task_id: str
    description: str
    input_spec: dict
    expected_output: Any
    ground_truth: Any


@dataclass
class BenchmarkDefinition:
    """Definition of a benchmark for agent performance evaluation."""
    benchmark_id: str
    benchmark_name: str
    target_agents: list[str]
    tasks: list[BenchmarkTask]
    metrics: list[str]  # e.g., ["accuracy", "latency", "success_rate"]
    pass_threshold: float


class BenchmarkAgent(PromptLoader):
    """Benchmark agent that creates benchmark definitions.

    When a user asks to create a benchmark, this agent:
    1. Defines benchmark tasks with known ground truth
    2. Specifies success criteria and metrics
    3. Determines appropriate test cases
    4. Generates synthetic test cases if real ones are insufficient

    Produces benchmark definitions with benchmark_name, target_agents,
    tasks, metrics, and pass_threshold.
    """

    AGENT_NAME = "benchmark_agent"

    SYSTEM_PROMPT = """You are the Benchmark Agent for Eden.

Your role is to create and run benchmarks to evaluate agent performance.

When creating a benchmark:
1. Define benchmark tasks with known ground truth
2. Specify success criteria and metrics
3. Determine appropriate test cases
4. Generate synthetic test cases if real ones are insufficient

For each benchmark task, you must define:
- task_id: unique identifier
- description: what the task evaluates
- input_spec: the input specification for the task
- expected_output: what the agent should produce
- ground_truth: the correct answer for evaluation

Supported metrics:
- accuracy: percentage of tasks completed correctly
- latency: time to complete a task
- token_usage: total tokens consumed
- success_rate: percentage of tasks that passed

Output benchmark definitions as structured JSON with benchmark_name,
target_agents, tasks, metrics, and pass_threshold fields."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or OpenRouterClient()
        self.max_tokens = settings.max_tokens_planner
        self.max_turns = settings.max_turns_planner
        self._load_prompt()
        self._episodic = None
        self._graph = None
        self._procedural = None

    @property
    def episodic(self):
        """Get or initialize episodic memory client."""
        if self._episodic is None:
            from eden.kb.episodic.client import get_episodic_client
            self._episodic = get_episodic_client()
        return self._episodic

    @property
    def graph(self):
        """Get or initialize graph client."""
        if self._graph is None:
            from eden.kb.semantic.graph_client import get_graph_client
            self._graph = get_graph_client()
        return self._graph

    @property
    def procedural(self):
        """Get or initialize procedural memory client."""
        if self._procedural is None:
            from eden.kb.procedural.client import get_procedural_client
            self._procedural = get_procedural_client()
        return self._procedural

    async def _generate_query_embedding(self, text: str) -> list[float]:
        """Generate a pseudo-embedding for a text query.

        Uses LLM to create a dense representation for vector search.
        Falls back to a simple hash-based vector if LLM unavailable.
        """
        try:
            response = self.llm.call(
                agent="benchmark",
                prompt=f"Generate a brief semantic summary of this text for embedding purposes: {text[:500]}",
                slot="extraction",
                max_tokens=100,
            )

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

    async def run(self, state: dict) -> dict:
        """Create benchmark definition based on user request or job context.

        Args:
            state: EdenJobState with benchmark request details

        Returns:
            dict with benchmark_definition and current_stage for pipeline continuation
        """
        job_id = state.get("job_id", "benchmark-create")
        user_request = state.get("user_request") or state.get("benchmark_request", {})
        target_agents = user_request.get("target_agents", ["executor", "tester"])
        criteria = user_request.get("criteria", {})
        benchmark_name = user_request.get("benchmark_name", f"benchmark-{job_id}")

        logger.info(f"BenchmarkAgent running for job {job_id}")

        # Query KB for relevant context
        past_benchmarks = await self._query_episodic_for_past_benchmarks(target_agents)
        performance_patterns = await self._query_graph_for_performance_patterns(target_agents)
        benchmark_skills = await self._query_procedural_for_benchmarking_skills()

        # Build prompt for benchmark generation with KB context
        prompt = self._build_benchmark_prompt(
            benchmark_name=benchmark_name,
            target_agents=target_agents,
            criteria=criteria,
            job_context=state,
            past_benchmarks=past_benchmarks,
            performance_patterns=performance_patterns,
            benchmark_skills=benchmark_skills,
        )

        # Generate benchmark definition
        response = self.llm.call(
            agent="benchmark",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        # Parse benchmark definition from response
        benchmark_def = self._parse_benchmark_response(
            response.content,
            benchmark_name=benchmark_name,
            target_agents=target_agents,
        )

        # Store benchmark definition to graph for future reference
        if benchmark_def:
            await self._store_benchmark_definition_to_graph(benchmark_def)

        # Store in state
        return {
            "benchmark_definition": benchmark_def,
            "current_stage": "benchmark_execution",
            "benchmark_id": benchmark_def.benchmark_id if benchmark_def else None,
        }

    async def _query_episodic_for_past_benchmarks(self, target_agents: list[str]) -> str:
        """Query episodic memory for past benchmark results.

        Args:
            target_agents: List of agent types to query for

        Returns:
            Context string with relevant past benchmark results
        """
        try:
            # Query for past benchmark results for the target agents
            query = f"benchmark results for agents: {', '.join(target_agents)}"
            embedding = await self._generate_query_embedding(query)

            results = await self.episodic.search_by_embedding(
                embedding=embedding,
                limit=5,
                filter_type="benchmark_result",
            )

            if not results:
                return ""

            context_parts = ["## PAST BENCHMARK RESULTS"]
            for r in results:
                context_parts.append(
                    f"- Benchmark {r.get('benchmark_id')}: "
                    f"passed={r.get('passed')}, scores={r.get('scores')}"
                )
            return "\n".join(context_parts)

        except Exception as e:
            logger.debug(f"Episodic query for past benchmarks failed: {e}")
            return ""

    async def _query_graph_for_performance_patterns(self, target_agents: list[str]) -> str:
        """Query graph for performance patterns on target agents.

        Args:
            target_agents: List of agent types to query

        Returns:
            Context string with performance patterns
        """
        try:
            patterns = await self.graph.query_performance_patterns(
                agent_types=target_agents,
                limit=5,
            )

            if not patterns:
                return ""

            context_parts = ["## PERFORMANCE PATTERNS"]
            for p in patterns:
                context_parts.append(
                    f"- {p.get('pattern')}: "
                    f"success_rate={p.get('success_rate')}, "
                    f"avg_latency={p.get('avg_latency_ms')}ms"
                )
            return "\n".join(context_parts)

        except Exception as e:
            logger.debug(f"Graph query for performance patterns failed: {e}")
            return ""

    async def _query_procedural_for_benchmarking_skills(self) -> str:
        """Query procedural memory for benchmarking skills and best practices.

        Returns:
            Context string with relevant benchmarking skills
        """
        try:
            query = "benchmarking skills best practices"
            embedding = await self._generate_query_embedding(query)

            skills = await self.procedural.search_by_embedding(
                embedding=embedding,
                limit=3,
                filter_type="skill",
            )

            if not skills:
                return ""

            context_parts = ["## BENCHMARKING SKILLS"]
            for s in skills:
                context_parts.append(f"- {s.get('name')}: {s.get('description', '')[:200]}")
            return "\n".join(context_parts)

        except Exception as e:
            logger.debug(f"Procedural query for benchmarking skills failed: {e}")
            return ""

    async def _store_benchmark_definition_to_graph(self, benchmark_def: BenchmarkDefinition) -> None:
        """Store benchmark definition to graph for future reference.

        Args:
            benchmark_def: The benchmark definition to store
        """
        try:
            record = {
                "type": "benchmark_definition",
                "benchmark_id": benchmark_def.benchmark_id,
                "benchmark_name": benchmark_def.benchmark_name,
                "target_agents": benchmark_def.target_agents,
                "task_count": len(benchmark_def.tasks),
                "metrics": benchmark_def.metrics,
                "pass_threshold": benchmark_def.pass_threshold,
            }

            await self.graph.upsert_node(
                label="BenchmarkDefinition",
                properties=record,
            )

            logger.info(f"Stored benchmark definition {benchmark_def.benchmark_id} to graph")

        except Exception as e:
            logger.error(f"Failed to store benchmark definition to graph: {e}")

    def _build_benchmark_prompt(
        self,
        benchmark_name: str,
        target_agents: list[str],
        criteria: dict,
        job_context: dict,
        past_benchmarks: str = "",
        performance_patterns: str = "",
        benchmark_skills: str = "",
    ) -> str:
        """Build prompt for benchmark generation."""
        context_str = ""
        if job_context:
            # Include relevant context from the job
            code = job_context.get("code_history", [""])[-1]
            res = job_context.get("res", {})
            if code:
                context_str += f"\n## GENERATED CODE TO BENCHMARK\n\n```python\n{code[:2000]}\n```\n\n"
            if res:
                context_str += f"\n## ENVIRONMENT SPEC\n\n```json\n{json.dumps(res, indent=2)[:2000]}\n```\n\n"

        # Add KB context if available
        kb_context = ""
        if past_benchmarks:
            kb_context += f"\n\n{past_benchmarks}\n"
        if performance_patterns:
            kb_context += f"\n\n{performance_patterns}\n"
        if benchmark_skills:
            kb_context += f"\n\n{benchmark_skills}\n"

        return f"""## BENCHMARK REQUEST

Benchmark Name: {benchmark_name}
Target Agents: {", ".join(target_agents)}
Criteria: {json.dumps(criteria, indent=2) if criteria else "None specified"}
{context_str}
{kb_context}
## YOUR TASK

Create a benchmark definition to evaluate agent performance on the target agents.

For the target agents, define:
1. Benchmark tasks with known ground truth
2. Success criteria and metrics
3. Appropriate test cases
4. Synthetic test cases if real ones are insufficient

Each task must have:
- task_id: unique identifier string
- description: what this task evaluates
- input_spec: dictionary describing the input
- expected_output: what the agent should produce
- ground_truth: the correct answer for evaluation

Metrics to consider (select appropriate ones):
- accuracy: percentage of tasks completed correctly
- latency: execution time per task
- token_usage: LLM tokens consumed
- success_rate: overall pass rate

Output a JSON benchmark definition with this structure:
{{
  "benchmark_name": "...",
  "target_agents": [...],
  "tasks": [...],
  "metrics": [...],
  "pass_threshold": 0.85
}}

Return ONLY valid JSON, no additional text."""

    def _parse_benchmark_response(
        self,
        content: str,
        benchmark_name: str,
        target_agents: list[str],
    ) -> Optional[BenchmarkDefinition]:
        """Parse benchmark definition from LLM response."""
        import re

        # Try to extract JSON from code blocks
        json_match = re.search(r"```(?:json)?\s*(.*?)\s*```", content, re.DOTALL)
        if json_match:
            json_str = json_match.group(1)
        else:
            # Try to find JSON directly
            json_str = content

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError:
            # Try to find JSON-like content
            json_start = content.find("{")
            json_end = content.rfind("}")
            if json_start != -1 and json_end != -1:
                json_str = content[json_start:json_end + 1]
                try:
                    data = json.loads(json_str)
                except json.JSONDecodeError:
                    logger.error(f"Failed to parse benchmark JSON from response: {content[:500]}")
                    return self._create_default_benchmark(benchmark_name, target_agents)
            else:
                logger.error(f"No JSON found in benchmark response: {content[:500]}")
                return self._create_default_benchmark(benchmark_name, target_agents)

        # Parse tasks
        tasks = []
        for task_data in data.get("tasks", []):
            tasks.append(BenchmarkTask(
                task_id=task_data.get("task_id", str(uuid.uuid4())),
                description=task_data.get("description", ""),
                input_spec=task_data.get("input_spec", {}),
                expected_output=task_data.get("expected_output"),
                ground_truth=task_data.get("ground_truth"),
            ))

        # Create benchmark definition
        benchmark_id = data.get("benchmark_id") or str(uuid.uuid4())
        return BenchmarkDefinition(
            benchmark_id=benchmark_id,
            benchmark_name=data.get("benchmark_name", benchmark_name),
            target_agents=data.get("target_agents", target_agents),
            tasks=tasks,
            metrics=data.get("metrics", ["accuracy", "success_rate"]),
            pass_threshold=data.get("pass_threshold", 0.85),
        )

    def _create_default_benchmark(
        self,
        benchmark_name: str,
        target_agents: list[str],
    ) -> BenchmarkDefinition:
        """Create a default benchmark if parsing fails."""
        return BenchmarkDefinition(
            benchmark_id=str(uuid.uuid4()),
            benchmark_name=benchmark_name,
            target_agents=target_agents,
            tasks=[
                BenchmarkTask(
                    task_id="default-task-1",
                    description="Default benchmark task",
                    input_spec={"type": "code_generation"},
                    expected_output="generated_code",
                    ground_truth="test_output",
                ),
            ],
            metrics=["accuracy", "success_rate"],
            pass_threshold=0.85,
        )


async def create_benchmark_from_request(
    target_agents: list[str],
    criteria: dict,
    benchmark_name: str = "default",
    job_context: Optional[dict] = None,
) -> BenchmarkDefinition:
    """Convenience function to create a benchmark from a request."""
    agent = BenchmarkAgent()
    state = {
        "job_id": "benchmark-create",
        "benchmark_request": {
            "target_agents": target_agents,
            "criteria": criteria,
            "benchmark_name": benchmark_name,
        },
    }
    if job_context:
        state.update(job_context)

    result = await agent.run(state)
    return result.get("benchmark_definition")
