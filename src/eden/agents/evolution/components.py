"""Evolution Engine components — async background processes.

These run continuously, processing Archivist output and improving every system component.
They do not block job execution.
"""

import json
import logging
from abc import ABC, abstractmethod
from typing import Optional
from datetime import datetime, timedelta
from collections import defaultdict

from eden.llm.client import OpenRouterClient
from eden.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class EvolutionComponent(ABC):
    """Base class for Evolution Engine components."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        self.llm = llm_client or OpenRouterClient()
        self.last_run: Optional[datetime] = None

    @abstractmethod
    async def run(self) -> dict:
        """Run the evolution component.

        Returns:
            dict with results, metrics, any KB writes
        """
        pass

    def should_run(self, interval: timedelta) -> bool:
        """Check if enough time has passed since last run."""
        if self.last_run is None:
            return True
        return datetime.utcnow() - self.last_run >= interval

    async def schedule(self, interval: timedelta):
        """Schedule this component to run periodically."""
        while True:
            if self.should_run(interval):
                try:
                    result = await self.run()
                    logger.info(f"{self.__class__.__name__} completed: {result.get('summary', 'OK')}")
                except Exception as e:
                    logger.error(f"{self.__class__.__name__} failed: {e}")
            else:
                await self._sleep(interval)

    async def _sleep(self, interval: timedelta):
        """Sleep until next run."""
        import asyncio
        await asyncio.sleep(interval.total_seconds())


class Distiller(EvolutionComponent):
    """Nightly batch process that clusters episodic memory and extracts patterns.

    Runs nightly. For clusters with ≥5 jobs showing consistent pattern:
    - Generates semantic fact with confidence + evidence citations
    For clusters with contradictory patterns:
    - Generates conditional facts or flags for Research Harvester

    Mines cross-job success patterns the per-job Archivist may miss.
    """

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__(llm_client)
        from eden.kb.episodic.client import get_episodic_client
        from eden.kb.semantic.graph_client import get_graph_client
        from eden.kb.shared.audit import evaluate_audn
        self.episodic = get_episodic_client()
        self.graph = get_graph_client()
        self.evaluate_audn = evaluate_audn

    async def run(self) -> dict:
        """Run the distiller.

        1. Query episodic for jobs from last 30 days
        2. Cluster by environment_class, reward_structure_type, outcome
        3. For clusters with ≥5 jobs showing consistent pattern:
           - Analyze for consistent patterns via LLM
           - If pattern found, propose semantic fact with AUDN protocol
        4. For contradictory clusters, generate conditional facts or flag
        """
        self.last_run = datetime.utcnow()
        logger.info("Distiller running nightly batch")

        # Step 1: Query recent jobs
        candidates = await self.episodic.get_clustering_candidates(days=30, limit=500)

        if not candidates:
            logger.info("No completed jobs in last 30 days, skipping")
            return {
                "summary": "No jobs to analyze",
                "clusters_analyzed": 0,
                "patterns_extracted": 0,
                "conditional_facts": 0,
                "flagged_for_harvester": 0,
            }

        # Step 2: Cluster by environment_class and reward_structure_type
        clusters = self._build_clusters(candidates)

        # Step 3: Analyze each qualifying cluster
        patterns_extracted = 0
        conditional_facts = 0
        flagged_for_harvester = 0
        clusters_analyzed = 0

        for (env_class, reward_type), jobs in clusters.items():
            if len(jobs) < 5:
                continue

            clusters_analyzed += 1
            outcome_dist = self._compute_outcome_distribution(jobs)

            # Check consistency: if ≥70% same outcome, treat as consistent pattern
            dominant_outcome, dominance_ratio = self._get_dominant_outcome(outcome_dist)

            if dominance_ratio >= 0.7:
                # Consistent pattern - extract semantic fact
                result = await self._extract_pattern(
                    env_class=env_class,
                    reward_type=reward_type,
                    jobs=jobs,
                    dominant_outcome=dominant_outcome,
                    dominance_ratio=dominance_ratio,
                )
                if result.get("fact_written"):
                    patterns_extracted += 1
                if result.get("flagged_for_harvester"):
                    flagged_for_harvester += 1
            else:
                # Contradictory cluster - generate conditional fact
                result = await self._extract_conditional_fact(
                    env_class=env_class,
                    reward_type=reward_type,
                    jobs=jobs,
                    outcome_dist=outcome_dist,
                )
                if result.get("fact_written"):
                    conditional_facts += 1
                if result.get("flagged_for_harvester"):
                    flagged_for_harvester += 1

        logger.info(
            f"Distiller completed: clusters={clusters_analyzed}, "
            f"patterns={patterns_extracted}, conditional={conditional_facts}, "
            f"flagged={flagged_for_harvester}"
        )

        return {
            "summary": "Distiller completed",
            "clusters_analyzed": clusters_analyzed,
            "patterns_extracted": patterns_extracted,
            "conditional_facts": conditional_facts,
            "flagged_for_harvester": flagged_for_harvester,
        }

    def _build_clusters(
        self,
        candidates: list[dict],
    ) -> dict[tuple[str, str], list[dict]]:
        """Group jobs by environment_class and reward_structure_type."""
        clusters: dict[tuple[str, str], list[dict]] = defaultdict(list)
        for job in candidates:
            env_class = job.get("environment_class") or "unknown"
            reward_type = job.get("reward_structure_type") or "unspecified"
            clusters[(env_class, reward_type)].append(job)
        return dict(clusters)

    def _compute_outcome_distribution(
        self,
        jobs: list[dict],
    ) -> dict[str, int]:
        """Count jobs by outcome_tier."""
        dist: dict[str, int] = defaultdict(int)
        for job in jobs:
            tier = job.get("outcome_tier") or "unknown"
            dist[tier] += 1
        return dict(dist)

    def _get_dominant_outcome(
        self,
        outcome_dist: dict[str, int],
    ) -> tuple[str, float]:
        """Get the dominant outcome and its ratio."""
        if not outcome_dist:
            return "unknown", 0.0
        total = sum(outcome_dist.values())
        if total == 0:
            return "unknown", 0.0
        dominant = max(outcome_dist, key=outcome_dist.get)
        return dominant, outcome_dist[dominant] / total

    async def _extract_pattern(
        self,
        env_class: str,
        reward_type: str,
        jobs: list[dict],
        dominant_outcome: str,
        dominance_ratio: float,
    ) -> dict:
        """Extract semantic fact from consistent pattern via LLM."""
        # Build job summaries for prompt
        job_summaries = []
        for job in jobs:
            summary = {
                "job_id": job["job_id"],
                "outcome": job["outcome_tier"],
                "design_confidence": job.get("design_confidence"),
                "novelty": job.get("novelty_assessment"),
                "difficulty": job.get("difficulty_parameters", {}),
                "design_decisions": [d.get("decision") for d in job.get("design_decisions", []) if d.get("decision")],
                "test_passed": job.get("test_passed"),
                "quality_iterations": job.get("quality_iterations"),
            }
            job_summaries.append(summary)

        prompt = self._build_pattern_prompt(
            env_class=env_class,
            reward_type=reward_type,
            job_summaries=job_summaries,
            dominant_outcome=dominant_outcome,
            dominance_ratio=dominance_ratio,
        )

        try:
            response = await self.llm.acall(
                agent="distiller",
                prompt=prompt,
                slot="extraction",
            )

            import json
            content = response.content.strip()

            # Try to parse JSON from response
            facts = self._parse_facts(content)

            facts_written = 0
            flagged = 0
            for fact in facts:
                written = await self._write_semantic_fact(fact)
                if written:
                    facts_written += 1
                if fact.get("requires_external_research"):
                    flagged += 1

            return {
                "fact_written": facts_written > 0,
                "facts_count": len(facts),
                "flagged_for_harvester": flagged > 0,
            }
        except Exception as e:
            logger.error(f"Distiller LLM call failed: {e}")
            return {"fact_written": False, "flagged_for_harvester": False}

    async def _extract_conditional_fact(
        self,
        env_class: str,
        reward_type: str,
        jobs: list[dict],
        outcome_dist: dict[str, int],
    ) -> dict:
        """Extract conditional fact from contradictory cluster."""
        job_summaries = []
        for job in jobs:
            summary = {
                "job_id": job["job_id"],
                "outcome": job["outcome_tier"],
                "design_confidence": job.get("design_confidence"),
                "difficulty": job.get("difficulty_parameters", {}),
                "known_risks": [r.get("risk") for r in job.get("known_risks", []) if r.get("risk")],
                "test_passed": job.get("test_passed"),
            }
            job_summaries.append(summary)

        prompt = self._build_conditional_prompt(
            env_class=env_class,
            reward_type=reward_type,
            job_summaries=job_summaries,
            outcome_dist=outcome_dist,
        )

        try:
            response = await self.llm.acall(
                agent="distiller",
                prompt=prompt,
                slot="extraction",
            )

            facts = self._parse_facts(response.content.strip())

            facts_written = 0
            flagged = 0
            for fact in facts:
                # Add conditional context to fact
                fact["is_conditional"] = True
                fact["condition"] = f"env_class={env_class}, reward_type={reward_type}"
                fact["outcome_distribution"] = outcome_dist
                written = await self._write_semantic_fact(fact)
                if written:
                    facts_written += 1
                if fact.get("requires_external_research"):
                    flagged += 1

            return {
                "fact_written": facts_written > 0,
                "facts_count": len(facts),
                "flagged_for_harvester": flagged > 0,
            }
        except Exception as e:
            logger.error(f"Distiller conditional LLM call failed: {e}")
            return {"fact_written": False, "flagged_for_harvester": False}

    def _build_pattern_prompt(
        self,
        env_class: str,
        reward_type: str,
        job_summaries: list[dict],
        dominant_outcome: str,
        dominance_ratio: float,
    ) -> str:
        """Build prompt for pattern extraction from consistent cluster."""
        return f"""You are the Distiller for Eden, analyzing a cluster of job outcomes.

