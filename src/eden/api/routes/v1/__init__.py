"""Eden Public API v1 routes.

Phase 2: the v1 env-gen routes (``jobs``, ``benchmarks``) have been
removed. The ``environments`` route is stubbed to 410 Gone (its
helpers read env-gen blob data that no longer has writers).
"""

from eden.api.routes.v1 import environments  # noqa: F401

__all__ = ["environments"]
