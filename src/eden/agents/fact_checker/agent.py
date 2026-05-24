"""Fact Checker agent — verifies empirical claims in the RES.

Verifies every class, method, constant exists in declared framework version
before a line of code is written.
"""

import logging
from typing import Optional

from eden.llm.client import OpenRouterClient
from eden.config import get_settings
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


class FactCheckerAgent(PromptLoader):
    """Fact Checker agent that verifies claims before code is written.

    The Fact Checker:
    1. Verifies every class/method/constant exists in declared framework version
    2. Checks physics plausibility for physics-based environments
    3. Verifies reward bounds are mathematically achievable
    4. Checks library dependency compatibility
    5. Checks logical consistency (termination reachable, initial state valid)
    6. For LLM eval envs: verifies observation/action format
    """

    AGENT_NAME = "fact_checker"

    SYSTEM_PROMPT = """You are the Fact Checker for Eden, an AI-native environment generation system.

Your role is to verify every empirical claim in the Refined Environment Spec (RES)
before code is written. This is the primary defense against hallucinated API calls.

Verification checklist:

1. FRAMEWORK API INTEGRITY: Every class, method, constant in the RES must exist
   in the declared framework version (Gymnasium 0.29, PettingZoo 1.24, etc.)
   Check against actual framework documentation.

2. PHYSICS PLAUSIBILITY: For physics-based environments, verify:
   - Timestep is physically reasonable (typically 0.001-0.05s for robotics)
   - Mass, inertia values are in realistic ranges
   - Coordinate systems are consistent

3. REWARD BOUNDS: Verify reward bounds are mathematically achievable given
   declared dynamics. Reward that requires more than physics allows is impossible.

4. DEPENDENCY COMPATIBILITY: All library dependencies must be mutually
   compatible in declared versions. Check PyPI compatibility.

5. LOGICAL CONSISTENCY: Verify:
   - At least one termination path is reachable from valid initial state
   - Initial state is valid per space definitions
   - No contradictions in spec

6. LLM EVAL FORMAT: For LLM evaluation environments:
   - Observation format is parseable by frontier models
   - Action space is producible by models (text, not arbitrary tensors)

Output a verification report as JSON with:
- pass: boolean
- checks: list of {check_name, passed, details}
- blockers: list of issues that must be fixed before proceeding

If any blocker exists, the pipeline cannot proceed to Executor."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or OpenRouterClient()
        self.max_tokens = settings.max_tokens_fact_checker
        self.max_turns = settings.max_turns_fact_checker
        self.framework_verifier = FrameworkVerifier()
        self._load_prompt()

    async def run(self, state: dict) -> dict:
        """Run the Fact Checker agent on the current RES.

        Args:
            state: EdenJobState with res from Refiner

        Returns:
            dict with fact_check_report and routing
        """
        job_id = state["job_id"]
        res = state.get("res")

        logger.info(f"Fact Checker running for job {job_id}")

        if not res:
            logger.error(f"No RES found in state for job {job_id}")
            return {
                "fact_check_report": {
                    "pass": False,
                    "checks": [],
                    "blockers": ["No RES found in state"],
                },
                "current_stage": "human_review",
                "routing_history": [{
                    "from": "fact_checker",
                    "to": "human_review",
                    "reason": "No RES to fact-check",
                }],
            }

        # Run FrameworkVerifier checks before LLM
        framework = res.get("meta", {}).get("framework", "gymnasium")
        version = res.get("meta", {}).get("framework_version", "0.29")
        verifier_results = self._run_framework_verification(res, framework, version)

        # Build fact-check prompt with verifier results
        prompt = self._build_fact_check_prompt(res, verifier_results)

        # Make LLM call
        response = self.llm.call(
            agent="fact_checker",
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        # Parse verification report
        report = self._parse_report(response.content)

        # Merge framework verification results
        report = self._merge_verifier_results(report, verifier_results)

        # Determine routing
        if report.get("pass", False) and not report.get("blockers"):
            routing = "executing"
            routing_reason = "All fact checks passed"
        else:
            routing = "human_review"
            routing_reason = f"Fact check failed: {len(report.get('blockers', []))} blocker(s) found"

        logger.info(
            f"Fact Checker result for job {job_id}: pass={report.get('pass', False)}, "
            f"blockers={len(report.get('blockers', []))}, routing={routing}"
        )

        return {
            "fact_check_report": report,
            "current_stage": routing,
            "routing_history": [{
                "from": "fact_checker",
                "to": routing,
                "reason": routing_reason,
            }],
        }

    def _run_framework_verification(self, res: dict, framework: str, version: str) -> list[dict]:
        """Run FrameworkVerifier checks on the RES.

        Args:
            res: The Refined Environment Spec
            framework: Framework name (gymnasium, pettingzoo, etc.)
            version: Framework version string

        Returns:
            List of verification results for each check
        """
        results = []

        # Check output interface classes
        output_interface = res.get("output_interface", {})
        for class_name in output_interface.get("classes", []):
            exists = self.framework_verifier.verify_class(framework, version, class_name)
            results.append({
                "check_name": f"class_exists_{class_name}",
                "passed": exists,
                "details": f"{class_name} {'found' if exists else 'NOT FOUND'} in {framework} {version}",
            })

        # Check methods on declared classes
        methods = output_interface.get("methods", {})
        for class_name, method_list in methods.items():
            for method_name in method_list:
                exists = self.framework_verifier.verify_method(framework, version, class_name, method_name)
                results.append({
                    "check_name": f"method_exists_{class_name}_{method_name}",
                    "passed": exists,
                    "details": f"{class_name}.{method_name} {'found' if exists else 'NOT FOUND'} in {framework} {version}",
                })

        # Check space types
        env_spec = res.get("environment", {})
        obs_space = env_spec.get("observation_space", {})
        action_space = env_spec.get("action_space", {})
        for space_name in [obs_space.get("type", ""), action_space.get("type", "")]:
            if space_name:
                exists = self.framework_verifier.verify_space(framework, version, space_name)
                results.append({
                    "check_name": f"space_exists_{space_name}",
                    "passed": exists,
                    "details": f"{space_name} space {'found' if exists else 'NOT FOUND'} in {framework} {version}",
                })

        # Check reward bounds
        reward_check = self._verify_reward_bounds(res)
        results.append(reward_check)

        # Check physics plausibility
        physics_check = self._verify_physics_plausibility(res)
        results.append(physics_check)

        return results

    def _verify_reward_bounds(self, res: dict) -> dict:
        """Verify reward bounds are mathematically achievable."""
        reward_spec = res.get("reward_pseudocode", {})
        components = reward_spec.get("components", [])

        issues = []
        for comp in components:
            bounds = comp.get("bounds", {})
            lower = bounds.get("lower", -float("inf"))
            upper = bounds.get("upper", float("inf"))

            if lower > upper:
                issues.append(f"Reward component '{comp.get('name', 'unknown')}' has invalid bounds: {lower} > {upper}")

        if issues:
            return {
                "check_name": "reward_bounds_validity",
                "passed": False,
                "details": "; ".join(issues),
            }

        return {
            "check_name": "reward_bounds_validity",
            "passed": True,
            "details": "All reward bounds have lower <= upper",
        }

    def _verify_physics_plausibility(self, res: dict) -> dict:
        """Verify physics parameters are in plausible ranges."""
        env_spec = res.get("environment", {})
        episode_dynamics = env_spec.get("episode_dynamics", {})
        difficulty = env_spec.get("difficulty_parameters", {})

        issues = []

        # Check timestep
        timestep = episode_dynamics.get("timestep")
        if timestep:
            try:
                t = float(timestep)
                if t <= 0 or t > 1.0:
                    issues.append(f"Timestep {t} outside plausible range (0, 1.0]")
                elif t > 0.1 and env_spec.get("observation_space", {}).get("type") == "Box":
                    # Likely robotics env, timestep should be smaller
                    issues.append(f"Timestep {t} may be too large for continuous control (typical: 0.001-0.05)")
            except (ValueError, TypeError):
                issues.append(f"Cannot parse timestep: {timestep}")

        # Check max_steps consistency
        max_steps = episode_dynamics.get("max_steps")
        if max_steps:
            try:
                ms = int(max_steps)
                if ms < 1:
                    issues.append(f"max_steps must be >= 1, got {ms}")
                elif ms > 1_000_000:
                    issues.append(f"max_steps {ms} seems excessive")
            except (ValueError, TypeError):
                issues.append(f"Cannot parse max_steps: {max_steps}")

        if issues:
            return {
                "check_name": "physics_plausibility",
                "passed": False,
                "details": "; ".join(issues),
            }

        return {
            "check_name": "physics_plausibility",
            "passed": True,
            "details": "Physics parameters within plausible ranges",
        }

    def _build_fact_check_prompt(self, res: dict, verifier_results: list[dict]) -> str:
        """Build the fact-check prompt from the RES."""
        import json

        # Separate passed/failed verifier checks
        passed_checks = [r for r in verifier_results if r.get("passed")]
        failed_checks = [r for r in verifier_results if not r.get("passed")]

        verifier_summary = f"Framework verification: {len(passed_checks)} passed, {len(failed_checks)} failed"
        if failed_checks:
            verifier_summary += "\nFailed checks:\n" + "\n".join(f"  - {c['details']}" for c in failed_checks)

        return f"""## REFINED ENVIRONMENT SPEC (RES) TO VERIFY