CLUSTER SUMMARY:
- Environment class: {env_class}
- Reward structure type: {reward_type}
- Total jobs: {len(job_summaries)}
- Dominant outcome: {dominant_outcome} ({dominance_ratio:.0%})
- Outcome distribution: {self._format_outcome_dist(job_summaries)}

JOB SUMMARIES:
{self._format_job_summaries(job_summaries)}

TASK:
Identify the key patterns that explain why this cluster has a consistent "{dominant_outcome}" outcome.
Focus on:
1. Design decisions that appear in successful (Gold/Silver) outcomes
2. Reward structure patterns (component types, bounds, shaping)
3. Difficulty parameter settings
4. Known risks that were/were not mitigated
5. Novelty vs standard design approaches

Output a JSON array of semantic facts. Each fact should have:
- "entity_type": e.g., "DesignPattern", "RewardStructure", "DifficultySetting"
- "name": concise pattern name
- "properties": {{"description", "evidence_count", "success_rate", "key_decisions": [], "relevant_env_classes": []}}
- "confidence": 0.0-1.0 based on evidence strength
- "valid_at": current datetime

If external research is needed to resolve contradictions, add "requires_external_research": true.
"""

    def _build_conditional_prompt(
        self,
        env_class: str,
        reward_type: str,
        job_summaries: list[dict],
        outcome_dist: dict[str, int],
    ) -> str:
        """Build prompt for conditional fact extraction from contradictory cluster."""
        return f"""You are the Distiller for Eden, analyzing a cluster with MIXED outcomes.

CLUSTER SUMMARY:
- Environment class: {env_class}
- Reward structure type: {reward_type}
- Total jobs: {len(job_summaries)}
- Outcome distribution: {outcome_dist}

JOB SUMMARIES:
{self._format_job_summaries(job_summaries)}

TASK:
This cluster shows contradictory outcomes despite similar environment class and reward structure.
Identify what conditions or factors might explain the different outcomes.

Focus on:
1. Subtle differences in design decisions between outcomes
2. Difficulty parameter variations that correlate with success/failure
3. Risk mitigation strategies that differ
4. Any conditional patterns (e.g., "when X is true, outcome is Y")

Output a JSON array of CONDITIONAL semantic facts. Each fact should have:
- "entity_type": "ConditionalPattern" or similar
- "name": descriptive conditional name
- "properties": {{"description", "when_conditions": [], "then_outcome", "evidence_count", "relevant_env_classes": []}}
- "confidence": 0.0-1.0
- "valid_at": current datetime
- "is_conditional": true

