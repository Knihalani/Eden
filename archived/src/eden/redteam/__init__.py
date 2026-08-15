"""Eden red-team probe subsystem.

Exposes :mod:`eden.redteam.probes` for adversarial prompt evaluation
and safety regression checks. Imported by
``eden.api.routes.redteam`` (mounted at ``/orgs/{org_id}/redteam`` in
``app.py``). Without this package marker the ``from eden.redteam.probes
import …`` in the route module raises ``ModuleNotFoundError`` under
several import paths; explicit ``__init__`` makes the package resolvable
in every context (Py3 namespace packages + tooling that walks
``__init__``-bearing trees).
"""
