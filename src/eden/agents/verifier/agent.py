from typing import cast, Any
"""Verifier agent — fidelity check between code and RES.

Checks if the generated code matches the Refined Environment Spec before testing.
"""

import json
import logging
import re

from eden.agents.base import PromptLoader
from eden.config import get_settings
from eden.llm.client import OpenRouterClient, get_llm_client

logger = logging.getLogger(__name__)
settings = get_settings()


class VerifierAgent(PromptLoader):
    """Verifier agent that checks code matches the RES.

    Checks:
    1. Interface compliance — all required methods, correct signatures
    2. RES fidelity — reward matches pseudocode, termination conditions match spec
    3. Completeness — zero stubs, TODOs, placeholders, zero undefined imports

    Escalation: Same flaw recurring 3x → escalate to Refiner (spec may be wrong)
    """

    AGENT_NAME = "verifier"

    SYSTEM_PROMPT = """You are the Verifier for Eden, an AI-native environment generation system.

Your role is to check that the generated code faithfully implements the Refined Environment Spec (RES).
This is a fidelity check, not a quality check — does the code match the spec?

Verification checks:

1. INTERFACE COMPLIANCE:
   - All required methods exist (reset, step, close, etc.)
   - Method signatures match declared framework API
   - Action and observation spaces are properly defined
   - Return types match spec

2. RES FIDELITY:
   - Reward computation matches pseudocode in RES
   - Termination conditions match spec (terminated/truncated logic)
   - Difficulty parameters are applied as specified
   - Episode dynamics are correct (max_steps, reset logic, stochasticity)

3. COMPLETENESS:
   - Zero stubs (pass, NotImplementedError)
   - Zero TODOs or FIXMEs
   - Zero placeholders (replace_with_...)
   - Zero undefined imports
   - No dead code paths

Output a verification report as JSON:
- passed: boolean
- issues: list of {type, location, description, severity}
- design_level: boolean (true if issue suggests spec problem, not just code problem)

If design_level=true and same pattern recurs, the spec needs revision, not the code."""

    def __init__(self, llm_client: OpenRouterClient | None = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_verifier
        self.max_turns = settings.max_turns_verifier
        self._load_prompt()

    async def run(self, state: dict) -> dict:
        """Run the Verifier agent to check code fidelity against the RES.

        Args:
            state: EdenJobState with res and code_history

        Returns:
            dict with verifier_report and routing
        """
        job_id = state["job_id"]
        res = state.get("res")
        code = state.get("code_history", [""])[-1] if state.get("code_history") else ""

        logger.info(f"Verifier running for job {job_id}")

        if not res:
            logger.warning(f"No RES found in state for job {job_id}")
            return {
                "verifier_report": {
                    "passed": False,
                    "issues": [{"type": "missing_res", "location": "state", "description": "No RES found in state", "severity": "critical"}],
                    "design_level": True,
                },
                "current_stage": "human_review",
            }

        if not code:
            logger.warning(f"No code found in state for job {job_id}")
            return {
                "verifier_report": {
                    "passed": False,
                    "issues": [{"type": "missing_code", "location": "state", "description": "No code found in state", "severity": "critical"}],
                    "design_level": True,
                },
                "current_stage": "human_review",
            }

        # Build verification prompt
        prompt = self._build_verification_prompt(res, code)

        # Call LLM
        response = self.llm.call(
            agent="verifier",
            prompt=prompt,
            slot="reasoning",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        # Parse verification report
        report = self._parse_verification_report(response.content)

        # Determine routing based on report
        routing = self._determine_routing(report, state)

        logger.info(f"Verifier result for job {job_id}: passed={report.get('passed', False)}, design_level={report.get('design_level', False)}")

        return {
            "verifier_report": report,
            "routing_history": state.get("routing_history", []) + [{
                "from": "verifier",
                "to": routing,
                "reason": f"passed={report.get('passed', False)}, design_level={report.get('design_level', False)}",
            }],
            "current_stage": routing,
        }

    def _build_verification_prompt(self, res: dict, code: str) -> str:
        """Build the verification prompt from RES and code."""
        return f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## GENERATED CODE TO VERIFY

```python
{code}
```

---

## YOUR TASK

Verify that the generated code faithfully implements the RES above.

Check ALL of the following:

1. INTERFACE COMPLIANCE:
   - Does the code have all required methods (reset, step, close)?
   - Do method signatures match the framework API?
   - Are observation_space and action_space properly defined?

2. RES FIDELITY:
   - Does the reward computation match the pseudocode/formulae in the RES?
   - Do termination conditions match the spec exactly?
   - Are difficulty parameters applied as specified?
   - Do episode dynamics (max_steps, reset logic, stochasticity) match?

3. COMPLETENESS:
   - Are there any stubs (pass, NotImplementedError, ...) that need implementation?
   - Are there any TODOs or FIXMEs left?
   - Are there any placeholders like replace_with_...?
   - Are there any undefined imports?

Output a verification report as valid JSON with:
- passed: boolean (true if ALL checks pass)
- issues: list of objects with {{type, location, description, severity}}
- design_level: boolean (true if issue suggests SPEC problem, not just code problem)

For design_level issues, the spec itself needs revision — the code correctly implements a flawed spec.

Be thorough and specific. Location should indicate file/line/method."""

    def _parse_verification_report(self, content: str) -> dict:
        """Parse verification report from LLM response."""
        # Try to extract JSON from markdown code blocks
        json_match = re.search(r"```(?:json)?\s*(\{[\s\S]*?\})\s*```", content)
        if json_match:
            try:
                return cast(dict[Any, Any], json.loads(json_match.group(1)))
            except json.JSONDecodeError:
                pass

        # Try to find raw JSON
        json_match = re.search(r"\{[\s\S]*\}", content)
        if json_match:
            try:
                return cast(dict[Any, Any], json.loads(json_match.group(0)))
            except json.JSONDecodeError:
                pass

        logger.error(f"Failed to parse verification report from response: {content[:200]}...")
        return {
            "passed": False,
            "issues": [{"type": "parse_error", "location": "llm_response", "description": "Failed to parse verification report", "severity": "critical"}],
            "design_level": False,
        }

    def _determine_routing(self, report: dict, state: dict) -> str:
        """Determine routing based on verification report and state.

        Per ROADMAP.md verifier_router:
        - report.passed == true → "testing"
        - report.passed == false with executor_iterations < 5 → "executing"
        - report.passed == false with executor_iterations >= 5 and design_level == true → "verifier" (escalation)
        - report.passed == false with executor_iterations >= 5 → "human_review"
        """
        if report.get("passed", False):
            return "testing"

        executor_iterations = state.get("executor_iterations", 0)
        design_level = report.get("design_level", False)

        if executor_iterations < 5:
            return "executing"
        elif design_level:
            # Escalation: same flaw 3x → spec needs revision, go back to Refiner
            return "refining"
        else:
            return "human_review"
