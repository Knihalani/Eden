"""Optimizer agent — deep code optimization after execution.

Optimizes the generated code for:
1. Performance — vectorization, caching, reduced allocations
2. Efficiency — eliminate redundant computations, reuse structures
3. Quality — cleaner implementation, better patterns
4. Best practices — follow framework idioms

This runs after Executor and before Code Quality checks.
"""

import json
import logging
import re
from typing import Optional

from eden.llm.client import OpenRouterClient, get_llm_client
from eden.config import get_settings
from eden.agents.base import PromptLoader

logger = logging.getLogger(__name__)
settings = get_settings()


class OptimizerAgent(PromptLoader):
    """Optimizer agent that deep-optimizes generated code.

    The Optimizer:
    1. Analyzes code for performance bottlenecks
    2. Applies vectorization and caching where beneficial
    3. Eliminates redundant computations
    4. Reuses data structures to reduce allocations
    5. Improves code clarity and maintainability
    6. Ensures optimizations don't break functionality
    """

    AGENT_NAME = "optimizer"

    SYSTEM_PROMPT = """You are the Optimizer for Eden, an AI-native environment generation system.

Your role is to optimize generated code for performance, efficiency, and quality.
You receive code from the Executor and make it better WITHOUT changing its behavior.

Optimization targets:

1. PERFORMANCE:
   - Vectorize operations using NumPy where possible
   - Cache computed values that don't change between steps
   - Pre-allocate arrays instead of growing them
   - Use in-place operations where safe
   - Avoid unnecessary copies

2. EFFICIENCY:
   - Eliminate redundant computations in step()
   - Move invariant calculations to __init__ or reset()
   - Reuse temporary structures instead of allocating new ones
   - Minimize dict/list lookups in hot paths

3. QUALITY:
   - Replace complex list comprehensions with vectorized alternatives
   - Use more efficient built-ins (enumerate vs range(len()))
   - Simplify boolean expressions
   - Remove dead code

4. FRAMEWORK BEST PRACTICES:
   - Gymnasium: use vectorized obs/reward when available
   - Match the framework's idiomatic patterns
   - Use recommended utilities (self.unwrapped, self.np_random)

CRITICAL: Do NOT change the environment's behavior. The optimized code must:
- Produce identical observations
- Compute identical rewards
- Have identical termination conditions
- Have identical episode dynamics

Output only the optimized code in a code block."""

    def __init__(self, llm_client: Optional[OpenRouterClient] = None):
        super().__init__()
        self.llm = llm_client or get_llm_client()
        self.max_tokens = settings.max_tokens_optimizer
        self.max_turns = settings.max_turns_optimizer
        self._load_prompt()

    async def run(self, state: dict) -> dict:
        """Run the Optimizer agent on generated code.

        Args:
            state: EdenJobState with code from Executor

        Returns:
            dict with optimized code added to state
        """
        job_id = state["job_id"]
        code_history = state.get("code_history", [])
        res = state.get("res")

        logger.info(f"Optimizer running for job {job_id}")

        if not code_history:
            logger.warning(f"No code found in state for job {job_id}")
            return {
                "code_history": [],
                "current_stage": "code_quality",
            }

        current_code = code_history[-1] if code_history else ""

        if not current_code:
            return {
                "code_history": code_history,
                "current_stage": "code_quality",
            }

        # Analyze and optimize
        optimized_code = await self._optimize(current_code, res)

        # Update history with optimized code
        new_history = code_history.copy()
        new_history.append(optimized_code)

        logger.info(f"Optimizer completed for job {job_id}")

        return {
            "code_history": new_history,
            "current_stage": "code_quality",
        }

    async def _optimize(self, code: str, res: Optional[dict] = None) -> str:
        """Perform deep optimization on the code.

        Args:
            code: Current code to optimize
            res: Optional RES for context

        Returns:
            Optimized code string
        """
        # Build context about the environment
        context = ""
        if res:
            meta = res.get("meta", {})
            output_spec = res.get("output_spec", {})
            context = f"""
## ENVIRONMENT CONTEXT
- Framework: {output_spec.get('framework', 'gymnasium')}
- Environment Class: {meta.get('environment_class', 'standard')}
- Reward Type: {res.get('environment', {}).get('reward_structure', {}).get('type', 'dense')}
"""

        prompt = f"""## CURRENT CODE (from Executor)

```python
{code}
```
{context}

---

## OPTIMIZATION TASK

Analyze the code above and optimize for:
1. Performance (vectorization, caching, pre-allocation)
2. Efficiency (eliminate redundant computations)
3. Quality (cleaner implementations, better patterns)

CRITICAL: The optimized code MUST produce identical behavior.
- Same observations
- Same rewards (within floating point precision)
- Same termination conditions
- Same episode dynamics

For each optimization, ensure it doesn't change behavior.
Use numpy.vectorize or numpy operations where applicable.
Cache values that don't change between steps.

Output ONLY the optimized code in a code block."""

        response = self.llm.call(
            agent="optimizer",
            prompt=prompt,
            slot="code",
            system_prompt=self.system_prompt,
            max_tokens=self.max_tokens,
        )

        optimized = self._extract_code(response.content)
        return optimized if optimized else code

    def _extract_code(self, content: str) -> str:
        """Extract code from LLM response."""
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