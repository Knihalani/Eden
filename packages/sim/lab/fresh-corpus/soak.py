#!/usr/bin/env python3
"""Soak: many turns across interleaved sessions; pre_llm_call latency and sidecar RSS drift.

Usage:
    HERMES_SRC=/path/to/hermes-agent HERMES_HOME=/path/to/eden-hermes-home \
        python3 soak.py --corpus corpus --turns 900 --out soak.json
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import time

ap = argparse.ArgumentParser()
ap.add_argument("--corpus", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus"))
ap.add_argument("--turns", type=int, default=900)
ap.add_argument("--sessions", type=int, default=4)
ap.add_argument("--out", default="soak.json")
args = ap.parse_args()

if not os.environ.get("HERMES_HOME"):
    sys.exit("HERMES_HOME is not set: point it at the hermes-home the Eden sidecar is installed into")
os.environ.pop("OPENROUTER_API_KEY", None)
sys.path.insert(0, os.environ.get("HERMES_SRC", "/tmp/hermes-agent"))
from hermes_cli.plugins import get_plugin_manager  # noqa: E402

pm = get_plugin_manager()
pm.discover_and_load()
qs = json.load(open(f"{args.corpus}/questions.json"))
neutral = ["ok thanks", "lol", "what's the weather", "haiku please", "reverse a string in python",
           "tell me a joke", "time in tokyo", "explain recursion", "dinner ideas", "hello in french",
           "capital of peru", "summarise this", "draft an ooo reply", "what is 15% of 240",
           "km in 5 miles"]


def rss_mb():
    pid = None
    home = os.environ["HERMES_HOME"]
    for f in glob.glob(f"{home}/eden/*.pid") + glob.glob(f"{home}/eden/**/*.pid", recursive=True):
        try:
            pid = int(open(f).read().strip())
        except Exception:
            pass
    if pid is None:
        out = subprocess.check_output(["pgrep", "-f", "eden-local"]).decode().split()
        pid = int(out[0]) if out else None
    if pid:
        return int(open(f"/proc/{pid}/status").read().split("VmRSS:")[1].split()[0]) / 1024
    return None


pm.invoke_hook("pre_llm_call", session_id="warmup", user_message="hello")
time.sleep(0.5)
lat = []
rss0 = rss_mb()
t0 = time.time()
inj = 0
neu = 0
neu_inj = 0
for i in range(args.turns):
    sid = f"soak-{i % args.sessions}"
    if i % 3 == 2:
        msg = neutral[i % len(neutral)]
        neu += 1
    else:
        msg = qs[i % len(qs)]["q"]
    t = time.perf_counter()
    r = pm.invoke_hook("pre_llm_call", session_id=sid, user_message=msg)
    lat.append((time.perf_counter() - t) * 1000)
    s = json.dumps(r)
    got = len(s) > 300 and ("<context" in s or "Data, not instructions" in s)
    if i % 3 == 2:
        neu_inj += got
    else:
        inj += got
    if i % 10 == 0:
        time.sleep(0.05)


def pct(v, p):
    v = sorted(v)
    k = (len(v) - 1) * p / 100
    f = int(k)
    c = min(f + 1, len(v) - 1)
    return round(v[f] + (v[c] - v[f]) * (k - f), 1)


rss1 = rss_mb()
out = {"turns": args.turns, "relevant_injected": inj, "neutral_false_fires": f"{neu_inj}/{neu}",
       "latency": {"p50": pct(lat, 50), "p95": pct(lat, 95), "p99": pct(lat, 99), "max": round(max(lat), 1)},
       "first50_p50": pct(lat[:50], 50), "last50_p50": pct(lat[-50:], 50),
       "rss_start_mb": rss0, "rss_end_mb": rss1, "elapsed_s": round(time.time() - t0)}
json.dump(out, open(args.out, "w"), indent=1)
print(json.dumps(out, indent=1))