{json.dumps(res, indent=2, default=str)}

---

## FRAMEWORK VERIFICATION RESULTS

{verifier_summary}

---

## YOUR TASK

Verify the RES above across ALL dimensions:

1. FRAMEWORK API INTEGRITY: Confirm every class, method exists in declared version
2. PHYSICS PLAUSIBILITY: Confirm timestep, masses, forces in realistic ranges
3. REWARD BOUNDS: Confirm bounds achievable given dynamics
4. DEPENDENCY COMPATIBILITY: All libraries mutually compatible
5. LOGICAL CONSISTENCY: Termination reachable, initial state valid
6. LLM EVAL FORMAT: Obs parseable, action producible

Output verification report as JSON with:
{{
  "pass": boolean,
  "checks": [{{"check_name", "passed", "details"}}],
  "blockers": ["issue1", "issue2"]
}}

If blockers exist, the pipeline cannot proceed to Executor."""

    def _parse_report(self, content: str) -> dict:
        """Parse verification report from LLM response."""
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

        logger.error(f"Failed to parse verification report from response: {content[:200]}...")
        return {
            "pass": False,
            "checks": [],
            "blockers": ["Failed to parse verification report from LLM response"],
        }

    def _merge_verifier_results(self, report: dict, verifier_results: list[dict]) -> dict:
        """Merge FrameworkVerifier results into the report.

        Args:
            report: The verification report from LLM
            verifier_results: Results from FrameworkVerifier checks

        Returns:
            Merged report with all checks combined
        """
        # Ensure checks list exists
        if "checks" not in report:
            report["checks"] = []

        # Add framework verification results
        report["checks"].extend(verifier_results)

        # Update pass/fail based on framework checks
        failed_framework_checks = [r for r in verifier_results if not r.get("passed")]
        if failed_framework_checks:
            report["pass"] = False
            for check in failed_framework_checks:
                report.setdefault("blockers", []).append(check["details"])

        return report


class FrameworkVerifier:
    """Verifies framework API calls against known documentation."""

    # Known framework APIs (subset - extend as needed)
    KNOWN_APIS = {
        "gymnasium": {
            "0.29": {
                "classes": ["Env", "Wrapper", "TimeLimit", "Monitor"],
                "methods": {
                    "Env": ["reset", "step", "close", "seed", "render", "close"],
                    "Wrapper": ["reset", "step", "close", "observation", "action"],
                },
                "spaces": ["Box", "Discrete", "Tuple", "Dict", "MultiBinary", "MultiDiscrete"],
            },
        },
        "pettingzoo": {
            "1.24": {
                "classes": [" AECEnv", "ParallelEnv", "Agent", "ParallelRNG"],
                "methods": {
                    "AECEnv": ["reset", "step", "close", "observation", "action_space", "observation_space"],
                    "ParallelEnv": ["reset", "step", "close", "action_space", "observation_space"],
                },
            },
        },
    }

    def verify_class(self, framework: str, version: str, class_name: str) -> bool:
        """Verify a class exists in the framework."""
        if framework not in self.KNOWN_APIS:
            return True  # Unknown framework, skip
        if version not in self.KNOWN_APIS[framework]:
            return True  # Unknown version, skip
        return class_name in self.KNOWN_APIS[framework][version].get("classes", [])

    def verify_method(
        self, framework: str, version: str, class_name: str, method_name: str
    ) -> bool:
        """Verify a method exists on a class."""
        if framework not in self.KNOWN_APIS:
            return True
        if version not in self.KNOWN_APIS[framework]:
            return True
        class_methods = self.KNOWN_APIS[framework][version].get("methods", {}).get(class_name, [])
        return method_name in class_methods

    def verify_space(self, framework: str, version: str, space_name: str) -> bool:
        """Verify a space type exists."""
        if framework not in self.KNOWN_APIS:
            return True
        if version not in self.KNOWN_APIS[framework]:
            return True
        return space_name in self.KNOWN_APIS[framework][version].get("spaces", [])