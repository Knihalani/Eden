"""W4-4 — Deterministic judges CRUD: route round-trip, scorer execution, RBAC.

Tests:
* CRUD round-trip against mocked storage (create → list → get → delete)
* Deterministic execution against sample payloads for each scorer type
* Admin gate on create / delete; non-admin gets 403
* doc_flag_drift script is unaffected (run separately in CI)
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient


# ── App factory ────────────────────────────────────────────────────


def _build_app(*, is_admin: bool = True):
    from eden.api.deps import (
        get_current_user,
        require_org_admin,
        require_path_org_access,
    )
    from eden.api.routes import judges as judges_routes

    app = FastAPI()
    # definitions_router MUST be included before router so that the literal
    # /definitions prefix matches before the parameterised /{judge_run_id}
    # catch-all on the parent router (mirrors app.py registration order).
    app.include_router(judges_routes.definitions_router)
    app.include_router(judges_routes.router)

    app.dependency_overrides[get_current_user] = lambda: {
        "user_id": "u-1",
        "email": "test@example.com",
    }
    app.dependency_overrides[require_path_org_access] = lambda: "org-A"

    if is_admin:
        app.dependency_overrides[require_org_admin] = lambda: {
            "user_id": "u-1",
            "role": "admin",
        }
    else:
        # Non-admin: require_org_admin raises 403
        from fastapi import HTTPException

        async def _not_admin():
            raise HTTPException(status_code=403, detail="admin required")

        app.dependency_overrides[require_org_admin] = _not_admin

    return app, judges_routes


# ── In-memory store stub ────────────────────────────────────────────

_STORE: list[dict] = []


def _reset_store() -> None:
    global _STORE
    _STORE = []


async def _fake_load(org_id: str) -> list[dict]:
    return list(_STORE)


async def _fake_save(org_id: str, metrics: list[dict]) -> None:
    global _STORE
    _STORE = list(metrics)


def _patch_store():
    """Context manager that patches _load/_save in the registry module.

    DeterministicJudgeRegistry imports _load/_save by name at module load
    time (``from ._common import ...``), so we must patch at the registry
    module's namespace — not at ``_common`` — to intercept the calls.
    """
    return patch.multiple(
        "eden.metric_studio.deterministic_judge_registry",
        _load_org_custom_metrics=AsyncMock(side_effect=_fake_load),
        _save_org_custom_metrics=AsyncMock(side_effect=_fake_save),
    )


# ── CRUD round-trip ────────────────────────────────────────────────


def test_create_judge_returns_judge_id() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "JSON validator", "scorer_type": "json_valid", "scorer_config": {}},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data"]["created"] is True
    assert body["data"]["judge_id"].startswith("djudge_")
    assert body["data"]["kind"] == "deterministic"
    assert body["data"]["scorer_type"] == "json_valid"


def test_list_returns_created_judge() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        # Create two judges
        c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "J1", "scorer_type": "json_valid", "scorer_config": {}},
        )
        c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={
                "name": "J2",
                "scorer_type": "regex",
                "scorer_config": {"pattern": "foo"},
            },
        )
        resp = c.get("/orgs/org-A/observability/judges/definitions")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data"]["count"] == 2
    names = {j["name"] for j in body["data"]["judges"]}
    assert names == {"J1", "J2"}


def test_get_returns_specific_judge() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        create_resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "Exact check", "scorer_type": "exact_match", "scorer_config": {}},
        )
        judge_id = create_resp.json()["data"]["judge_id"]
        resp = c.get(f"/orgs/org-A/observability/judges/definitions/{judge_id}")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data"]["found"] is True
    assert body["data"]["judge"]["name"] == "Exact check"
    assert body["data"]["judge"]["judge_id"] == judge_id


def test_get_not_found_returns_found_false() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        resp = c.get("/orgs/org-A/observability/judges/definitions/djudge_does_not_exist")

    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["found"] is False


def test_delete_archives_judge() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        create_resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "To delete", "scorer_type": "json_valid", "scorer_config": {}},
        )
        judge_id = create_resp.json()["data"]["judge_id"]

        del_resp = c.delete(f"/orgs/org-A/observability/judges/definitions/{judge_id}")
        assert del_resp.status_code == 200, del_resp.text
        assert del_resp.json()["data"]["deleted"] is True

        # Should no longer appear in default list
        list_resp = c.get("/orgs/org-A/observability/judges/definitions")
        assert list_resp.json()["data"]["count"] == 0

        # But visible when include_archived=true
        list_archived = c.get(
            "/orgs/org-A/observability/judges/definitions?include_archived=true"
        )
        assert list_archived.json()["data"]["count"] == 1
        assert list_archived.json()["data"]["judges"][0]["status"] == "archived"


# ── Scorer execution ────────────────────────────────────────────────


@pytest.mark.parametrize(
    "scorer_type,scorer_config,output,expected_val,want_score",
    [
        # json_valid: valid JSON scores 1.0
        ("json_valid", {}, '{"key": "value"}', None, 1.0),
        # json_valid: invalid JSON scores 0.0
        ("json_valid", {}, "not json", None, 0.0),
        # exact_match: match → 1.0
        ("exact_match", {}, "hello world", "hello world", 1.0),
        # exact_match: no match → 0.0
        ("exact_match", {}, "hello world", "goodbye", 0.0),
        # regex: pattern matches → True (truthy)
        ("regex", {"pattern": r"\d{3}"}, "abc 123 def", None, True),
        # regex: pattern absent → False
        ("regex", {"pattern": r"\d{3}"}, "no digits here", None, False),
        # contains: found → 1.0
        ("contains", {}, "the quick brown fox", "quick", 1.0),
        # icontains: case-insensitive match → 1.0
        ("icontains", {}, "Hello World", "hello", 1.0),
    ],
)
def test_execute_deterministic_scorer(
    scorer_type, scorer_config, output, expected_val, want_score
) -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        # Create the judge
        create_payload: dict = {
            "name": f"{scorer_type} judge",
            "scorer_type": scorer_type,
            "scorer_config": scorer_config,
        }
        create_resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json=create_payload,
        )
        assert create_resp.status_code == 200, create_resp.text
        judge_id = create_resp.json()["data"]["judge_id"]

        # Execute it
        exec_payload: dict = {"output": output}
        if expected_val is not None:
            exec_payload["expected"] = expected_val

        exec_resp = c.post(
            f"/orgs/org-A/observability/judges/definitions/{judge_id}/execute",
            json=exec_payload,
        )
        assert exec_resp.status_code == 200, exec_resp.text
        body = exec_resp.json()
        assert body["data"]["executed"] is True
        assert body["data"]["score"] == want_score or bool(body["data"]["score"]) == bool(
            want_score
        )


def test_execute_returns_not_found_for_missing_judge() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        resp = c.post(
            "/orgs/org-A/observability/judges/definitions/djudge_nope/execute",
            json={"output": "test"},
        )
    assert resp.status_code == 200
    assert resp.json()["data"]["found"] is False


# ── RBAC gate ──────────────────────────────────────────────────────


def test_create_requires_admin() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=False)
    with _patch_store():
        c = TestClient(app)
        resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "X", "scorer_type": "json_valid", "scorer_config": {}},
        )
    assert resp.status_code == 403


def test_delete_requires_admin() -> None:
    _reset_store()
    # Create with admin app, then try delete as non-admin
    admin_app, _ = _build_app(is_admin=True)
    with _patch_store():
        c_admin = TestClient(admin_app)
        create_resp = c_admin.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "To delete", "scorer_type": "json_valid", "scorer_config": {}},
        )
        judge_id = create_resp.json()["data"]["judge_id"]

    non_admin_app, _ = _build_app(is_admin=False)
    with _patch_store():
        c_non_admin = TestClient(non_admin_app)
        resp = c_non_admin.delete(
            f"/orgs/org-A/observability/judges/definitions/{judge_id}"
        )
    assert resp.status_code == 403


def test_list_and_get_do_not_require_admin() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=False)
    with _patch_store():
        c = TestClient(app)
        resp = c.get("/orgs/org-A/observability/judges/definitions")
        assert resp.status_code == 200

        resp2 = c.get("/orgs/org-A/observability/judges/definitions/djudge_any")
        assert resp2.status_code == 200


# ── Validation ─────────────────────────────────────────────────────


def test_create_invalid_scorer_type_returns_validation_error() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "Bad", "scorer_type": "llm_judge", "scorer_config": {}},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("error_code") == "validation_error"


def test_create_regex_without_pattern_returns_validation_error() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "Regex", "scorer_type": "regex", "scorer_config": {}},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("error_code") == "validation_error"


def test_create_missing_name_returns_validation_error() -> None:
    _reset_store()
    app, _ = _build_app(is_admin=True)
    with _patch_store():
        c = TestClient(app)
        resp = c.post(
            "/orgs/org-A/observability/judges/definitions",
            json={"name": "", "scorer_type": "json_valid", "scorer_config": {}},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body.get("error_code") == "validation_error"
