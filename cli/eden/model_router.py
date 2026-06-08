"""Eden model slot → LiteLLM model name.

Eden operates on *model slots* (semantic roles) rather than concrete
model names. The CLI maps these slots onto the LiteLLM identifiers
the Aider LLM layer expects.

Slots:
    reasoning  - planning, multi-step analysis, /eden-improve passes
    code       - code generation / editing (default in chat)
    fast       - quick lookups, KB summarization
    fallback   - last-resort when primary is unavailable

Aider's ``Model`` constructor consumes any LiteLLM-compatible name,
so this mapping is the only place where "slot" semantics are concrete.
"""

from __future__ import annotations

from typing import Literal

from eden.config import EdenCLIConfig, ModelsConfig

SlotName = Literal["reasoning", "code", "fast", "fallback"]


class ModelRouter:
    """Resolve Eden model slots to LiteLLM model names."""

    def __init__(self, models: ModelsConfig):
        self._models = models

    def resolve(self, slot: SlotName) -> str:
        try:
            return getattr(self._models, slot)
        except AttributeError as exc:
            raise ValueError(f"Unknown model slot: {slot!r}") from exc

    @property
    def reasoning(self) -> str:
        return self._models.reasoning

    @property
    def code(self) -> str:
        return self._models.code

    @property
    def fast(self) -> str:
        return self._models.fast

    @property
    def fallback(self) -> str:
        return self._models.fallback

    def default(self) -> str:
        """Default model for chat (Aider's ``--model`` flag)."""
        return self._models.code

    def for_task(self, task: str) -> str:
        """Pick a slot based on a task label.

        Recognized task labels:
            - "analysis", "plan", "refine", "improve"  → reasoning
            - "edit", "code", "implement"               → code
            - "summary", "lookup", "classify"           → fast
            - anything else                              → code
        """
        t = task.lower()
        if any(k in t for k in ("analysis", "plan", "refine", "improve", "reasoning")):
            return self.reasoning
        if any(k in t for k in ("summary", "lookup", "classify", "fast", "cheap")):
            return self.fast
        if any(k in t for k in ("edit", "code", "implement", "fix", "refactor")):
            return self.code
        return self.code

    def as_dict(self) -> dict[str, str]:
        return {
            "reasoning": self._models.reasoning,
            "code": self._models.code,
            "fast": self._models.fast,
            "fallback": self._models.fallback,
        }


def build_router(config: EdenCLIConfig) -> ModelRouter:
    return ModelRouter(config.models)
