#!/usr/bin/env python3
"""A/B runner: hermes -z with the Eden plugin vs a control arm that searches the same corpus as files.

Per question per arm: `hermes -z <question> --yolo -m <model> --provider openrouter --usage-file <f>`.
The Eden arm runs with HERMES_HOME=<eden-home> in an empty cwd; the control arm with
HERMES_HOME=<ctl-home> in <corpus>/files. Per-run records land in <out>/ab/, token usage in
<out>/usage/. Paid model calls — check the spend before running the full set (--limit first).

Usage:
    python3 ab_run.py --corpus corpus --hermes /path/to/.venv/bin/hermes \
        --eden-home /path/to/eden-hermes-home --ctl-home /path/to/ctl-hermes-home \
        --model deepseek/deepseek-v3.2 --out runs/2026-11
"""
import argparse
import concurrent.futures as cf
import json
import os
import subprocess
import time

ap = argparse.ArgumentParser()
ap.add_argument("--corpus", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "corpus"))
ap.add_argument("--hermes", default="/tmp/hermes-agent/.venv/bin/hermes", help="hermes CLI binary")
ap.add_argument("--eden-home", default="/tmp/hermes-home", help="HERMES_HOME with the Eden plugin installed")
ap.add_argument("--ctl-home", default="/tmp/hermes-ctl", help="plain HERMES_HOME for the control arm")
ap.add_argument("--eden-cwd", default=None, help="cwd for the Eden arm (default: an empty dir under --out)")
ap.add_argument("--ctl-cwd", default=None, help="cwd for the control arm (default: <corpus>/files)")
ap.add_argument("--model", default="deepseek/deepseek-v3.2")
ap.add_argument("--provider", default="openrouter")
ap.add_argument("--out", required=True, help="run directory: ab/ records and usage/ go under it")
ap.add_argument("--arms", default="eden,ctl")
ap.add_argument("--parallel", type=int, default=3)
ap.add_argument("--timeout", type=int, default=300)
ap.add_argument("--limit", type=int, default=None, help="only the first N questions (smoke runs)")
args = ap.parse_args()

QS = json.load(open(f"{args.corpus}/questions.json"))
if args.limit:
    QS = QS[: args.limit]
OUT = args.out
os.makedirs(f"{OUT}/ab", exist_ok=True)
os.makedirs(f"{OUT}/usage", exist_ok=True)
EDEN_CWD = args.eden_cwd or os.path.join(OUT, "empty")
os.makedirs(EDEN_CWD, exist_ok=True)
CTL_CWD = args.ctl_cwd or f"{args.corpus}/files"
ARMS = [a for a in args.arms.split(",") if a in ("eden", "ctl")]
if not ARMS:
    raise SystemExit("--arms must name eden and/or ctl")


def run(arm, q):
    home = args.eden_home if arm == "eden" else args.ctl_home
    cwd = EDEN_CWD if arm == "eden" else CTL_CWD
    uf = f"{OUT}/usage/{arm}-{q['id']}.json"
    env = dict(os.environ, HERMES_HOME=home)
    t0 = time.time()
    try:
        p = subprocess.run(
            [args.hermes, "-z", q["q"], "--yolo", "-m", args.model,
             "--provider", args.provider, "--usage-file", uf],
            cwd=cwd, env=env, capture_output=True, text=True, timeout=args.timeout)
        out = p.stdout + ("\n[stderr] " + p.stderr[-2000:] if p.returncode else "")
        rc = p.returncode
    except subprocess.TimeoutExpired:
        out = "[TIMEOUT]"
        rc = 124
    dt = time.time() - t0
    usage = {}
    try:
        usage = json.load(open(uf))
    except Exception:
        pass
    rec = {"id": q["id"], "arm": arm, "rc": rc, "secs": round(dt, 1), "answer": out[-4000:], "usage": usage}
    json.dump(rec, open(f"{OUT}/ab/{arm}-{q['id']}.json", "w"))
    return rec


jobs = [(arm, q) for q in QS for arm in ARMS]
done = 0
with cf.ThreadPoolExecutor(args.parallel) as ex:
    for rec in ex.map(lambda j: run(*j), jobs):
        done += 1
        if done % 10 == 0:
            print(f"{done}/{len(jobs)}", flush=True)
print("done", done, "→", f"{OUT}/ab")
