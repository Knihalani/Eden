"""Archivist agent — learns from every job outcome.

Runs post every job (success or failure) and converts the full trace into
durable, structured, retrievable knowledge in the Knowledge Base.
"""

import json
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, Literal
from uuid import uuid4

from eden.llm.client import OpenRouterClient
from eden.config import get_settings
from eden.kb.semantic.graph_client import get_graph_client
from eden.kb.episodic.client import get_episodic_client
from eden.kb.procedural.client import get_procedural_client
from eden.kb.exploit.client import get_exploit_client
from eden.kb.semantic.vector_client import get_vector_client
from eden.kb.shared.audit import evaluate_audn, AUDNAction
from eden.kb.research.client import get_research_client
from eden.kb.retrieval_logger import get_retrieval_logger
from eden.kb.strategy_store import get_strategy_store
from eden.storage.postgres import get_postgres_client
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


@dataclass
class ContrastivePair:
    """A pair of jobs used for contrastive analysis."""
    anchor: dict
    positive: list[dict] = field(default_factory=list)
    negative: list[dict] = field(default_factory=list)

    def has_both_outcomes(self) -> bool:
        return len(self.positive) > 0 and len(self.negative) > 0


class CausationTracker:
    """Tracks causal chains from design decisions to failure modes.

    Reconstructs the decision chain from EDP to failure for root cause analysis.
    Uses the semantic knowledge graph for causal link storage and retrieval.
    """

    def __init__(self, graph_client, episodic_client):
        self.graph = graph_client
        self.episodic = episodic_client

    async def trace_causes(
        self,
        job_id: str,
        failure: dict,
        edp_history: list,
        test_results: dict,
    ) -> list[dict]:
        """Trace the causal chain from design decision to failure.

        Args:
            job_id: The job ID for lookup
            failure: The failure description containing failure_mode, category, blockers
            edp_history: List of EDP iterations
            test_results: Tester results

        Returns:
            List of causal chain links: {from_node, to_node, edge_type, rationale, evidence}
        """
        chain = []

        if not edp_history:
            return chain

        final_edp = edp_history[-1]
        design_decisions = final_edp.get("design_decisions", [])

        failure_category = test_results.get("category", "unknown")
        blockers = test_results.get("blockers", [])

        for i, decision in enumerate(design_decisions):
            decision_text = decision.get("decision", "")
            decision_rationale = decision.get("rationale", "")
            if not decision_text:
                continue

            decision_node = await self._get_or_create_decision_node(
                job_id=job_id,
                decision_text=decision_text,
                iteration=i + 1,
            )

            intermediate_state = self._infer_intermediate_state(decision)

            if intermediate_state:
                chain.append({
                    "from_node": decision_node,
                    "to_node": intermediate_state,
                    "edge_type": "LEADS_TO",
                    "rationale": f"Decision '{decision_text[:50]}...' leads to {intermediate_state['type']}",
                    "evidence": {
                        "decision_rationale": decision_rationale,
                        "edp_iteration": i + 1,
                    },
                })

            if blockers or failure_category == "fundamental":
                failure_node = {
                    "type": self._map_failure_category(failure_category),
                    "blockers": blockers,
                    "job_id": job_id,
                }

                chain.append({
                    "from_node": intermediate_state,
                    "to_node": failure_node,
                    "edge_type": "CAUSES",
                    "rationale": self._build_failure_rationale(failure_category, blockers),
                    "confidence": self._calculate_confidence(len(blockers), failure_category),
                    "evidence": {
                        "failure_category": failure_category,
                        "blocker_count": len(blockers),
                    },
                })

        await self._store_causal_chain(job_id, chain)

        return chain

    async def _get_or_create_decision_node(
        self,
        job_id: str,
        decision_text: str,
        iteration: int,
    ) -> dict:
        """Get or create a design decision entity in the graph."""
        node_name = f"decision_{job_id}_{iteration}"

        try:
            existing = await self.graph.get_entity_by_name(node_name, "DesignDecision")
            if existing:
                return existing
        except Exception:
            pass

        entity = {
            "entity_type": "DesignDecision",
            "name": node_name,
            "properties": {
                "decision_text": decision_text,
                "job_id": job_id,
                "edp_iteration": iteration,
            },
            "recorded_at": datetime.utcnow(),
            "valid_at": datetime.utcnow(),
        }

        try:
            entity_id = await self.graph.insert_entity(entity)
            entity["id"] = entity_id
        except Exception as e:
            logger.warning(f"Failed to create decision node: {e}")
            entity["id"] = str(uuid4())

        return entity

    def _infer_intermediate_state(self, decision: dict) -> Optional[dict]:
        """Infer intermediate state from design decision context."""
        decision_text = decision.get("decision", "").lower()

        if "reward" in decision_text and "shape" in decision_text:
            return {"type": "RewardShapingState", "description": "Reward shaping applied"}
        elif "difficulty" in decision_text or "parameters" in decision_text:
            return {"type": "DifficultyState", "description": "Difficulty parameters set"}
        elif "observation" in decision_text:
            return {"type": "ObservationState", "description": "Observation space defined"}
        elif "action" in decision_text:
            return {"type": "ActionSpaceState", "description": "Action space defined"}
        elif "risk" in decision_text or "mitigation" in decision_text:
            return {"type": "RiskMitigationState", "description": "Risk mitigation applied"}

        return {"type": "GeneralDesignState", "description": "General design decision"}

    def _map_failure_category(self, category: str) -> str:
        """Map tester failure category to failure mode."""
        mapping = {
            "fundamental": "FundamentalFailure",
            "exploit": "ExploitVulnerability",
            "instability": "TrainingInstability",
            "reward_hacking": "RewardHacking",
            "exploration": "ExplorationFailure",
        }
        return mapping.get(category, "UnknownFailure")

    def _build_failure_rationale(self, category: str, blockers: list) -> str:
        """Build human-readable rationale for failure."""
        if blockers:
            return f"CAUSES {category} failure: blockers include {'; '.join(blockers[:2])}"
        return f"CAUSES {category} failure without specific blockers"

    def _calculate_confidence(self, blocker_count: int, category: str) -> str:
        """Calculate confidence score as N/M format."""
        base_confidence = {
            "fundamental": (8, 10),
            "exploit": (7, 10),
            "instability": (6, 10),
            "reward_hacking": (5, 10),
            "exploration": (5, 10),
        }

        n, m = base_confidence.get(category, (5, 10))

        if blocker_count > 3:
            n = min(n + 1, m)

        return f"{n}/{m}"

    async def _store_causal_chain(self, job_id: str, chain: list[dict]) -> None:
        """Store completed causal chain in graph for future retrieval."""
        if not chain:
            return

        chain_entity = {
            "entity_type": "CausalChain",
            "name": f"causal_chain_{job_id}",
            "properties": {
                "job_id": job_id,
                "chain_length": len(chain),
                "链条": [self._serialize_link(link) for link in chain],
            },
            "recorded_at": datetime.utcnow(),
            "valid_at": datetime.utcnow(),
        }

        try:
            chain_id = await self.graph.insert_entity(chain_entity)

            for link in chain:
                from_node = link.get("from_node", {})
                to_node = link.get("to_node", {})

                from_id = from_node.get("id")
                to_id = to_node.get("id")

                if from_id and to_id:
                    await self.graph.insert_link({
                        "source_id": from_id,
                        "target_id": to_id,
                        "edge_type": link.get("edge_type", "CAUSES"),
                        "properties": {
                            "rationale": link.get("rationale", ""),
                            "confidence": link.get("confidence", "5/10"),
                        },
                    })
        except Exception as e:
            logger.warning(f"Failed to store causal chain for job {job_id}: {e}")

    def _serialize_link(self, link: dict) -> dict:
        """Serialize a causal chain link for storage."""
        from_node = link.get("from_node", {})
        to_node = link.get("to_node", {})

        return {
            "edge_type": link.get("edge_type", "CAUSES"),
            "from_type": from_node.get("type", "unknown"),
            "from_id": from_node.get("id", ""),
            "to_type": to_node.get("type", "unknown"),
            "to_id": to_node.get("id", ""),
            "rationale": link.get("rationale", ""),
            "evidence": link.get("evidence", {}),
        }


