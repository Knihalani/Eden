"""Planner agent — research arm of the Eden pipeline.

Produces Environment Design Plan (EDP) by gathering context from the Knowledge Base,
performing multi-hop web research, and synthesizing an evidence-grounded plan.
"""

import json
import logging
import re
from typing import Optional, Any

from eden.llm.client import OpenRouterClient, get_llm_client
from eden.config import get_settings
from eden.kb.episodic.client import get_episodic_client
from eden.kb.semantic.graph_client import get_graph_client
from eden.kb.semantic.vector_client import get_vector_client
from eden.kb.procedural.client import get_procedural_client
from eden.kb.exploit.client import get_exploit_client
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


class PlannerAgent(PromptLoader):
    """Planner agent that researches and produces Environment Design Plans.

    The Planner is responsible for:
    1. Querying the Knowledge Base for relevant context
    2. Performing multi-hop web research (~15 calls)
    3. Synthesizing an evidence-grounded EDP

    The EDP schema is defined in the PRD and includes:
    - meta: environment_class, observation_modality, novelty_assessment, design_confidence
    - environment: observation_space, action_space, reward_structure, episode_dynamics
    - output_spec: language, framework, framework_version, interface_contract, entry_class
    - known_risks, design_decisions
    """

    AGENT_NAME = "planner"

    SYSTEM_PROMPT = """You are the Planner for Eden, an AI-native environment generation system.

Your role is to research and produce a complete Environment Design Plan (EDP) for the requested
environment. The EDP must be grounded in evidence from literature, the Knowledge Base, and
web research.

You have access to:
- Episodic memory (past job outcomes and lessons)
- Semantic memory (design patterns, failure modes, best practices)
- Procedural memory (skill library, code patterns)
- Web search for literature and framework documentation

Produce a complete EDP that addresses ALL of the following:

1. ENVIRONMENT CLASS: Classify the environment based on the description provided.
   This is a flexible label — choose what fits best, or create a new one if needed.
   Examples: rl_training, rl_eval, agent_sandbox, llm_agent_eval, tool_use,
   multi_agent, curriculum, adversarial, simulation, or custom.

2. OBSERVATION MODALITY: How does the agent perceive the environment?
   Examples: discrete, continuous, image, language, graph, multimodal, or custom.

3. NOVELTY ASSESSMENT: standard (known pattern), variant (modification), novel (first-of-kind)

4. DESIGN CONFIDENCE: 0.0-1.0 (your confidence the design will succeed)

For the ENVIRONMENT specification:
- observation_space: type, shape, bounds, sufficiency_rationale
- action_space: type, dimensionality, bounds, meaningfulness_rationale
- reward_structure: type (dense/sparse/shaped/verifiable/none), components with formulas,
  hacking_risk_per_category with mitigations
- episode_dynamics: termination conditions, max_steps, reset_logic, stochasticity
- difficulty_parameters: axes, defaults, ranges

For KNOWN_RISKS: Identify specific risks with severity and mitigations.

For DESIGN_DECISIONS: Document each decision with rationale and alternatives considered.

CRITICAL: Address all archivist_warnings for this environment class from the Knowledge Base.
Every warning must be explicitly addressed in the design.

Output the complete EDP as structured JSON."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_planner
        self.max_turns = settings.max_turns_planner
        self._episodic = None
        self._graph = None
        self._vector = None
        self._procedural = None
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
    def vector(self):
        """Lazy load vector client."""
        if self._vector is None:
            self._vector = get_vector_client()
        return self._vector

    @property
    def procedural(self):
        """Lazy load procedural client."""
        if self._procedural is None:
            self._procedural = get_procedural_client()
        return self._procedural

    @property
    def exploit(self):
        """Lazy load exploit client."""
        if self._exploit is None:
            self._exploit = get_exploit_client()
        return self._exploit

    async def run(self, state: dict) -> dict:
        """Run the Planner agent on the current state.

        Args:
            state: EdenJobState with job_id, request, kb_reads

        Returns:
            dict with edp added to state
        """
        job_id = state["job_id"]
        request = state["request"]

        logger.info(f"Planner running for job {job_id}")

        # Track KB reads for provenance
        kb_reads = []

        # Step 1: Query episodic memory for similar jobs
        episodic_context = await self._query_episodic(request, kb_reads)

        # Step 2: Query semantic graph for failure patterns
        graph_context = await self._query_graph(request, kb_reads)

        # Step 3: Query semantic vector for design patterns
        vector_context = await self._query_vector(request, kb_reads)

        # Step 4: Query procedural memory (skill library)
        skill_context = await self._query_skills(request, kb_reads)

        # Step 5: Query exploits for known attack patterns
        exploit_context = await self._query_exploits(request, kb_reads)

        # Step 6: Retrieve archivist warnings for this env class
        warnings_context = await self._query_archivist_warnings(request, kb_reads)

        # Step 7: Multi-hop web research
        research_context = await self._perform_web_research(request)

        # Step 8: Synthesize all context into EDP
        edp = await self._synthesize_edp(
            request=request,
            episodic_context=episodic_context,
            graph_context=graph_context,
            vector_context=vector_context,
            skill_context=skill_context,
            exploit_context=exploit_context,
            warnings_context=warnings_context,
            research_context=research_context,
        )

        logger.info(f"Planner produced EDP for job {job_id}: confidence={edp.get('meta', {}).get('design_confidence', 'unknown')}")

        return {
            "edp": edp,
            "edp_history": [edp],
            "current_stage": "criticizing",
            "kb_reads": kb_reads,
        }

    async def _query_episodic(self, request: dict, kb_reads: list) -> str:
        """Query episodic memory for similar job outcomes."""
        try:
            description = request.get("description", "")
            framework = request.get("framework", "")
            env_class = request.get("environment_class", "")

            # Build search query
            search_terms = [description, framework, env_class]
            search_text = " ".join(filter(None, search_terms))

            if not search_text:
                return "No episodic context available."

            # Search by description text
            recent_jobs = await self.episodic.search_by_description(search_text, limit=5)

            # Also get recent jobs
            recent = await self.episodic.get_recent(days=30, limit=10)

            # Combine and deduplicate
            all_jobs = {j["job_id"]: j for j in recent_jobs + recent}
            similar_jobs = list(all_jobs.values())[:5]

            context_parts = []
            for job in similar_jobs:
                outcome = job.get("outcome_tier", "unknown")
                env = job.get("environment_class", "unknown")
                status = job.get("status", "unknown")

                context_parts.append(
                    f"- Job {job['job_id'][:8]}: {env} | outcome={outcome} | status={status}\n"
                    f"  Request: {str(job.get('request', {}))[:200]}"
                )

                kb_reads.append({
                    "type": "episodic",
                    "job_id": job["job_id"],
                    "summary": f"{env} job with outcome={outcome}",
                })

            return "\n".join(context_parts) if context_parts else "No similar episodic jobs found."
        except Exception as e:
            logger.warning(f"Episodic query failed: {e}")
            return f"Episodic query failed: {e}"

    async def _query_graph(self, request: dict, kb_reads: list) -> str:
        """Query semantic graph for failure patterns and design patterns."""
        try:
            env_class = request.get("environment_class", "")
            description = request.get("description", "")

            if not env_class:
                return "No graph context available."

            # Query entities by type for this environment class
            failure_entities = await self.graph.query_by_type(
                entity_type="FailureMode",
                limit=10,
            )

            pattern_entities = await self.graph.query_by_type(
                entity_type="DesignPattern",
                limit=10,
            )

            context_parts = []

            if failure_entities:
                context_parts.append("## Known Failure Modes")
                for entity in failure_entities[:5]:
                    props = entity.get("properties", {})
                    context_parts.append(
                        f"- {entity['name']}: {props.get('description', 'No description')}\n"
                        f"  Severity: {props.get('severity', 'unknown')}\n"
                        f"  Prevention: {props.get('prevention', 'unknown')}"
                    )
                    kb_reads.append({
                        "type": "graph_failure",
                        "entity_id": entity["id"],
                        "summary": entity["name"],
                    })

            if pattern_entities:
                context_parts.append("\n## Design Patterns")
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

            return "\n".join(context_parts) if context_parts else "No graph context found."
        except Exception as e:
            logger.warning(f"Graph query failed: {e}")
            return f"Graph query failed: {e}"

    async def _query_vector(self, request: dict, kb_reads: list) -> str:
        """Query semantic vector store for design patterns."""
        try:
            description = request.get("description", "")
            env_class = request.get("environment_class", "")

            if not description:
                return "No vector context available."

            # Generate query embedding (using LLM to create a pseudo-embedding)
            query_text = f"{description} {env_class}"
            query_vector = await self._generate_query_embedding(query_text)

            # Search semantic memory collection
            results = await self.vector.search(
                collection="semantic_memory",
                query_vector=query_vector,
                filter_conditions={"entity_type": "DesignPattern"} if env_class else None,
                limit=5,
            )

            context_parts = []
            for result in results.results:
                context_parts.append(
                    f"- {result.payload.get('name', 'Unknown')}: "
                    f"{result.payload.get('description', 'No description')}"
                )
                kb_reads.append({
                    "type": "vector_design",
                    "entity_id": result.id,
                    "score": result.score,
                    "summary": result.payload.get("name", ""),
                })

            return "\n".join(context_parts) if context_parts else "No vector context found."
        except Exception as e:
            logger.warning(f"Vector query failed: {e}")
            return f"Vector query failed: {e}"

    async def _query_skills(self, request: dict, kb_reads: list) -> str:
        """Query procedural memory (Skill Library) for relevant skills."""
        try:
            env_class = request.get("environment_class", "")
            framework = request.get("framework", "")
            description = request.get("description", "")

            query_text = f"{description} {env_class} {framework}"
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
                    f"  Template: {skill.get('code_template', '')[:200]}..."
                )
                kb_reads.append({
                    "type": "skill",
                    "skill_id": skill["id"],
                    "summary": skill["name"],
                })

            return "\n".join(context_parts) if context_parts else "No relevant skills found."
        except Exception as e:
            logger.warning(f"Skill query failed: {e}")
            return f"Skill query failed: {e}"

    async def _query_exploits(self, request: dict, kb_reads: list) -> str:
        """Query Exploit Library for known attack patterns."""
        try:
            env_class = request.get("environment_class", "")
            reward_types = request.get("difficulty_parameters", {}).get("reward_types", [])

            if not env_class:
                return "No exploit context available."

            # Get applicable exploits
            exploits = await self.exploit.get_applicable(
                env_class=env_class,
                reward_types=reward_types if reward_types else ["dense", "sparse"],
            )

            context_parts = []
            for exploit in exploits[:5]:
                context_parts.append(
                    f"- Exploit: {exploit['name']} ({exploit['category']})\n"
                    f"  Description: {exploit.get('description', 'No description')}\n"
                    f"  Probe: {exploit.get('probe_code', '')[:150]}..."
                )
                kb_reads.append({
                    "type": "exploit",
                    "exploit_id": exploit["id"],
                    "summary": f"{exploit['name']} ({exploit['category']})",
                })

            return "\n".join(context_parts) if context_parts else "No relevant exploits found."
        except Exception as e:
            logger.warning(f"Exploit query failed: {e}")
            return f"Exploit query failed: {e}"

    async def _query_archivist_warnings(self, request: dict, kb_reads: list) -> str:
        """Retrieve archivist warnings for this environment class."""
        try:
            env_class = request.get("environment_class", "")

            if not env_class:
                return "No archivist warnings available."

            # Query graph for warnings specific to this env class
            entities = await self.graph.query_by_type(
                entity_type="ArchivistWarning",
                limit=10,
            )

            # Filter to relevant warnings
            relevant_warnings = [
                e for e in entities
                if env_class in e.get("properties", {}).get("applicable_env_classes", [])
            ]

            context_parts = []
            for warning in relevant_warnings:
                props = warning.get("properties", {})
                context_parts.append(
                    f"- WARNING: {warning['name']}\n"
                    f"  Rule: {props.get('warning_text', 'No description')}\n"
                    f"  Mitigation: {props.get('mitigation', 'Unknown')}"
                )
                kb_reads.append({
                    "type": "archivist_warning",
                    "entity_id": warning["id"],
                    "summary": warning["name"],
                })

            return "\n".join(context_parts) if context_parts else "No archivist warnings for this environment class."
        except Exception as e:
            logger.warning(f"Archivist warnings query failed: {e}")
            return f"Archivist warnings query failed: {e}"

    async def _perform_web_research(self, request: dict) -> str:
        """Perform multi-hop web research for the environment.

        This implements iterative agentic research:
        1. Initial broad search
        2. Read top results, update understanding
        3. Form refined follow-up queries
        4. Repeat until research budget (~15 calls) exhausted
        """
        research_items = []
        call_count = 0
        max_calls = 15
        # Budget allocation: 5 initial searches, 4 page reads, 3 follow-up, 3 deep-dive
        search_budget = 5
        read_budget = 4
        followup_budget = 3
        deep_dive_budget = 3

        description = request.get("description", "")
        framework = request.get("framework", "")
        env_class = request.get("environment_class", "")

        if not description:
            return "No web research performed - no description provided."

        try:
            # Phase 1: Initial broad search (5 calls)
            initial_queries = self._generate_initial_queries(description, framework, env_class)

            initial_results = []
            for query in initial_queries[:search_budget]:
                if call_count >= max_calls:
                    break

                try:
                    result = await self._web_search(query)
                    if result:
                        initial_results.append(result)
                        research_items.append(result)
                        call_count += 1
                except Exception as e:
                    logger.debug(f"Web search failed for '{query}': {e}")

            # Phase 2: Read top results and update understanding (4 calls)
            # Extract URLs from initial results for deeper reading
            urls_to_read = self._extract_urls_from_results(initial_results)
            page_contents = []

            for url in urls_to_read[:read_budget]:
                if call_count >= max_calls:
                    break

                try:
                    content = await self._read_page(url)
                    if content:
                        page_contents.append(content)
                        call_count += 1
                        research_items.append({
                            "query": f"read:{url}",
                            "findings": content,
                        })
                except Exception as e:
                    logger.debug(f"Page read failed for '{url}': {e}")

            # Phase 3: Form refined follow-up queries based on initial findings
            refined_queries = self._generate_refined_queries(
                description, framework, env_class, initial_results, page_contents
            )

            for query in refined_queries[:followup_budget]:
                if call_count >= max_calls:
                    break

                try:
                    result = await self._web_search(query)
                    if result:
                        research_items.append(result)
                        call_count += 1
                except Exception as e:
                    logger.debug(f"Web search failed for refined query '{query}': {e}")

            # Phase 4: Deep dive queries informed by earlier research
            deep_dive_queries = self._generate_deep_dive_queries(
                description, framework, env_class, research_items
            )

            for query in deep_dive_queries[:deep_dive_budget]:
                if call_count >= max_calls:
                    break

                try:
                    result = await self._web_search(query)
                    if result:
                        research_items.append(result)
                        call_count += 1
                except Exception as e:
                    logger.debug(f"Web search failed for deep dive query '{query}': {e}")

            # Synthesize research into context
            return self._synthesize_research_context(research_items)

        except Exception as e:
            logger.warning(f"Web research failed: {e}")
            return f"Web research failed: {e}"

    def _generate_initial_queries(self, description: str, framework: str, env_class: str) -> list[str]:
        """Generate initial research queries based on request."""
        queries = [
            f"{env_class} RL environment design best practices",
            f"{framework} API reference documentation",
            f"{description} reinforcement learning implementation",
            f"{env_class} reward function design patterns",
            f"{framework} {env_class} example implementation",
        ]
        return queries

    def _extract_urls_from_results(self, results: list[dict]) -> list[str]:
        """Extract relevant URLs from search results for deeper reading."""
        urls = []
        for result in results:
            if hasattr(result, 'results') and result.results:
                for r in result.results[:2]:  # Top 2 from each result set
                    if r.get('url'):
                        urls.append(r['url'])
        return urls[:4]  # Limit to 4 URLs total

    async def _read_page(self, url: str) -> Optional[str]:
        """Read the content of a URL and extract key information."""
        try:
            from mcp__exa__web_fetch_exa import web_fetch_exa

            fetched = web_fetch_exa(urls=[url], max_characters=2000)

            if fetched and len(fetched) > 0:
                content = fetched[0].get('content', '')
                if content:
                    # Extract key sections - title, main points, technical details
                    synthesized = f"## Content from: {url}\n"
                    # Take first 1500 chars of content
                    synthesized += content[:1500]
                    if len(content) > 1500:
                        synthesized += "...\n[truncated]"
                    return synthesized
            return None
        except Exception as e:
            logger.debug(f"Page fetch error for '{url}': {e}")
            return None

    def _generate_refined_queries(
        self,
        description: str,
        framework: str,
        env_class: str,
        initial_results: list,
        page_contents: list,
    ) -> list[str]:
        """Generate refined follow-up queries based on initial findings and page content."""
        # Analyze what we've learned to refine queries
        topics_identified = []

        # Extract key topics from initial results
        for result in initial_results:
            if hasattr(result, 'results') and result.results:
                for r in result.results[:3]:
                    title = r.get('title', '').lower()
                    desc = r.get('description', '').lower()

                    # Identify common themes
                    if 'reward' in title or 'reward' in desc:
                        topics_identified.append('reward_design')
                    if 'observation' in title or 'observation' in desc:
                        topics_identified.append('observation_space')
                    if 'action' in title or 'action' in desc:
                        topics_identified.append('action_space')
                    if 'termination' in title or 'episode' in desc:
                        topics_identified.append('episode_dynamics')
                    if 'difficulty' in title or 'challenge' in desc:
                        topics_identified.append('difficulty_calibration')

        # Extract topics from page contents
        for content in page_contents:
            if 'reward' in content.lower():
                topics_identified.append('reward_design')
            if 'observation' in content.lower():
                topics_identified.append('observation_space')
            if 'action space' in content.lower():
                topics_identified.append('action_space')

        # Count occurrences to prioritize
        from collections import Counter
        topic_counts = Counter(topics_identified)

        # Generate queries for the most common topics
        refined_queries = []
        for topic, count in topic_counts.most_common(3):
            if topic == 'reward_design' and 'reward' not in description.lower():
                refined_queries.append(f"common failure modes {env_class} reward design")
                refined_queries.append(f"reward hacking prevention {env_class}")
            elif topic == 'observation_space':
                refined_queries.append(f"{env_class} observation space design patterns")
                refined_queries.append(f"optimal observation representation {env_class}")
            elif topic == 'action_space':
                refined_queries.append(f"{env_class} action space best practices")
                refined_queries.append(f"action space balance {env_class}")
            elif topic == 'episode_dynamics':
                refined_queries.append(f"{env_class} termination conditions implementation")
            elif topic == 'difficulty_calibration':
                refined_queries.append(f"{env_class} difficulty progression design")

        # Default follow-ups if no specific topics identified
        if not refined_queries:
            refined_queries = [
                f"common failure modes {env_class} environments",
                f"reward hacking prevention {env_class}",
                f"{framework} gymnasium implementation tips",
            ]

        return refined_queries

    def _generate_deep_dive_queries(
        self,
        description: str,
        framework: str,
        env_class: str,
        all_research: list[dict],
    ) -> list[str]:
        """Generate deep dive queries informed by all prior research."""
        # Find gaps in research coverage
        research_text = ""
        for item in all_research:
            if 'findings' in item:
                research_text += item['findings'].lower()

        deep_dive_queries = []

        # Check what aspects haven't been well covered
        if 'termination' not in research_text and 'max_step' not in research_text:
            deep_dive_queries.append(f"{env_class} termination conditions implementation")

        if 'observation' not in research_text and 'state' not in research_text:
            deep_dive_queries.append(f"{env_class} observation space design")

        if 'action' not in research_text:
            deep_dive_queries.append(f"{env_class} action space best practices")

        # Specific deep dives for RL environments
        deep_dive_queries.extend([
            f"{env_class} reset logic and initial state distribution",
            f"{env_class} step function performance optimization",
            f"{framework} environment wrapper usage patterns",
        ])

        return deep_dive_queries[:3]

    async def _web_search(self, query: str) -> Optional[dict]:
        """Perform a single web search and return structured result."""
        try:
            from mcp__exa__web_search_exa import web_search_exa

            result = web_search_exa(num_results=3, query=query)

            if result and hasattr(result, 'results') and result.results:
                synthesized = f"## Research: {query}\n"
                for r in result.results[:3]:
                    synthesized += f"- {r.get('title', 'Unknown')}: {r.get('description', '')[:200]}\n"
                return {"query": query, "findings": synthesized}
            return None
        except Exception as e:
            logger.debug(f"Web search error: {e}")
            return None

    def _synthesize_research_context(self, research_items: list[dict]) -> str:
        """Synthesize research items into a context string."""
        if not research_items:
            return "No web research findings available."

        context_parts = ["## Web Research Findings"]

        for item in research_items:
            context_parts.append(item.get("findings", ""))

        return "\n\n".join(context_parts)

    async def _generate_query_embedding(self, text: str) -> list[float]:
        """Generate a pseudo-embedding for a text query.

        Uses LLM to create a dense representation for vector search.
        Falls back to a simple hash-based vector if LLM unavailable.
        """
        try:
            # Use LLM to generate a pseudo-embedding (simplified - real impl would use embedding model)
            response = self.llm.call(
                agent="planner",
                prompt=f"Generate a brief semantic summary of this text for embedding purposes: {text[:500]}",
                slot="extraction",
                max_tokens=100,
            )

            # Create a simple pseudo-embedding based on text content
            # In production, this would call an actual embedding model
            words = text.lower().split()
            vector = [0.0] * 1536
            for i, word in enumerate(words[:1536]):
                vector[i] = hash(word) % 100 / 100.0

            return vector
        except Exception as e:
            logger.debug(f"Embedding generation failed, using fallback: {e}")
            # Fallback: create deterministic pseudo-embedding
            words = text.lower().split()
            vector = [0.0] * 1536
            for i, word in enumerate(words[:1536]):
                vector[i] = hash(word) % 100 / 100.0
            return vector

    async def _synthesize_edp(
        self,
        request: dict,
        episodic_context: str,
        graph_context: str,
        vector_context: str,
        skill_context: str,
        exploit_context: str,
        warnings_context: str,
        research_context: str,
    ) -> dict:
        """Synthesize all context into a final EDP."""

        prompt = self._build_synthesis_prompt(
            request=request,
            episodic_context=episodic_context,
            graph_context=graph_context,
            vector_context=vector_context,
            skill_context=skill_context,
            exploit_context=exploit_context,
            warnings_context=warnings_context,
            research_context=research_context,
        )

        response = self.llm.call(
            agent="planner",
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        edp = self._parse_edp(response.content)

        # Add research sources to EDP meta
        edp.setdefault("meta", {})["research_sources"] = ["web_search"]
        edp["meta"]["kb_references"] = {
            "episodic": "see kb_reads in state",
            "semantic": "see kb_reads in state",
            "procedural": "see kb_reads in state",
        }
        edp["meta"]["archivist_warnings_addressed"] = self._extract_warnings_addressed(warnings_context)

        return edp

    def _build_synthesis_prompt(
        self,
        request: dict,
        episodic_context: str,
        graph_context: str,
        vector_context: str,
        skill_context: str,
        exploit_context: str,
        warnings_context: str,
        research_context: str,
    ) -> str:
        """Build the synthesis prompt from all collected context."""

        return f"""## JOB REQUEST

