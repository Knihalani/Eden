"""FastAPI middleware for Eden API.

Audit 2026-07-06 — the package __init__ is lazy via PEP 562
``__getattr__``. Previously the eager ``from eden.api.middleware
.X import Y`` style caused every middleware module to be loaded
on the first one (Python imports the parent package first), which
pulled fastapi + redis + jose + eden.config + the postgres client
for a single ``from eden.api.middleware.internal_only import
...`` call. Now each submodule is imported on first attribute
access; the public API is unchanged.
"""

from __future__ import annotations

__all__ = [
    "APIVersionMiddleware",
    "CURRENT_VERSION",
    "CorrelationIdMiddleware",
    "DefaultDenyAuthMiddleware",
    "IdempotencyMiddleware",
    "InternalOnlyMiddleware",
    "QuotaEnforcementMiddleware",
    "RLSOrgContextMiddleware",
    "SecurityHeadersMiddleware",
    "TenantRateLimitMiddleware",
    "get_api_version",
    "get_correlation_id",
]


def __getattr__(name: str):
    """PEP 562 — lazy module attribute access.

    Maps the public name back to the submodule + attribute that
    originally defined it. Importing the submodule on first access
    binds it into ``sys.modules[__name__]`` so subsequent
    ``from eden.api.middleware.<submodule> import ...`` calls
    skip the ``__getattr__`` entirely.
    """
    if name == "APIVersionMiddleware" or name == "CURRENT_VERSION" or name == "get_api_version":
        from eden.api.middleware import api_version as _mod
        value = getattr(_mod, name)
    elif name == "CorrelationIdMiddleware" or name == "get_correlation_id":
        from eden.api.middleware import correlation_id as _mod
        value = getattr(_mod, name)
    elif name == "DefaultDenyAuthMiddleware":
        from eden.api.middleware import default_deny as _mod
        value = getattr(_mod, name)
    elif name == "IdempotencyMiddleware":
        from eden.api.middleware import idempotency as _mod
        value = _mod.IdempotencyMiddleware
    elif name == "InternalOnlyMiddleware":
        from eden.api.middleware import internal_only as _mod
        value = _mod.InternalOnlyMiddleware
    elif name == "QuotaEnforcementMiddleware":
        from eden.api.middleware import quota_enforcement as _mod
        value = _mod.QuotaEnforcementMiddleware
    elif name == "RLSOrgContextMiddleware":
        from eden.api.middleware import rls_org_context as _mod
        value = _mod.RLSOrgContextMiddleware
    elif name == "SecurityHeadersMiddleware":
        from eden.api.middleware import security_headers as _mod
        value = _mod.SecurityHeadersMiddleware
    elif name == "TenantRateLimitMiddleware":
        from eden.api.middleware import tenant_rate_limit as _mod
        value = _mod.TenantRateLimitMiddleware
    else:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    # Cache on the package so ``from eden.api.middleware import X``
    # resolves it on the second import too.
    globals()[name] = value
    return value

