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
        client.enqueue(TraceEvent(payload=payload, source_format="custom"))
        client.flush(timeout=timeout_s)
        checks.append(
            DoctorCheck(
                "test_event",
                True,
                f"Emitted test event {event_id}",
                {"event_id": event_id},
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
