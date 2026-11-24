"""What the Python client costs an agent's turn over a real network (D2115): the turn's observe plus N tool steps,
against a running Eden server reached through a TLS terminator and a relay that delays every chunk ``--rtt-ms / 2``
each way. TCP connect latency is not emulated (the relay accepts at once), so a client that opens a connection per
call is measured cheaper than it would be.

    bun run dev   # or any server, e.g. EDEN_DEV=1 PORT=8799 ...
    python3 packages/client-python/bench_rtt.py --server http://127.0.0.1:8799 [--rtt-ms 40] [--steps 5] [--turns 12]
        [--client DIR]   # another eden_client to compare (e.g. a `git show` of an older one), once per --client

Modes: ``two-calls`` reports with observe then ``pending`` per step (``collect``), ``one-call`` with ``observe_all``
(skipped for a client without it). Needs ``openssl`` for the throwaway certificate. Lab only: nothing is recorded.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import os
import ssl
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse


def relay(server: str, rtt_ms: float, cert: str, key: str) -> int:
    """Starts the TLS terminator and the delaying relay on a thread; the relay's port."""
    target = urllib.parse.urlsplit(server)
    delay = rtt_ms / 2000
    ready: list = []

    async def pipe(r, w, d):
        q: asyncio.Queue = asyncio.Queue()

        async def rd():
            while True:
                b = await r.read(65536)
                await q.put((asyncio.get_running_loop().time() + d, b))
                if not b:
                    return

        async def wr():
            while True:
                t, b = await q.get()
                await asyncio.sleep(max(0.0, t - asyncio.get_running_loop().time()))
                if not b:
                    w.close()
                    return
                w.write(b)
                await w.drain()

        await asyncio.gather(rd(), wr(), return_exceptions=True)

    def forward(host, port, d):
        async def handle(r, w):
            ur, uw = await asyncio.open_connection(host, port)
            await asyncio.gather(pipe(r, uw, d), pipe(ur, w, d), return_exceptions=True)
        return handle

    async def main():
        asyncio.get_running_loop().set_exception_handler(lambda *_: None)  # a client hanging up is not news
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(cert, key)
        tls = await asyncio.start_server(forward(target.hostname, target.port or 80, 0), "127.0.0.1", 0, ssl=ctx)
        tls_port = tls.sockets[0].getsockname()[1]
        lag = await asyncio.start_server(forward("127.0.0.1", tls_port, delay), "127.0.0.1", 0)
        ready.append(lag.sockets[0].getsockname()[1])
        await asyncio.gather(tls.serve_forever(), lag.serve_forever())

    threading.Thread(target=lambda: asyncio.run(main()), daemon=True).start()
    while not ready:
        time.sleep(0.01)
    return ready[0]


def run(client_dir: str, mode: str, url: str, steps: int, turns: int, tag: str) -> None:
    sys.path.insert(0, client_dir)
    for name in [m for m in sys.modules if m == "eden_client" or m.startswith("eden_client.")]:
        del sys.modules[name]
    mod = importlib.import_module("eden_client")
    sys.path.pop(0)
    if mode == "one-call" and not hasattr(mod.EdenClient, "observe_all"):
        return
    errors: list = []
    xs = []
    for i in range(turns):
        c = mod.EdenClient(user_id="bench-rtt", session_id=f"{tag}-{mode}-{i}-{os.getpid()}", base_url=url,
                           timeout_s=5, on_error=errors.append, bypass_proxies=True)
        t = time.perf_counter()
        turn = {"kind": "user_message", "text": "Move lunch with Priya Raman to Friday"}
        if mode == "one-call":
            c.observe_all(turn)
            for k in range(steps):
                c.observe_all({"kind": "tool_result", "tool": "terminal", "output": f"ok {k}"})
        else:
            c.collect(c.observe(turn)["injection"])
            for k in range(steps):
                c.observe({"kind": "tool_result", "tool": "terminal", "output": f"ok {k}"})
                c.pending()
        xs.append((time.perf_counter() - t) * 1000)
    print(f"{tag:>10} {mode:>9}: turn + {steps} tool steps p50 {statistics.median(xs):.0f} ms "
          f"(min {min(xs):.0f}, max {max(xs):.0f}, n {turns}){f', {len(errors)} errors' if errors else ''}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", required=True)
    ap.add_argument("--rtt-ms", type=float, default=40)
    ap.add_argument("--steps", type=int, default=5)
    ap.add_argument("--turns", type=int, default=12)
    ap.add_argument("--client", action="append", default=[])
    a = ap.parse_args()
    with tempfile.TemporaryDirectory() as d:
        cert, key = os.path.join(d, "cert.pem"), os.path.join(d, "key.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
                        "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
                       check=True, capture_output=True)
        os.environ["SSL_CERT_FILE"] = cert  # the throwaway certificate is the only one trusted, in this process
        url = f"https://localhost:{relay(a.server, a.rtt_ms, cert, key)}"
        here = os.path.dirname(os.path.abspath(__file__))
        for tag, path in [("this", here)] + [(f"client{n}", p) for n, p in enumerate(a.client)]:
            for mode in ("two-calls", "one-call"):
                run(path, mode, url, a.steps, a.turns, tag)
    sys.stdout.flush()
    os._exit(0)  # the relay's thread holds open connections: no teardown chatter


if __name__ == "__main__":
    main()
