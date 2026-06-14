"""API route modules.

Phase 2: the env-gen routes (``jobs``, ``specs``, ``benchmark``) have
been removed — see ``eden/api/app.py`` for the router-include list.
This package's ``__init__`` no longer re-exports them; importing the
package is now side-effect free.
"""

from eden.api.routes import (  # noqa: F401
    analytics,
    api_keys,
    audit,
    auth,
    kb,
    orgs,
    references,
    scim,
    sso,
)

__all__ = [
    "kb", "auth", "orgs", "references", "api_keys", "audit",
    "analytics", "scim", "sso",
]
