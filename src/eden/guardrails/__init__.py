"""Cat 15 — Runtime Protection & Guardrails.

Public surface (lazy re-exports so that
``from eden.guardrails import InterventionEngine`` does not
eagerly import the detectors + intervention modules):

* :class:`GuardrailPolicy` (in :mod:`eden.guardrails.policy`)
* :class:`ContentPolicyEnforcer` (in :mod:`eden.guardrails.policy`)
* :class:`PromptInjectionDetector` (in :mod:`eden.guardrails.detectors`)
* :class:`PIIFirewall` (in :mod:`eden.guardrails.detectors`)
* :class:`HallucinationBlocker` (in :mod:`eden.guardrails.detectors`)
* :class:`LLMFirewall` (in :mod:`eden.guardrails.detectors`)
* :class:`InterventionEngine` (in :mod:`eden.guardrails.intervention`)
* :class:`EvalToGuardrailLink` (in :mod:`eden.guardrails.intervention`)
* :class:`InterventionLog` (in :mod:`eden.guardrails.intervention`)
* :class:`GuardrailMetrics` (in :mod:`eden.guardrails.intervention`)

The :mod:`eden.guardrails.policy` module is imported eagerly
because it carries the validation constants + the postgres
helpers that the other two modules depend on.

The route file :mod:`eden.api.routes.intelligence_guardrails`
imports the symbols from this package; the lazy re-exports
mean the route file keeps working unchanged.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .policy import (
    ACTION_RANK,
    VALID_ACTIONS,
    VALID_DIRECTIONS,
    VALID_POLICY_TYPES,
    ContentPolicyEnforcer,
    GuardrailPolicy,
)

__all__ = [
    "GuardrailPolicy",
    "ContentPolicyEnforcer",
    "PromptInjectionDetector",
    "PIIFirewall",
    "HallucinationBlocker",
    "LLMFirewall",
    "InterventionEngine",
    "EvalToGuardrailLink",
    "InterventionLog",
    "GuardrailMetrics",
    "ACTION_RANK",
    "VALID_ACTIONS",
    "VALID_POLICY_TYPES",
    "VALID_DIRECTIONS",
]


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and
# the import spec stay in sync. Adding a new service means
# adding two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "PromptInjectionDetector": (".detectors", "PromptInjectionDetector"),
    "PIIFirewall": (".detectors", "PIIFirewall"),
    "HallucinationBlocker": (".detectors", "HallucinationBlocker"),
    "LLMFirewall": (".detectors", "LLMFirewall"),
    "InterventionEngine": (".intervention", "InterventionEngine"),
    "EvalToGuardrailLink": (".intervention", "EvalToGuardrailLink"),
    "InterventionLog": (".intervention", "InterventionLog"),
    "GuardrailMetrics": (".intervention", "GuardrailMetrics"),
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
