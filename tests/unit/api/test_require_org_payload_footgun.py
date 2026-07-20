"""Static + handler regression: bare ``await require_org_*`` Depends footgun.

Direct ``await require_org_permission(perm, x_org_id=org_id)`` (and the
admin/owner/member siblings) leaves the default ``payload=Depends(...)``
sentinel unresolved. Call sites under ``src/eden/api/routes/`` must
inject ``payload: dict | None = Depends(_try_resolve_token_payload)``
and pass it explicitly.
"""

from __future__ import annotations

import ast
import inspect
import pathlib
import re

import pytest
from fastapi import HTTPException
from fastapi.params import Depends as DependsParam

from eden.api.deps import _try_resolve_token_payload, require_org_permission
from eden.api.routes.pii_policy import PIIPolicyIn, put_pii_policy
from eden.api.routes.region import RegionIn, put_region
from eden.api.routes.retention_policy import RetentionPolicyIn, put_retention_policy

_ROUTES_ROOT = (
    pathlib.Path(__file__).resolve().parents[3] / "src" / "eden" / "api" / "routes"
)
_FN_RE = re.compile(r"^require_org_(permission|admin|owner|member)$")


def _bare_require_org_awaits(routes_root: pathlib.Path) -> list[tuple[str, int, str]]:
    """Return (path, lineno, call_src) for awaits missing an explicit payload."""
    issues: list[tuple[str, int, str]] = []
    for path in sorted(routes_root.rglob("*.py")):
        src = path.read_text(encoding="utf-8")
        try:
            tree = ast.parse(src)
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Await):
                continue
            call = node.value
            if not isinstance(call, ast.Call):
                continue
            func = call.func
            name: str | None = None
            if isinstance(func, ast.Name):
                name = func.id
            elif isinstance(func, ast.Attribute):
                name = func.attr
            if not name or not _FN_RE.match(name):
                continue
            positional = list(call.args)
            keywords = {k.arg for k in call.keywords if k.arg}
            if name == "require_org_permission":
                has_payload = len(positional) >= 3 or "payload" in keywords
            else:
                has_payload = len(positional) >= 2 or "payload" in keywords
            if not has_payload:
                segment = ast.get_source_segment(src, call) or name
                rel = str(path.relative_to(_ROUTES_ROOT.parents[3]))
                issues.append((rel, node.lineno, segment))
    return issues


def test_no_bare_require_org_awaits_in_routes():
    issues = _bare_require_org_awaits(_ROUTES_ROOT)
    assert issues == [], (
        "Bare await require_org_* without resolved payload "
        "(inject Depends(_try_resolve_token_payload) and pass it):\n"
        + "\n".join(f"  {p}:{ln}: {seg}" for p, ln, seg in issues)
    )


@pytest.mark.parametrize(
    "handler",
    [put_pii_policy, put_region, put_retention_policy],
)
def test_policy_put_handlers_declare_payload_depends(handler):
    sig = inspect.signature(handler)
    assert "payload" in sig.parameters, f"{handler.__name__} missing payload param"
    default = sig.parameters["payload"].default
    assert isinstance(default, DependsParam)
    assert default.dependency is _try_resolve_token_payload


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "handler,body",
    [
        (put_pii_policy, PIIPolicyIn()),
        (put_region, RegionIn(region="us")),
        (
            put_retention_policy,
            RetentionPolicyIn(
                table_name="telemetry_events",
                hot_days=7,
                warm_days=30,
                cold_days=90,
                delete_days=365,
            ),
        ),
    ],
)
async def test_policy_put_handlers_pass_payload_not_sentinel(handler, body, monkeypatch):
    """Handlers must forward the injected payload into require_org_permission."""
    seen: dict = {}

    async def _capture(permission, x_org_id=None, payload=None):
        seen["permission"] = permission
        seen["x_org_id"] = x_org_id
        seen["payload"] = payload
        raise HTTPException(status_code=403, detail="Permission denied")

    mod = inspect.getmodule(handler)
    assert mod is not None
    monkeypatch.setattr(mod, "require_org_permission", _capture)

    jwt = {"sub": "u1", "o": {"id": "org-1", "rol": "owner"}}
    with pytest.raises(HTTPException) as exc_info:
        await handler(
            body=body,
            org_id="org-1",
            user={"user_id": "u1"},
            payload=jwt,
        )
    assert exc_info.value.status_code == 403
    assert seen["payload"] is jwt
    assert seen["x_org_id"] == "org-1"
    assert not isinstance(seen["payload"], DependsParam)


@pytest.mark.asyncio
async def test_require_org_permission_bare_default_is_403_not_500():
    """Unresolved Depends default → 403, never AttributeError/500."""
    sentinel = DependsParam(_try_resolve_token_payload)
    with pytest.raises(HTTPException) as exc_info:
        await require_org_permission(
            "settings:edit", "org-1", sentinel
        )  # type: ignore[arg-type]
    assert exc_info.value.status_code == 403