class ArchivistAgent(PromptLoader):
    """Archivist agent — dedicated learning from job outcomes.

    The Archivist is the only agent whose primary job is learning.

    Process:
    1. Full trace ingestion (EDP, code, quality reports, test results)
    2. Outcome classification (Gold/Silver/Bronze/Partial/Failed)
    3. Success extraction (contrastive pattern analysis, best practices, skills)
    4. Failure extraction (root cause, causal chain, prevention rules)
    5. Exploit Library maintenance
    6. Contradiction resolution
    7. Forward annotations for future agents
    8. KB health maintenance

    Write ownership:
    - Agents write provisional → episodic
    - Archivist writes canonical → semantic + procedural (via AUDN)
    """

    AGENT_NAME = "archivist"

    SYSTEM_PROMPT = """You are the Archivist for Eden, an AI-native environment generation system.

Your role is to learn from EVERY completed job — success or failure — and convert
the full trace into durable, structured knowledge that improves future jobs.

This is the most important agent in the system. Memory compounds. Learning from both
success AND failure is essential (ExpeL methodology, AAAI 2024).

Process:

1. FULL TRACE INGESTION: Read the complete job trace:
   - Request and EDP history
   - Critic decisions with rationale
   - All routing events
   - Code Quality Pipeline results per pass
   - Verifier report
   - Tester results including individual probe outcomes
   - Performance measurements

2. OUTCOME CLASSIFICATION:
   - Gold: passed all Tester categories on first Executor attempt;
           ≤2 Code Quality iterations; no Critic routing loops
   - Silver: passed all Tester categories; normal iteration profile
   - Bronze: passed but required above-average iterations or one replan cycle
   - Partial: passed but with flagged quality concerns or borderline probe results
   - Failed: fundamental failure requiring Planner restart; or exhausted iteration limits

3. SUCCESS EXTRACTION (Gold, Silver):
   - Contrastive pattern analysis: compare Gold/Silver traces against Bronze/Partial/Failed
     for the same environment class. What decisions made the difference?
   - Best practice extraction: generalizable patterns → semantic memory as BestPractice
   - Skill extraction (Voyager-style): reusable code patterns → Skill Library
   - Quality fingerprint: EDP + quality metrics → semantic memory as positive exemplar

4. FAILURE EXTRACTION (Bronze, Partial, Failed):
   - Root cause identification: where in the pipeline was the flaw introduced?
   - Causal chain reconstruction: design_decision → intermediate_state → failure_mode
   - Prevention rules: "When [env class] with [X] and EDP includes [Y],
     produces [failure Z] with [confidence N/M]. Alternative: [A]"
   - Retrieval gap analysis: if relevant KB info existed but wasn't retrieved,
     flag for Retrieval Tuner

5. EXPLOIT LIBRARY MAINTENANCE: Any novel exploit from Tester → new parameterizable probe

6. CONTRADICTION RESOLUTION: Check for conflicts with existing KB entries.
   Create CONTRADICTS edge. Resolve: supersede, coexist, or flag for investigation.

7. FORWARD ANNOTATIONS:
   - Planner warning [env_class]: watch for [specific pitfall]
   - Critic priority [reward_type]: prioritize checking [exploit category]
   - Executor note [framework, env_class]: validated patterns; avoid [anti-pattern]
   - Tester priority [env_class]: highest discovery rate probes

8. KB HEALTH: Mark stale entries, upgrade/downgrade confidence, archive old traces.

Output the archivist summary as JSON with:
- outcome_tier
- extraction_results: {best_practices, skills, prevention_rules, exploit_probes}
- kb_writes: {provisional, canonical}
- forward_annotations
- kb_health_actions"""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or OpenRouterClient()
        self.max_tokens = settings.max_tokens_archivist
        self.max_turns = settings.max_turns_archivist
        self.graph = get_graph_client()
        self.episodic = get_episodic_client()
        self.procedural = get_procedural_client()
        self.exploit = get_exploit_client()
        self.vector = get_vector_client()
        self.research = get_research_client()
        self._causation_tracker = CausationTracker(self.graph, self.episodic)
        self._load_prompt()

    async def run(self, state: dict) -> dict:
        """Run the Archivist learning pipeline on a completed job.

        Args:
            state: EdenJobState with full pipeline trace

        Returns:
            dict with outcome_tier and archivist_summary
        """
        job_id = state["job_id"]
        logger.info(f"Archivist running for job {job_id}")

        # Step 1: Build trace
        trace = self._build_trace(state)

        # Step 2: Classify outcome
        outcome_tier = self._classify_outcome(state)
        logger.info(f"Job {job_id} classified as {outcome_tier}")

        # Step 3: Extract patterns via LLM
        extraction = await self._extract_patterns(trace, outcome_tier)

        # Step 4: Trace failures for failed jobs
        causal_chain = []
        if outcome_tier in ("bronze", "partial", "failed"):
            causal_chain = await self._trace_failures(state, trace)

        # Step 5: Update exploit library
        await self._update_exploit_library(extraction, state)

        # Step 6: Resolve contradictions
        contradictions = await self._resolve_contradictions(extraction)

        # Step 7: Generate forward annotations
        forward_annotations = self._generate_forward_annotations(trace, outcome_tier)

        # Step 8: KB health maintenance
        kb_health = await self._perform_kb_health(extraction, state)

        # Build summary
        summary = {
            "outcome_tier": outcome_tier,
            "extraction_results": extraction,
            "forward_annotations": forward_annotations,
            "kb_health_actions": kb_health,
            "contradictions_resolved": contradictions,
            "causal_chain": causal_chain,
        }

        # Update job record in episodic memory
        await self.episodic.update(job_id, {
            "outcome_tier": outcome_tier,
            "archivist_summary": json.dumps(summary),
        })

        logger.info(f"Archivist completed for job {job_id}: {outcome_tier}")

        # Step 9: Score retrieval relevance for RetrievalTuner
        await self._score_retrieval_relevance(state)

        return {
            "outcome_tier": outcome_tier,
            "archivist_summary": summary,
        }

    async def _score_retrieval_relevance(self, state: dict) -> None:
        """Score which retrieved items appeared in agent reasoning.

        This feeds the RetrievalTuner's relevance analysis.
        """
        job_id = state["job_id"]
        kb_reads = state.get("kb_reads", [])
        agent_proposals = state.get("agent_proposals", [])
        code_history = state.get("code_history", [])

        if not kb_reads:
            return

        # Build content indices
        proposal_text = " ".join([
            f"{p.get('name', '')} {p.get('justification', '')}"
            for p in agent_proposals
        ])
        code_text = " ".join(code_history) if code_history else ""

        retrieval_logger = get_retrieval_logger()
        retrieval_logs = await retrieval_logger.get_retrieval_for_job(job_id)

        # Create lookup by collection+query
        logs_by_key = {}
        for log in retrieval_logs:
            key = (log.get("collection"), log.get("query_text") or "")
            logs_by_key[key] = log

        for kb_read in kb_reads:
            collection = kb_read.get("collection")
            query = kb_read.get("query", "")
            retrieved_items = kb_read.get("retrieved_items", [])

            key = (collection, query)
            if key not in logs_by_key:
                continue

            log_entry = logs_by_key[key]

            for item in retrieved_items:
                item_id = item.get("id") or item.get("item_id")
                item_name = item.get("name", "")

                # Check if item appeared in reasoning
                appears_in_proposals = (
                    item_name.lower() in proposal_text.lower() if item_name else False
                )
                appears_in_code = (
                    item_name.lower() in code_text.lower() if item_name else False
                )

                is_relevant = appears_in_proposals or appears_in_code
                signal = (
                    "used_in_proposal" if appears_in_proposals
                    else "used_in_code" if appears_in_code
                    else None
                )

                if signal:
                    await self._record_relevance_score(
                        log_entry["id"], item_id, is_relevant, signal
                    )

                    # Also update strategy counters
                    strategy_store = get_strategy_store()
                    await strategy_store.record_relevance(collection, is_relevant)

    async def _record_relevance_score(
        self,
        retrieval_log_id: str,
        item_id: str,
        is_relevant: bool,
        signal: str,
    ) -> None:
        """Record a relevance score for a retrieved item."""
        client = await get_postgres_client()

        try:
            await client.execute(
                """
                INSERT INTO retrieval_relevance_scores (
                    id, retrieval_log_id, item_id, is_relevant, relevance_signal, scored_by
                ) VALUES (gen_random_uuid(), $1, $2, $3, $4, 'archivist')
                ON CONFLICT (retrieval_log_id, item_id) DO UPDATE
                SET is_relevant = EXCLUDED.is_relevant,
                    relevance_signal = EXCLUDED.relevance_signal,
                    scored_at = NOW()
                """,
                retrieval_log_id,
                item_id,
                is_relevant,
                signal,
            )
        except Exception as e:
            logger.warning(f"Failed to record relevance score: {e}")

    def _classify_outcome(self, state: dict) -> str:
        """Classify job outcome into tier."""
        tester = state.get("tester_results", {}) or {}
        passed = tester.get("passed", False)
        categories = tester.get("categories", {})

        # Get iteration counts
        code_quality_its = state.get("code_quality_iterations", 0)
        critic_replans = state.get("critic_replan_count", 0)
        executor_its = state.get("executor_iterations", 0)

        # Check if all tests passed
        all_passed = True
        if categories:
            all_passed = all(c.get("passed", False) for c in categories.values())

        # First attempt = no code quality iterations or just 1
        first_attempt = code_quality_its <= 1 and executor_its <= 1

        if not passed or not all_passed:
            return "failed"

        # Gold: ≤2 CQ iterations, no critic routing, first attempt
        if code_quality_its <= 2 and critic_replans == 0 and all_passed and first_attempt:
            return "gold"

        # Silver: passed all tests, normal iteration profile
        if all_passed and critic_replans == 0:
            return "silver"

        # Bronze: passed but above-average iterations or one replan
        if all_passed and (code_quality_its > 4 or critic_replans >= 1):
            return "bronze"

        # Partial: passed but quality concerns or borderline probes
        if self._has_quality_concerns(state) or self._has_borderline_probes(tester):
            return "partial"

        return "silver"

    def _has_quality_concerns(self, state: dict) -> bool:
        """Check if there are quality concerns."""
        quality_reports = state.get("quality_reports", [])
        if not quality_reports:
            return False
        last_report = quality_reports[-1] if quality_reports else {}
        # Concern if code quality took more than 3 iterations
        return state.get("code_quality_iterations", 0) > 3

    def _has_borderline_probes(self, tester: dict) -> bool:
        """Check for borderline probe results."""
        categories = tester.get("categories", {})
        for cat_result in categories.values():
            if not cat_result.get("passed", True):
                # Borderline = close to passing threshold
                if cat_result.get("margin", 0) < 0.1:
                    return True
        return False

    def _build_trace(self, state: dict) -> dict:
        """Serialize state for LLM prompt."""
        return {
            "job_id": state["job_id"],
            "request": state.get("request", {}),
            "edp_history": state.get("edp_history", []),
            "critic_decisions": state.get("critic_decisions", []),
            "routing_history": state.get("routing_history", []),
            "res": state.get("res"),
            "code_history": state.get("code_history", []),
            "quality_reports": state.get("quality_reports", []),
            "verifier_report": state.get("verifier_report"),
            "tester_results": state.get("tester_results"),
            "kb_reads": state.get("kb_reads", []),
            "agent_proposals": state.get("agent_proposals", []),
            "executor_iterations": state.get("executor_iterations", 0),
            "code_quality_iterations": state.get("code_quality_iterations", 0),
            "critic_replan_count": state.get("critic_replan_count", 0),
            "critic_reresearch_count": state.get("critic_reresearch_count", 0),
            "current_stage": state.get("current_stage"),
        }

    async def _build_contrastive_pairs(
        self,
        current_job: dict,
        outcome_tier: str,
    ) -> Optional[ContrastivePair]:
        """Build contrastive pairs for the current job.

        Retrieves same-env-class jobs with opposite outcomes and packages
        them for the extraction prompt.

        Args:
            current_job: The current job trace
            outcome_tier: The classified outcome tier

        Returns:
            ContrastivePair with anchor, positive (success), and negative (failure) trajectories
        """
        request = current_job.get("request", {})
        env_class = request.get("framework") or current_job.get("environment_class", "unknown")

        if outcome_tier in ("gold", "silver"):
            failed_outcomes = ["bronze", "partial", "failed"]
            successful_outcomes = [outcome_tier]
        elif outcome_tier in ("bronze", "partial", "failed"):
            failed_outcomes = [outcome_tier]
            successful_outcomes = ["gold", "silver"]
        else:
            return None

        positive_jobs = await self.episodic.get_contrastive_jobs(
            environment_class=env_class,
            current_job_id=current_job["job_id"],
            target_outcomes=successful_outcomes,
            limit=5,
        )

        negative_jobs = await self.episodic.get_contrastive_jobs(
            environment_class=env_class,
            current_job_id=current_job["job_id"],
            target_outcomes=failed_outcomes,
            limit=5,
        )

        if not positive_jobs and not negative_jobs:
            logger.debug(f"No contrastive jobs found for env_class={env_class}")
            return None

        return ContrastivePair(
            anchor=current_job,
            positive=[dict(j) for j in positive_jobs],
            negative=[dict(j) for j in negative_jobs],
        )

    def _format_job_summary(self, job: dict) -> str:
        """Format a job record into a brief summary for contrastive context."""
        job_id = job.get("job_id", "unknown")[:8]
        outcome = job.get("outcome_tier", "unknown")
        edp_history = job.get("edp_history") or []

        summary_parts = [f"Job {job_id} (outcome={outcome})"]

        if edp_history:
            latest_edp = edp_history[-1]
            design_decisions = [
                d.get("decision", "")
                for d in latest_edp.get("design_decisions", [])
                if d.get("decision")
            ][:5]
            known_risks = [
                r.get("risk", "")
                for r in latest_edp.get("known_risks", [])
                if r.get("risk")
            ]

            if design_decisions:
                summary_parts.append(f"  Key decisions: {'; '.join(design_decisions[:3])}")
            if known_risks:
                summary_parts.append(f"  Known risks: {'; '.join(known_risks[:2])}")
            summary_parts.append(f"  EDP iterations: {len(edp_history)}")

        tester = job.get("tester_results") or {}
        if tester:
            summary_parts.append(f"  Test category: {tester.get('category', 'unknown')}")
            blockers = tester.get("blockers", [])
            if blockers:
                summary_parts.append(f"  Blockers: {'; '.join(blockers[:2])}")

        return "\n".join(summary_parts)

    # Ensure all expected keys exist
        extraction.setdefault("best_practices", [])
        extraction.setdefault("skills", [])
        extraction.setdefault("prevention_rules", [])
        extraction.setdefault("exploit_probes", [])
        extraction.setdefault("contrastive_insights", {})

        # Add provenance metadata if contrastive analysis was performed
        if contrastive_pair and contrastive_pair.has_both_outcomes():
            extraction["_contrastive_provenance"] = {
                "analysis_type": "ExPeL_contrastive",
                "positive_samples": len(contrastive_pair.positive),
                "negative_samples": len(contrastive_pair.negative),
                "env_class": trace.get("request", {}).get("framework", "unknown"),
            }

        return extraction

    def _build_extraction_prompt(
        self,
        trace: dict,
        outcome_tier: str,
        extraction_type: str,
        contrastive_pair: Optional[ContrastivePair] = None,
    ) -> str:
        """Build LLM prompt for pattern extraction."""
        prompt_parts = []

        prompt_parts.append(f"## JOB OUTCOME: {outcome_tier.upper()}")
        prompt_parts.append(f"## EXTRACTION TASK: {extraction_type.upper()} EXTRACTION")

        # Add contrastive context if available
        if contrastive_pair:
            prompt_parts.append("\n## CONTRASTIVE JOB SAMPLES (Same Environment Class)")
            prompt_parts.append("")
            prompt_parts.append(
                "Use these comparable job trajectories to inform your extraction. "
                "Compare successful (Gold/Silver) against failed (Bronze/Partial/Failed) trajectories."
            )
            prompt_parts.append("")

            if contrastive_pair.positive:
                prompt_parts.append("### SUCCESSFUL TRAJECTORIES (Gold/Silver):")
                for job in contrastive_pair.positive[:3]:
                    prompt_parts.append(self._format_job_summary(job))
                prompt_parts.append("")

            if contrastive_pair.negative:
                prompt_parts.append("### FAILED TRAJECTORIES (Bronze/Partial/Failed):")
                for job in contrastive_pair.negative[:3]:
                    prompt_parts.append(self._format_job_summary(job))
                prompt_parts.append("")

        prompt_parts.append(f"## REQUEST:")
        prompt_parts.append(json.dumps(trace.get("request", {}), indent=2))

        prompt_parts.append(f"## EDP HISTORY:")
        prompt_parts.append(json.dumps(trace.get("edp_history", []), indent=2))

        prompt_parts.append(f"## CRITIC DECISIONS:")
        prompt_parts.append(json.dumps(trace.get("critic_decisions", []), indent=2))

        prompt_parts.append(f"## CODE HISTORY (final code):")
        prompt_parts.append(trace.get("code_history", [""])[-1] if trace.get("code_history") else "N/A")

        prompt_parts.append(f"## CODE QUALITY REPORTS:")
        prompt_parts.append(json.dumps(trace.get("quality_reports", []), indent=2))

        prompt_parts.append(f"## VERIFIER REPORT:")
        prompt_parts.append(json.dumps(trace.get("verifier_report", {}), indent=2))

        prompt_parts.append(f"## TESTER RESULTS:")
        prompt_parts.append(json.dumps(trace.get("tester_results", {}), indent=2))

        prompt_parts.append(f"## ITERATION METRICS:")
        prompt_parts.append(f"- Executor iterations: {trace.get('executor_iterations', 0)}")
        prompt_parts.append(f"- Code Quality iterations: {trace.get('code_quality_iterations', 0)}")
        prompt_parts.append(f"- Critic replans: {trace.get('critic_replan_count', 0)}")
        prompt_parts.append(f"- Critic reresearches: {trace.get('critic_reresearch_count', 0)}")

        prompt_parts.append("## TASK:")
        prompt_parts.append("Extract structured knowledge from this job outcome.")

        if contrastive_pair and contrastive_pair.has_both_outcomes():
            # Contrastive analysis prompt
            if extraction_type == "success":
                prompt_parts.append("""Analyze the CONTRASTIVE JOB SAMPLES above. Compare this job's trajectory
against both successful (Gold/Silver) AND failed (Bronze/Partial/Failed) trajectories
for the same environment class.

Identify:
1. Which design decisions appear in SUCCESSFUL jobs but NOT in failed jobs?
2. Which patterns predict FAILURE (appear in failed jobs but not in successful)?
3. What env_class-specific risks must be mitigated for success?

Output ONLY valid JSON with this structure:
{
  "best_practices": [...],
  "skills": [...],
  "prevention_rules": [...],
  "exploit_probes": [...],
  "contrastive_insights": {
    "success_factors": ["factor1", "factor2"],
    "failure_predictors": ["predictor1", "predictor2"],
    "env_class_specific_risks": ["risk1", "risk2"]
  }
}""")
            else:
                prompt_parts.append("""Analyze this job's failure in context of the CONTRASTIVE JOB SAMPLES above.
Compare against both successful and other failed trajectories.

Identify:
1. What decision or risk mitigation was MISSING compared to successful jobs?
2. What patterns did OTHER failed jobs share with this one?
3. What would have prevented this failure (based on successful trajectories)?

Output ONLY valid JSON with this structure:
{
  "best_practices": [...],
  "skills": [...],
  "prevention_rules": [...],
  "exploit_probes": [...],
  "contrastive_insights": {
    "missing_success_factor": "description",
    "failure_pattern": "description",
    "prevention_based_on_success": ["prevention1", "prevention2"]
  }
}""")
        else:
            # Original non-contrastive prompt
            if extraction_type == "success":
                prompt_parts.append("""For SUCCESS extraction (Gold/Silver):
- Generalizable BestPractice patterns → semantic memory
- Reusable code Skill templates → Skill Library
- Quality fingerprints → positive exemplars

Output ONLY valid JSON with this structure:
{
  "best_practices": [...],
  "skills": [...],
  "prevention_rules": [...],
  "exploit_probes": [...]
}""")
            else:
                prompt_parts.append("""For FAILURE extraction (Bronze/Partial/Failed):
- Root cause identification
- Prevention rules with confidence scores
- Causal chain reconstruction
- Retrieval gaps

Output ONLY valid JSON with this structure:
{
  "best_practices": [...],
  "skills": [...],
  "prevention_rules": [...],
  "exploit_probes": [...]
}""")

        return "\n\n".join(prompt_parts)

    async def _trace_failures(self, state: dict, trace: dict) -> list[dict]:
        """Trace causal chain for failed jobs using CausationTracker."""
        job_id = state["job_id"]
        edp_history = trace.get("edp_history", [])
        tester_results = trace.get("tester_results") or {}

        if not edp_history:
            return []

        failure = {
            "job_id": job_id,
            "category": tester_results.get("category", "unknown"),
            "blockers": tester_results.get("blockers", []),
        }

        try:
            chain = await self._causation_tracker.trace_causes(
                job_id=job_id,
                failure=failure,
                edp_history=edp_history,
                test_results=tester_results,
            )
            return chain
        except Exception as e:
            logger.warning(f"Failed to trace causal chain for job {job_id}: {e}")
            return []

    async def _update_exploit_library(self, extraction: dict, state: dict) -> None:
        """Write novel exploits to exploit library."""
        job_id = state["job_id"]
        probes = extraction.get("exploit_probes", [])

        for probe in probes:
            # Generate embedding for the probe
            text_for_embedding = f"{probe.get('name', '')} {probe.get('probe_code', '')}"
            embedding = await self._generate_embedding(text_for_embedding)

            exploit = {
                "category": probe.get("category", "unknown"),
                "name": probe.get("name", f"probe_{job_id}"),
                "probe_code": probe.get("probe_code", ""),
                "applicable_env_classes": probe.get("applicable_env_classes", []),
                "applicable_reward_types": probe.get("applicable_reward_types", []),
                "structural_preconditions": probe.get("structural_preconditions", {}),
                "discovery_episode_id": job_id,
                "archivist_rationale": f"Extracted from job {job_id}",
                "embedding": embedding,
            }

            try:
                await self.exploit.insert(exploit)
            except Exception as e:
                logger.error(f"Failed to insert exploit {exploit['name']}: {e}")

    async def _resolve_contradictions(self, extraction: dict) -> list[dict]:
        """Check for contradictions with existing KB entries."""
        resolved = []
        all_entities = (
            extraction.get("best_practices", [])
            + extraction.get("prevention_rules", [])
        )

        for entity in all_entities:
            name = entity.get("name")
            entity_type = entity.get("entity_type", "Unknown")

            if not name:
                continue

            try:
                existing = await self.graph.query_by_type(entity_type, limit=10)
                existing_list = [dict(e) for e in existing if e.get("name") == name]

                if existing_list:
                    audn_result = evaluate_audn(entity, existing_list, "name", "recorded_at")
                    if audn_result.action == AUDNAction.UPDATE and audn_result.conflicting_entry:
                        # Create CONTRADICTS edge
                        conflicting = audn_result.conflicting_entry
                        try:
                            await self.graph.insert_link({
                                "source_id": entity.get("id", str(uuid4())),
                                "target_id": conflicting.get("id"),
                                "edge_type": "CONTRADICTS",
                                "properties": {
                                    "reason": audn_result.reason,
                                    "resolved": False,
                                },
                            })
                            resolved.append({
                                "entity": name,
                                "conflicting_with": conflicting.get("id"),
                                "action": "CONTRADICTS_edge_created",
                            })
                        except Exception as e:
                            logger.warning(f"Failed to create CONTRADICTS edge: {e}")
            except Exception as e:
                logger.warning(f"Contradiction check failed for {name}: {e}")

        return resolved

    def _generate_forward_annotations(self, trace: dict, outcome_tier: str) -> dict:
        """Generate annotations for future agents."""
        annotations = {
            "planner": [],
            "critic": [],
            "executor": [],
            "tester": [],
        }

        request = trace.get("request", {})
        env_class = request.get("framework", "unknown")

        if outcome_tier in ("gold", "silver"):
            annotations["planner"].append({
                "env_class": env_class,
                "warning": f"Validated pattern for {env_class}",
                "confidence": "high" if outcome_tier == "gold" else "medium",
                "source": "success",
            })
            annotations["executor"].append({
                "pattern": "validated_success",
                "env_class": env_class,
                "source": "success",
            })
        elif outcome_tier in ("bronze", "partial", "failed"):
            # Add failure-based warnings
            edp_history = trace.get("edp_history", [])
            if edp_history:
                last_edp = edp_history[-1]
                risks = last_edp.get("known_risks", [])
                for risk in risks:
                    annotations["planner"].append({
                        "env_class": env_class,
                        "warning": f"Risk identified: {risk.get('risk', 'unknown')}",
                        "severity": risk.get("severity", "medium"),
                        "source": "failure",
                    })

            # Critic routing feedback
            critic_decisions = trace.get("critic_decisions", [])
            if critic_decisions:
                last_critique = critic_decisions[-1]
                routing = last_critique.get("routing", {})
                if routing.get("decision") in ("targeted_replan", "full_reresearch"):
                    annotations["critic"].append({
                        "env_class": env_class,
                        "routing_decision": routing.get("decision"),
                        "reason": routing.get("reason", ""),
                    })

        return annotations

    async def _perform_kb_health(self, extraction: dict, state: dict) -> dict:
        """Perform KB health maintenance."""
        health_actions = {
            "upgraded": [],
            "downgraded": [],
            "archived": [],
            "contradictions_resolved": [],
        }

        outcome_tier = extraction.get("outcome_tier") or state.get("outcome_tier")

        # For Gold outcomes, upgrade confidence of related entries
        if outcome_tier == "gold":
            skills = extraction.get("skills", [])
            for skill in skills:
                if skill.get("confidence_score", 0) < 0.9:
                    # Upgrade confidence
                    try:
                        existing = await self.procedural.get_by_name(skill.get("name"))
                        if existing:
                            new_confidence = min(1.0, (existing.get("confidence_score", 0.5) + 0.1))
                            await self.procedural.update(existing["id"], {
                                "confidence_score": new_confidence,
                                "quality_metrics": {"upgraded_from": "gold_outcome"},
                            })
                            health_actions["upgraded"].append(skill.get("name"))
                    except Exception as e:
                        logger.warning(f"Failed to upgrade skill {skill.get('name')}: {e}")

        # For Failed outcomes, check if existing entries should be invalidated
        if outcome_tier == "failed":
            # Mark stale entries for this env class
            request = state.get("request", {})
            env_class = request.get("framework", "unknown")

            try:
                entities = await self.graph.query_by_type("BestPractice", limit=50)
                for entity in entities:
                    props = entity.get("properties", {})
                    if props.get("env_class") == env_class and props.get("confidence_score", 0) > 0.7:
                        # Downgrade if it led to failure
                        await self.graph.invalidate_entity(entity["id"])
                        health_actions["downgraded"].append(entity.get("name"))
            except Exception as e:
                logger.warning(f"Failed to perform KB health for failed job: {e}")

        return health_actions

    async def _generate_embedding(self, text: str) -> Optional[list[float]]:
        """Generate embedding for text using the extraction model.

        Falls back gracefully if embedding generation fails.
        """
        try:
            response = self.llm.call(
                agent="archivist",
                prompt=f"Generate embedding for: {text[:1000]}",
                slot="extraction",
                max_tokens=512,
            )
            # For now, return None - real implementation would call
            # an embedding model. The vector clients handle this gracefully.
            return None
        except Exception as e:
            logger.warning(f"Failed to generate embedding: {e}")
            return None

    async def process_research_batch(self, limit: int = 50) -> dict:
        """Process pending research proposals in batch mode.

        Called by the evolution engine to validate research findings
        via AUDN protocol and write canonical entries to the KB.

        Args:
            limit: Maximum number of proposals to process

        Returns:
            Dict with processed count, AUDN actions taken
        """
        logger.info(f"Archivist processing research batch (limit={limit})")

        proposals = await self.research.get_pending_proposals(limit=limit)

        if not proposals:
            logger.info("No pending research proposals to process")
            return {"processed": 0, "additions": 0, "updates": 0, "conflicts": 0}

        processed = 0
        additions = 0
        updates = 0
        conflicts = 0

        for proposal in proposals:
            proposal_id = proposal["id"]
            findings = proposal.get("findings", [])

            try:
                for finding in findings:
                    # Determine entity type based on finding type
                    entity_type = self._map_finding_to_entity_type(finding)
                    finding["entity_type"] = entity_type
                    finding["recorded_at"] = datetime.utcnow().isoformat()

                    # Query existing entities for AUDN evaluation
                    existing = await self.graph.query_by_type(entity_type, limit=20)

                    # Evaluate with AUDN protocol
                    audn_result = evaluate_audn(
                        finding,
                        [dict(e) for e in existing],
                        key_field="title",
                        timestamp_field="recorded_at",
                    )

                    if audn_result.action in (AUDNAction.ADD, AUDNAction.UPDATE):
                        # Write to semantic graph
                        entity_id = await self.graph.insert_entity(finding)
                        logger.info(f"Wrote {entity_type} entity: {entity_id}")

                        # Also write to vector store for semantic retrieval
                        await self._index_finding_vector(finding, entity_id)

                        if audn_result.action == AUDNAction.ADD:
                            additions += 1
                        else:
                            updates += 1

                    elif audn_result.action == AUDNAction.CONFLICT:
                        # Create CONTRADICTS edge and flag for review
                        if audn_result.conflicting_entry:
                            await self.graph.insert_link({
                                "source_id": entity_id,
                                "target_id": audn_result.conflicting_entry.get("id"),
                                "edge_type": "CONTRADICTS",
                                "properties": {
                                    "reason": audn_result.reason,
                                    "proposal_id": proposal_id,
                                    "resolved": False,
                                },
                            })
                        conflicts += 1
                        logger.warning(f"CONFLICT detected for proposal {proposal_id}")

                    # Mark proposal as reviewed
                    await self.research.mark_reviewed(proposal_id, audn_result.action.value)
                    processed += 1

            except Exception as e:
                logger.error(f"Failed to process proposal {proposal_id}: {e}")
                # Mark as reviewed with NONE action to prevent reprocessing
                await self.research.mark_reviewed(proposal_id, "NONE")

        logger.info(
            f"Research batch complete: processed={processed}, "
            f"additions={additions}, updates={updates}, conflicts={conflicts}"
        )

        return {
            "processed": processed,
            "additions": additions,
            "updates": updates,
            "conflicts": conflicts,
        }

    def _map_finding_to_entity_type(self, finding: dict) -> str:
        """Map a finding dict to its corresponding KB entity type."""
        finding_type = finding.get("finding_type", "")

        type_mapping = {
            "ResearchPaper": "ResearchPaper",
            "ConferencePaper": "ConferencePaper",
            "FrameworkVersion": "FrameworkVersion",
            "BenchmarkMethod": "BenchmarkMethod",
            "ResearchFinding": "ResearchFinding",
        }

        return type_mapping.get(finding_type, "ResearchFinding")

    async def _index_finding_vector(self, finding: dict, entity_id: str) -> None:
        """Index a finding in the semantic vector store for retrieval."""
        try:
            # Create text for embedding
            text_for_embedding = (
                f"{finding.get('title', '')} "
                f"{finding.get('abstract_summary', '')} "
                f"{finding.get('implications', '')}"
            )

            # Generate embedding (will return None if LLM fails)
            embedding = await self._generate_embedding(text_for_embedding)

            if embedding:
                await self.vector.upsert(
                    collection="semantic_memory",
                    id=entity_id,
                    vector=embedding,
                    payload=finding,
                )
        except Exception as e:
            logger.warning(f"Failed to index finding vector: {e}")