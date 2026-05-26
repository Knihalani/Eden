"""Executor agent — writes complete, runnable code from the RES.

Takes the verified RES and produces implementation code with no design decisions,
only implementation of the spec.

Phase F.3: Multi-section generation for complex environments, Skill Library integration,
and self-review before passing to code_quality.
"""

import json
import logging
import re
from typing import Optional

from eden.llm.client import OpenRouterClient
from eden.config import get_settings
from eden.agents.base import PromptLoader
from eden.kb.procedural.client import get_procedural_client

logger = logging.getLogger(__name__)
settings = get_settings()

COMPLEX_ENV_CLASSES = {"adversarial", "multi_agent", "curriculum"}
# Thresholds for triggering multi-section
REWARD_COMPONENTS_THRESHOLD = 3
DIFFICULTY_AXES_THRESHOLD = 3


def _is_complex_environment(res: dict) -> bool:
    """Determine if environment needs multi-section generation."""
    meta = res.get("meta", {})
    env_class = meta.get("environment_class", "")
    reward_components = len(
        res.get("environment", {}).get("reward_structure", {}).get("components", [])
    )
    difficulty_axes = len(
        res.get("environment", {}).get("difficulty_parameters", {}).get("axes", [])
    )
    return (
        env_class in COMPLEX_ENV_CLASSES
        or reward_components >= REWARD_COMPONENTS_THRESHOLD
        or difficulty_axes >= DIFFICULTY_AXES_THRESHOLD
    )


# Output mode templates for different environment types
OUTPUT_MODES = {
    "gymnasium_mode": """# Gymnasium-compatible environment
import gymnasium as gym
from gymnasium import spaces
import numpy as np

class {class_name}(gym.Env):
    metadata = {{'render_modes': [], 'render_fps': 30}}

    def __init__(self, {init_params}):
        super().__init__()
        {space_definitions}

    def reset(self, seed=None, options=None):
        {reset_body}
        return self.observation, {{}}

    def step(self, action):
        {step_body}
        return self.observation, self.reward, terminated, truncated, {{}}

    def close(self):
        {close_body}
""",
    "pettingzoo_mode": """# PettingZoo environment
from pettingzoo import AECEnv, ParallelEnv
from pettingzoo.utils import agent_selector
import numpy as np

class {class_name}(AECEnv):
    metadata = {{'render_modes': [], 'name': '{env_name}'}}

    def __init__(self, {init_params}):
        super().__init__()
        {space_definitions}
        {agent_definitions}

    def reset(self, seed=None, options=None):
        {reset_body}

    def step(self, action):
        {step_body}
""",
    "llm_sandbox_mode": """# Text-based interactive environment for LLM agents
class {class_name}:
    def __init__(self, {init_params}):
        {init_body}

    def reset(self):
        {reset_body}
        return self.get_observation()

    def step(self, action: str):
        {step_body}
        return self.get_observation(), self.reward, self.done, {{}}

    def get_observation(self) -> str:
        {observation_body}
""",
}


