"""``eden doctor`` — validate SDK config and emit a test event."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from eden_sdk.client import TraceEvent, get_default_client
from eden_sdk.config import get_config


@dataclass
class DoctorCheck:
    name: str
    ok: bool
    message: str
    detail: dict[str, Any] = field(default_factory=dict)


@dataclass
class DoctorReport:
    ok: bool
    checks: list[DoctorCheck]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "checks": [
                {
                    "name": c.name,
                    "ok": c.ok,
                    "message": c.message,
                    "detail": c.detail,
                }
                for c in self.checks
            ],
        }


def run_doctor(*, emit_test_event: bool = True, timeout_s: float = 5.0) -> DoctorReport:
    """Run connectivity + config checks and optionally emit a test event."""
    checks: list[DoctorCheck] = []
    cfg = get_config()

    if cfg.org_id:
        checks.append(DoctorCheck("org_id", True, f"org_id set ({cfg.org_id})"))
    else:
        checks.append(
            DoctorCheck(
                "org_id",
                False,
                "Missing org_id — set EDEN_ORG_ID or eden.configure(org_id=...)",
            )
        )

    if cfg.api_key:
        checks.append(DoctorCheck("api_key", True, "api_key set"))
    else:
        checks.append(
            DoctorCheck(
                "api_key",
                False,
                "Missing api_key — set EDEN_API_KEY or eden.configure(api_key=...)",
            )
        )

    checks.append(
        DoctorCheck("base_url", True, f"base_url={cfg.base_url}", {"base_url": cfg.base_url})
    )
    checks.append(
        DoctorCheck(
            "gateway_url",
            True,
            f"gateway_url={cfg.resolved_gateway_url()}",
            {"gateway_url": cfg.resolved_gateway_url()},
        )
    )

    enabled_opts = [
        name
        for name, on in (
            ("exact_cache", cfg.exact_cache),
            ("coalesce", cfg.coalesce),
            ("provider_cache_layout", cfg.provider_cache_layout),
            ("response_repair", cfg.response_repair),
        )
        if on
    ]
    disabled_opts = [
        name
        for name, on in (
            ("exact_cache", cfg.exact_cache),
            ("coalesce", cfg.coalesce),
            ("provider_cache_layout", cfg.provider_cache_layout),
            ("response_repair", cfg.response_repair),
        )
        if not on
    ]
    opt_msg = f"enabled: {', '.join(enabled_opts) or 'none'}"
    if disabled_opts:
        opt_msg += f"; disabled: {', '.join(disabled_opts)}"
    checks.append(
        DoctorCheck(
            "gateway_optimizations",
            True,
            opt_msg,
            {
                "exact_cache": cfg.exact_cache,
                "coalesce": cfg.coalesce,
                "provider_cache_layout": cfg.provider_cache_layout,
                "response_repair": cfg.response_repair,
            },
        )
    )

    if cfg.disabled:
        checks.append(DoctorCheck("enabled", False, "SDK is disabled (EDEN_DISABLED=1)"))

    health_url = f"{cfg.base_url.rstrip('/')}/health"
    try:
        headers: dict[str, str] = {}
        if cfg.api_key:
            headers["X-Org-Api-Key"] = cfg.api_key
        resp = httpx.get(health_url, headers=headers, timeout=timeout_s)
        reachable = resp.status_code < 500 or resp.status_code == 503
        checks.append(
            DoctorCheck(
                "connectivity",
                reachable,
                f"GET /health -> {resp.status_code}",
                {"status_code": resp.status_code},
            )
        )
    except Exception as exc:  # noqa: BLE001
        checks.append(
            DoctorCheck(
                "connectivity",
                False,
                f"Could not reach {health_url}: {exc!r}",
            )
        )

    # Session config readiness (F23) — does not require a live round-trip.
    session_ok = bool(cfg.org_id and cfg.api_key and cfg.base_url)
    checks.append(
        DoctorCheck(
            "session_config",
            session_ok,
            (
                "Session ingest path ready "
                f"(/orgs/{{org_id}}/ingest/agent-sessions)"
                if session_ok
                else "Session config incomplete — need org_id + api_key + base_url"
            ),
            {
                "endpoint": (
                    f"{cfg.base_url.rstrip('/')}/orgs/{cfg.org_id}/ingest/agent-sessions"
                    if cfg.org_id and cfg.base_url
                    else None
                ),
            },
        )
    )

    if emit_test_event and cfg.org_id and cfg.enabled:
        event_id = f"doctor_{uuid.uuid4().hex[:12]}"
        payload = {
            "event_id": event_id,
            "trace_id": uuid.uuid4().hex,
            "event_type": "agent.run",
            "name": "eden.doctor",
            "outcome": "success",
            "duration_ms": 0,
            "attributes": {"doctor": True},
            "tags": ["doctor", "sdk"],
            "source_format": "eden-sdk-doctor",
        }
        client = get_default_client()
        sent0, failed0 = client.sent, client.failed
        # Path must be allow-listed (webhook); payload keeps semantic label.
        client.enqueue(TraceEvent(payload=payload, source_format="webhook"))
        client.flush(timeout=timeout_s)
        if cfg.dry_run:
            emit_ok = client.sent > sent0
            emit_msg = (
                f"Dry-run accepted test event {event_id}"
                if emit_ok
                else f"Dry-run did not accept test event {event_id}"
            )
        else:
            failed_delta = client.failed - failed0
            sent_delta = client.sent - sent0
            emit_ok = sent_delta > 0 and failed_delta == 0
            if emit_ok:
                emit_msg = f"Emitted test event {event_id} (HTTP 2xx)"
            elif failed_delta > 0:
                emit_msg = (
                    f"Test event {event_id} ingest failed "
                    f"(failed+={failed_delta}; expect HTTP 2xx)"
                )
            else:
                emit_msg = (
                    f"Test event {event_id} did not confirm HTTP 2xx "
                    f"(sent+={sent_delta}, failed+={failed_delta})"
                )
        checks.append(
            DoctorCheck(
                "test_event",
                emit_ok,
                emit_msg,
                {
                    "event_id": event_id,
                    "sent_delta": client.sent - sent0,
                    "failed_delta": client.failed - failed0,
                },
            )
        )

    ok = all(c.ok for c in checks)
    return DoctorReport(ok=ok, checks=checks)


def main() -> int:
    report = run_doctor()
    print(json.dumps(report.to_dict(), indent=2))
    if not report.ok:
        print("\nNo events in 60s? Run `eden doctor` after configure() to diagnose.")
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
