"""Agent mixin for dynamic prompt loading from Knowledge Base.

Provides PromptLoader mixin that enables agents to load their system prompts
from the prompt_versions table instead of using hardcoded constants.
"""

import inspect
import logging
from typing import Optional, ClassVar

from eden.kb.prompt_versions.client import get_prompt_versions_client

logger = logging.getLogger(__name__)


class PromptLoader:
    """Mixin class that enables dynamic prompt loading from KB.

    Agents using this mixin will load their SYSTEM_PROMPT from the
    prompt_versions table at initialization time, with fallback to
    the class-level SYSTEM_PROMPT constant.

    Usage:
        class MyAgent(PromptLoader):
            SYSTEM_PROMPT = "Default prompt text..."
            AGENT_NAME = "my_agent"  # Required class variable

            def __init__(self, ...):
                super().__init__(...)
                self._load_prompt()
    """

    AGENT_NAME: ClassVar[str] = ""  # Must be set by subclass

    _system_prompt: Optional[str] = None
    _prompt_version: Optional[int] = None
    _prompt_loaded: bool = False

    def _load_prompt(self) -> None:
        """Load the active system prompt from prompt_versions table.

        Falls back to class-level SYSTEM_PROMPT if KB is unavailable
        or no active prompt exists.

        This method is sync (called from ``__init__``). The KB client
        exposes an async ``get_active_prompt``; if the call returns a
        coroutine (e.g. a real or mocked async function) we can't
        ``await`` it from sync context, so we silently fall back to the
        class-level default. Agents that need a real KB-loaded prompt
        should call ``await agent.a_load_prompt()`` from an async
        context after construction.
        """
        if not self.AGENT_NAME:
            logger.warning(f"{self.__class__.__name__} has no AGENT_NAME, using default prompt")
            self._system_prompt = getattr(self, "SYSTEM_PROMPT", "")
            return

        try:
            client = get_prompt_versions_client()

            # Try to get active prompt from KB
            prompt_data = client.get_active_prompt(self.AGENT_NAME)

            # The KB client is async; from a sync __init__ we can't
            # ``await`` the coroutine. Detect coroutines and fall back
            # to the class-level default. Async callers should use
            # ``a_load_prompt`` instead.
            if inspect.isawaitable(prompt_data):
                # Close the unawaited coroutine so Python's runtime
                # doesn't emit a "coroutine was never awaited" warning
                # during garbage collection.
                try:
                    prompt_data.close()
                except Exception:  # pragma: no cover - best-effort
                    pass
                self._system_prompt = getattr(self, "SYSTEM_PROMPT", "")
                self._prompt_version = None
                self._prompt_loaded = False
                return

            if prompt_data:
                self._system_prompt = prompt_data["system_prompt"]
                self._prompt_version = prompt_data["version"]
                self._prompt_loaded = True
                logger.info(
                    f"Loaded prompt for {self.AGENT_NAME} from KB "
                    f"(version {self._prompt_version})"
                )
            else:
                # Fall back to class constant
                self._system_prompt = getattr(self, "SYSTEM_PROMPT", "")
                self._prompt_version = None
                self._prompt_loaded = False
                logger.debug(
                    f"No active prompt in KB for {self.AGENT_NAME}, using default"
                )

        except Exception as e:
            # KB unavailable or error - fall back to class constant
            logger.warning(
                f"Failed to load prompt from KB for {self.AGENT_NAME}: {e}. "
                "Using default."
            )
            self._system_prompt = getattr(self, "SYSTEM_PROMPT", "")
            self._prompt_version = None
            self._prompt_loaded = False

    async def a_load_prompt(self) -> None:
        """Async variant of :meth:`_load_prompt`.

        Use this from async contexts (e.g. FastAPI handlers) when you
        want the KB-loaded prompt, not the class-level default.
        """
        if not self.AGENT_NAME:
            return
        try:
            client = get_prompt_versions_client()
            prompt_data = await client.get_active_prompt(self.AGENT_NAME)
            if prompt_data:
                self._system_prompt = prompt_data["system_prompt"]
                self._prompt_version = prompt_data["version"]
                self._prompt_loaded = True
        except Exception as e:  # pragma: no cover - best-effort
            logger.debug(f"a_load_prompt: KB unavailable for {self.AGENT_NAME}: {e}")

    @property
    def system_prompt(self) -> str:
        """Get the current system prompt.

        Returns:
            The active system prompt string.
        """
        if self._system_prompt is None:
            self._load_prompt()
        return self._system_prompt or ""

    @property
    def prompt_version(self) -> Optional[int]:
        """Get the prompt version loaded from KB.

        Returns:
            Version number if loaded from KB, None if using default.
        """
        if self._system_prompt is None:
            self._load_prompt()
        return self._prompt_version

    @property
    def is_using_kb_prompt(self) -> bool:
        """Check if currently using a prompt from KB.

        Returns:
            True if prompt was loaded from KB, False if using default.
        """
        if self._system_prompt is None:
            self._load_prompt()
        return self._prompt_loaded

    def reload_prompt(self) -> None:
        """Reload prompt from KB, clearing any cached value."""
        self._system_prompt = None
        self._prompt_version = None
        self._prompt_loaded = False
        self._load_prompt()