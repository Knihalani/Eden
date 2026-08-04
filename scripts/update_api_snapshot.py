#!/usr/bin/env python3
"""Regenerate the public API surface snapshot.

Run after a *deliberate* change to Eden's routes or response models::

    python scripts/update_api_snapshot.py

then review the diff. The snapshot exists so that a change to serialization —
swapping the default response class, changing a response model — cannot alter
the public contract without someone seeing it in a diff first.

The snapshot deliberately records structure, not the whole schema. The full
``app.openapi()`` document is about a megabyte and churns on every unrelated
description edit; a snapshot nobody can read is a snapshot nobody reviews.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_REPO / "src"))

SNAPSHOT = _REPO / "tests" / "unit" / "api" / "api_surface_snapshot.json"


def build_surface() -> dict:
    """Return the structural facts a serialization change would perturb.

    W15-c: most routers are deferred to the lifespan (B26 intelligence
    tier + the tier-2 table in ``eden.api.app``). Mount them all first so
    the snapshot records the surface clients actually see once uvicorn
    has run the lifespan — and so a route accidentally dropped from a
    deferred table shows up here as a removal.
    """
    from eden.api.app import app, mount_deferred_routers

    mount_deferred_routers(app)

    routes = sorted(
        {
            f"{method} {route.path}"
            for route in app.routes
            if hasattr(route, "methods") and route.methods
            for method in route.methods
            if method not in {"HEAD", "OPTIONS"}
        }
    )

    spec = app.openapi()

    media_types: set[str] = set()
    operations: dict[str, list[str]] = {}
    for path, path_item in sorted(spec.get("paths", {}).items()):
        for method, operation in sorted(path_item.items()):
            if not isinstance(operation, dict):
                continue
            codes = []
            for code, response in sorted((operation.get("responses") or {}).items()):
                content = (response or {}).get("content") or {}
                media_types.update(content)
                codes.append(f"{code}:{','.join(sorted(content)) or 'empty'}")
            operations[f"{method.upper()} {path}"] = codes

    return {
        "_comment": (
            "Structural snapshot of Eden's public API surface. Regenerate "
            "deliberately with `python scripts/update_api_snapshot.py` and "
            "review the diff — this file is the record that a serialization "
            "change did not silently alter the contract."
        ),
        "route_count": len(routes),
        "routes": routes,
        "schema_count": len(spec.get("components", {}).get("schemas", {})),
        "schemas": sorted(spec.get("components", {}).get("schemas", {})),
        "response_media_types": sorted(media_types),
        "operation_responses": operations,
    }


def main() -> int:
    surface = build_surface()
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT.write_text(json.dumps(surface, indent=2, sort_keys=True) + "\n")
    print(
        f"wrote {SNAPSHOT.relative_to(_REPO)}: "
        f"{surface['route_count']} routes, {surface['schema_count']} schemas"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