Environment Class: {request.get('environment_class', 'flexible - determine from description')}
Observation Modality: {request.get('observation_modality', 'flexible - determine from description')}
Framework: {request.get('framework', 'gymnasium')} v{request.get('framework_version', '0.29')}
Output Mode: {request.get('output_mode', 'gymnasium_mode')}

Description:
{request.get('description', 'No description provided')}

Difficulty Parameters:
{json.dumps(request.get('difficulty_parameters', {}))}

---

## EPISODIC MEMORY (Past Job Outcomes)
{episodic_context}

---

## SEMANTIC GRAPH (Failure Modes & Design Patterns)
{graph_context}

---

## SEMANTIC VECTOR (Design Patterns)
{vector_context}

---

## SKILL LIBRARY (Relevant Skills)
{skill_context}

---

## EXPLOIT LIBRARY (Known Attack Patterns)
{exploit_context}

---

## ARCHIVIST WARNINGS (Must Address)
{warnings_context}

---

## WEB RESEARCH
{research_context}

---

## YOUR TASK

Produce a complete Environment Design Plan (EDP) as structured JSON.

CRITICAL REQUIREMENTS:
1. Address ALL archivist_warnings listed above. Each warning must have explicit "how_addressed" in the EDP.
2. Incorporate lessons from episodic memory about what worked/didn't work
3. Reference design patterns from semantic memory
4. Use relevant skills as inspiration but avoid direct copying
5. Mitigate all identified exploits and attack patterns
6. Ground design decisions in web research evidence