If the contradiction cannot be resolved without external research, add "requires_external_research": true.
"""

    def _format_outcome_dist(self, job_summaries: list[dict]) -> str:
        """Format outcome distribution for prompts."""
        dist = defaultdict(int)
        for job in job_summaries:
            dist[job["outcome"]] += 1
        return ", ".join(f"{k}: {v}" for k, v in sorted(dist.items()))

    def _format_job_summaries(self, summaries: list[dict], max_jobs: int = 10) -> str:
        """Format job summaries for prompts, limiting to most relevant."""
        if len(summaries) > max_jobs:
            # Prioritize showing diverse outcomes
            by_outcome = defaultdict(list)
            for s in summaries:
                by_outcome[s["outcome"]].append(s)
            selected = []
            for outcome in ["Gold", "Silver", "Bronze", "Partial", "Failed", "unknown"]:
                selected.extend(by_outcome.get(outcome, [])[:2])
            summaries = selected[:max_jobs]

        lines = []
        for s in summaries:
            lines.append(f"  - job={s['job_id'][:8]}, outcome={s['outcome']}, "
                        f"confidence={s.get('design_confidence')}, "
                        f"novelty={s.get('novelty')}, "
                        f"passed={s.get('test_passed')}")
        return "\n".join(lines)

    def _parse_facts(self, content: str) -> list[dict]:
        """Parse JSON facts from LLM response."""
        import json, re

        # Try direct JSON parse
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            pass

        # Try to extract from markdown code blocks
        match = re.search(r"```(?:json)?\s*\n(.*?)\n```", content, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass

        # Try to find any JSON array
        match = re.search(r"\[\s*\{.*\}\s*\]", content, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(0))
            except json.JSONDecodeError:
                pass

        logger.warning(f"Could not parse facts from LLM response: {content[:200]}")
        return []

    async def _write_semantic_fact(self, fact: dict) -> bool:
        """Write a semantic fact using AUDN protocol."""
        # Check for existing facts with same name and type
        existing = await self.graph.query_by_type(
            entity_type=fact.get("entity_type", "Unknown"),
            limit=100,
        )

        # Filter to matching name
        name = fact.get("name")
        matching = [e for e in existing if e.get("name") == name]

        # Evaluate AUDN
        audn_result = self.evaluate_audn(
            proposed=fact,
            existing=matching,
            subject_key="name",
        )

        if audn_result.action == "NONE":
            logger.debug(f"Skipping duplicate fact: {name}")
            return False

        # Apply write
        fact["recorded_at"] = datetime.utcnow()
        fact["valid_at"] = fact.get("valid_at", datetime.utcnow())

        success = await self.graph.insert_entity(fact)

        if success:
            logger.info(f"Wrote semantic fact: {fact.get('entity_type')}/{name}")
        else:
            logger.error(f"Failed to write semantic fact: {name}")

        return success


class PromptEvolvers(EvolutionComponent):
    """Per-agent prompt improvement based on quality metrics.

    Runs per agent, per 50-job rolling window.
    If downstream quality metrics degrade:
    - Retrieve 10 failure cases
    - Generate structured failure analysis
    - Propose 3 candidate improved prompts
    - A/B test on next 20 jobs
    - Promote winner

    Also runs on improvement: identify what changed and reinforce it.
    """

    # Quality thresholds
    DEGRADATION_THRESHOLD = 0.10  # 10% degradation triggers evolution
    IMPROVEMENT_THRESHOLD = 0.10  # 10% improvement triggers reinforcement
    MIN_JOBS_FOR_ANALYSIS = 20   # Minimum jobs before analyzing
    AB_TEST_JOBS = 20            # Number of jobs for A/B test

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__(llm_client)
        from eden.kb.episodic.client import get_episodic_client
        from eden.kb.prompt_versions.client import get_prompt_versions_client
        self.episodic = get_episodic_client()
        self.prompt_versions = get_prompt_versions_client()

    async def run(self) -> dict:
        """Run prompt evolution check.

        Process:
        1. For each agent, check quality metrics over last 50 jobs
        2. If quality degraded or improved significantly:
           - Retrieve failure/success cases
           - Generate prompt variants
           - Create A/B test entries
        3. Track results and promote winner
        """
        self.last_run = datetime.utcnow()
        logger.info("PromptEvolvers running per-agent prompt evolution")

        # Get all agents
        agents = ["planner", "critic", "refiner", "fact_checker", "executor", "verifier", "tester", "archivist"]

        results = {
            "summary": "Prompt Evolver completed",
            "agents_checked": 0,
            "degradations_detected": 0,
            "improvements_detected": 0,
            "prompts_updated": 0,
            "ab_tests_initiated": 0,
        }

        for agent in agents:
            try:
                agent_result = await self._evolve_agent_prompts(agent)
                results["agents_checked"] += 1

                if agent_result.get("degradation_detected"):
                    results["degradations_detected"] += 1
                if agent_result.get("improvement_detected"):
                    results["improvements_detected"] += 1
                if agent_result.get("prompts_updated"):
                    results["prompts_updated"] += agent_result["prompts_updated"]
                if agent_result.get("ab_test_initiated"):
                    results["ab_tests_initiated"] += 1

            except Exception as e:
                logger.error(f"Error evolving prompts for agent {agent}: {e}")

        logger.info(
            f"PromptEvolvers completed: agents={results['agents_checked']}, "
            f"degradations={results['degradations_detected']}, "
            f"improvements={results['improvements_detected']}, "
            f"updates={results['prompts_updated']}, "
            f"ab_tests={results['ab_tests_initiated']}"
        )

        return results

    async def _evolve_agent_prompts(self, agent: str) -> dict:
        """Check and evolve prompts for a specific agent.

        Returns dict with:
          - degradation_detected: bool
          - improvement_detected: bool
          - prompts_updated: int
          - ab_test_initiated: bool
        """
        # Get current active prompt version
        active_prompt = await self.prompt_versions.get_active_prompt(agent)
        if not active_prompt:
            logger.debug(f"No active prompt for agent {agent}, skipping")
            return {"degradation_detected": False, "improvement_detected": False, "prompts_updated": 0, "ab_test_initiated": False}

        current_version = active_prompt["version"]
        current_metrics = active_prompt.get("quality_metrics", {})

        # Get recent jobs for this agent (jobs that used this prompt version)
        # We track which jobs tested which prompt version
        recent_jobs = await self._get_recent_jobs_for_agent(agent, limit=50)

        if len(recent_jobs) < self.MIN_JOBS_FOR_ANALYSIS:
            logger.debug(f"Agent {agent}: insufficient jobs ({len(recent_jobs)}) for analysis")
            return {"degradation_detected": False, "improvement_detected": False, "prompts_updated": 0, "ab_test_initiated": False}

        # Calculate quality metrics for current prompt
        current_quality = self._calculate_quality_metrics(recent_jobs, current_version)

        # Compare to previous quality metrics
        previous_quality = self._extract_previous_quality(current_metrics)

        degradation_detected = False
        improvement_detected = False
        variants_created = 0

        if previous_quality:
            # Check for degradation
            if self._is_degraded(current_quality, previous_quality):
                degradation_detected = True
                logger.info(f"Agent {agent}: degradation detected, generating prompt variants")
                variants_created = await self._handle_degradation(agent, current_version, recent_jobs, current_quality, previous_quality)

            # Check for improvement
            elif self._is_improved(current_quality, previous_quality):
                improvement_detected = True
                logger.info(f"Agent {agent}: improvement detected, reinforcing")
                await self._handle_improvement(agent, current_version, current_quality, previous_quality)

        # Update quality metrics on the prompt version
        await self._update_prompt_metrics(agent, current_version, current_quality)

        return {
            "degradation_detected": degradation_detected,
            "improvement_detected": improvement_detected,
            "prompts_updated": variants_created,
            "ab_test_initiated": variants_created > 0,
        }

    async def _get_recent_jobs_for_agent(self, agent: str, limit: int) -> list[dict]:
        """Get recent jobs with quality metrics.

        Since we don't have direct agent-job mapping, we infer from job outcomes.
        For this implementation, we use jobs that completed successfully as proxy.
        """
        # Get recent completed jobs
        jobs = await self.episodic.get_recent(days=30, limit=limit)

        # Filter to jobs with quality metrics
        jobs_with_metrics = [j for j in jobs if j.get("quality_metrics")]

        return jobs_with_metrics[:limit]

    def _calculate_quality_metrics(self, jobs: list[dict], version: int) -> dict:
        """Calculate aggregate quality metrics from jobs.

        Metrics we track:
        - test_pass_rate: fraction of jobs passing tests
        - critic_routing_rate: fraction requiring critic routing
        - executor_iterations: average executor iterations
        - quality_iterations: average code quality iterations
        """
        if not jobs:
            return {}

        total = len(jobs)
        passed = sum(1 for j in jobs if j.get("outcome_tier") in ["Gold", "Silver"])
        critic_routed = sum(1 for j in jobs if j.get("critic_decisions") and len(j.get("critic_decisions", [])) > 1)

        # Calculate averages
        executor_iters = []
        quality_iters = []
        for j in jobs:
            if "executor_iterations" in j:
                executor_iters.append(j["executor_iterations"])
            if "quality_iterations" in j:
                quality_iters.append(j["quality_iterations"])

        return {
            "test_pass_rate": passed / total if total > 0 else 0.0,
            "critic_routing_rate": critic_routed / total if total > 0 else 0.0,
            "avg_executor_iterations": sum(executor_iters) / len(executor_iters) if executor_iters else 0.0,
            "avg_quality_iterations": sum(quality_iters) / len(quality_iters) if quality_iters else 0.0,
            "jobs_analyzed": total,
            "version": version,
        }

    def _extract_previous_quality(self, current_metrics: dict) -> Optional[dict]:
        """Extract previous quality metrics from prompt version metrics.

        Previous metrics are stored under 'history' key.
        """
        if not current_metrics:
            return None

        history = current_metrics.get("history", [])
        if history:
            return history[-1]  # Most recent previous quality

        return None

    def _is_degraded(self, current: dict, previous: dict) -> bool:
        """Check if quality has degraded beyond threshold."""
        if not previous:
            return False

        # Check test pass rate degradation
        current_pass_rate = current.get("test_pass_rate", 0)
        previous_pass_rate = previous.get("test_pass_rate", 0)

        if previous_pass_rate > 0:
            degradation = (previous_pass_rate - current_pass_rate) / previous_pass_rate
            if degradation >= self.DEGRADATION_THRESHOLD:
                return True

        # Check executor iterations increase (bad)
        current_iters = current.get("avg_executor_iterations", 0)
        previous_iters = previous.get("avg_executor_iterations", 0)

        if previous_iters > 0:
            increase = (current_iters - previous_iters) / previous_iters
            if increase >= self.DEGRADATION_THRESHOLD:
                return True

        return False

    def _is_improved(self, current: dict, previous: dict) -> bool:
        """Check if quality has improved beyond threshold."""
        if not previous:
            return False

        # Check test pass rate improvement
        current_pass_rate = current.get("test_pass_rate", 0)
        previous_pass_rate = previous.get("test_pass_rate", 0)

        if previous_pass_rate > 0:
            improvement = (current_pass_rate - previous_pass_rate) / previous_pass_rate
            if improvement >= self.IMPROVEMENT_THRESHOLD:
                return True

        # Check executor iterations decrease (good)
        current_iters = current.get("avg_executor_iterations", 0)
        previous_iters = previous.get("avg_executor_iterations", 0)

        if previous_iters > 0:
            decrease = (previous_iters - current_iters) / previous_iters
            if decrease >= self.IMPROVEMENT_THRESHOLD:
                return True

        return False

    async def _handle_degradation(
        self,
        agent: str,
        current_version: int,
        failure_jobs: list[dict],
        current_quality: dict,
        previous_quality: dict,
    ) -> int:
        """Handle detected degradation by generating prompt variants.

        Process:
        1. Get failure cases (jobs that failed or had issues)
        2. Generate 3 candidate improved prompts via LLM
        3. Insert candidates as new versions with ab_test_active flag

        Returns:
            Number of variants created for A/B testing
        """
        # Get failure cases (Bronze, Partial, Failed outcomes)
        failures = [j for j in failure_jobs if j.get("outcome_tier") in ["Bronze", "Partial", "Failed"]]

        if not failures:
            logger.debug(f"Agent {agent}: no failure jobs found for analysis")
            return 0

        # Select 10 failure cases for analysis
        failure_cases = failures[:10]

        # Generate prompt variants
        variants = await self._generate_prompt_variants(agent, failure_cases, current_quality, previous_quality)

        if not variants:
            logger.warning(f"Agent {agent}: failed to generate prompt variants")
            return 0

        # Insert new versions with A/B test flag
        variants_created = 0
        for i, variant in enumerate(variants):
            new_version = current_version + i + 1
            success = await self.prompt_versions.insert_version(
                agent=agent,
                system_prompt=variant["prompt"],
                version=new_version,
                few_shot_examples=[],
                quality_metrics={"ab_test_active": True, "ab_test_round": i + 1},
                active=False,
            )
            if success:
                variants_created += 1
                logger.info(f"Agent {agent}: created prompt variant v{new_version} for A/B testing")
                # Auto-create canary experiment for this variant when
                # enabled via settings. Defaults to 5% traffic; 0 disables.
                await self._auto_create_canary(agent, new_version, i + 1)

        return variants_created

    async def _auto_create_canary(
        self,
        agent: str,
        version: int,
        ab_test_round: int,
    ) -> bool:
        """Auto-create a canary experiment for a newly generated variant.

        When ``settings.evolver_auto_canary_pct`` is greater than 0, each
        newly inserted prompt variant is automatically enrolled in a
        canary at the configured traffic percentage.  The variant's
        ``quality_metrics`` are updated to mark it as an active canary
        (``canary_status="active"``, ``canary_traffic_pct``,
        ``canary_created_at``).  An ``evolver.auto_canary_created``
        audit event is written to ``org_audit_log``.

        Args:
            agent: Agent name the variant belongs to.
            version: Newly inserted prompt version.
            ab_test_round: A/B test round (1-based) within the batch.

        Returns:
            True if a canary was created, False if disabled / failed.
        """
        traffic_pct = settings.evolver_auto_canary_pct
        if not isinstance(traffic_pct, int) or traffic_pct <= 0:
            logger.debug(
                f"Auto-canary disabled (evolver_auto_canary_pct={traffic_pct}) "
                f"for {agent} v{version}; variant stays inactive."
            )
            return False

        if traffic_pct > 100:
            traffic_pct = 100

        canary_metrics = {
            "ab_test_active": True,
            "ab_test_round": ab_test_round,
            "canary_status": "active",
            "canary_traffic_pct": traffic_pct,
            "canary_created_at": datetime.utcnow().isoformat(),
        }

        # Persist the canary state on the prompt version row.  The
        # ``prompt_versions`` table is the source of truth for variant
        # status in this codebase; a separate ``prompt_canary_experiments``
        # table can be wired up later without breaking callers.
        try:
            updated = await self.prompt_versions.update_quality_metrics(
                agent, version, canary_metrics
            )
        except Exception as e:
            logger.error(
                f"Failed to mark canary active on {agent} v{version}: {e}"
            )
            return False

        if not updated:
            logger.warning(
                f"Could not persist canary metrics for {agent} v{version}"
            )
            return False

        # Best-effort audit log.  Evolution runs are org-agnostic in
        # this codebase (no ``org_id`` is plumbed through the prompt
        # evolver), so the row is attributed to the first organization
        # and user we can resolve; see ``_log_canary_audit_event`` for
        # the resolution strategy.
        try:
            await self._log_canary_audit_event(agent, version, traffic_pct)
        except Exception as e:
            # Audit failures must never break evolution; the canary is
            # already live in the database.
            logger.error(
                f"Failed to write evolver.auto_canary_created audit log "
                f"for {agent} v{version}: {e}"
            )

        logger.info(
            f"Agent {agent}: auto-canary created for v{version} "
            f"at {traffic_pct}% traffic"
        )
        return True

    async def _log_canary_audit_event(
        self,
        agent: str,
        version: int,
        traffic_pct: int,
    ) -> None:
        """Write an ``evolver.auto_canary_created`` event to org_audit_log.

        Evolution runs in the background with no logged-in user and the
        ``prompt_versions`` table is not org-scoped, so the audit row is
        attributed to a synthetic ``system`` user and the first
        organization in the database.  When the schema evolves to
        org-scope ``prompt_versions``, this method should resolve
        ``org_id`` from the variant row instead.
        """
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()

        # Resolve an org_id: prefer the first real org so we satisfy
        # the org_audit_log FK to organizations(id).  Falls back to a
        # sentinel all-zeros UUID if the orgs table is empty (e.g. in
        # unit tests that don't seed the org table).
        org_id: Optional[str] = None
        try:
            org_id = await client.fetchval(
                "SELECT id FROM organizations ORDER BY created_at LIMIT 1"
            )
        except Exception:
            org_id = None
        if not org_id:
            org_id = "00000000-0000-0000-0000-000000000000"

        # Resolve a system user (best-effort).  Most prod databases
        # have at least one user; in fresh test DBs we fall back to
        # the sentinel so the INSERT doesn't violate the FK.
        user_id: Optional[str] = None
        try:
            user_id = await client.fetchval(
                "SELECT id FROM users ORDER BY created_at LIMIT 1"
            )
        except Exception:
            user_id = None
        if not user_id:
            user_id = "00000000-0000-0000-0000-000000000000"

        metadata = {
            "agent": agent,
            "version": version,
            "traffic_pct": traffic_pct,
            "source": "PromptEvolvers",
        }

        await client.execute(
            """
            INSERT INTO org_audit_log (
                org_id, user_id, action, target_type, target_id,
                metadata, ip_address, user_agent
            ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
            """,
            org_id,
            user_id,
            "evolver.auto_canary_created",
            "prompt_version",
            f"{agent}:{version}",
            json.dumps(metadata),
        )

    async def _handle_improvement(
        self,
        agent: str,
        current_version: int,
        current_quality: dict,
        previous_quality: dict,
    ) -> None:
        """Handle detected improvement by reinforcing the winning strategy."""
        # When improvement is detected, we note what changed and keep it
        # The current prompt is already working well

        improvement_details = {
            "reinforced_at": datetime.utcnow().isoformat(),
            "improvement_factors": [],
        }

        # Calculate what improved
        if current_quality.get("test_pass_rate", 0) > previous_quality.get("test_pass_rate", 0):
            improvement_details["improvement_factors"].append("test_pass_rate_increased")

        if current_quality.get("avg_executor_iterations", 0) < previous_quality.get("avg_executor_iterations", 0):
            improvement_details["improvement_factors"].append("executor_iterations_decreased")

        # Update metrics with reinforcement info
        current_quality["reinforcement"] = improvement_details
        await self.prompt_versions.update_quality_metrics(agent, current_version, current_quality)

        logger.info(f"Agent {agent}: reinforced current prompt (improvement detected)")

    async def _generate_prompt_variants(
        self,
        agent: str,
        failure_cases: list[dict],
        current_quality: dict,
        previous_quality: dict,
    ) -> list[dict]:
        """Generate 3 candidate prompt variants based on failure analysis.

        Uses LLM to analyze failures and propose improvements.
        """
        # Build failure analysis prompt
        failure_summary = self._build_failure_summary(failure_cases)

        prompt = f"""You are improving the system prompt for the {agent} agent in Eden.

ANALYSIS OF RECENT FAILURES:
{failure_summary}

CURRENT QUALITY METRICS:
- Test pass rate: {current_quality.get('test_pass_rate', 0):.2%}
- Critic routing rate: {current_quality.get('critic_routing_rate', 0):.2%}
- Avg executor iterations: {current_quality.get('avg_executor_iterations', 0):.1f}
- Avg quality iterations: {current_quality.get('avg_quality_iterations', 0):.1f}

PREVIOUS QUALITY METRICS:
- Test pass rate: {previous_quality.get('test_pass_rate', 0):.2%}
- Critic routing rate: {previous_quality.get('critic_routing_rate', 0):.2%}
- Avg executor iterations: {previous_quality.get('avg_executor_iterations', 0):.1f}
- Avg quality iterations: {previous_quality.get('avg_quality_iterations', 0):.1f}

TASK:
Analyze the failure cases and generate 3 improved system prompts for the {agent} agent.
Each prompt should address the specific failure patterns observed.

For each variant:
1. Identify the key failure pattern
2. Propose a specific improvement to the prompt
3. Write the complete improved system prompt

Output a JSON array of 3 objects, each with:
- "variant_id": 1, 2, or 3
- "failure_pattern": what this variant addresses
- "prompt": the complete improved system prompt text

Focus on concrete, actionable improvements. Avoid generic advice."""

        try:
            response = await self.llm.acall(
                agent="prompt_evolvers",
                prompt=prompt,
                slot="reasoning",
            )

            # Parse response
            import json, re
            content = response.content.strip()

            # Try JSON parse
            try:
                variants = json.loads(content)
            except json.JSONDecodeError:
                # Try markdown code blocks
                match = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", content, re.DOTALL)
                if match:
                    variants = json.loads(match.group(1))
                else:
                    logger.warning(f"Could not parse prompt variants from response")
                    return []

            return variants

        except Exception as e:
            logger.error(f"Error generating prompt variants: {e}")
            return []

    def _build_failure_summary(self, failure_cases: list[dict]) -> str:
        """Build a text summary of failure cases for the LLM."""
        lines = []
        for i, case in enumerate(failure_cases[:10]):
            outcome = case.get("outcome_tier", "unknown")
            job_id = case.get("job_id", "unknown")[:8]

            # Extract failure info
            critic_decisions = case.get("critic_decisions", [])
            routing = case.get("routing_history", [])

            failure_type = "unknown"
            if outcome == "Failed":
                failure_type = "fundamental_failure"
            elif outcome == "Partial":
                failure_type = "partial_pass_with_concerns"

            lines.append(f"""
Case {i+1}: Job {job_id}
- Outcome: {outcome}
- Failure type: {failure_type}
- Routing decisions: {[r.get('to') for r in routing[-3:]]}
- Critic decisions: {[c.get('routing') for c in critic_decisions[-2:]]}
""")

        return "\n".join(lines)

    async def _update_prompt_metrics(
        self,
        agent: str,
        version: int,
        quality: dict,
    ) -> None:
        """Update quality metrics on a prompt version.

        Appends current quality to history.
        """
        # Get current metrics
        current = await self.prompt_versions.get_prompts_for_agent(agent, version)
        if not current:
            return

        existing_metrics = current.get("quality_metrics", {})

        # Build history entry
        history_entry = {
            "timestamp": datetime.utcnow().isoformat(),
            "test_pass_rate": quality.get("test_pass_rate", 0),
            "critic_routing_rate": quality.get("critic_routing_rate", 0),
            "avg_executor_iterations": quality.get("avg_executor_iterations", 0),
            "avg_quality_iterations": quality.get("avg_quality_iterations", 0),
            "jobs_analyzed": quality.get("jobs_analyzed", 0),
        }

        # Update metrics
        history = existing_metrics.get("history", [])
        history.append(history_entry)

        # Keep only last 10 history entries
        if len(history) > 10:
            history = history[-10:]

        existing_metrics["history"] = history
        existing_metrics["last_updated"] = datetime.utcnow().isoformat()
        existing_metrics["latest_quality"] = quality

        await self.prompt_versions.update_quality_metrics(agent, version, existing_metrics)


class ResearchHarvester(EvolutionComponent):
    """Weekly crawl of research sources.

    Crawls arXiv, framework docs, conference proceedings, agent eval platforms.
    Extracted findings → research_proposals table for Archivist batch mode.
    Framework changes trigger invalid_at updates on superseded KB entries.
    """

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__(llm_client)
        from eden.kb.episodic.client import get_episodic_client
        from eden.kb.semantic.graph_client import get_graph_client
        from eden.kb.research.client import get_research_client
        from eden.agents.evolution.research.harvester import ResearchHarvesterEngine

        self.episodic = get_episodic_client()
        self.graph = get_graph_client()
        self.research = get_research_client()
        self.engine = ResearchHarvesterEngine(llm_client)

    async def run(self) -> dict:
        """Run weekly research harvest."""
        self.last_run = datetime.utcnow()
        run_id = f"harvester_{self.last_run.isoformat()}"

        logger.info("Research Harvester starting weekly harvest...")

        results = await self.engine.harvest_all_sources(run_id)

        if results.get("framework_changes"):
            updates = await self._update_superseded_entries(results["framework_changes"])
            results["kb_updates"] = updates

        logger.info(
            f"Research Harvester completed: papers={results['papers_processed']}, "
            f"findings={results['findings_extracted']}, "
            f"framework_changes={len(results.get('framework_changes', []))}, "
            f"kb_updates={results.get('kb_updates', 0)}"
        )

        return {
            "summary": "Research Harvester completed",
            "papers_processed": results.get("papers_processed", 0),
            "findings_extracted": results.get("findings_extracted", 0),
            "framework_changes_detected": len(results.get("framework_changes", [])),
            "kb_updates": results.get("kb_updates", 0),
        }

    async def _update_superseded_entries(self, changes: list[dict]) -> int:
        """Set invalid_at on KB entries superseded by framework changes."""
        updates = 0
        for change in changes:
            framework = change["framework_name"]
            new_version = change["new_version"]

            try:
                entities = await self.graph.query_by_type("FrameworkVersion")
                for entity in entities:
                    props = entity.get("properties", {})
                    if props.get("framework_name") == framework and not entity.get("invalid_at"):
                        await self.graph.invalidate_entity(entity["id"])
                        updates += 1
                        logger.info(f"Invalidated {entity['id']} for {framework} v{new_version}")
            except Exception as e:
                logger.warning(f"Failed to invalidate entries for {framework}: {e}")

        return updates


class RetrievalTuner(EvolutionComponent):
    """Optimizes KB retrieval strategies based on usage.

    Active at 200 completed jobs. Every KB retrieval tagged with:
    - Agent ID
    - Job ID
    - Query

    After job completion, Archivist identifies which retrieved items
    appeared in agent reasoning. Queries that retrieve irrelevant items →
    strategy adjusted. Queries that retrieve relevant → strategy reinforced.
    """

    # Activation threshold
    MIN_JOBS_BEFORE_ACTIVE = 200

    # Relevance thresholds for adjustment
    IRRELEVANT_THRESHOLD = 0.25  # <25% relevant = adjust
    RELEVANT_THRESHOLD = 0.80  # >80% relevant = reinforce

    # Minimum queries before deciding
    MIN_QUERIES_FOR_DECISION = 10

    # Adjustment increments
    THRESHOLD_INCREMENT = 0.05
    WEIGHT_INCREMENT = 0.1

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__(llm_client)
        self._init_clients()

    def _init_clients(self):
        """Lazy initialization to avoid circular imports."""
        from eden.kb.retrieval_logger import get_retrieval_logger
        from eden.kb.strategy_store import get_strategy_store
        from eden.storage.postgres import get_postgres_client

        self.retrieval_logger = get_retrieval_logger()
        self.strategy_store = get_strategy_store()
        self._postgres = None

    async def _get_postgres(self):
        if self._postgres is None:
            from eden.storage.postgres import get_postgres_client
            self._postgres = await get_postgres_client()
        return self._postgres

    async def run(self) -> dict:
        """Run retrieval tuning analysis."""
        self.last_run = datetime.utcnow()

        # Check if enough completed jobs exist
        completed_count = await self._count_completed_jobs()
        if completed_count < self.MIN_JOBS_BEFORE_ACTIVE:
            logger.info(
                f"RetrievalTuner: only {completed_count} jobs, "
                f"need {self.MIN_JOBS_BEFORE_ACTIVE} to activate"
            )
            return {
                "summary": "Not yet active",
                "completed_jobs": completed_count,
            }

        logger.info("RetrievalTuner running retrieval strategy analysis")

        # Get all active strategies
        strategies = await self.strategy_store.get_all_strategies()

        strategies_adjusted = 0
        strategies_reinforced = 0
        queries_analyzed = 0

        for strategy in strategies:
            collection = strategy["collection"]

            # Analyze relevance for this collection
            result = await self._analyze_collection_strategy(collection, strategy)

            if result.get("adjusted"):
                strategies_adjusted += 1
            elif result.get("reinforced"):
                strategies_reinforced += 1

            queries_analyzed += result.get("queries_analyzed", 0)

        logger.info(
            f"RetrievalTuner completed: queries={queries_analyzed}, "
            f"adjusted={strategies_adjusted}, reinforced={strategies_reinforced}"
        )

        return {
            "summary": "Retrieval Tuner completed",
            "completed_jobs": completed_count,
            "queries_analyzed": queries_analyzed,
            "strategies_adjusted": strategies_adjusted,
            "strategies_reinforced": strategies_reinforced,
        }

    async def _count_completed_jobs(self) -> int:
        """Count completed jobs in the database."""
        client = await self._get_postgres()
        row = await client.fetchrow(
            """
            SELECT COUNT(*) as count FROM jobs WHERE completed_at IS NOT NULL
            """
        )
        return row["count"] if row else 0

    async def _analyze_collection_strategy(
        self, collection: str, strategy: dict
    ) -> dict:
        """Analyze retrieval relevance for a collection and adjust strategy if needed."""

        # Get recent retrieval logs with relevance scores for this collection
        analysis = await self._get_relevance_analysis(collection)

        if analysis["total_queries"] < self.MIN_QUERIES_FOR_DECISION:
            return {
                "queries_analyzed": analysis["total_queries"],
                "adjusted": False,
                "reinforced": False,
            }

        relevant_ratio = (
            analysis["relevant_queries"] / analysis["total_queries"]
            if analysis["total_queries"] > 0
            else 0
        )

        # Determine action
        if relevant_ratio < self.IRRELEVANT_THRESHOLD:
            # Consistently irrelevant - adjust strategy
            adjustment = await self._adjust_strategy(collection, strategy, analysis)
            return {
                "queries_analyzed": analysis["total_queries"],
                "adjusted": True,
                "reinforced": False,
                "adjustment": adjustment,
                "relevant_ratio": relevant_ratio,
            }

        elif relevant_ratio > self.RELEVANT_THRESHOLD:
            # Consistently relevant - reinforce current strategy
            await self._reinforce_strategy(collection, strategy)
            return {
                "queries_analyzed": analysis["total_queries"],
                "adjusted": False,
                "reinforced": True,
                "relevant_ratio": relevant_ratio,
            }

        # Within acceptable range - no action
        return {
            "queries_analyzed": analysis["total_queries"],
            "adjusted": False,
            "reinforced": False,
            "relevant_ratio": relevant_ratio,
        }

    async def _get_relevance_analysis(self, collection: str) -> dict:
        """Get aggregated relevance scores for a collection."""
        client = await self._get_postgres()

        # Query: join retrieval_logs with relevance_scores
        # Count relevant vs irrelevant items per query
        rows = await client.fetch(
            """
            SELECT
                rl.query_hash,
                COUNT(rrs.id) as total_items,
                COUNT(CASE WHEN rrs.is_relevant = TRUE THEN 1 END) as relevant_items
            FROM retrieval_logs rl
            LEFT JOIN retrieval_relevance_scores rrs ON rrs.retrieval_log_id = rl.id
            WHERE rl.collection = $1
              AND rl.created_at > NOW() - INTERVAL '7 days'
            GROUP BY rl.query_hash
            HAVING COUNT(rrs.id) > 0
            LIMIT 100
            """,
            collection,
        )

        total_queries = len(rows)
        relevant_queries = (
            sum(
                1
                for r in rows
                if r["total_items"] > 0 and r["relevant_items"] / r["total_items"] >= 0.5
            )
            if rows
            else 0
        )

        return {
            "total_queries": total_queries,
            "relevant_queries": relevant_queries,
            "query_details": [dict(r) for r in rows],
        }

    async def _adjust_strategy(
        self, collection: str, strategy: dict, analysis: dict
    ) -> dict:
        """Adjust retrieval strategy for a collection with low relevance."""

        current_threshold = strategy.get("score_threshold", 0.7)
        current_dense_weight = strategy.get("dense_weight", 0.6)

        adjustments = {}

        # Strategy 1: Increase score threshold (filter more aggressively)
        new_threshold = min(current_threshold + self.THRESHOLD_INCREMENT, 0.95)
        adjustments["score_threshold"] = new_threshold

        # Strategy 2: If hybrid search is being used, adjust weight
        # Shift toward keyword search if queries are text-based
        hybrid_queries = [
            q
            for q in analysis["query_details"]
            if q.get("query_text") and " " in str(q.get("query_text", ""))
        ]
        if hybrid_queries:
            # Shift toward keyword search
            new_weight = max(current_dense_weight - self.WEIGHT_INCREMENT, 0.3)
            adjustments["dense_weight"] = new_weight
            adjustments["sparse_weight"] = 1.0 - new_weight

        # Apply adjustments
        await self.strategy_store.update_strategy(
            collection,
            {
                **adjustments,
                "last_adjusted_at": datetime.utcnow(),
                "adjustment_reason": f"Relevance below {self.IRRELEVANT_THRESHOLD}",
            },
        )

        logger.info(f"RetrievalTuner: adjusted {collection} strategy: {adjustments}")

        return adjustments

    async def _reinforce_strategy(self, collection: str, strategy: dict) -> None:
        """Mark strategy as reinforced and increment confidence counter."""
        logger.info(
            f"RetrievalTuner: reinforcing {collection} strategy (relevance >80%)"
        )
        # Increment the relevant count to reinforce the strategy
        await self.strategy_store.record_relevance(collection, is_relevant=True)
        # Update last reinforced timestamp
        await self.strategy_store.update_strategy(
            collection,
            {
                "last_reinforced_at": datetime.utcnow(),
                "reinforcement_count": strategy.get("reinforcement_count", 0) + 1,
            },
        )


class PatternMiner(EvolutionComponent):
    """Monthly deep cross-job analysis.

    Complex graph queries across semantic memory:
    - Which design decisions appear in >80% of Gold outcomes?
    - Which reward structure types have highest exploit scan failure rates?
    - Which framework versions have highest fact-check failure rates?
    - What Critic routing decisions predict Tester fundamental failures?
    - Which Skill Library entries most frequently retrieved?

    Produces monthly intelligence report → semantic memory.
    Planner retrieves most recent Pattern Miner report at job start.
    """

    # Minimum job count before patterns are statistically meaningful
    MIN_JOBS_FOR_PATTERNS = 20

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__(llm_client)
        self._episodic = None
        self._graph = None
        self._procedural = None
        self._retrieval_logger = None

    @property
    def episodic(self):
        if self._episodic is None:
            from eden.kb.episodic.client import get_episodic_client
            self._episodic = get_episodic_client()
        return self._episodic

    @property
    def graph(self):
        if self._graph is None:
            from eden.kb.semantic.graph_client import get_graph_client
            self._graph = get_graph_client()
        return self._graph

    @property
    def procedural(self):
        if self._procedural is None:
            from eden.kb.procedural.client import get_procedural_client
            self._procedural = get_procedural_client()
        return self._procedural

    @property
    def retrieval_logger(self):
        if self._retrieval_logger is None:
            from eden.kb.retrieval_logger import get_retrieval_logger
            self._retrieval_logger = get_retrieval_logger()
        return self._retrieval_logger

    async def run(self) -> dict:
        """Run pattern miner — monthly deep cross-job analysis."""
        self.last_run = datetime.utcnow()
        logger.info("PatternMiner running monthly analysis")

        # Step 1: Check if enough completed jobs exist
        recent_jobs = await self._get_recent_jobs()
        if len(recent_jobs) < self.MIN_JOBS_FOR_PATTERNS:
            logger.info(
                f"PatternMiner: only {len(recent_jobs)} jobs, "
                f"need {self.MIN_JOBS_FOR_PATTERNS} to analyze patterns"
            )
            return {
                "summary": "Not enough jobs for pattern analysis",
                "jobs_analyzed": len(recent_jobs),
                "patterns_found": 0,
            }

        # Step 2: Run all pattern queries in parallel
        pattern_results = await self._run_all_pattern_queries(recent_jobs)

        # Step 3: Synthesize into monthly intelligence report
        report = await self._synthesize_intelligence_report(pattern_results)

        # Step 4: Invalidate stale reports and write new one
        invalidated = await self._invalidate_stale_reports()
        written = await self._write_report_to_kb(report)

        patterns_found = (
            len(pattern_results.get("gold_decisions", [])) +
            len(pattern_results.get("exploit_failures", [])) +
            len(pattern_results.get("fact_check_failures", [])) +
            len(pattern_results.get("routing_predictions", [])) +
            len(pattern_results.get("skill_usage", []))
        )

        logger.info(
            f"PatternMiner completed: jobs={len(recent_jobs)}, "
            f"patterns={patterns_found}, invalidated={invalidated}, written={written}"
        )

        return {
            "summary": "Pattern Miner completed",
            "jobs_analyzed": len(recent_jobs),
            "patterns_found": patterns_found,
            "report_id": report.get("id"),
            "invalidated_stale_reports": invalidated,
        }

    async def _get_recent_jobs(self) -> list[dict]:
        """Get recent completed jobs for analysis."""
        return await self.episodic.get_clustering_candidates(days=90, limit=500)

    async def _run_all_pattern_queries(self, recent_jobs: list[dict]) -> dict:
        """Run all 5 pattern queries and return results."""
        results = {}

        gold_decisions = await self._query_gold_outcome_patterns(recent_jobs)
        results["gold_decisions"] = gold_decisions

        exploit_failures = await self._query_exploit_failure_patterns(recent_jobs)
        results["exploit_failures"] = exploit_failures

        fact_check_failures = await self._query_fact_check_failure_patterns(recent_jobs)
        results["fact_check_failures"] = fact_check_failures

        routing_predictions = await self._query_critic_routing_predictions(recent_jobs)
        results["routing_predictions"] = routing_predictions

        skill_usage = await self._query_skill_library_usage()
        results["skill_usage"] = skill_usage

        return results

    async def _query_gold_outcome_patterns(self, recent_jobs: list[dict]) -> list[dict]:
        """Find design decisions appearing in >80% of Gold outcomes."""
        gold_jobs = [j for j in recent_jobs if j.get("outcome") == "Gold"]
        if len(gold_jobs) < 5:
            return []

        # Extract design decisions from Gold jobs
        decisions_by_pattern: dict[str, int] = {}
        for job in gold_jobs:
            edp_history = job.get("edp_history", [])
            if not edp_history:
                continue
            latest_edp = edp_history[-1]
            design_decisions = latest_edp.get("design_decisions", [])
            for decision in design_decisions:
                decision_text = decision.get("decision", "")[:100]
                if decision_text:
                    decisions_by_pattern[decision_text] = \
                        decisions_by_pattern.get(decision_text, 0) + 1

        # Find decisions in >80% of Gold jobs
        threshold = len(gold_jobs) * 0.8
        common_decisions = [
            {"decision": decision, "frequency": count, "ratio": count / len(gold_jobs)}
            for decision, count in decisions_by_pattern.items()
            if count >= threshold
        ]

        return sorted(common_decisions, key=lambda x: x["ratio"], reverse=True)

    async def _query_exploit_failure_patterns(self, recent_jobs: list[dict]) -> list[dict]:
        """Find reward_structure_types with highest exploit scan failure rates."""
        by_reward_type: dict[str, dict] = defaultdict(lambda: {"total": 0, "failures": 0})

        for job in recent_jobs:
            edp_history = job.get("edp_history", [])
            tester_results = job.get("tester_results", {})
            exploit_findings = tester_results.get("exploit_findings", []) if tester_results else []

            if not edp_history:
                continue

            latest_edp = edp_history[-1]
            reward_structure = latest_edp.get("environment", {}).get("reward_structure", {})
            reward_type = reward_structure.get("type", "unknown")

            by_reward_type[reward_type]["total"] += 1
            if len(exploit_findings) > 0:
                by_reward_type[reward_type]["failures"] += 1

        # Compute failure rates
        failure_patterns = []
        for reward_type, counts in by_reward_type.items():
            if counts["total"] < 3:
                continue
            failure_rate = counts["failures"] / counts["total"]
            if failure_rate > 0:
                failure_patterns.append({
                    "reward_type": reward_type,
                    "total_jobs": counts["total"],
                    "failure_count": counts["failures"],
                    "failure_rate": failure_rate,
                })

        return sorted(failure_patterns, key=lambda x: x["failure_rate"], reverse=True)

    async def _query_fact_check_failure_patterns(self, recent_jobs: list[dict]) -> list[dict]:
        """Find which framework versions have highest fact-check failure rates."""
        by_framework: dict[str, dict] = defaultdict(lambda: {"total": 0, "failures": 0})

        for job in recent_jobs:
            edp_history = job.get("edp_history", [])
            if not edp_history:
                continue

            latest_edp = edp_history[-1]
            output_spec = latest_edp.get("output_spec", {})
            framework = output_spec.get("framework", "unknown")
            framework_version = output_spec.get("framework_version", "unknown")

            key = f"{framework}:{framework_version}"

            # Check if job had fact_check failures
            fact_check_report = job.get("fact_check_report", {})
            had_blockers = fact_check_report and fact_check_report.get("blockers")

            by_framework[key]["total"] += 1
            if had_blockers:
                by_framework[key]["failures"] += 1

        # Compute failure rates
        failure_patterns = []
        for framework_key, counts in by_framework.items():
            if counts["total"] < 2:
                continue
            failure_rate = counts["failures"] / counts["total"]
            framework, version = framework_key.split(":", 1)
            failure_patterns.append({
                "framework": framework,
                "framework_version": version,
                "total_jobs": counts["total"],
                "failure_count": counts["failures"],
                "failure_rate": failure_rate,
            })

        return sorted(failure_patterns, key=lambda x: x["failure_rate"], reverse=True)

    async def _query_critic_routing_predictions(self, recent_jobs: list[dict]) -> list[dict]:
        """Find which Critic routing decisions predict downstream fundamental failures."""
        routing_outcomes: dict[str, dict] = defaultdict(lambda: {"total": 0, "fundamental_failures": 0})

        for job in recent_jobs:
            critic_decisions = job.get("critic_decisions", [])
            routing_history = job.get("routing_history", [])
            tester_results = job.get("tester_results", {})

            # Determine if job had fundamental failure
            had_fundamental_failure = (
                tester_results.get("category") == "fundamental" if tester_results else False
            )

            # Extract routing decisions
            for decision in critic_decisions:
                routing_decision = decision.get("routing_decision", "unknown")
                routing_outcomes[routing_decision]["total"] += 1
                if had_fundamental_failure:
                    routing_outcomes[routing_decision]["fundamental_failures"] += 1

            # Also look at routing history
            for route in routing_history:
                target = route.get("target", "unknown")
                if target in ["human_review", "planning"]:
                    routing_outcomes[target]["total"] += 1
                    if had_fundamental_failure:
                        routing_outcomes[target]["fundamental_failures"] += 1

        # Compute prediction rates
        predictions = []
        for routing_decision, counts in routing_outcomes.items():
            if counts["total"] < 3:
                continue
            failure_rate = counts["fundamental_failures"] / counts["total"]
            predictions.append({
                "routing_decision": routing_decision,
                "total_occurrences": counts["total"],
                "downstream_failures": counts["fundamental_failures"],
                "failure_prediction_rate": failure_rate,
            })

        return sorted(predictions, key=lambda x: x["failure_prediction_rate"], reverse=True)

    async def _query_skill_library_usage(self) -> list[dict]:
        """Find which Skill Library entries are most frequently retrieved and used."""
        try:
            # Query retrieval logs for skill library usage
            from eden.storage.postgres import get_postgres_client
            client = await get_postgres_client()

            query = """
                SELECT
                    rl.query_text,
                    COUNT(*) as retrieval_count,
                    COUNT(DISTINCT rl.job_id) as unique_jobs
                FROM retrieval_logs rl
                WHERE rl.collection = 'eden_skills'
                    AND rl.retrieval_latency_ms IS NOT NULL
                GROUP BY rl.query_text
                ORDER BY retrieval_count DESC
                LIMIT 20
            """
            rows = await client.fetch(query)
            return [
                {
                    "skill_query": row["query_text"],
                    "retrieval_count": row["retrieval_count"],
                    "unique_jobs": row["unique_jobs"],
                }
                for row in rows
            ]
        except Exception as e:
            logger.warning(f"Could not query skill library usage: {e}")
            return []

    async def _synthesize_intelligence_report(self, pattern_results: dict) -> dict:
        """Use LLM to synthesize pattern findings into monthly intelligence report."""
        report_id = f"intel-report-{datetime.utcnow().strftime('%Y-%m')}"

        # Build context summary of all patterns
        gold_decisions = pattern_results.get("gold_decisions", [])
        exploit_failures = pattern_results.get("exploit_failures", [])
        fact_check_failures = pattern_results.get("fact_check_failures", [])
        routing_predictions = pattern_results.get("routing_predictions", [])
        skill_usage = pattern_results.get("skill_usage", [])

        # If we have enough patterns, use LLM to synthesize
        total_patterns = len(gold_decisions) + len(exploit_failures) + \
                        len(fact_check_failures) + len(routing_predictions) + \
                        len(skill_usage)

        if total_patterns >= 3:
            synthesis_prompt = self._build_synthesis_prompt(pattern_results)
            try:
                llm_response = await self.llm.acall(
                    prompt=synthesis_prompt,
                    slot="reasoning",
                    max_tokens=2048,
                )
                # Parse LLM synthesis if available
                synthesis = llm_response.content if llm_response else ""
            except Exception as e:
                logger.warning(f"LLM synthesis failed: {e}")
                synthesis = ""
        else:
            synthesis = ""

        # Build structured report
        report = {
            "id": report_id,
            "entity_type": "IntelligenceReport",
            "name": f"Monthly Intelligence Report — {datetime.utcnow().strftime('%B %Y')}",
            "properties": {
                "report_month": datetime.utcnow().strftime("%Y-%m"),
                "executive_summary": self._generate_executive_summary(pattern_results),
                "gold_outcome_patterns": gold_decisions[:10],
                "exploit_failure_patterns": exploit_failures[:10],
                "fact_check_failure_patterns": fact_check_failures[:10],
                "routing_predictions": routing_predictions[:10],
                "skill_usage_patterns": skill_usage[:10],
                "llm_synthesis": synthesis,
                "total_patterns_analyzed": total_patterns,
            },
            "valid_at": datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0),
            "recorded_at": datetime.utcnow(),
        }

        return report

    def _build_synthesis_prompt(self, pattern_results: dict) -> str:
        """Build prompt for LLM to synthesize patterns into narrative."""
        gold = pattern_results.get("gold_decisions", [])
        exploit = pattern_results.get("exploit_failures", [])
        fact_check = pattern_results.get("fact_check_failures", [])
        routing = pattern_results.get("routing_predictions", [])
        skills = pattern_results.get("skill_usage", [])

        return f"""You are Eden's Pattern Miner, synthesizing monthly intelligence.

Synthesize these patterns into a concise executive summary with key recommendations.

GOLD OUTCOME DESIGN PATTERNS ({len(gold)} found):
{self._format_patterns(gold[:5], "decision", "ratio")}

EXPLOIT SCAN FAILURE PATTERNS ({len(exploit)} found):
{self._format_patterns(exploit[:5], "reward_type", "failure_rate")}

FACT-CHECK FAILURE PATTERNS ({len(fact_check)} found):
{self._format_patterns(fact_check[:5], "framework", "failure_rate")}

CRITIC ROUTING PREDICTIONS ({len(routing)} found):
{self._format_patterns(routing[:5], "routing_decision", "failure_prediction_rate")}

SKILL LIBRARY USAGE ({len(skills)} found):
{self._format_patterns(skills[:5], "skill_query", "retrieval_count")}

Provide a 3-paragraph synthesis:
1. Key findings across all pattern categories
2. Most actionable insights for Planner improvement
3. Recommended focus areas for next month

Format as plain text, no JSON needed."""

    def _format_patterns(self, patterns: list[dict], key_field: str, metric_field: str) -> str:
        """Format pattern list for prompts."""
        if not patterns:
            return "  (none)"
        lines = []
        for p in patterns:
            key = p.get(key_field, "unknown")
            metric = p.get(metric_field, 0)
            if isinstance(metric, float):
                metric = f"{metric:.2%}" if metric < 1 else f"{metric:.1f}"
            lines.append(f"  - {key}: {metric}")
        return "\n".join(lines)

    def _generate_executive_summary(self, pattern_results: dict) -> str:
        """Generate executive summary without LLM for fallback."""
        gold = pattern_results.get("gold_decisions", [])
        exploit = pattern_results.get("exploit_failures", [])
        fact_check = pattern_results.get("fact_check_failures", [])

        parts = []

        if gold:
            top_gold = gold[0].get("decision", "unknown")[:50]
            parts.append(f"Top Gold pattern: {top_gold}...")

        if exploit:
            worst = exploit[0]
            parts.append(f"Highest exploit failure rate: {worst.get('reward_type', 'unknown')} at {worst.get('failure_rate', 0):.0%}")

        if fact_check:
            worst = fact_check[0]
            parts.append(f"Most fact-check problematic: {worst.get('framework', 'unknown')} {worst.get('framework_version', '')} at {worst.get('failure_rate', 0):.0%}")

        return "; ".join(parts) if parts else "No significant patterns detected."

    async def _write_report_to_kb(self, report: dict) -> bool:
        """Write intelligence report to semantic memory using AUDN protocol."""
        from eden.kb.shared.audit import evaluate_audn

        # Check for existing reports of same month
        existing = await self.graph.query_by_type(entity_type="IntelligenceReport", limit=10)

        # Filter to same month
        report_month = report.get("properties", {}).get("report_month", "")
        matching = [
            e for e in existing
            if e.get("properties", {}).get("report_month") == report_month
        ]

        # Evaluate AUDN
        audn_result = evaluate_audn(
            proposed=report,
            existing=matching,
            subject_key="name",
        )

        if audn_result.action == "NONE":
            logger.debug(f"Skipping duplicate intelligence report for {report_month}")
            return False

        # Apply write
        success = await self.graph.insert_entity(report)

        if success:
            logger.info(f"Wrote intelligence report: {report.get('name')}")
        else:
            logger.error(f"Failed to write intelligence report")

        return success

    async def _invalidate_stale_reports(self) -> int:
        """Invalidate any previous IntelligenceReport entities for older months."""
        existing = await self.graph.query_by_type(entity_type="IntelligenceReport", limit=50)

        current_month = datetime.utcnow().strftime("%Y-%m")
        invalidated = 0

        for entity in existing:
            entity_month = entity.get("properties", {}).get("report_month", "")
            if entity_month and entity_month != current_month:
                if await self.graph.invalidate_entity(entity.get("id")):
                    invalidated += 1

        if invalidated:
            logger.info(f"Invalidated {invalidated} stale intelligence reports")

        return invalidated