class ExecutorAgent(PromptLoader):
    """Executor agent that produces code from the verified RES.

    The Executor:
    1. Queries procedural memory for similar past implementations
    2. Applies relevant Skill Library entries
    3. Generates code in structured sections
    4. Self-reviews for RES compliance
    5. Documents all public methods
    """

    AGENT_NAME = "executor"

    SYSTEM_PROMPT = """You are the Executor for Eden, an AI-native environment generation system.

Your role is to write COMPLETE, RUNNABLE code from the Refined Environment Spec (RES).
NO design decisions — only implementation of the spec.

For each code generation:
1. Query procedural memory (Skill Library) for similar implementations
2. Apply relevant best practices and patterns
3. Generate in structured sections (skeleton -> state -> obs -> actions -> reward -> termination -> helpers)
4. Self-review: all RES elements implemented, no stubs, all edge cases handled
5. Document: docstrings on all public methods, reward rationale inline

Output mode templates are provided for gymnasium, pettingzoo, and llm_sandbox modes.
Use the one matching the RES output_spec.

Code requirements:
- All imports must be valid
- All methods must be implemented (no stubs/TODOs)
- Observation and action spaces must match declared spec exactly
- Reward function must match pseudocode exactly
- Termination logic must match spec exactly
- All edge cases from spec must be handled

Output the complete code as a string in a code block."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or OpenRouterClient()
        self.max_tokens = settings.max_tokens_executor
        self.max_turns = settings.max_turns_executor
        self._load_prompt()

    async def run(self, state: dict) -> dict:
        """Run the Executor agent on the verified RES.

        Args:
            state: EdenJobState with res from Refiner

        Returns:
            dict with code added to state
        """
        job_id = state["job_id"]
        res = state.get("res")

        logger.info(f"Executor running for job {job_id}")

        if not res:
            logger.error(f"No RES found in state for job {job_id}")
            return {
                "code_history": ["# Error: No RES found"],
                "current_stage": "human_review",
            }

        # Branch on complexity
        if _is_complex_environment(res):
            logger.info(f"Job {job_id}: complex environment detected, using multi-section generation")
            result = await self._run_multi_section(res)
        else:
            logger.info(f"Job {job_id}: simple environment detected, using single-pass generation")
            result = await self._run_single_pass(res)

        # Self-review pass before moving to code_quality
        code = result.get("code_history", [""])[0]
        reviewed_code = await self._self_review(code, res)
        result["code_history"] = [reviewed_code]

        return result

    async def _run_single_pass(self, res: dict) -> dict:
        """Single-pass generation for simple environments.

        Actually queries Skill Library and uses OUTPUT_MODES template as guidance.
        """
        logger.info(f"Executor single-pass: querying Skill Library")
        # Query Skill Library for relevant patterns
        skill_context = await self._query_skill_library(res)

        # Get output mode template
        output_mode = res.get("output_spec", {}).get("output_mode", "gymnasium_mode")
        template = OUTPUT_MODES.get(output_mode, OUTPUT_MODES["gymnasium_mode"])

        # Build prompt with skill context and template
        prompt = self._build_single_pass_prompt(res, skill_context, template)

        logger.info(f"Executor single-pass: generating code")
        # Make LLM call
        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        # Parse code from response
        code = self._extract_code(response.content)
        logger.info(f"Executor single-pass: code generated ({len(code)} chars)")

        return {
            "code_history": [code],
            "current_stage": "code_quality",
        }

    async def _run_multi_section(self, res: dict) -> dict:
        """Multi-section generation for complex environments.

        Seven structured passes as specified in Phase F.3.
        """
        sections = {}
        skill_context = await self._query_skill_library(res)

        logger.info(f"Job multi-section generation: starting 7-pass pipeline")

        # Pass 1: Skeleton — class structure, required methods, type annotations
        logger.info(f"Multi-section pass 1/7: skeleton")
        sections["skeleton"] = await self._generate_skeleton(res, skill_context)

        # Pass 2: State management — observation/action/reward space definitions
        logger.info(f"Multi-section pass 2/7: state")
        sections["state"] = await self._generate_state(res, sections["skeleton"], skill_context)

        # Pass 3: Core implementation — step(), reset(), utility methods
        logger.info(f"Multi-section pass 3/7: core")
        sections["core"] = await self._generate_core(res, sections["skeleton"], sections["state"], skill_context)

        # Pass 4: Reward computation — all reward components
        logger.info(f"Multi-section pass 4/7: reward")
        sections["reward"] = await self._generate_reward(res, sections["skeleton"], sections["state"], skill_context)

        # Pass 5: Termination — all conditions handled
        logger.info(f"Multi-section pass 5/7: termination")
        sections["termination"] = await self._generate_termination(res, sections["skeleton"], sections["state"], skill_context)

        # Pass 6: Helpers — utility functions
        logger.info(f"Multi-section pass 6/7: helpers")
        sections["helpers"] = await self._generate_helpers(res, sections["skeleton"], sections["state"], skill_context)

        # Pass 7: Integration synthesis — final wiring, tests
        logger.info(f"Multi-section pass 7/7: integration")
        sections["integration"] = await self._generate_integration(
            res, sections, skill_context
        )

        # Synthesize final code from all sections
        code = await self._synthesize(sections, res, skill_context)

        logger.info(f"Multi-section generation: completed all 7 passes")

        return {
            "code_history": [code],
            "current_stage": "code_quality",
        }

    async def _query_skill_library(self, res: dict) -> dict:
        """Query Skill Library for similar implementations.

        Returns context dict with relevant skill entries for the generation prompt.
        """
        meta = res.get("meta", {})
        output_spec = res.get("output_spec", {})
        env_class = meta.get("environment_class", "")
        framework = output_spec.get("framework", "")
        reward_type = res.get("environment", {}).get("reward_structure", {}).get("type", "")

        try:
            procedural = get_procedural_client()

            # Try vector search first
            skills = await procedural.search_by_embedding(
                query_vector=self._res_embedding(res),
                env_class=env_class,
                framework=framework,
                limit=5,
            )

            # Fall back to filtered list if vector search yields nothing
            if not skills:
                skills = await procedural.list(
                    env_class=env_class,
                    framework=framework,
                    archivist_reviewed=True,
                    limit=5,
                )

            logger.info(f"Retrieved {len(skills)} skills from Skill Library")
            return {
                "skills": skills,
                "env_class": env_class,
                "framework": framework,
                "reward_type": reward_type,
            }
        except Exception as e:
            logger.warning(f"Skill Library query failed: {e}")
            return {"skills": [], "env_class": env_class, "framework": framework, "reward_type": reward_type}

    def _res_embedding(self, res: dict) -> list[float]:
        """Generate a simple embedding from RES for Skill Library search."""
        # Simple bag-of-words embedding for now
        text = json.dumps(res)
        # Truncate to reasonable size
        text = text[:2000]
        # Use character counts as pseudo-embedding (128 dim)
        vec = [0.0] * 128
        for i, c in enumerate(text):
            vec[i % 128] += ord(c)
        # Normalize
        magnitude = sum(v * v for v in vec) ** 0.5
        if magnitude > 0:
            vec = [v / magnitude for v in vec]
        return vec

    async def _generate_skeleton(self, res: dict, skill_context: dict) -> str:
        """Pass 1: Generate class skeleton with required methods and type annotations."""
        prompt = f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## PASS 1: SKELETON GENERATION

Generate only the class skeleton for this environment. Include:
1. All required imports (framework, spaces, numpy, etc.)
2. Class definition with correct base class
3. All required method signatures with type annotations (no implementation)
4. Metadata class attribute
5. __init__ signature with all parameters

Use the OUTPUT_MODES template structure for the framework type in the RES.
Output ONLY the skeleton code, no implementation beyond signatures."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )
        return self._extract_code(response.content)

    async def _generate_state(
        self, res: dict, skeleton: str, skill_context: dict
    ) -> str:
        """Pass 2: Generate state management — observation/action/reward space definitions."""
        prompt = f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## PREVIOUS PASS: SKELETON

```python
{skeleton}
```

---

## PASS 2: STATE MANAGEMENT

Using the skeleton above, now generate ONLY the state management section:
1. __init__ body — space definitions with bounds and shapes
2. Instance variable declarations for all state
3. Property definitions for spaces
4. _get_obs() helper if needed

Keep it to state management only — no step() logic."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )
        return self._extract_code(response.content)

    async def _generate_core(
        self, res: dict, skeleton: str, state: str, skill_context: dict
    ) -> str:
        """Pass 3: Generate core implementation — step(), reset(), utility methods."""
        prompt = f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## PREVIOUS PASSES: SKELETON + STATE

### Skeleton:
```python
{skeleton}
```

### State:
```python
{state}
```

---

## PASS 3: CORE IMPLEMENTATION

Generate ONLY the core methods (no reward computation):
1. reset() — full implementation with seed handling
2. step() — action processing and state update (no reward calculation)
3. Any utility methods needed by step/reset

Implement the complete reward calculation in this pass - do NOT use placeholders.
The reward must be fully implemented according to the reward_structure spec.
Include docstrings on all methods."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )
        return self._extract_code(response.content)

    async def _generate_reward(
        self, res: dict, skeleton: str, state: str, skill_context: dict
    ) -> str:
        """Pass 4: Generate reward computation — all reward components."""
        reward_spec = res.get("environment", {}).get("reward_structure", {})
        prompt = f"""## REWARD SPECIFICATION

