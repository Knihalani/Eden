"""Research Expert agent — provides deep research expertise for Eden pipeline."""

import hashlib
import logging
import struct
from typing import Optional

from eden.agents.base import PromptLoader
from eden.llm.client import OpenRouterClient, get_llm_client
from eden.config import get_settings
from eden.kb.episodic.client import get_episodic_client
from eden.kb.semantic.graph_client import get_graph_client
from eden.kb.semantic.vector_client import get_vector_client

logger = logging.getLogger(__name__)
settings = get_settings()


class ResearchExpertAgent(PromptLoader):
    """Research Expert for Eden.

    Provides deep expertise on:
    - Literature lookup and summarization (arXiv, papers)
    - Framework version change detection
    - New RL technique recommendations
    - State-of-the-art method analysis
    - Academic paper practical applications

    Assists planner and critic agents with research integration.
    """

    AGENT_NAME = "research_expert"

    SYSTEM_PROMPT = """You are the Research Expert for Eden.

    Your role is to provide deep expertise on research integration:
    - Literature lookup and summarization (arXiv, papers)
    - Framework version change detection
    - New RL technique recommendations
    - State-of-the-art method analysis
    - Academic paper practical applications

    Assist planner and critic agents with research integration.

    When called, you will receive:
    - The current job request
    - The current EDP (Environment Design Plan) if available
    - Any specific research questions from other agents

    Your goal is to provide actionable research insights that improve the environment design.
    """

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_planner
        self.max_turns = settings.max_turns_planner
        self._episodic = None
        self._graph = None
        self._vector = None
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
        """Run the Research Expert agent on the current state.

        Args:
            state: EdenJobState with job_id, request, edp, current_stage

        Returns:
            dict with current_stage for pipeline continuation
        """
        job_id = state["job_id"]
        request = state.get("request", {})
        current_edp = state.get("edp", {})

        logger.info(f"ResearchExpert running for job {job_id}")

        # Track KB reads for provenance
        kb_reads = []

        # Query KB sources for relevant context
        episodic_context = await self._query_episodic(request, kb_reads)
        graph_context = await self._query_graph(request, kb_reads)
        vector_context = await self._query_vector(request, kb_reads)

        # Determine what research is needed based on current stage
        research_focus = self._determine_research_focus(state)

        # Perform targeted research
        research_results = await self._perform_research(
            request=request,
            edp=current_edp,
            focus=research_focus,
            episodic_context=episodic_context,
            graph_context=graph_context,
            vector_context=vector_context,
        )

        # Generate research report
        research_report = await self._generate_research_report(
            request=request,
            edp=current_edp,
            results=research_results,
        )

        logger.info(f"ResearchExpert completed for job {job_id}")

        # Return with appropriate next stage
        return {
            "research_report": research_report,
            "research_findings": research_results,
            "current_stage": self._get_next_stage(state),
            "kb_reads": kb_reads,
        }

    async def _query_episodic(self, request: dict, kb_reads: list) -> str:
        """Query episodic memory for past research."""
        try:
            description = request.get("description", "")
            search_text = f"research {description}"

            if not search_text.strip():
                return ""

            recent_jobs = await self.episodic.search_by_description(search_text, limit=5)
            recent = await self.episodic.get_recent(days=30, limit=10)

            all_jobs = {j["job_id"]: j for j in recent_jobs + recent}
            similar_jobs = list(all_jobs.values())[:5]

            context_parts = []
            for job in similar_jobs:
                outcome = job.get("outcome_tier", "unknown")
                research_notes = job.get("research_notes", "")
                if research_notes:
                    context_parts.append(
                        f"- Job {job['job_id'][:8]}: outcome={outcome}\n"
                        f"  Research: {research_notes[:200]}"
                    )
                    kb_reads.append({
                        "type": "episodic",
                        "job_id": job["job_id"],
                        "summary": f"research outcome={outcome}",
                    })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Episodic query failed: {e}")
            return ""

    async def _query_graph(self, request: dict, kb_reads: list) -> str:
        """Query semantic graph for intelligence reports."""
        try:
            env_class = request.get("environment_class", "")

            # Query for intelligence reports and related entities
            entities = await self.graph.query_by_type(
                entity_type="IntelligenceReport",
                limit=10,
            )

            context_parts = []
            for entity in entities[:5]:
                props = entity.get("properties", {})
                context_parts.append(
                    f"- {entity['name']}: {props.get('description', 'No description')[:200]}"
                )
                kb_reads.append({
                    "type": "graph_intelligence",
                    "entity_id": entity["id"],
                    "summary": entity["name"],
                })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Graph query failed: {e}")
            return ""

    async def _query_vector(self, request: dict, kb_reads: list) -> str:
        """Query semantic vector for design patterns."""
        try:
            description = request.get("description", "")
            env_class = request.get("environment_class", "")

            if not description:
                return ""

            # Generate query embedding
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
                    f"{result.payload.get('description', 'No description')[:150]}"
                )
                kb_reads.append({
                    "type": "vector_design",
                    "entity_id": result.id,
                    "score": result.score,
                    "summary": result.payload.get("name", ""),
                })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Vector query failed: {e}")
            return ""

    def _determine_research_focus(self, state: dict) -> str:
        """Determine what research focus is needed based on pipeline stage."""
        current_stage = state.get("current_stage", "")

        # Research is typically called after planning or critic feedback
        if current_stage == "planning":
            return "env_design"
        elif current_stage == "criticizing":
            # Critic may have flagged areas needing more research
            return "critique_areas"
        elif current_stage == "refining":
            return "implementation_details"
        else:
            return "general"

    async def _perform_research(
        self,
        request: dict,
        edp: dict,
        focus: str,
        episodic_context: str = "",
        graph_context: str = "",
        vector_context: str = "",
    ) -> dict:
        """Perform targeted research based on focus area.

        Args:
            request: The original job request
            edp: Current environment design plan
            focus: Research focus area
            episodic_context: Past research from episodic memory
            graph_context: Intelligence reports from graph
            vector_context: Design patterns from vector

        Returns:
            dict with research findings
        """
        findings = {
            "literature": [],
            "techniques": [],
            "framework_updates": [],
            "sota_methods": [],
            "kb_context": {
                "episodic": episodic_context,
                "graph": graph_context,
                "vector": vector_context,
            },
        }

        try:
            # Research literature for environment class
            env_class = request.get("environment_class", edp.get("meta", {}).get("environment_class", ""))
            if env_class:
                lit_results = await self._research_literature(env_class)
                findings["literature"] = lit_results

            # Research RL techniques relevant to the design
            if edp:
                tech_results = await self._research_techniques(edp)
                findings["techniques"] = tech_results

            # Check for framework version updates
            framework = request.get("framework", "gymnasium")
            framework_version = request.get("framework_version", "0.29")
            version_results = await self._check_framework_updates(framework, framework_version)
            findings["framework_updates"] = version_results

            # Research state-of-the-art methods
            sota_results = await self._research_sota(env_class)
            findings["sota_methods"] = sota_results

        except Exception as e:
            logger.warning(f"Research failed: {e}")

        return findings

    async def _research_literature(self, env_class: str) -> list[dict]:
        """Research academic literature for the environment class.

        Args:
            env_class: The environment class to research

        Returns:
            list of relevant papers/publications
        """
        results = []

        try:
            from mcp__exa__web_search_exa import web_search_exa

            query = f"{env_class} reinforcement learning environment design academic paper"
            search_result = web_search_exa(num_results=5, query=query)

            if search_result and hasattr(search_result, 'results') and search_result.results:
                for r in search_result.results[:5]:
                    results.append({
                        "title": r.get("title", ""),
                        "description": r.get("description", ""),
                        "url": r.get("url", ""),
                        "source": "web_search",
                    })

        except Exception as e:
            logger.debug(f"Literature search failed: {e}")

        return results

    async def _research_techniques(self, edp: dict) -> list[dict]:
        """Research RL techniques relevant to the EDP.

        Args:
            edp: Current environment design plan

        Returns:
            list of relevant techniques
        """
        techniques = []

        try:
            # Extract key design elements from EDP
            reward_type = edp.get("environment", {}).get("reward_structure", {}).get("type", "dense")
            obs_modality = edp.get("meta", {}).get("observation_modality", "discrete")

            from mcp__exa__web_search_exa import web_search_exa

            query = f"{reward_type} reward reinforcement learning techniques {obs_modality} observation"
            search_result = web_search_exa(num_results=5, query=query)

            if search_result and hasattr(search_result, 'results') and search_result.results:
                for r in search_result.results[:5]:
                    techniques.append({
                        "name": r.get("title", ""),
                        "description": r.get("description", ""),
                        "url": r.get("url", ""),
                    })

        except Exception as e:
            logger.debug(f"Technique research failed: {e}")

        return techniques

    async def _check_framework_updates(self, framework: str, current_version: str) -> list[dict]:
        """Check for framework version updates and breaking changes.

        Args:
            framework: Framework name (e.g., "gymnasium")
            current_version: Current version string

        Returns:
            list of version updates and breaking changes
        """
        updates = []

        try:
            from mcp__exa__web_search_exa import web_search_exa

            query = f"{framework} latest version release notes breaking changes"
            search_result = web_search_exa(num_results=3, query=query)

            if search_result and hasattr(search_result, 'results') and search_result.results:
                for r in search_result.results[:3]:
                    updates.append({
                        "version": r.get("title", ""),
                        "changes": r.get("description", ""),
                        "url": r.get("url", ""),
                    })

        except Exception as e:
            logger.debug(f"Framework version check failed: {e}")

        return updates

    async def _research_sota(self, env_class: str) -> list[dict]:
        """Research state-of-the-art methods for the environment class.

        Args:
            env_class: The environment class

        Returns:
            list of SOTA methods
        """
        sota = []

        try:
            from mcp__exa__web_search_exa import web_search_exa

            query = f"{env_class} state-of-the-art reinforcement learning 2024 2025"
            search_result = web_search_exa(num_results=5, query=query)

            if search_result and hasattr(search_result, 'results') and search_result.results:
                for r in search_result.results[:5]:
                    sota.append({
                        "method": r.get("title", ""),
                        "description": r.get("description", ""),
                        "paper_url": r.get("url", ""),
                    })

        except Exception as e:
            logger.debug(f"SOTA research failed: {e}")

        return sota

    async def _generate_research_report(
        self,
        request: dict,
        edp: dict,
        results: dict,
    ) -> dict:
        """Generate a structured research report.

        Args:
            request: The original job request
            edp: Current environment design plan
            results: Research findings

        Returns:
            Structured research report
        """
        report = {
            "job_id": request.get("job_id", ""),
            "timestamp": None,  # Could add timestamp here
            "literature_summary": self._summarize_literature(results.get("literature", [])),
            "technique_recommendations": self._summarize_techniques(results.get("techniques", [])),
            "framework_updates": results.get("framework_updates", []),
            "sota_summary": self._summarize_sota(results.get("sota_methods", [])),
            "recommendations": self._generate_recommendations(edp, results),
        }

        return report

    def _summarize_literature(self, literature: list[dict]) -> str:
        """Summarize literature findings."""
        if not literature:
            return "No relevant literature found."

        summary_parts = ["## Relevant Literature\n"]
        for item in literature[:5]:
            summary_parts.append(f"- **{item.get('title', 'Unknown')}**: {item.get('description', 'No description')[:200]}")

        return "\n".join(summary_parts)

    def _summarize_techniques(self, techniques: list[dict]) -> str:
        """Summarize RL technique findings."""
        if not techniques:
            return "No specific techniques found."

        summary_parts = ["## RL Techniques\n"]
        for item in techniques[:5]:
            summary_parts.append(f"- **{item.get('name', 'Unknown')}**: {item.get('description', 'No description')[:200]}")

        return "\n".join(summary_parts)

    def _summarize_sota(self, sota_methods: list[dict]) -> str:
        """Summarize state-of-the-art methods."""
        if not sota_methods:
            return "No SOTA methods found."

        summary_parts = ["## State-of-the-Art Methods\n"]
        for item in sota_methods[:5]:
            summary_parts.append(f"- **{item.get('method', 'Unknown')}**: {item.get('description', 'No description')[:200]}")

        return "\n".join(summary_parts)

    def _generate_recommendations(self, edp: dict, results: dict) -> list[str]:
        """Generate recommendations based on research."""
        recommendations = []

        # Check literature for design patterns
        if results.get("literature"):
            recommendations.append(
                "Consider implementing design patterns from recent literature"
            )

        # Check for new techniques
        if results.get("techniques"):
            recommendations.append(
                "Explore recommended RL techniques for improved performance"
            )

        # Check framework updates
        framework_updates = results.get("framework_updates", [])
        if framework_updates:
            for update in framework_updates:
                version = update.get("version", "")
                if version and version != edp.get("output_spec", {}).get("framework_version"):
                    recommendations.append(f"Consider upgrading to {version}")

        # SOTA recommendations
        if results.get("sota_methods"):
            recommendations.append(
                "State-of-the-art methods available - review for potential integration"
            )

        return recommendations

    def _get_next_stage(self, state: dict) -> str:
        """Determine the next stage based on current state.

        Research expert typically feeds back to planner or critic.
        """
        current_stage = state.get("current_stage", "")

        # After research, typically go back to planning or critic
        if current_stage == "planning":
            return "criticizing"
        elif current_stage == "criticizing":
            return "refining"
        elif current_stage == "refining":
            return "fact_checking"
        else:
            return "criticizing"