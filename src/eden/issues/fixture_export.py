"""D6 — redacted failure fixture export for local replay."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_REDACT_KEYS = frozenset(
    {
        "api_key",
        "authorization",
        "password",
        "secret",
        "token",
        "email",
        "phone",
    }
)


def _redact(obj: Any) -> Any:
    if isinstance(obj, dict):
        out: dict[str, Any] = {}
        for k, v in obj.items():
            if k.lower() in _REDACT_KEYS:
                out[k] = "[REDACTED]"
            else:
                out[k] = _redact(v)
        return out
    if isinstance(obj, list):
        return [_redact(x) for x in obj]
    return obj


async def export_issue_fixture(org_id: str, issue_id: str) -> dict[str, Any]:
    """Build a redacted trace bundle for an issue's example stumbles."""
    from eden.issues.repo import IssuesRepo

    issue = await IssuesRepo().get_issue(org_id, issue_id)
    if issue is None:
        return {"status": "not_found", "issue_id": issue_id}

    stumbles = await IssuesRepo().list_stumbles(
        org_id, fingerprint=issue.fingerprint, limit=10
    )
    traces: list[dict[str, Any]] = []
    client = await _client()
    for s in stumbles[:5]:
        trace_id = s.get("trace_id")
        if not trace_id or client is None:
            traces.append(
                {
                    "trace_id": trace_id,
                    "stumble": _redact(
                        {k: v for k, v in s.items() if k != "detail"}
                    ),
                    "detail": _redact(s.get("detail") or {}),
                }
            )
            continue
        try:
            rows = await client.fetch(
                "SELECT span_id, name, attributes, start_time "
                "FROM telemetry_events "
                "WHERE org_id = $1 AND trace_id = $2 "
                "ORDER BY start_time LIMIT 50",
                org_id,
                trace_id,
            )
            spans = []
            for r in rows:
                attrs = r.get("attributes")
                if isinstance(attrs, str):
                    try:
                        attrs = json.loads(attrs)
                    except Exception:
                        attrs = {}
                spans.append(
                    _redact(
                        {
                            "span_id": str(r.get("span_id", "")),
                            "name": r.get("name"),
                            "attributes": attrs,
                        }
                    )
                )
            traces.append(
                {
                    "trace_id": trace_id,
                    "stumble": _redact(
                        {k: v for k, v in s.items() if k != "detail"}
                    ),
                    "spans": spans,
                }
            )
        except Exception as exc:
            logger.debug("fixture export span fetch failed: %s", exc)
            traces.append({"trace_id": trace_id, "error": str(exc)})

    bundle = {
        "format": "eden-failure-fixture-v1",
        "exported_at": datetime.now(UTC).isoformat(),
        "issue": {
            "id": issue.id,
            "fingerprint": issue.fingerprint,
            "kind": issue.kind,
            "title": issue.title,
            "agent_id": issue.agent_id,
            "severity": issue.severity,
        },
        "traces": traces,
        "replay_hint": (
            "Import this JSON locally and replay spans against your agent "
            "using eden debugger or MCP export_fixture."
        ),
    }
    return {"status": "ok", "fixture": bundle}


async def _client() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:
        return None
