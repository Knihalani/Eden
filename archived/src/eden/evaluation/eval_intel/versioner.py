"""Backwards-compat shim for the original Phase-0 stub module.

The 13 Eval Quality services were originally declared in a
single ``versioner.py`` file as stub-only implementations.
They have now been graduated to real implementations and
split across 7 sibling modules:

* :class:`EvalVersioner`, :class:`EvalRegistry` →
  :mod:`.versioning`
* :class:`FailureClusterer` → :mod:`.failure_clusters`
* :class:`CLHFGenerator` → :mod:`.clhf`
* :class:`HumanInTheLoopService`, :class:`PairwiseAnnotationService`
  → :mod:`.annotation`
* :class:`MultiModalEvaluator`, :class:`SixModalitiesRegistry`
  → :mod:`.multimodal`
* :class:`BooleanCategoricalScore`, :class:`UserFeedbackService`
  → :mod:`.scores`
* :class:`EvalToGuardrailLink`, :class:`CustomPythonEval`,
  :class:`AutoDatasetBridge` → :mod:`.integration`

This file exists so external code that imports
``from eden.evaluation.eval_intel.versioner import ...``
continues to work without changes. New code should import
from :mod:`eden.evaluation.eval_intel` (the package itself,
which uses lazy re-exports) or from the sibling modules
directly.

The router ``src/eden/api/routes/intelligence_eval.py`` was
updated to import from the package, so this shim is purely
for external backwards compat.
"""

from __future__ import annotations

# Re-export every public service class from the new home
# modules. The ``__all__`` list mirrors the package's
# ``__all__`` so ``from versioner import *`` also works.
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
