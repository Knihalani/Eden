"""Eden's public API surface must not change by accident.

This is the safety net for the serialization work. Replacing the default
response class, or swapping a response model, can alter what FastAPI declares
in the OpenAPI document — the media type of a response, the schemas that get
generated — without breaking a single existing test, because almost no test
asserts on the *contract* rather than on one endpoint's behaviour.

The snapshot records structure rather than the full ``app.openapi()``
document. That document is about a megabyte and churns on every unrelated
description edit; a snapshot nobody can read is a snapshot nobody reviews.
What is recorded is exactly what a serialization change perturbs: the route
inventory, the component-schema names, and the response media types per
operation.

Regenerate deliberately with ``python scripts/update_api_snapshot.py`` and
review the diff.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[3]
_SNAPSHOT_PATH = _REPO / "tests" / "unit" / "api" / "api_surface_snapshot.json"

_REGENERATE = "run `python scripts/update_api_snapshot.py` and review the diff"


@pytest.fixture(scope="module")
def snapshot() -> dict:
    return json.loads(_SNAPSHOT_PATH.read_text())


@pytest.fixture(scope="module")
def current() -> dict:
    import sys

    sys.path.insert(0, str(_REPO / "scripts"))
    from update_api_snapshot import build_surface

    return build_surface()


class TestRouteInventory:
    def test_no_routes_added_or_removed(self, snapshot: dict, current: dict) -> None:
        before, after = set(snapshot["routes"]), set(current["routes"])
        added = sorted(after - before)
        removed = sorted(before - after)
        assert not added and not removed, (
            f"the API surface changed.\n"
            f"  added ({len(added)}): {added[:20]}\n"
            f"  removed ({len(removed)}): {removed[:20]}\n"
            f"If this was intended, {_REGENERATE}."
        )

    def test_route_count_is_stable(self, snapshot: dict, current: dict) -> None:
        assert current["route_count"] == snapshot["route_count"]

    def test_every_route_is_uniquely_declared(self, current: dict) -> None:
        """Two handlers on one method+path means one silently shadows the other."""
        routes = current["routes"]
        assert len(routes) == len(set(routes))


class TestResponseContract:
    def test_media_types_are_unchanged(self, snapshot: dict, current: dict) -> None:
        """A response-class swap shows up here first."""
        assert current["response_media_types"] == snapshot["response_media_types"], (
            "the set of declared response media types changed — this is what a "
            f"default_response_class change perturbs. If intended, {_REGENERATE}."
        )

    def test_media_types_stay_within_the_known_set(self, current: dict) -> None:
        assert set(current["response_media_types"]) <= {
            "application/json",
            "text/plain",
        }

    def test_per_operation_responses_are_unchanged(
        self, snapshot: dict, current: dict
    ) -> None:
        before = snapshot["operation_responses"]
        after = current["operation_responses"]
        changed = {
            key: {"before": before[key], "after": after[key]}
            for key in before.keys() & after.keys()
            if before[key] != after[key]
        }
        assert not changed, (
            f"{len(changed)} operation(s) changed their declared responses: "
            f"{dict(list(changed.items())[:5])}\nIf intended, {_REGENERATE}."
        )


class TestSchemaInventory:
    def test_no_schemas_added_or_removed(self, snapshot: dict, current: dict) -> None:
        before, after = set(snapshot["schemas"]), set(current["schemas"])
        added = sorted(after - before)
        removed = sorted(before - after)
        assert not added and not removed, (
            f"OpenAPI component schemas changed.\n"
            f"  added ({len(added)}): {added[:20]}\n"
            f"  removed ({len(removed)}): {removed[:20]}\n"
            f"If this was intended, {_REGENERATE}."
        )


class TestSpecIsWellFormed:
    def test_openapi_builds_without_raising(self) -> None:
        """Schema generation is the first thing a bad response model breaks."""
        from eden.api.app import app

        spec = app.openapi()
        assert spec["openapi"].startswith("3.")
        assert spec["paths"]

    def test_spec_is_json_serializable(self) -> None:
        """A non-serializable default leaks into the schema and 500s /openapi.json."""
        from eden.api.app import app

        json.dumps(app.openapi())

    def test_snapshot_file_is_current_format(self, snapshot: dict) -> None:
        for key in (
            "routes",
            "route_count",
            "schemas",
            "response_media_types",
            "operation_responses",
        ):
            assert key in snapshot, f"snapshot missing {key!r}; {_REGENERATE}"
