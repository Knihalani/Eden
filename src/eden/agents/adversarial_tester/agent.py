"""Adversarial Tester agent — finds exploits, breaks, and failure modes.

Tries to break the environment by finding:
1. Exploits — ways to manipulate reward or bypass intended behavior
2. Edge cases — conditions that cause crashes or invalid states
3. Failure modes — situations where the environment doesn't work as intended
4. Security issues — sandbox escapes, resource exhaustion, etc.

This runs after verification/testing passes and before archiving.
"""

import json
import logging
import re
from typing import Optional

from eden.llm.client import OpenRouterClient, get_llm_client
from eden.config import get_settings
from eden.agents.base import PromptLoader
from eden.kb.exploit.client import get_exploit_client

logger = logging.getLogger(__name__)
settings = get_settings()


class AdversarialTesterAgent(PromptLoader):
    """Adversarial Tester agent that attempts to break the environment.

    The Adversarial Tester:
    1. Queries exploit knowledge base for known attack patterns
    2. Tests reward hacking possibilities
    3. Checks for edge cases that cause failures
    4. Attempts to find failure modes
    5. Reports all findings for human review if critical issues found
    """

    AGENT_NAME = "adversarial_tester"

    SYSTEM_PROMPT = """You are the Adversarial Tester for Eden, an AI-native environment generation system.

Your role is to FIND WEAKNESSES in the environment — places where it can be broken,
exploited, or made to fail. You are acting as an adversarial agent trying to break
the environment.

Your goals:
1. Find REWARD HACKS — ways to manipulate the reward function
2. Find EDGE CASES — conditions that cause crashes or invalid states
3. Find FAILURE MODES — situations where behavior is incorrect
4. Find SANDBOX ISSUES — potential escapes or resource exhaustion
5. Find LOGIC BUGS — cases where the environment doesn't match the spec

For each potential exploit you find:
1. Describe the attack vector
2. Show code that would trigger it
3. Estimate severity (critical/high/medium/low)
4. Suggest a fix

Queries to the Exploit Knowledge Base for known patterns and tests them.
Report ALL findings — do not filter out low-severity issues."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_adversarial_tester
        self.max_turns = settings.max_turns_adversarial_tester
        self._load_prompt()
        self.exploit_client = get_exploit_client()

    async def run(self, state: dict) -> dict:
        """Run the Adversarial Tester to find exploits and failure modes.

        Args:
            state: EdenJobState with code and RES

        Returns:
            dict with adversarial findings
        """
        job_id = state["job_id"]
        code_history = state.get("code_history", [])
        res = state.get("res")

        logger.info(f"Adversarial Tester running for job {job_id}")

        if not code_history:
            logger.warning(f"No code found in state for job {job_id}")
            return {
                "adversarial_report": {"findings": [], "passed": True},
                "current_stage": "archiving",
            }

        current_code = code_history[-1] if code_history else ""

        if not current_code:
            return {
                "adversarial_report": {"findings": [], "passed": True},
                "current_stage": "archiving",
            }

        # Run adversarial tests
        findings = await self._find_exploits(current_code, res)

        # Determine if any critical issues found
        critical_findings = [f for f in findings if f.get("severity") == "critical"]
        passed = len(critical_findings) == 0

        report = {
            "findings": findings,
            "passed": passed,
            "critical_count": len(critical_findings),
            "total_findings": len(findings),
        }

        logger.info(f"Adversarial Tester completed for job {job_id}: {len(findings)} findings, passed={passed}")

        return {
            "adversarial_report": report,
            "current_stage": "archiving",
        }

    async def _find_exploits(self, code: str, res: Optional[dict] = None) -> list[dict]:
        """Find exploits and failure modes in the code.

        Args:
            code: Current code to analyze
            res: Optional RES for context

        Returns:
            List of finding dictionaries
        """
        # Query exploit KB for known patterns
        known_exploits = await self._query_exploit_kb(res)

        # Analyze code for vulnerabilities
        code_findings = await self._analyze_code(code, res, known_exploits)

        return code_findings

    async def _query_exploit_kb(self, res: Optional[dict] = None) -> list[dict]:
        """Query the exploit knowledge base for known attack patterns.

        Args:
            res: Optional RES for context

        Returns:
            List of relevant exploit patterns
        """
        try:
            env_class = res.get("meta", {}).get("environment_class", "") if res else ""
            reward_types = []

            if res:
                reward_struct = res.get("environment", {}).get("reward_structure", {})
                reward_types = [reward_struct.get("type", "dense")]

            exploits = await self.exploit_client.get_applicable(
                env_class=env_class or "agent_sandbox",
                reward_types=reward_types if reward_types else ["dense", "sparse"],
            )

            return exploits[:10]  # Limit to top 10
        except Exception as e:
            logger.warning(f"Exploit KB query failed: {e}")
            return []

    async def _analyze_code(
        self, code: str, res: Optional[dict] = None, known_exploits: list[dict] = None
    ) -> list[dict]:
        """Analyze code for vulnerabilities and exploits.

        Args:
            code: Code to analyze
            res: Optional RES
            known_exploits: Known exploit patterns from KB

        Returns:
            List of findings
        """
        known_exploit_str = ""
        if known_exploits:
            known_exploit_str = "\n\n## KNOWN EXPLOIT PATTERNS FROM KB\n\n"
            for exploit in known_exploits:
                known_exploit_str += f"- **{exploit.get('name', 'unnamed')}** ({exploit.get('category', 'unknown')})\n"
                known_exploit_str += f"  {exploit.get('description', 'No description')}\n"

        env_context = ""
        if res:
            meta = res.get("meta", {})
            output_spec = res.get("output_spec", {})
            env_context = f"""
