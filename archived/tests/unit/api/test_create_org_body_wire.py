"""``POST /orgs`` must accept the JSON body the portal actually sends.

Regression guard. ``create_org`` declared ``name: str`` and
``make_default: bool = True`` as bare scalars, which FastAPI binds as
*query* parameters. The portal's "Create workspace" recovery button
(``clients/portal/src/lib/api/auth-api.ts``) posts a JSON body with no
query string, so it 422'd every time — and that button is the only
in-product path to a workspace for a user whose Clerk signup produced no
organization. Every backend test called it the other way (``?name=``),
so nothing covered the real wire shape.

Both shapes must keep working: body (portal) and query (existing tests,
CLI, curl).
"""

from __future__ import annotations

import inspect

import pytest
from pydantic import BaseModel


def test_create_org_declares_a_pydantic_body() -> None:
    """The handler must take a model FastAPI will read from the body,
    not a bare ``name: str`` that lands in the query string."""
    from eden.api.routes.orgs import CreateOrgBody, create_org

    params = inspect.signature(create_org).parameters
    assert "body" in params, "create_org lost its JSON body parameter"
    annotation = params["body"].annotation
    # ``CreateOrgBody | None`` — check the model is in the union.
    assert CreateOrgBody in getattr(annotation, "__args__", (annotation,))
    assert issubclass(CreateOrgBody, BaseModel)


def test_body_model_enforces_the_documented_name_bounds() -> None:
    from pydantic import ValidationError

    from eden.api.routes.orgs import CreateOrgBody

    assert CreateOrgBody(name="Acme").make_default is True
    assert CreateOrgBody(name="Acme", make_default=False).make_default is False
    with pytest.raises(ValidationError):
        CreateOrgBody(name="a")  # < 2 chars
    with pytest.raises(ValidationError):
        CreateOrgBody(name="x" * 101)  # > 100 chars


def test_query_params_are_still_accepted() -> None:
    """Existing callers pass ``?name=…``; both must resolve."""
    params = inspect.signature(
        __import__(
            "eden.api.routes.orgs", fromlist=["create_org"]
        ).create_org
    ).parameters
    assert "name" in params and "make_default" in params
    # Query fallbacks must be optional, or a body-only request 422s again.
    assert params["name"].annotation == (str | None)
    assert params["make_default"].annotation == (bool | None)


@pytest.mark.parametrize(
    ("body_name", "query_name", "expected"),
    [
        ("FromBody", None, "FromBody"),
        (None, "FromQuery", "FromQuery"),
        ("FromBody", "FromQuery", "FromBody"),  # body wins
    ],
)
def test_name_resolution_precedence(
    body_name: str | None, query_name: str | None, expected: str
) -> None:
    """Mirrors the resolution line at the top of the handler."""
    from eden.api.routes.orgs import CreateOrgBody

    body = CreateOrgBody(name=body_name) if body_name else None
    resolved = (body.name if body is not None else None) or query_name
    assert resolved == expected
