"""MCP Resources capability (F04 extension — 6.3).

Exposes Eden trace and issue data as MCP Resources, following the same pattern
as TOOL_CATALOG / call_tool in server.py. Handles ``resources/list`` and
``resources/read``.

URI scheme: ``eden://orgs/{org_id}/traces/{trace_id}``
             ``eden://orgs/{org_id}/issues/{issue_id}``
"""

from __future__ import annotations

import re
from typing import Any

# ── Resource template catalog ────────────────────────────────────────

RESOURCE_TEMPLATE_CATALOG: list[dict[str, Any]] = [
    {
        "uriTemplate": "eden://orgs/{org_id}/traces/{trace_id}",
        "name": "Trace detail",
        "description": (
            "Full trace tree and metadata for a single agent trace. "
            "Includes spans, tool calls, token usage, and attached score data."
        ),
        "mimeType": "application/json",
    },
    {
        "uriTemplate": "eden://orgs/{org_id}/issues/{issue_id}",
        "name": "Agent issue",
        "description": (
            "Issue detail with triage, severity, affected traces, and "
            "root-cause analysis if available."
        ),
        "mimeType": "application/json",
    },
    {
        "uriTemplate": "eden://orgs/{org_id}/plans/{plan_id}",
        "name": "Improvement plan",
        "description": (
            "Improvement plan detail including proposed changes, eval delta, "
            "and current approval status."
        ),
        "mimeType": "application/json",
    },
]

# ── URI patterns ─────────────────────────────────────────────────────

_URI_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"^eden://orgs/(?P<org_id>[^/]+)/traces/(?P<trace_id>[^/]+)$"),
        "trace",
    ),
    (
        re.compile(r"^eden://orgs/(?P<org_id>[^/]+)/issues/(?P<issue_id>[^/]+)$"),
        "issue",
    ),
    (
        re.compile(r"^eden://orgs/(?P<org_id>[^/]+)/plans/(?P<plan_id>[^/]+)$"),
        "plan",
    ),
]


def list_resource_templates() -> list[dict[str, Any]]:
    """Return MCP-shaped resource template descriptors."""
    return [
        {
            "uriTemplate": t["uriTemplate"],
            "name": t["name"],
            "description": t["description"],
            "mimeType": t["mimeType"],
        }
        for t in RESOURCE_TEMPLATE_CATALOG
    ]


def _parse_uri(uri: str) -> tuple[str, dict[str, str]] | tuple[None, None]:
    """Parse an ``eden://`` URI into (kind, params) or (None, None)."""
    for pattern, kind in _URI_PATTERNS:
        m = pattern.match(uri)
        if m:
            return kind, m.groupdict()
    return None, None


async def read_resource(
    uri: str,
    *,
    client: Any,
    auth: Any,
) -> dict[str, Any]:
    """Fetch the resource at *uri* and return MCP resource content.

    Returns a dict with ``contents`` (list of content blobs) on success, or an
    error dict.  The caller (``_handle_rpc``) wraps the result in a JSON-RPC
    response.
    """
    kind, params = _parse_uri(uri)
    if kind is None:
        return {
            "status": "error",
            "error": f"Unsupported resource URI: {uri!r}",
        }

    from eden.mcp_server.auth import pin_org_id

    org_id_raw = params.get("org_id")
    try:
        org_id = pin_org_id(auth, org_id_raw)
    except (PermissionError, ValueError) as exc:
        return {"status": "error", "error": str(exc)}

    try:
        if kind == "trace":
            data = await client.get_trace(org_id, params["trace_id"])
        elif kind == "issue":
            data = await client.get_issue(org_id, params["issue_id"])
        elif kind == "plan":
            data = await client.get_improvement_plan(org_id, params["plan_id"])
        else:
            return {"status": "error", "error": f"Unknown kind: {kind}"}
    except Exception as exc:  # noqa: BLE001
        return {"status": "error", "error": f"Resource fetch failed: {exc}"}

    import json

    return {
        "contents": [
            {
                "uri": uri,
                "mimeType": "application/json",
                "text": json.dumps(data, default=str),
            }
        ]
    }
