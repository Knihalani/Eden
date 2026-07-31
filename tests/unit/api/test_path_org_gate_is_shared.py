"""The path-org authorization gate must exist in exactly one place.

Seventeen route modules had each grown a byte-identical private copy:

    async def _require_path_org(
        org_id: str = Path(..., description="Organization ID"),
        user: dict = Depends(get_current_user),
        payload: dict | None = Depends(_try_resolve_token_payload),
    ) -> str:
        _, eden_org = await resolve_path_org_access(org_id, user, payload)
        return eden_org

identical to ``eden.api.deps.require_path_org_access`` in behaviour. Nothing
was broken by that, which is the problem: a tenant-isolation gate copied
seventeen times is a gate that has to be corrected in seventeen places, and the
next copy is written by whoever adds the next ``/orgs/{org_id}/...`` router. The
cost only lands the day the gate is found to be wrong.

Twenty-three test files then bound their dependency overrides to the
module-local symbol, which is what made the copies load-bearing and kept them
alive. Overrides now target the shared dependency, so one override covers every
router.

This test fails on a re-introduced copy rather than waiting for a review to
notice it.
"""

from __future__ import annotations

import ast
import importlib
import pkgutil
from pathlib import Path as FsPath

import pytest
from fastapi import APIRouter, FastAPI

import eden.api.routes as routes_pkg
from eden.api.deps import require_path_org_access

_ROUTES_DIR = FsPath(routes_pkg.__file__).parent

# A module may legitimately define a *differently shaped* local gate (extra
# role checks, a non-standard path parameter name). What must not recur is a
# private alias that merely re-wraps ``resolve_path_org_access`` with no added
# behaviour. Any such module belongs here with a reason, or nowhere.
_ALLOWED_LOCAL_GATES: dict[str, str] = {}


def _route_modules() -> list[str]:
    return sorted(
        m.name for m in pkgutil.iter_modules([str(_ROUTES_DIR)]) if not m.ispkg
    )


class TestNoPrivateDuplicates:
    def test_no_route_module_defines_its_own_path_org_gate(self) -> None:
        offenders: list[str] = []
        for name in _route_modules():
            source = (_ROUTES_DIR / f"{name}.py").read_text(encoding="utf-8")
            if "_require_path_org" not in source:
                continue
            tree = ast.parse(source)
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.AsyncFunctionDef | ast.FunctionDef)
                    and node.name == "_require_path_org"
                    and name not in _ALLOWED_LOCAL_GATES
                ):
                    offenders.append(f"{name}.py:{node.lineno}")
        assert not offenders, (
            "these modules define a private copy of the path-org gate instead "
            "of importing eden.api.deps.require_path_org_access -- a gate "
            f"duplicated per-module has to be fixed per-module: {offenders}"
        )

    def test_the_shared_gate_resolves_the_path_org(self) -> None:
        """Guards the premise: the canonical helper is the real gate."""
        import inspect

        src = inspect.getsource(require_path_org_access)
        assert "resolve_path_org_access" in src
        assert "org_id" in src


class TestEveryPathOrgRouterIsGated:
    """A ``/orgs/{org_id}/`` route with no gate is a cross-tenant hole.

    Consolidating removed seventeen indirections; this asserts the removal did
    not also remove the gate from any route that had one.
    """

    @staticmethod
    def _key(route: object) -> frozenset[tuple[str, str]]:
        """``{(method, path)}`` for one route.

        Keyed per method, not per path. ``GET`` and ``POST`` on the same path
        are separate routes with separate dependency trees, so a path-keyed set
        reports the path as gated when *either* method is gated -- which hides
        exactly the mistake this test exists to catch (verified: removing one
        endpoint's gate left a path-keyed check green).
        """
        path = str(getattr(route, "path", ""))
        methods = getattr(route, "methods", None) or {"*"}
        return frozenset((m, path) for m in methods)

    @classmethod
    def _gated(cls, app: FastAPI) -> set[tuple[str, str]]:
        gated: set[tuple[str, str]] = set()
        for route in app.routes:
            dependant = getattr(route, "dependant", None)
            if dependant is None:
                continue
            stack = [dependant]
            while stack:
                d = stack.pop()
                stack.extend(d.dependencies)
                if d.call is require_path_org_access:
                    gated |= cls._key(route)
                    break
        return gated

    @pytest.mark.parametrize(
        "module_name",
        [
            "browser_sessions",
            "datasets_hub",
            "datasets_spreadsheet",
            "debugger",
            "experiments_offline",
            "improve",
            "intelligence_apm_depth",
            "intelligence_eval",
            "intelligence_replay",
            "judges",
            "labeling",
            "playgrounds",
            "production_eval",
            "qa_generator",
            "sharing",
            "streaming_tokens",
            "wave6_online",
        ],
    )
    def test_consolidated_module_still_gates_its_org_routes(
        self, module_name: str
    ) -> None:
        """Each of the seventeen former copy-holders keeps a real gate."""
        mod = importlib.import_module(f"eden.api.routes.{module_name}")
        # Most modules export ``router``; ``sharing`` exports ``sharing_router``
        # plus an intentionally unauthenticated ``public_router``. Mount every
        # APIRouter the module exposes so the check cannot be sidestepped by
        # naming, and so the public router's presence does not mask the
        # authenticated one.
        app = FastAPI()
        mounted = 0
        for attr in dir(mod):
            candidate = getattr(mod, attr)
            if isinstance(candidate, APIRouter):
                app.include_router(candidate)
                mounted += 1
        assert mounted, f"{module_name} exposes no APIRouter"

        org_routes: set[tuple[str, str]] = set()
        for r in app.routes:
            if "{org_id}" in str(getattr(r, "path", "")):
                org_routes |= self._key(r)
        # HEAD requests are auto-added alongside GET by Starlette and carry the
        # same dependency tree; OPTIONS is CORS preflight. Neither is a separate
        # authorization surface.
        org_routes = {(m, p) for m, p in org_routes if m not in {"HEAD", "OPTIONS"}}
        if not org_routes:
            pytest.skip(f"{module_name} mounts no /{{org_id}}/ routes")

        # Every /{org_id}/ route, not merely one of them. An earlier version of
        # this test asserted only ``gated`` being non-empty, which wave6_online
        # would have satisfied after losing 24 of its 25 gates -- a guard that
        # cannot see the failure it was written for.
        gated = self._gated(app)
        ungated = sorted(org_routes - gated)
        assert not ungated, (
            f"{module_name}: {len(ungated)} of {len(org_routes)} /{{org_id}}/ "
            "routes do not depend on require_path_org_access, so the path org "
            f"is never checked against the caller's membership: {ungated}"
        )


class TestOverridesTargetTheSharedSymbol:
    def test_one_override_covers_every_consolidated_router(self) -> None:
        """The ergonomic payoff, and a proof the symbol really is shared.

        With per-module copies, a test had to override each module's own
        symbol. If they are genuinely the same object now, overriding once
        must reach every router.
        """
        judges = importlib.import_module("eden.api.routes.judges")
        labeling = importlib.import_module("eden.api.routes.labeling")

        app = FastAPI()
        app.include_router(judges.router)
        app.include_router(labeling.router)
        app.dependency_overrides[require_path_org_access] = lambda: "org-x"

        gated = TestEveryPathOrgRouterIsGated._gated(app)
        judges_paths = {p for _m, p in gated if "judges" in p}
        labeling_paths = {p for _m, p in gated if "labeling" in p or "label" in p}
        assert judges_paths, "judges routes not reached by the shared symbol"
        assert labeling_paths, "labeling routes not reached by the shared symbol"
