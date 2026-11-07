"""S2's live Pi analysis (docs/research/fix-s2-rules.md): each arm against `eden`, paired by task.

Usage: python3 -I analyze.py out.json name=file1,file2,... [name=...]
Rates per kind: hidden facts raised (hidden), false concerns (control), any concern (neutral); a task's rate is the
share of its must facts the grader found true. Paired differences arm - eden with a bootstrap 95% interval over tasks
(10,000 resamples, fixed seed). Also wall p50, Eden's per-task $ and the agent's $ per 1,000 tasks, and items injected.
"""

import json
import random
import statistics
import sys

BASE = "eden"


def load(files):
    tasks, res, dropped = {}, {}, 0
    for f in files:
        d = json.load(open(f))
        for t in d["tasks"]:
            tasks[t["id"]] = t["kind"]
        for r in d["results"]:
            if r.get("error") or not r.get("facts"):
                dropped += 1
                continue
            key = (r["task"], r["condition"])
            if key in res:
                raise SystemExit(f"{f}: {key} is in two files (pass one run per seed)")
            v = list(r["facts"].values())
            res[key] = {
                "rate": sum(1 for x in v if x) / len(v),
                "wall": r["wallMs"] / 1000,
                "eden": r.get("edenCostUsd", 0),
                "agent": r["costUsd"],
                "items": r.get("injectedItems", 0),
            }
    if dropped:
        print(f"  dropped {dropped} results with an error or no facts")
    return tasks, res


def boot(diffs, n=10_000, seed=7):
    rng = random.Random(seed)
    k = len(diffs)
    means = sorted(sum(diffs[rng.randrange(k)] for _ in range(k)) / k for _ in range(n))
    return means[int(0.025 * n)], means[int(0.975 * n) - 1]


def main():
    out, groups = sys.argv[1], sys.argv[2:]
    report = {}
    for g in groups:
        name, files = g.split("=", 1)
        tasks, res = load(files.split(","))
        arms = sorted({c for (_, c) in res})
        rows = {}
        for kind in ("hidden", "control", "neutral"):
            ids = [t for t, k in tasks.items() if k == kind]
            if not ids:
                continue
            for arm in arms:
                have = [t for t in ids if (t, arm) in res]
                if not have:
                    continue
                x = [res[(t, arm)] for t in have]
                row = {
                    "n": len(have),
                    "rate": round(sum(r["rate"] for r in x) / len(x), 4),
                    "wallP50": round(statistics.median(r["wall"] for r in x), 2),
                    "edenPer1k": round(1000 * sum(r["eden"] for r in x) / len(x), 4),
                    "agentPer1k": round(1000 * sum(r["agent"] for r in x) / len(x), 4),
                    "itemsPerTask": round(sum(r["items"] for r in x) / len(x), 3),
                }
                if arm != BASE:
                    paired = [t for t in have if (t, BASE) in res]
                    row["paired"] = len(paired)
                    if not paired:
                        rows[f"{kind}/{arm}"] = row
                        continue
                    for key in ("rate", "wall", "eden"):
                        d = [res[(t, arm)][key] - res[(t, BASE)][key] for t in paired]
                        lo, hi = boot(d)
                        scale = 1000 if key == "eden" else 1
                        row[f"d_{key}"] = [
                            round(scale * sum(d) / len(d), 4),
                            round(scale * lo, 4),
                            round(scale * hi, 4),
                        ]
                rows[f"{kind}/{arm}"] = row
        report[name] = rows
        print(f"== {name}")
        for k, r in rows.items():
            print(f"  {k:45s} {json.dumps(r)}")
    json.dump(report, open(out, "w"), indent=1)


main()