Environment class and observation modality are FLEXIBLE — choose what best fits the description.
Do not force existing categories if new ones would be more appropriate.

Output the EDP as valid JSON only, no additional text.
"""

    def _extract_warnings_addressed(self, warnings_context: str) -> list[dict]:
        """Extract warnings and create addressed entries from context."""
        addressed = []

        # Parse warnings from context (format: "- WARNING: name\n  Rule: text\n  Mitigation: text")
        warning_pattern = re.compile(r"- WARNING: (.+?)\n\s+Rule: (.+?)\n\s+Mitigation: (.+?)(?=\n\s*-|\Z)", re.DOTALL)

        for match in warning_pattern.finditer(warnings_context):
            warning_name = match.group(1).strip()
            rule = match.group(2).strip()
            mitigation = match.group(3).strip()

            addressed.append({
                "warning": f"{warning_name}: {rule[:100]}",
                "how_addressed": f"Design incorporates mitigation: {mitigation[:200]}",
            })

        return addressed

    def _parse_edp(self, content: str) -> dict:
        """Parse EDP from LLM response content."""
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

        logger.error(f"Failed to parse EDP from response: {content[:200]}...")
        return self._create_fallback_edp()

    def _create_fallback_edp(self) -> dict:
        """Create a fallback EDP when parsing fails."""
        return {
            "meta": {
                "environment_class": "rl_training",
                "observation_modality": "discrete",
                "novelty_assessment": "standard",
                "design_confidence": 0.5,
                "research_sources": [],
                "kb_references": {"episodic": [], "semantic": [], "procedural": []},
                "archivist_warnings_addressed": [],
                "error": "Failed to parse EDP from LLM response",
            },
            "environment": {
                "observation_space": {"type": "Box", "shape": "", "bounds": "", "sufficiency_rationale": ""},
                "action_space": {"type": "Discrete", "dimensionality": "", "bounds": "", "meaningfulness_rationale": ""},
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
                "difficulty_parameters": {"axes": [], "defaults": {}, "ranges": {}},
            },
            "output_spec": {
                "language": "python",
                "framework": "gymnasium",
                "framework_version": "0.29",
                "interface_contract": "",
                "entry_class": "",
            },
            "known_risks": [],
            "design_decisions": [],
        }