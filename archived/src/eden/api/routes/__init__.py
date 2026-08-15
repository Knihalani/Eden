"""API route modules.

Phase 2: the env-gen routes (``jobs``, ``specs``, ``benchmark``) have
been removed — see ``eden/api/app.py`` for the router-include list.

Audit 2026-07-06 — the package ``__init__`` is lazy via PEP 562
``__getattr__``. Previously every ``from eden.api.routes.<sub> import
...`` triggered the eager imports of analytics, api_keys, audit,
auth, kb, orgs, references, scim, and sso, which pulled fastapi +
httpx + jose + eden.api.deps even when the caller only needed one.
Now each submodule is imported on first attribute access; the
public API is unchanged.
"""

from __future__ import annotations

# Audit 2026-07-06 v3 — PEP 562 covers ALL route names, not just
# the 9 listed in __all__ previously. The expanded hook lets
# ``from eden.api.routes import auth, kb, gateway, intelligence_replay``
# style imports be lazy at every name. Resolves the names by
# attempting a submodule import; if the module exists, it's cached
# in globals (so the second access is a single dict lookup). If no
# submodule matches, AttributeError falls through to the normal
# module attribute lookup.

# Original 9 always-lazy names (kept first in __all__ so a star-import
# works the same; expanded __getattr__ covers the rest).
__all__ = [
    "analytics", "api_keys", "audit", "auth", "kb",
    "orgs", "references", "scim", "sso",
]


def __getattr__(name: str):
    """PEP 562 — lazy module attribute access for ALL route names.

    Behaviour:
      1. If the name is already in globals (cached), return it.
      2. Otherwise try to import it as a submodule ``.name``. If
         that succeeds, bind it to globals and return.
      3. If ``name`` is in ``__all__`` but no module exists, raise
         AttributeError. Otherwise fall through to raise too.

    The first access costs an import (the actual cost saved). All
    subsequent accesses are dict lookups because the imported
    submodule is bound into ``globals()``.
    """
    import importlib

    if name in globals():
        return globals()[name]

    if not name.startswith("_"):
        try:
            submodule = importlib.import_module(f".{name}", __name__)
        except ModuleNotFoundError:
            pass
        else:
            globals()[name] = submodule
            return submodule

    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
