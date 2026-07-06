"""PR agent — coding-agent layer.

The agent package ships four implementations:

* :class:`EdenPatchAgent` — the production default when
  an LLM provider is configured. Real patch generation via
  Eden's existing :class:`eden.code_change.patch_generator.
  PatchGenerator` + :class:`eden.optimization.model_router.
  ModelRouter`. In-process, bounded (timeout + cost cap),
  cost-effective (T2 tier selection is reused from the
  existing pipeline).
* :class:`LocalCodingAgent` — bulletproof fallback. Tries
  the OpenHands Python SDK / CLI locally first (when
  installed), then the deterministic
  :class:`ScriptedCodingAgent`, then a structured
  ``report_only`` payload. Never returns ``None`` —
  bulletproof by design.
* :class:`OpenHandsPRAgent` — optional hosted upgrade.
  Activates only when ``OPENHANDS_API_KEY`` is set.
* :class:`LocalPRAgent` — no-LLM fallback. Always returns
  ``report_only``; never fabricates a diff.

The factory :func:`get_default_pr_agent` picks the right
implementation based on environment variables + the
availability of Eden's ModelRouter.

Every agent has one method:

* :meth:`PRAgent.run` — given the PR candidate +
  graph context + discipline decision, produce a
  structured payload:

  * ``{"kind": "pr_ready", "diff": ..., "title": ..., "body": ...}``
    — the agent produced a high-confidence patch. The
    caller may open the PR.
  * ``{"kind": "draft_pr", ...}`` — confidence is lower;
    the caller should open as a draft.
  * ``{"kind": "report_only", "reason": ...}`` — the
    agent decided not to attempt a code change. The
    caller should write a report to the user instead
    of a PR.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "EdenPatchAgent",
    "LocalCodingAgent",
    "LocalPRAgent",
    "OpenHandsPRAgent",
    "OpenHandsLocalAgent",
    "PRAgent",
    "PRCandidate",
    "PRResult",
    "ScriptedCodingAgent",
    "get_default_pr_agent",
]


if TYPE_CHECKING:  # pragma: no cover - import only
    from .eden_patch_agent import EdenPatchAgent
    from .factory import get_default_pr_agent
    from .local import LocalPRAgent
    from .local_coder import LocalCodingAgent, OpenHandsLocalAgent, ScriptedCodingAgent
    from .openhands import OpenHandsPRAgent, PRCandidate, PRResult
    from .protocol import PRAgent


_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "EdenPatchAgent": (".eden_patch_agent", "EdenPatchAgent"),
    "LocalCodingAgent": (".local_coder", "LocalCodingAgent"),
    "LocalPRAgent": (".local", "LocalPRAgent"),
    "OpenHandsPRAgent": (".openhands", "OpenHandsPRAgent"),
    "OpenHandsLocalAgent": (".local_coder", "OpenHandsLocalAgent"),
    "PRAgent": (".protocol", "PRAgent"),
    "PRCandidate": (".openhands", "PRCandidate"),
    "PRResult": (".openhands", "PRResult"),
    "ScriptedCodingAgent": (".local_coder", "ScriptedCodingAgent"),
    "get_default_pr_agent": (".factory", "get_default_pr_agent"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access."""
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module
        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
