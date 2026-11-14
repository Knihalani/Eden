"""The Python `mcp` SDK's client as one arm of `mcp-compare.bench.ts` (D1860). Run by the bench, under the venv's
Python with `-I`, never from inside the install's directory:

    python -I mcp-compare-client.py --perf <port>
    python -I mcp-compare-client.py --case <port> <case>

The same work and output as the bench's JavaScript arms: `first` once the first call is answered, then one JSON line.
"""

import asyncio
import json
import os
import resource
import sys
import threading
import time

from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp.shared._httpx_utils import create_mcp_http_client

SECRET_HEADERS = {"authorization": "Bearer canary-token", "x-api-key": "canary-key"}
SIZES = [1024, 65_536, 1_048_576]
INFLIGHT = [1, 16, 256]
PAGE = os.sysconf("SC_PAGE_SIZE")


def rss_mb() -> float:
    with open("/proc/self/statm") as f:
        return int(f.read().split()[1]) * PAGE / 2**20


class Opened:
    """One connected client: `call` calls the tool, `close` ends the session."""

    def __init__(self, url: str, timeout_s: float, max_event: int | None):
        self.url, self.timeout_s, self.max_event = url, timeout_s, max_event

    async def __aenter__(self):
        self.http = create_mcp_http_client(headers=SECRET_HEADERS)
        await self.http.__aenter__()
        kwargs = {} if self.max_event is None else {"max_sse_event_size": self.max_event}
        # `legacy`: the initialize handshake, as every other arm (the default probes `server/discover` first).
        self.client = Client(streamable_http_client(self.url, http_client=self.http, **kwargs), mode="legacy")
        await self.client.__aenter__()
        return self

    async def call(self):
        return await self.client.call_tool("search", {"query": "budget"}, read_timeout_seconds=self.timeout_s)

    async def __aexit__(self, *exc):
        try:
            await self.client.__aexit__(None, None, None)
        finally:
            await self.http.__aexit__(None, None, None)


async def run(call, calls: int, inflight: int) -> list[float]:
    lat = [0.0] * calls
    nxt = 0

    async def worker():
        nonlocal nxt
        while nxt < calls:
            i = nxt
            nxt += 1
            t = time.perf_counter()
            await call()
            lat[i] = (time.perf_counter() - t) * 1e6

    await asyncio.gather(*(worker() for _ in range(inflight)))
    return lat


async def perf(port: int) -> None:
    async with Opened(f"http://127.0.0.1:{port}/json/1024/plain/mcp", 60, None) as first:
        await first.call()
        print("first", flush=True)
    cells = []
    # The shapes and modes as the TypeScript bench takes them (`MCP_COMPARE_TEXT`, `MCP_COMPARE_MODES`).
    shapes = os.environ.get("MCP_COMPARE_TEXT", "plain").split(",")
    modes = os.environ.get("MCP_COMPARE_MODES", "json,sse").split(",")
    for shape, mode in [(sh, mo) for sh in shapes for mo in modes]:
        for size in SIZES:
            # The per-event cap raised to Eden's (4 MiB) so a 1 MB event is read; the default is 1 MiB.
            async with Opened(f"http://127.0.0.1:{port}/{mode}/{size}/{shape}/mcp", 120, 4 * 2**20) as c:
                for inflight in INFLIGHT:
                    key = f"{shape} {mode} {size} x{inflight}"
                    calls = max(inflight * 4, min(2_000, (256 * 2**20) // size))
                    try:
                        await run(c.call, max(inflight, calls // 10), inflight)
                        peak = [rss_mb()]
                        stop = threading.Event()

                        def sample():
                            while not stop.wait(0.005):
                                peak[0] = max(peak[0], rss_mb())

                        th = threading.Thread(target=sample, daemon=True)
                        th.start()
                        cpu0 = time.process_time()
                        lat = sorted(await run(c.call, calls, inflight))
                        cpu = time.process_time() - cpu0
                        stop.set()
                        th.join()
                        cells.append(
                            {
                                "key": key,
                                "p50": lat[int(0.5 * (len(lat) - 1))],
                                "p99": lat[int(0.99 * (len(lat) - 1))],
                                "cpu": cpu * 1e6 / calls,
                                "rssMb": max(peak[0], rss_mb()),
                            }
                        )
                    except Exception as e:  # noqa: BLE001 - a failed cell is reported, not fatal
                        cells.append({"key": key, "p50": 0, "p99": 0, "cpu": 0, "rssMb": 0, "error": repr(e)[:200]})
    print(json.dumps({"cells": cells}), flush=True)


async def case(port: int, name: str) -> None:
    t0 = time.perf_counter()
    r0 = resource.getrusage(resource.RUSAGE_SELF)
    try:
        async with Opened(f"http://127.0.0.1:{port}/{name}", 5, None) as c:
            try:
                r = await asyncio.wait_for(c.call(), 25)
                text = r.content[0].text if r.content and hasattr(r.content[0], "text") else ""
                outcome = f"answered ({len(text)} chars)" if len(text) > 20 else f"answered ({text or 'empty'})"
                if getattr(r, "is_error", getattr(r, "isError", False)):
                    outcome = f"error result: {text[:160]}"
            except BaseException as e:  # noqa: BLE001 - any failure is the outcome being measured
                outcome = f"error: {type(e).__name__}: {str(e)[:140]}"
    except BaseException as e:  # noqa: BLE001
        outcome = f"connect error: {type(e).__name__}: {str(e)[:140]}"
    r1 = resource.getrusage(resource.RUSAGE_SELF)
    cpu = (r1.ru_utime - r0.ru_utime + r1.ru_stime - r0.ru_stime) * 1000
    ms = (time.perf_counter() - t0) * 1000
    peak = r1.ru_maxrss / 1024  # kB on Linux
    print(json.dumps({"outcome": outcome, "ms": round(ms), "cpuMs": round(cpu), "maxRssMb": round(peak)}), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "--perf":
        asyncio.run(perf(int(sys.argv[2])))
    else:
        asyncio.run(case(int(sys.argv[2]), sys.argv[3]))
