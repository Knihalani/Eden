"""N5 (docs/research/n5-widen-check.md): an arm against `eden`, paired task by task, for cost and wall.

    python3 -I mix.py [--days] [--cluster template|user|day] --base eden --arms 'eden~K,eden~G' OUT.json [OUT.json ...]

Short runs (one request a session, hidden, control and neutral in equal numbers) are weighted to the 1:1:8 mix: each
kind's mean difference, then 0.1 x hidden + 0.1 x control + 0.8 x neutral. `--days` runs are a 1:1:8 user already: the
plain mean over tasks. Per arm: agent $ and Eden's per-task $ per 1,000 tasks, wall seconds a task, Eden's model calls
a task, the agent's model calls and tool calls a task. Intervals: 95% bootstrap, 5,000 draws, whole clusters resampled
(templates for short runs; users or user-days for `--days`, D519).
"""
import argparse
import json
import random
import re

W = {"hidden": 0.1, "control": 0.1, "neutral": 0.8}
METRICS = {
    "agent $/1k": lambda r: 1000 * r["costUsd"],
    "Eden $/1k": lambda r: 1000 * r.get("edenCostUsd", 0),
    "total $/1k": lambda r: 1000 * (r["costUsd"] + r.get("edenCostUsd", 0)),
    "wall s": lambda r: r["wallMs"] / 1000,
    "Eden calls": lambda r: r.get("edenModelCalls", 0),
    "agent turns": lambda r: r.get("modelCalls", 0),
    "agent tools": lambda r: r.get("toolCalls", 0),
}


def load(files, days):
    rows = {}
    for f in files:
        j = json.load(open(f))
        seed = j["seeds"][0] if j.get("seeds") else 0
        kinds = {t["id"]: t for t in j["tasks"]}
        for r in j["results"]:
            t = kinds.get(r["task"])
            if not t or t["kind"] not in W or "wallMs" not in r:
                continue
            day = re.search(r":day(\d+)", r["task"])
            rows[(seed, r["task"], r["condition"])] = {
                **r, "kind": t["kind"], "template": f"{t['suite']}/{t['type']}", "user": seed,
                "day": f"{seed}:{day.group(1) if day else 0}",
            }
    return rows


def effect(pairs, metric, days):
    if days:
        d = [metric(a) - metric(b) for a, b in pairs]
        return sum(d) / len(d) if d else float("nan")
    out = 0.0
    for kind, w in W.items():
        d = [metric(a) - metric(b) for a, b in pairs if a["kind"] == kind]
        if not d:
            return float("nan")
        out += w * sum(d) / len(d)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--base", default="eden")
    ap.add_argument("--arms", required=True)
    ap.add_argument("--days", action="store_true")
    ap.add_argument("--cluster", default=None)
    ap.add_argument("--draws", type=int, default=5000)
    a = ap.parse_args()
    cluster = a.cluster or ("user" if a.days else "template")
    rows = load(a.files, a.days)
    for arm in a.arms.split(","):
        pairs = [(rows[(s, t, arm)], rows[(s, t, a.base)]) for (s, t, c) in rows if c == arm and (s, t, a.base) in rows]
        by = {}
        for p in pairs:
            by.setdefault(p[0][cluster], []).append(p)
        keys = sorted(by)
        kinds = {k: sum(1 for p in pairs if p[0]["kind"] == k) for k in W}
        print(f"[{arm} - {a.base}] {len(pairs)} pairs ({kinds}), {len(keys)} {cluster}s, "
              f"{'days: plain mean' if a.days else 'short: weighted 1:1:8'}")
        rng = random.Random(5)
        for name, metric in METRICS.items():
            point = effect(pairs, metric, a.days)
            draws = []
            for _ in range(a.draws):
                sample = [p for k in rng.choices(keys, k=len(keys)) for p in by[k]]
                e = effect(sample, metric, a.days)
                if e == e:
                    draws.append(e)
            draws.sort()
            lo, hi = draws[int(0.025 * len(draws))], draws[int(0.975 * len(draws)) - 1]
            level = effect([(b, b) for _, b in pairs], lambda r: 0, a.days)  # noqa: F841
            base = (sum(metric(b) for _, b in pairs) / len(pairs)) if a.days else sum(
                W[k] * (sum(metric(b) for _, b in pairs if b["kind"] == k) / max(1, kinds[k])) for k in W)
            print(f"  {name:12s} {point:+.3f} ({lo:+.3f}..{hi:+.3f})   base {base:.3f}")


main()