## ENVIRONMENT CONTEXT
- Framework: {output_spec.get('framework', 'gymnasium')}
- Environment Class: {meta.get('environment_class', 'standard')}
- Reward Type: {res.get('environment', {}).get('reward_structure', {}).get('type', 'dense')}
- Episode Max Steps: {res.get('environment', {}).get('episode_dynamics', {}).get('max_steps', 'unlimited')}
"""

        prompt = f"""## CODE TO ANALYZE

```python
{code}
```
{env_context}
{known_exploit_str}

---

## ADVERSARIAL ANALYSIS TASK

Act as an adversarial agent trying to BREAK this environment.

Analyze for:

1. **REWARD HACKING**:
   - Can rewards be manipulated without achieving actual goal?
   - Are there reward shortcuts or degenerate strategies?
   - Can the agent get stuck in reward loops?

2. **EDGE CASE FAILURES**:
   - Division by zero or NaN propagation?
   - Index out of bounds?
   - Unhandled None values?
   - Race conditions in multi-agent?

3. **STATE CORRUPTION**:
   - Can internal state become inconsistent?
   - Are there cases where reset() doesn't fully reset?
   - Can the environment get stuck in a bad state?

4. **TERMINATION BYPASS**:
   - Can the agent prevent termination ever happening?
   - Can termination conditions be subverted?

5. **RESOURCE ISSUES**:
   - Memory leaks from growing structures?
   - Unbounded loops?
   - Excessive computation in step()?

6. **SANDBOX ESCAPES** (if applicable):
   - Can code access files/system inappropriately?
   - Can it interfere with other agents?

For EACH issue found provide:
- Type (reward_hack, edge_case, state_corruption, termination_bypass, resource, sandbox)
- Severity (critical/high/medium/low)
- Description of the issue
- Example code that triggers it
- Suggested fix

Output findings as a JSON array:
```json
[
  {{
    "type": "...",
    "severity": "...",
    "description": "...",
    "trigger_code": "...",
    "fix": "..."
  }}
]
```

If no issues found, return an empty array `[]`."""

        response = self.llm.call(
            agent="adversarial_tester",
            prompt=prompt,
            slot="analysis",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        return self._parse_findings(response.content)

    def _parse_findings(self, content: str) -> list[dict]:
        """Parse findings from LLM response.

        Args:
            content: LLM response content

        Returns:
            List of finding dictionaries
        """
        # Try to extract JSON array from code block
        json_match = re.search(r"```(?:json)?\s*(\[.*?\])\s*```", content, re.DOTALL)
        if json_match:
            try:
                findings = json.loads(json_match.group(1))
                if isinstance(findings, list):
                    return findings
            except json.JSONDecodeError:
                pass

        # Try to find JSON array anywhere in content
        json_match = re.search(r"\[.*\]", content, re.DOTALL)
        if json_match:
            try:
                findings = json.loads(json_match.group(0))
                if isinstance(findings, list):
                    return findings
            except json.JSONDecodeError:
                pass

        # No valid JSON found - try to parse structured text
        findings = []
        lines = content.split("\n")
        current_finding = None

        for line in lines:
            # Look for severity markers
            severity_match = re.search(r"\*\*\s*(critical|high|medium|low)\s*\*\*", line, re.IGNORECASE)
            if severity_match and not current_finding:
                current_finding = {"severity": severity_match.group(1).lower()}
                continue

            # Look for type markers
            type_match = re.search(r"\b(reward_hack|edge_case|state_corruption|termination_bypass|resource|sandbox)\b", line, re.IGNORECASE)
            if type_match and current_finding:
                current_finding["type"] = type_match.group(1).lower()
                continue

        # Return empty if couldn't parse
        if not findings:
            logger.warning("Could not parse adversarial findings, returning empty list")
        return findings