{json.dumps(reward_spec, indent=2)}

---

## CONTEXT: SKELETON + STATE

### Skeleton:
```python
{skeleton}
```

### State:
```python
{state}
```

---

## PASS 4: REWARD COMPUTATION

Generate ONLY reward-related code:
1. _compute_reward() method with all reward components from the spec
2. Each component as a separate calculation with inline comment explaining rationale
3. Final reward = sum of weighted components (as per spec)
4. Any shaping helpers if potential-based reward shaping is used

Ensure bounds match the declared reward structure exactly.
Include inline comments explaining each component's contribution."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )
        return self._extract_code(response.content)

    async def _generate_termination(
        self, res: dict, skeleton: str, state: str, skill_context: dict
    ) -> str:
        """Pass 5: Generate termination logic — all conditions handled."""
        episode_spec = res.get("environment", {}).get("episode_dynamics", {})
        prompt = f"""## EPISODE DYNAMICS SPEC

{json.dumps(episode_spec, indent=2)}

---

## CONTEXT: SKELETON + STATE

### Skeleton:
```python
{skeleton}
```

### State:
```python
{state}
```

---

## PASS 5: TERMINATION LOGIC

Generate ONLY termination-related code:
1. _is_terminated() method checking all termination conditions from spec
2. _is_truncated() method checking truncation (time limits, etc.)
3. Any helper methods for termination detection
4. Max steps tracking logic

Each condition should be checked in order of priority as specified."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )
        return self._extract_code(response.content)

    async def _generate_helpers(
        self, res: dict, skeleton: str, state: str, skill_context: dict
    ) -> str:
        """Pass 6: Generate helper functions and utilities."""
        prompt = f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## CONTEXT: SKELETON + STATE + CORE

### Skeleton:
```python
{skeleton}
```

### State:
```python
{state}
```

---

## PASS 6: HELPERS

Generate ONLY utility functions and helper methods:
1. Any seeding helpers (seed() method)
2. Observation normalization helpers
3. State validation helpers
4. Any domain-specific helper methods needed

Keep it focused on utilities — no core logic."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )
        return self._extract_code(response.content)

    async def _generate_integration(
        self, res: dict, sections: dict, skill_context: dict
    ) -> str:
        """Pass 7: Integration synthesis — final wiring and any missing pieces."""
        prompt = f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## ALL PREVIOUS SECTIONS

### skeleton:
```python
{sections.get("skeleton", "")}
```

### state:
```python
{sections.get("state", "")}
```

### core:
```python
{sections.get("core", "")}
```

### reward:
```python
{sections.get("reward", "")}
```

### termination:
```python
{sections.get("termination", "")}
```

### helpers:
```python
{sections.get("helpers", "")}
```

---

## PASS 7: INTEGRATION SYNTHESIS

Synthesize all sections into a complete, runnable environment file.
1. Wire reward calls into step()
2. Wire termination checks into step()
3. Ensure all imports are present and valid
4. Add any missing glue code
5. Verify all RES requirements are met

Output the COMPLETE, INTEGRATED file ready to run."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )
        return self._extract_code(response.content)

    async def _synthesize(self, sections: dict, res: dict, skill_context: dict) -> str:
        """Final synthesis: combine all sections into complete code.

        If integration pass succeeded, use it. Otherwise fall back to combining
        sections in order.
        """
        # If integration succeeded, it should be the complete file
        integration = sections.get("integration", "")
        if integration and "class " in integration and "def step" in integration:
            return integration

        # Fall back: combine sections in order
        parts = [
            sections.get("skeleton", ""),
            sections.get("state", ""),
            sections.get("core", ""),
            sections.get("reward", ""),
            sections.get("termination", ""),
            sections.get("helpers", ""),
        ]
        return "\n\n".join(p for p in parts if p)

    async def _self_review(self, code: str, res: dict) -> str:
        """Self-review pass: verify code matches RES before moving to code_quality.

        Checks:
        - All RES elements are implemented
        - No stubs or TODOs remain
        - Edge cases handled
        - All required methods present with correct signatures
        """
        prompt = f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## GENERATED CODE TO REVIEW

```python
{code}
```

---

## SELF-REVIEW

Review the generated code against the RES above. Check:
1. All required methods (reset, step, close, etc.) are present with correct signatures
2. Observation and action spaces match declared spec
3. Reward function implements all components from the spec
4. Termination logic handles all specified conditions
5. No stubs, TODOs, or placeholders remain
6. All imports are valid and standard

If issues found:
- Fix them directly in the code
- Return the corrected code

If code is complete and correct:
- Return it unchanged

Output the reviewed code in a code block."""

        response = self.llm.call(
            agent="executor",
            prompt=prompt,
            slot="code",
            system_prompt="You are a code reviewer. Be thorough. Fix any issues found.",
            max_tokens=self.max_tokens,
        )
        reviewed = self._extract_code(response.content)
        return reviewed if reviewed else code

    def _build_single_pass_prompt(
        self, res: dict, skill_context: dict, template: str
    ) -> str:
        """Build prompt for single-pass generation with Skill Library context."""
        # Build skill context string
        skills = skill_context.get("skills", [])
        skill_str = ""
        if skills:
            skill_str = "## RELEVANT SKILL LIBRARY ENTRIES\n\n"
            for skill in skills[:3]:
                skill_str += f"### {skill.get('name', 'unnamed')}\n"
                skill_str += f"{skill.get('description', '')}\n"
                skill_str += f"```python\n{skill.get('code_template', '')}\n```\n\n"

        return f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

