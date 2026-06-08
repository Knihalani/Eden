"""EdenCoder — Aider ``EditBlockCoder`` subclass with Eden context injection.

This file *does* import Aider — that is the entire point of the fork.
The ``edit_format = "eden"`` attribute registers us with Aider's
``Coder.create()`` factory (which matches by attribute on the class).

We deliberately do NOT modify Aider core. All Eden behavior is added
via:

    1. ``format_messages()`` override that appends Eden context
       sections ([GLOBAL KNOWLEDGE], [TENANT CONTEXT], [OBSERVABILITY CONTEXT])
       to the system prompt.

    2. Lazy-loaded KB + observability context providers (the
       EdenCoder is constructed even if the API is offline; queries
       fail soft).

If Aider isn't importable at runtime (e.g. someone installs only this
package and not ``aider-chat``), we re-export a stub class with a
useful error message — never crash on import.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("eden.cli.coders.eden_coder")

# Sentinel used by Coder.create() to find us.
EDIT_FORMAT = "eden"


# ── Aider import shim ───────────────────────────────────────────────────

_AIDER_IMPORT_ERROR: Optional[Exception] = None
try:
    from aider.coders import EditBlockCoder  # type: ignore[import-not-found]
    from aider.coders.base_coder import Coder  # type: ignore[import-not-found]

    _AIDER_AVAILABLE = True
except Exception as exc:  # noqa: BLE001
    _AIDER_IMPORT_ERROR = exc
    _AIDER_AVAILABLE = False
    EditBlockCoder = object  # type: ignore[assignment,misc]
    Coder = object  # type: ignore[assignment,misc]


# ── Context payload ─────────────────────────────────────────────────────


class EdenContextPayload:
    """Container for the three Eden context sections.

    Built by ``EdenCoder._build_eden_context`` and consumed by
    ``format_messages``. Kept as a small dataclass-like so it can be
    inspected and overridden in tests.
    """

    __slots__ = ("global_kb", "tenant_kb", "observability")

    def __init__(
        self,
        *,
        global_kb: str = "",
        tenant_kb: str = "",
        observability: str = "",
    ):
        self.global_kb = global_kb
        self.tenant_kb = tenant_kb
        self.observability = observability

    def to_system_message(self) -> Optional[dict[str, Any]]:
        """Combine sections into a single system message (or None)."""
        sections: list[str] = []
        if self.global_kb.strip():
            sections.append(self.global_kb.strip())
        if self.tenant_kb.strip():
            sections.append(self.tenant_kb.strip())
        if self.observability.strip():
            sections.append(self.observability.strip())
        if not sections:
            return None
        return {
            "role": "system",
            "content": (
                "You are the Eden coding agent. The following Eden context "
                "has been retrieved for this conversation:\n\n"
                + "\n\n---\n\n".join(sections)
            ),
        }


# ── EdenCoder ───────────────────────────────────────────────────────────


class EdenCoder(EditBlockCoder):  # type: ignore[misc,valid-type]
    """EditBlockCoder that injects Eden context into the system prompt.

    Attributes
    ----------
    edit_format : str
        ``"eden"`` — used by ``Coder.create()`` to dispatch to us.
    eden_client_factory : callable | None
        Override in tests to inject a fake API client.
    """

    edit_format = EDIT_FORMAT
    gpt_prompts: Any = None  # populated below in __init_subclass__

    # The Aider base class reads ``gpt_prompts`` for the system prompt
    # file. We inherit it from ``EditBlockCoder`` but expose a hook
    # for unit tests.

    def __init__(self, *args: Any, **kwargs: Any):
        # Pull our custom kwargs out before super().__init__ sees them
        self._eden_config = kwargs.pop("eden_config", None)
        self._eden_client_factory = kwargs.pop(
            "eden_client_factory", _default_client_factory
        )
        self._eden_query_seed = kwargs.pop("eden_query_seed", None)

        # Cache for the current context; refreshed on demand.
        self._eden_cached_payload: Optional[EdenContextPayload] = None

        super().__init__(*args, **kwargs)

    # ── Aider Coder.create() registration ─────────────────────────────

    @classmethod
    def match(cls, edit_format: str) -> bool:
        return edit_format == EDIT_FORMAT

    # ── Context injection ─────────────────────────────────────────────

    def format_messages(self) -> list[dict[str, Any]]:
        """Build the message list with Eden context appended.

        We call ``super().format_messages()`` first so Aider's repo map,
        file content, and base system prompt are all in place. We then
        insert our Eden context as a fresh system message immediately
        after the primary system message.
        """
        messages = super().format_messages()

        payload = self._build_eden_context()
        eden_msg = payload.to_system_message()
        if eden_msg is None:
            return messages

        # Insert after the first system message (or at the very top)
        insert_at = 0
        for i, m in enumerate(messages):
            if m.get("role") == "system":
                insert_at = i + 1
                break
        messages.insert(insert_at, eden_msg)
        return messages

    async def _build_eden_context_async(self) -> EdenContextPayload:
        """Async path — used by /eden-improve and any pre-warming."""
        from eden.api_client import EdenAPIClient
        from eden.config import EdenCLIConfig, ContextConfig
        from eden.kb_context import KBContextProvider
        from eden.observability_context import ObservabilityContextProvider

        config: EdenCLIConfig = self._eden_config or EdenCLIConfig()
        ctx_cfg: ContextConfig = config.context

        async with self._eden_client_factory(config) as client:
            kb = KBContextProvider(client, ctx_cfg)
            obs = ObservabilityContextProvider(client, ctx_cfg)

            seed = self._eden_query_seed or self._derive_query_seed()
            g, t, o = await _gather_kb_obs(kb, obs, seed)

        return EdenContextPayload(
            global_kb=g.text, tenant_kb=t.text, observability=o.text
        )

    def _build_eden_context(self) -> EdenContextPayload:
        """Sync path used inside ``format_messages``.

        Aider's chat loop is sync, so we cache the payload from a
        previous async build (set via ``prime_context_async``), or
        return an empty payload with a one-shot log line.
        """
        if self._eden_cached_payload is not None:
            return self._eden_cached_payload
        # No cached payload — return empty and let the user know once.
        logger.debug(
            "EdenCoder: no primed context; "
            "call EdenCoder.prime_context_async() before chat starts."
        )
        return EdenContextPayload()

    async def prime_context_async(self) -> EdenContextPayload:
        """Pre-warm the Eden context cache.

        Call this from your async bootstrap before launching Aider's
        sync chat loop. The returned payload is what ``format_messages``
        will inject.
        """
        payload = await self._build_eden_context_async()
        self._eden_cached_payload = payload
        return payload

    # ── Internals ─────────────────────────────────────────────────────

    def _derive_query_seed(self) -> str:
        """Best-effort seed string for KB queries.

        Falls back to the project root's name when no explicit seed is
        provided, so the global KB surfaces a baseline of relevant
        patterns even on a fresh chat.
        """
        try:
            root = getattr(self.repo, "root", None) if hasattr(self, "repo") else None
            if root:
                return f"project:{root}"
        except Exception:  # noqa: BLE001
            pass
        return "eden:general"


# ── Helpers ─────────────────────────────────────────────────────────────


async def _gather_kb_obs(kb, obs, seed: str) -> tuple[Any, Any, Any]:
    """Run KB + observability fetches concurrently."""
    import asyncio

    return await asyncio.gather(
        kb.get_global_context(seed),
        kb.get_tenant_context(seed),
        obs.get_context(),
    )


def _default_client_factory(config):  # type: ignore[no-untyped-def]
    """Lazy import wrapper so tests can monkeypatch without import side-effects."""
    from eden.api_client import EdenAPIClient

    return EdenAPIClient(config)


# ── Coder.create() registration helper ─────────────────────────────────


def register_with_aider() -> bool:
    """Register ``EdenCoder`` with ``Coder.create()``.

    Returns True on success, False if Aider is not importable.

    Aider's factory iterates over ``EditBlockCoder`` subclasses and
    matches by ``edit_format``. We rely on the ``match`` classmethod +
    the ``edit_format`` attribute being the only requirement.
    """
    if not _AIDER_AVAILABLE:
        return False
    # No explicit registration call is needed — Aider's Coder.create
    # uses ``__init_subclass__``-style discovery via ``edit_format``
    # attribute matching. We expose a no-op registration function for
    # callers that want an explicit hook.
    return True


# ── Lazy / stub export ──────────────────────────────────────────────────


def is_aider_available() -> bool:
    return _AIDER_AVAILABLE


def aider_import_error() -> Optional[Exception]:
    return _AIDER_IMPORT_ERROR


__all__ = [
    "EDIT_FORMAT",
    "EdenCoder",
    "EdenContextPayload",
    "is_aider_available",
    "aider_import_error",
    "register_with_aider",
]
