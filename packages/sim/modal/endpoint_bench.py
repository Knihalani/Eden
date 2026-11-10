"""The distilled card endpoint's latency and throughput (M2, lab tooling, no Modal library): the held-out rows' card
calls sent to an OpenAI-compatible endpoint, once at concurrency 1 (one user's background drain: per-call latency)
and once at concurrency N (a shared server's backfill: items per GPU-second). The prompts are the export's, Eden's
exact card call; the key is read from EDEN_LAB_CARDS_KEY and never printed.

    python3 -I packages/sim/modal/endpoint_bench.py --url https://…modal.run --data .local/modal/cards/data \
      --gpu L4 --concurrency 1,16 --out .local/modal/cards/<run>/bench.json

Run it against a warm endpoint (one call first, not timed) so a cold start is not in the figures; the GPU-seconds
of a concurrency-N pass are its wall time on the endpoint's one GPU (one container: max_inputs 32, not scaled out).
"""
import argparse
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import distill_data as dd  # noqa: E402


def call(base, key, row, timeout=300):
    body = json.dumps({"model": dd.SERVED_NAME, "messages": row["messages"][:2], "temperature": 0,
                       "max_tokens": int(row["maxTokens"]),
                       # As Eden's card call asks (`json: true`, sent as response_format): guided JSON on vLLM.
                       "response_format": {"type": "json_object"}}).encode()
    req = urllib.request.Request(f"{base}/v1/chat/completions", data=body, method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = json.load(r)
    except Exception as e:  # a dropped call is counted, not fatal: the pass reports how many failed
        return {"ms": round((time.time() - t0) * 1000), "error": type(e).__name__, "items": len(row["keys"])}
    usage = out.get("usage") or {}
    finish = ((out.get("choices") or [{}])[0]).get("finish_reason")
    return {"ms": round((time.time() - t0) * 1000), "in": usage.get("prompt_tokens", 0),
            "out": usage.get("completion_tokens", 0), "items": len(row["keys"]), "cut": finish == "length"}


def run_pass(base, key, rows, concurrency):
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        got = list(pool.map(lambda r: call(base, key, r), rows))
    wall = time.time() - t0
    failed = [g for g in got if "error" in g]
    got = [g for g in got if "error" not in g]
    if not got:
        return {"concurrency": concurrency, "failed": len(failed), "errors": sorted({g["error"] for g in failed})}
    ms = [g["ms"] for g in got]
    items = sum(g["items"] for g in got)
    return {"concurrency": concurrency, "calls": len(got), "failed": len(failed),
            "errors": sorted({g["error"] for g in failed}), "items": items, "wallSeconds": round(wall, 1),
            "p50ms": dd.percentile(ms, 50), "p90ms": dd.percentile(ms, 90), "maxMs": max(ms),
            "tokensInPerCall": round(sum(g["in"] for g in got) / len(got)),
            "tokensOutPerCall": round(sum(g["out"] for g in got) / len(got)),
            "cutAtMaxTokens": sum(g["cut"] for g in got),
            "itemsPerGpuSecond": round(items / wall, 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--gpu", required=True, choices=sorted(dd.GPU_USD_PER_HOUR))
    ap.add_argument("--concurrency", default="1,16")
    ap.add_argument("--limit", type=int, default=0, help="rows per pass (0: all 61)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    key = os.environ.get("EDEN_LAB_CARDS_KEY", "")
    if not key:
        sys.exit("EDEN_LAB_CARDS_KEY is not set")
    base = a.url.rstrip("/").removesuffix("/v1")
    rows = dd.load_rows(os.path.join(a.data, "heldout.jsonl"))
    rows = rows[: a.limit] if a.limit else rows
    call(base, key, rows[0])  # warm, not timed
    passes = []
    for c in [int(x) for x in a.concurrency.split(",")]:
        p = run_pass(base, key, rows, c)
        if "items" in p:
            p["usdPer1000Items"] = dd.usd_per_1000_items(a.gpu, p["wallSeconds"], p["items"])
        passes.append(p)
        print(json.dumps(p))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as f:
        json.dump({"gpu": a.gpu, "usdPerHour": dd.GPU_USD_PER_HOUR[a.gpu], "passes": passes}, f, indent=2)


if __name__ == "__main__":
    main()
