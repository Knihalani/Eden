"""Public OpenAPI spec — customer-facing routes only.

Served at ``GET /openapi/v1/public.json`` without authentication.
Internal ops, SCIM, metrics, and webhook receivers are stripped so
SDK generators and partner integrations never see the full surface.
"""

from __future__ import annotations

import copy
from typing import Any

# Path prefixes excluded from the public contract.
_INTERNAL_PATH_PREFIXES: tuple[str, ...] = (
    "/v1/internal",
    "/metrics",
    "/clerk/webhook",
    "/webhooks",
)

# Exact paths that are auth/session plumbing, not customer API.
_INTERNAL_EXACT_PATHS: frozenset[str] = frozenset({
    "/health",
    "/openapi.json",
    "/openapi/v1/public.json",
    "/docs",
    "/redoc",
    "/scalar",
})

# Route tags that never ship in the public contract.
_INTERNAL_TAGS: frozenset[str] = frozenset({
    "internal-health",
    "clerk-webhooks",
    "scim",
})

# HTTP methods we never expose (browser preflight, etc.).
_SKIP_METHODS: frozenset[str] = frozenset({"options", "head"})


def _is_public_path(path: str) -> bool:
    if path in _INTERNAL_EXACT_PATHS:
        return False
    return not any(path.startswith(prefix) for prefix in _INTERNAL_PATH_PREFIXES)


def _operation_is_public(operation: dict[str, Any]) -> bool:
    tags = operation.get("tags") or []
    return not any(tag in _INTERNAL_TAGS for tag in tags)


def build_public_openapi_spec(full_spec: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``full_spec`` with internal routes removed."""
    spec = copy.deepcopy(full_spec)
    public_paths: dict[str, Any] = {}

    for path, path_item in (full_spec.get("paths") or {}).items():
        if not _is_public_path(path):
            continue
        kept: dict[str, Any] = {}
        for method, operation in path_item.items():
            if method in _SKIP_METHODS or not isinstance(operation, dict):
                if method in ("parameters", "servers", "summary", "description"):
                    kept[method] = operation
                continue
            if _operation_is_public(operation):
                kept[method] = operation
        if any(k not in ("parameters", "servers", "summary", "description") for k in kept):
            public_paths[path] = kept

    spec["paths"] = public_paths
    spec["info"] = {
        **(spec.get("info") or {}),
        "title": "Eden Public API",
        "description": (
            "Customer-facing Eden API surface. For the full operator "
            "contract including internal routes, use /openapi.json "
            "with a valid session."
        ),
        "version": (spec.get("info") or {}).get("version", "1.0.0"),
    }
    # Public spec is served from a versioned URL — pin servers when present.
    if spec.get("servers"):
        spec["servers"] = spec["servers"][:3]
    return spec
