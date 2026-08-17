from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Callable

Original = Callable[[str, dict[str, Any]], Any]


def _read_json(res: Any) -> dict[str, Any] | None:
    try:
        body = json.loads(res.read().decode())
        return body if isinstance(body, dict) else None
    except Exception:
        return None


def _post(url: str, key: str, payload: dict[str, Any], timeout: float = 5) -> dict[str, Any] | None:
    if not key:
        return None
    body = json.dumps(payload).encode()
    wait = 60 if "/v1/wrap-run" in url else timeout
    last: dict[str, Any] | None = None
    for attempt in range(3):
        req = urllib.request.Request(
            url,
            data=body,
            headers={"Authorization": f"Bearer {key}", "content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=wait) as res:
                return _read_json(res)
        except urllib.error.HTTPError as e:
            parsed = _read_json(e)
            if parsed is not None:
                parsed.setdefault("status", e.code)
                last = parsed
            else:
                last = {"error": str(e), "status": e.code}
            if e.code and e.code < 500 and e.code != 429:
                return last
        except Exception:
            last = None
        if attempt < 2:
            time.sleep(0.05 * (2**attempt))
    return last


def _get(url: str, key: str) -> dict[str, Any] | None:
    if not key:
        return None
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return _read_json(res)
    except Exception:
        return None


def _cfg(base_url: str | None, api_key: str | None) -> tuple[str, str]:
    base = base_url or os.environ.get("EDEN_BASE_URL", "http://127.0.0.1:8788")
    key = api_key or os.environ.get("EDEN_API_KEY") or ("eden_dev" if os.environ.get("EDEN_DEV") == "1" else "")
    return base, key


def wrap_tools(
    tools: dict[str, Callable[[dict[str, Any]], Any]],
    *,
    base_url: str | None = None,
    api_key: str | None = None,
    programs: list[dict[str, Any]] | None = None,
) -> dict[str, Callable[[dict[str, Any]], Any]]:
    """Wrap a dict of execute callables. Fail-open if the wrap is down."""
    base, key = _cfg(base_url, api_key)
    live = [p for p in (programs or []) if p.get("manifest")]
    fetched_at = 0.0
    skip_seq = 0
    skip_rest: dict[str, tuple[set[str], dict[str, Any], str]] = {}
    wrap_ok: list[str] = []

    def refresh() -> None:
        nonlocal live, fetched_at
        if not key:
            return
        now = time.time()
        if live and now - fetched_at < 30:
            return
        remote = _get(f"{base.rstrip('/')}/v1/tools", key)
        if remote and isinstance(remote.get("tools"), list):
            rows = [t for t in remote["tools"] if isinstance(t, dict)]
            pulled = [t["program"] for t in rows if t.get("state") == "live" and t.get("program")]
            known = {t["program"].get("id") for t in rows if t.get("program") and t["program"].get("id")}
            local_only = [p for p in live if p.get("manifest") and p.get("id") not in known]
            live = pulled + local_only
            fetched_at = now

    if not live:
        refresh()
    else:
        fetched_at = time.time()
    wrapped: dict[str, Callable[[dict[str, Any]], Any]] = {}

    def fallback(p: dict[str, Any], tool_name: str, args: dict[str, Any], hit: dict[str, Any] | None) -> Any:
        first = (p.get("sequence") or [None])[0]
        orig = tools.get(str(first)) if first else None
        if orig is None:
            orig = tools.get(tool_name)
        early = bool(hit and (hit.get("early") or "witness envelope" in str(hit.get("reason") or "")))
        down = hit is None
        if (early or down) and orig:
            return orig(args)
        if hit and (hit.get("deopt") or hit.get("error")):
            return {"eden": str(hit.get("error") or "deopt"), "reason": hit.get("reason")}
        if orig:
            return orig(args)
        raise RuntimeError(f"compiled tool {tool_name} unavailable")

    def make(name: str, fn: Callable[[dict[str, Any]], Any]) -> Callable[[dict[str, Any]], Any]:
        def execute(args: dict[str, Any]) -> Any:
            nonlocal skip_seq
            refresh()
            for p in live:
                n = str(p.get("name") or "")
                if n:
                    compiled_fn = live_get(n)
                    if compiled_fn:
                        wrapped[n] = compiled_fn
            is_start = any((p.get("sequence") or [None])[0] == name for p in live)
            hits = [p for p in live if (p.get("sequence") or [None])[0] == name]
            hits.sort(key=lambda p: len(p.get("sequence") or []), reverse=True)
            wrap_ok.clear()
            for p in hits:
                compiled = live_get(p["name"])
                if compiled is None:
                    continue
                value = compiled(args)
                pid = str(p.get("id") or p.get("name") or "")
                if pid and pid in wrap_ok:
                    skip_seq += 1
                    skip_rest[f"{pid}#{skip_seq}"] = (set((p.get("sequence") or [])[1:]), dict(args), pid)
                elif is_start and pid:
                    for sid, armed in list(skip_rest.items()):
                        if armed[2] == pid:
                            skip_rest.pop(sid, None)
                return value
            for sid, (rest, armed, _pid) in list(skip_rest.items()):
                if name not in rest:
                    continue
                if args != armed:
                    continue
                rest.discard(name)
                if not rest:
                    skip_rest.pop(sid, None)
                return {"eden": "steered", "skipped": name}
            return fn(args)

        return execute

    def live_get(tool_name: str) -> Callable[[dict[str, Any]], Any] | None:
        p = next((x for x in live if x.get("name") == tool_name), None)
        if not p:
            return None

        def compiled(args: dict[str, Any]) -> Any:
            refresh()
            current = next((x for x in live if x.get("name") == tool_name), None)
            if not current:
                orig = tools.get(tool_name)
                if orig:
                    return orig(args)
                raise RuntimeError(f"compiled tool {tool_name} unavailable")
            b, k = _cfg(base_url, api_key)
            hit = _post(
                f"{b.rstrip('/')}/v1/wrap-run",
                k,
                {"program": current, "input": args, "timeoutMs": int(os.environ.get("EDEN_TIMEOUT_MS", "60000") or "60000")},
            )
            if hit and "value" in hit:
                wrap_ok.append(str(current.get("id") or current.get("name") or tool_name))
                return hit["value"]
            return fallback(current, tool_name, args, hit)

        return compiled

    for name, fn in tools.items():
        wrapped[name] = make(name, fn)
    for p in live:
        fn = live_get(str(p["name"]))
        if fn:
            wrapped[str(p["name"])] = fn
    return wrapped


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
    wrap = _post(
        f"{base.rstrip('/')}/v1/wrap-run",
        key,
        {
            "program": {"name": name},
            "input": args,
            "timeoutMs": int(os.environ.get("EDEN_TIMEOUT_MS", "60000") or "60000"),
        },
    )
    if wrap and "value" in wrap:
        return wrap["value"]
    return original(name, args)


class Eden:
    def __init__(self, *, base_url: str | None = None, api_key: str | None = None, run_id: str | None = None) -> None:
        self.base_url = base_url
        self.api_key = api_key
        self.run_id = run_id or f"sdk-{int(time.time() * 1000)}"

    def wrap_tools(self, tools: dict[str, Callable[[dict[str, Any]], Any]]) -> dict[str, Callable[[dict[str, Any]], Any]]:
        return wrap_tools(tools, base_url=self.base_url, api_key=self.api_key)
