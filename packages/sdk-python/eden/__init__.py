"""Eden product-agent wrap. Record, steer, playback via the Eden API."""

from __future__ import annotations

import json
import os
import time
import urllib.request
import uuid
from typing import Any, Callable

Original = Callable[[str, dict[str, Any]], Any]

_seq: dict[str, int] = {}


def _post(url: str, key: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read().decode())
    except Exception:
        return None


def _cfg(base_url: str | None, api_key: str | None) -> tuple[str, str]:
    base = base_url or os.environ.get("EDEN_BASE_URL", "http://127.0.0.1:8787")
    key = api_key or os.environ.get("EDEN_API_KEY", "eden_dev")
    return base, key


def run_tool(
    name: str,
    args: dict[str, Any],
    original: Original,
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    run_id: str | None = None,
    stretch_end: bool = False,
) -> Any:
    base, key = _cfg(base_url, api_key)
    run = run_id or f"sdk-{int(time.time() * 1000)}"
    wrap = _post(f"{base}/v1/wrap", key, {"name": name, "args": args, "run_id": run})
    if wrap and wrap.get("action") == "play":
        return wrap.get("facts") if wrap.get("facts") is not None else wrap.get("text")
    result = original(name, args)
    seq = _seq.get(run, 0) + 1
    _seq[run] = seq
    _post(
        f"{base}/v1/ingest",
        key,
        {
            "agent_id": "sdk_python",
            "run_id": run,
            "stretch_end": stretch_end,
            "events": [{"event_id": str(uuid.uuid4()), "seq": seq, "name": name, "args": args, "ok": True}],
        },
    )
    return result


def end_stretch(
    run_id: str,
    *,
    base_url: str | None = None,
    api_key: str | None = None,
) -> None:
    base, key = _cfg(base_url, api_key)
    _post(f"{base}/v1/ingest", key, {"agent_id": "sdk_python", "run_id": run_id, "stretch_end": True, "events": []})


class Eden:
    def __init__(self, *, base_url: str | None = None, api_key: str | None = None, run_id: str | None = None) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.run_id = run_id or f"sdk-{int(time.time() * 1000)}"

    def run_tool(self, name: str, args: dict[str, Any], original: Original) -> Any:
        return run_tool(name, args, original, base_url=self.base_url, api_key=self.api_key, run_id=self.run_id)

    def end(self) -> None:
        end_stretch(self.run_id, base_url=self.base_url, api_key=self.api_key)
