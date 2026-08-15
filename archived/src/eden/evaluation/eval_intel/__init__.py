"""Evaluation Quality Intelligence (Cat 3) — Eval-side package.

Thirteen services that turn raw judge scores + LLM judge
verdicts into actionable intelligence for the operator and
the closed-loop:

* :class:`EvalVersioner` — tag a deployment SHA + prompt
  version with a judge set, and detect regressions vs. the
  previous active version.
* :class:`EvalRegistry` — list all eval versions for an org.
* :class:`FailureClusterer` — group low-score traces by
  ``(judge_name, agent_id, error_category)`` signature.
* :class:`CLHFGenerator` — Galileo CLHF: 2-5 examples → a
  custom eval metric spec.
* :class:`HumanInTheLoopService` — LangSmith-style
  annotation tasks + submissions.
* :class:`PairwiseAnnotationService` — LangSmith-style
  pairwise preference queues + submissions.
* :class:`MultiModalEvaluator` — score ``text``, ``image``,
  and ``audio`` inputs.
* :class:`EvalToGuardrailLink` — Galileo's eval-to-guardrail
  lifecycle: promote a reliable judge into a production
  guardrail with FPR + sample-count gates.
* :class:`SixModalitiesRegistry` — declare one of the six
  Arize-style eval modalities.
* :class:`BooleanCategoricalScore` — Langfuse-style non-
  continuous scores (boolean, categorical).
* :class:`CustomPythonEval` — Langfuse-style user-registered
  Python eval functions.
* :class:`UserFeedbackService` — Langfuse/Lunary-style
  thumbs + rating + comment submission.
* :class:`AutoDatasetBridge` — Braintrust-style auto-curate
  a golden dataset from low-score traces.

A real implementation reads from the existing
``judge_scores`` table (written by
:class:`eden.llmops.judges.runner.JudgeRunner`) and writes to
the 14 Cat 3 tables in migration 020. CLHF, MultiModal, and
BooleanCategorical services also use the existing
:class:`eden.llm.client.OpenRouterClient` for spec
generation.

The package uses **lazy re-exports** so that
``from eden.evaluation.eval_intel import EvalVersioner`` does
not eagerly import the heavy transitive deps (Postgres client,
the shared helpers, the per-service modules). Routes that need
a specific service can rely on the lazy re-export or import
the service module directly:

    from eden.evaluation.eval_intel.versioning import EvalVersioner

See ``docs/observability-gap/03-evaluation-quality-intelligence.md``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

__all__ = [
    "AutoDatasetBridge",
    "BooleanCategoricalScore",
    "CLHFGenerator",
    "CustomPythonEval",
    "EvalRegistry",
    "EvalToGuardrailLink",
    "EvalVersioner",
    "FailureClusterer",
    "HumanInTheLoopService",
    "MultiModalEvaluator",
    "PairwiseAnnotationService",
    "SixModalitiesRegistry",
    "UserFeedbackService",
]


# Lazy re-exports — keep the import graph cheap. The
# TYPE_CHECKING block keeps static type checkers (mypy,
# pyright) happy without importing the implementations at
# runtime.
if TYPE_CHECKING:  # pragma: no cover - import only
    from .annotation import HumanInTheLoopService, PairwiseAnnotationService
    from .clhf import CLHFGenerator
    from .failure_clusters import FailureClusterer
    from .integration import (
        AutoDatasetBridge,
        CustomPythonEval,
        EvalToGuardrailLink,
    )
    from .multimodal import MultiModalEvaluator, SixModalitiesRegistry
    from .scores import BooleanCategoricalScore, UserFeedbackService
    from .versioning import EvalRegistry, EvalVersioner


# Map public name -> (module, attribute) for the lazy
# ``__getattr__``. Centralised so the public surface and the
# import spec stay in sync. Adding a new service means adding
# two lines, not three.
_LAZY_IMPORTS: dict[str, tuple[str, str]] = {
    "AutoDatasetBridge": (".integration", "AutoDatasetBridge"),
    "BooleanCategoricalScore": (".scores", "BooleanCategoricalScore"),
    "CLHFGenerator": (".clhf", "CLHFGenerator"),
    "CustomPythonEval": (".integration", "CustomPythonEval"),
    "EvalRegistry": (".versioning", "EvalRegistry"),
    "EvalToGuardrailLink": (".integration", "EvalToGuardrailLink"),
    "EvalVersioner": (".versioning", "EvalVersioner"),
    "FailureClusterer": (".failure_clusters", "FailureClusterer"),
    "HumanInTheLoopService": (".annotation", "HumanInTheLoopService"),
    "MultiModalEvaluator": (".multimodal", "MultiModalEvaluator"),
    "PairwiseAnnotationService": (".annotation", "PairwiseAnnotationService"),
    "SixModalitiesRegistry": (".multimodal", "SixModalitiesRegistry"),
    "UserFeedbackService": (".scores", "UserFeedbackService"),
}


def __getattr__(name: str) -> Any:
    """PEP 562 lazy attribute access.

    Resolves a public name like ``EvalVersioner`` to the
    implementation in the corresponding submodule. The
    submodule is imported on first access and cached in
    ``sys.modules``, so subsequent accesses are O(1).
    """
    if name in _LAZY_IMPORTS:
        module_name, attr_name = _LAZY_IMPORTS[name]
        from importlib import import_module

        module = import_module(module_name, __name__)
        value = getattr(module, attr_name)
        globals()[name] = value  # cache for next access
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__() -> list[str]:
    """Make ``dir(eden.evaluation.eval_intel)`` show the public
    surface — useful for REPL auto-completion and for the test
    suite's introspection."""
    return sorted(list(globals().keys()) + list(_LAZY_IMPORTS.keys()))
