"""Register the 7 new Cat 3 judges into the global JudgeRegistry.

Importing this module has the side-effect of populating
``JudgeRegistry`` with:
* ``GroundednessJudge`` (Cat 3 standard)
* ``RelevanceJudge`` (Cat 3 standard)
* ``SafetyJudge`` (Cat 3 standard)
* ``SatisfactionJudge`` (Cat 3 standard)
* ``ActionCompletionJudge`` (Galileo Luna-2)
* ``ToolSelectionQualityJudge`` (Galileo Luna-2)
* ``ReasoningCoherenceJudge`` (Galileo Luna-2)

Wired into the lifespan in ``src/eden/api/app.py`` so the new
judges start scoring production events as soon as the app
boots.

The 3 existing judges (``HallucinationJudge``, ``CorrectnessJudge``,
``ToneJudge``) are already registered by
``src/eden/llmops/judges/registry.py``; this module does not
re-register them.
"""

from __future__ import annotations

import logging

from .action_completion import ActionCompletionJudge
from .groundedness import GroundednessJudge
from .reasoning_coherence import ReasoningCoherenceJudge
from .registry import JudgeRegistry
from .relevance import RelevanceJudge
from .safety import SafetyJudge
from .satisfaction import SatisfactionJudge
from .tool_selection_quality import ToolSelectionQualityJudge

logger = logging.getLogger(__name__)


def register_intelligence_judges(registry: JudgeRegistry | None = None) -> int:
    """Register the 7 Cat 3 judges. Returns the count newly added."""
    registry = registry or JudgeRegistry()
    new_judges = [
        GroundednessJudge(),
        RelevanceJudge(),
        SafetyJudge(),
        SatisfactionJudge(),
        ActionCompletionJudge(),
        ToolSelectionQualityJudge(),
        ReasoningCoherenceJudge(),
    ]
    added = 0
    for judge in new_judges:
        if registry.get(judge.name) is None:
            registry.register(judge)
            added += 1
    logger.info(
        "registered %d intelligence judges (Cat 3 + Galileo Luna-2)",
        added,
    )
    return added
