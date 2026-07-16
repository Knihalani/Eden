"""Legacy entrypoint — Cat 3 judges now live in UnifiedJudge.

``register_intelligence_judges`` is a no-op kept for call-site
compatibility (tests / docs that still import it). Defaults are
registered via ``register_default_judges``.
"""

from __future__ import annotations

import logging

from .registry import JudgeRegistry

logger = logging.getLogger(__name__)


def register_intelligence_judges(registry: JudgeRegistry | None = None) -> int:
    """No-op: unified judge already covers Cat 3 + Galileo axes."""
    _ = registry or JudgeRegistry()
    logger.debug("register_intelligence_judges: unified judge owns these axes")
    return 0
