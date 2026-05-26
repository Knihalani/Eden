"""Sandbox Expert agent — provides deep expertise on sandbox execution environments.

The Sandbox Expert assists other agents when they encounter sandbox-related issues
including Firecracker VM configuration, container isolation, timeout handling, and
debugging sandbox failures.
"""

import hashlib
import logging
import struct
from typing import Optional

from eden.agents.base import PromptLoader
from eden.config import get_settings
from eden.kb.episodic.client import get_episodic_client
from eden.kb.semantic.graph_client import get_graph_client
from eden.kb.exploit.client import get_exploit_client
from eden.llm.client import get_llm_client

logger = logging.getLogger(__name__)
settings = get_settings()


class SandboxExpertAgent(PromptLoader):
    """Sandbox Expert agent that provides deep expertise on sandbox execution.

    The Sandbox Expert is consulted when other agents encounter issues with:
    - Firecracker VM configuration and troubleshooting
    - Container isolation best practices
    - Sandbox timeout and resource limit handling
    - Debugging sandbox failures and errors
    """

    AGENT_NAME = "sandbox_expert"

    SYSTEM_PROMPT = """You are the Sandbox Expert for Eden.

Your role is to provide deep expertise on sandbox execution environments:
- Firecracker VM configuration and troubleshooting
- Container isolation best practices
- Sandbox timeout and resource limit handling
- Debugging sandbox failures and errors

When other agents encounter sandbox-related issues, you provide guidance and
troubleshooting steps. You draw on knowledge of:
- Firecracker microVM lifecycle and configuration
- Linux namespace and cgroup isolation
- Container networking and storage
- Resource limits (CPU, memory, disk, network)
- Timeout handling and graceful degradation
- Common failure modes and their resolution

Assist other agents by providing specific, actionable guidance based on the
current job context and sandbox state."""

    def __init__(self, llm_client=None):
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

    @property
    def system_prompt(self) -> str:
        """Get the current system prompt (from KB or class default)."""
        return self._system_prompt or self.SYSTEM_PROMPT

    async def run(self, state: dict) -> dict:
        """Run the Sandbox Expert agent on the current state.

        Args:
            state: EdenJobState with job_id, request, sandbox_info

        Returns:
            dict with current_stage and any sandbox guidance added to state
        """
        job_id = state.get("job_id", "unknown")
        sandbox_info = state.get("sandbox_info", {})
        error_context = state.get("error_context", {})
        request = state.get("request", {})

        logger.info(f"SandboxExpert running for job {job_id}")

        # Track KB reads for provenance
        kb_reads = []

        # Query KB sources for relevant context
        episodic_context = await self._query_episodic(request, kb_reads)
        graph_context = await self._query_graph(request, kb_reads)
        exploit_context = await self._query_exploits(request, kb_reads)

        # Analyze the sandbox context with KB context
        guidance = self._analyze_sandbox_context(
            sandbox_info, error_context,
            episodic_context=episodic_context,
            graph_context=graph_context,
            exploit_context=exploit_context,
        )

        # Determine next stage based on guidance
        current_stage = self._determine_next_stage(state, guidance)

        return {
            "current_stage": current_stage,
            "sandbox_guidance": guidance,
            "kb_reads": kb_reads,
        }

    async def _query_episodic(self, request: dict, kb_reads: list) -> str:
        """Query episodic memory for past sandbox failures."""
        try:
            description = request.get("description", "")
            search_text = f"sandbox failure timeout {description}"

            if not search_text.strip():
                return ""

            recent_jobs = await self.episodic.search_by_description(search_text, limit=5)
            recent = await self.episodic.get_recent(days=30, limit=10)

            all_jobs = {j["job_id"]: j for j in recent_jobs + recent}
            similar_jobs = list(all_jobs.values())[:5]

            context_parts = []
            for job in similar_jobs:
                outcome = job.get("outcome_tier", "unknown")
                sandbox_errors = job.get("sandbox_error", "")

                if sandbox_errors:
                    context_parts.append(
                        f"- Job {job['job_id'][:8]}: outcome={outcome}\n"
                        f"  Sandbox error: {sandbox_errors[:200]}"
                    )
                    kb_reads.append({
                        "type": "episodic",
                        "job_id": job["job_id"],
                        "summary": f"sandbox failure outcome={outcome}",
                    })

            return "\n".join(context_parts) if context_parts else ""
        except Exception as e:
            logger.warning(f"Episodic query failed: {e}")
            return ""

    async def _query_graph(self, request: dict, kb_reads: list) -> str:
        """Query semantic graph for sandbox-related failure modes."""
        try:
            failure_entities = await self.graph.query_by_type(
                entity_type="FailureMode",
                limit=10,
            )

            context_parts = []
            for entity in failure_entities[:5]:
                props = entity.get("properties", {})
                category = props.get("category", "")
                if category in ("sandbox", "timeout", "resource"):
                    context_parts.append(
                        f"- {entity['name']}: {props.get('description', 'No description')}\n"
                        f"  Prevention: {props.get('prevention', 'unknown')}"
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
        """Query exploit library for sandbox escaping patterns."""
        try:
            exploits = await self.exploit.get_applicable(
                env_class="agent_sandbox",
                reward_types=["dense", "sparse"],
            )

            context_parts = []
            for exploit in exploits[:5]:
                category = exploit.get("category", "")
                if category in ("sandbox_escape", "resource_exhaustion"):
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

    def _analyze_sandbox_context(
        self, sandbox_info: dict, error_context: dict,
        episodic_context: str = "", graph_context: str = "", exploit_context: str = ""
    ) -> dict:
        """Analyze sandbox context and provide guidance.

        Args:
            sandbox_info: Current sandbox configuration and status
            error_context: Any error information from previous attempts
            episodic_context: Past sandbox failures from episodic memory
            graph_context: Failure modes from semantic graph
            exploit_context: Sandbox exploits from exploit library

        Returns:
            dict with guidance, recommendations, and relevant context
        """
        guidance = {
            "summary": "Sandbox configuration analysis complete",
            "recommendations": [],
            "troubleshooting_steps": [],
            "configuration_suggestions": {},
            "kb_context": {
                "episodic": episodic_context,
                "graph": graph_context,
                "exploit": exploit_context,
            },
        }

        # Analyze sandbox type and configuration
        sandbox_type = sandbox_info.get("type", "firecracker")
        config = sandbox_info.get("config", {})

        if sandbox_type == "firecracker":
            guidance["recommendations"].extend([
                "Use Firecracker microVM for strong isolation",
                "Configure appropriate vCPUs and memory for workload",
                "Set up proper network interfaces for agent communication",
            ])
            guidance["configuration_suggestions"] = self._get_firecracker_config(config)

        elif sandbox_type == "container":
            guidance["recommendations"].extend([
                "Use container isolation for lighter workloads",
                "Ensure proper cgroup limits are set",
                "Configure network namespace for isolation",
            ])
            guidance["configuration_suggestions"] = self._get_container_config(config)

        # Handle any error context
        if error_context:
            error_type = error_context.get("type", "unknown")
            guidance["troubleshooting_steps"] = self._get_troubleshooting_steps(error_type)

        return guidance

    def _get_firecracker_config(self, config: dict) -> dict:
        """Get Firecracker configuration suggestions."""
        suggestions = {
            "vcpus": config.get("vcpus", 2),
            "memory_mb": config.get("memory_mb", 2048),
            "timeout_seconds": config.get("timeout_seconds", 300),
            "network_interfaces": config.get("network_interfaces", 1),
        }

        # Add recommendations based on workload
        if config.get("workload_type") == "agent_execution":
            suggestions.update({
                "vcpus": 2,
                "memory_mb": 2048,
                "timeout_seconds": 300,
            })
        elif config.get("workload_type") == "test_execution":
            suggestions.update({
                "vcpus": 1,
                "memory_mb": 1024,
                "timeout_seconds": 120,
            })

        return suggestions

    def _get_container_config(self, config: dict) -> dict:
        """Get container configuration suggestions."""
        suggestions = {
            "cpu_limit": config.get("cpu_limit", "2"),
            "memory_limit": config.get("memory_limit", "2g"),
            "timeout_seconds": config.get("timeout_seconds", 120),
            "network_mode": config.get("network_mode", "none"),
        }

        return suggestions

    def _get_troubleshooting_steps(self, error_type: str) -> list[str]:
        """Get troubleshooting steps for common error types."""
        steps = []

        if error_type == "timeout":
            steps.extend([
                "Increase timeout if workload is legitimately long-running",
                "Check for infinite loops or blocking operations in code",
                "Implement proper cancellation support in the workload",
                "Consider splitting long-running tasks into smaller steps",
            ])
        elif error_type == "resource_exhaustion":
            steps.extend([
                "Increase memory limits if workload requires more",
                "Check for memory leaks in the workload",
                "Implement proper cleanup of resources",
                "Consider using streaming/chunking for large data",
            ])
        elif error_type == "network_failure":
            steps.extend([
                "Verify network configuration is correct",
                "Check firewall rules and network policies",
                "Ensure DNS resolution is working",
                "Verify the sandbox has network access",
            ])
        elif error_type == "sandbox_startup_failure":
            steps.extend([
                "Check kernel module availability (vhost_vsock)",
                "Verify KVM permissions and access",
                "Check disk image availability and integrity",
                "Review Firecracker logs for detailed error",
            ])
        else:
            steps.extend([
                "Review sandbox logs for detailed error information",
                "Verify all required resources are available",
                "Check network and filesystem permissions",
                "Consider simplifying the sandbox configuration",
            ])

        return steps

    def _determine_next_stage(self, state: dict, guidance: dict) -> str:
        """Determine the next pipeline stage based on guidance.

        Args:
            state: Current pipeline state
            guidance: Sandbox guidance analysis

        Returns:
            str: next stage to transition to
        """
        # Default next stage after sandbox expert consultation
        # The actual routing depends on what other agents need
        error_context = state.get("error_context", {})

        if error_context.get("type") == "timeout":
            return "executing"  # Retry with adjusted timeout
        elif error_context.get("type") == "sandbox_startup_failure":
            return "refining"  # Refine sandbox configuration
        else:
            # Default: continue to next stage based on pipeline
            return state.get("current_stage", "executing")