{skill_str}

---

## OUTPUT MODE TEMPLATE (use as structural guidance)

```python
{template}
```

---

## YOUR TASK

Generate complete, runnable code that implements the RES above using the template structure.

Requirements:
- All imports must be valid and standard
- All methods must be fully implemented (no stubs, no TODOs)
- Observation and action spaces must match the declared spec exactly
- Reward function must match the pseudocode exactly
- Termination logic must match the spec exactly
- All edge cases from the spec must be handled
- Include docstrings on all public methods
- Include inline comments explaining reward rationale

Output the complete code as a string in a code block."""

    def _build_execution_prompt(self, res: dict) -> str:
        """Build the execution prompt from the RES."""
        return f"""## REFINED ENVIRONMENT SPEC (RES)

{json.dumps(res, indent=2)}

---

## YOUR TASK

Generate complete, runnable code that implements the RES above.

Requirements:
- All imports must be valid and standard
- All methods must be fully implemented (no stubs, no TODOs)
- Observation and action spaces must match the declared spec exactly
- Reward function must match the pseudocode exactly
- Termination logic must match the spec exactly
- All edge cases from the spec must be handled
- Include docstrings on all public methods
- Include inline comments explaining reward rationale

Output the complete code as a string in a code block."""

    def _extract_code(self, content: str) -> str:
        """Extract code from LLM response."""
        import re

        # Try to extract from code blocks
        code_match = re.search(r"```(?:python)?\s*(.*?)\s*```", content, re.DOTALL)
        if code_match:
            return code_match.group(1).strip()

        # Try to find any code-like content
        lines = content.split("\n")
        code_lines = []
        in_code = False
        for line in lines:
            if "```" in line:
                in_code = not in_code
                continue
            if in_code or (line.startswith("import ") or line.startswith("class ") or line.startswith("def ")):
                code_lines.append(line)

        if code_lines:
            return "\n".join(code_lines)

        return content