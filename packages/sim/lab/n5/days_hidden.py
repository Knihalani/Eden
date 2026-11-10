"""N5: hidden facts raised over a `--days` run, an arm against `eden`, with whole users resampled (D519: a day's
requests share one transcript, so a task-level or template-level interval is too narrow there).

    python3 -I days_hidden.py --base eden --arms 'eden~K,eden~G' RUN_DIR/s*/

Sonnet's verdict (regrade-sonnet.json beside out.json) replaces the run's grader's wherever Sonnet graded the answer.
"""
import argparse
import json
import os
import random


def load(dirs):
    rows = {}
    for d in dirs:
        j = json.load(open(os.path.join(d, "out.json")))
        seed = j["seeds"][0]
        kinds = {t["id"]: t["kind"] for t in j["tasks"]}
        sonnet = {}
        p = os.path.join(d, "regrade-sonnet.json")
        if os.path.exists(p):
            for g in json.load(open(p))["graded"]:
                if g.get("readable", True):
                    sonnet[(g["task"], g["condition"])] = all(g["facts"].values()) if g["facts"] else False
        for r in j["results"]:
            if kinds.get(r["task"]) != "hidden" or not r.get("facts"):
                continue
            raised = sonnet.get((r["task"], r["condition"]), all(r["facts"].values()))
            rows[(seed, r["task"], r["condition"])] = raised
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dirs", nargs="+")
    ap.add_argument("--base", default="eden")
    ap.add_argument("--arms", required=True)
    ap.add_argument("--draws", type=int, default=5000)
    a = ap.parse_args()
    rows = load(a.dirs)
    for arm in a.arms.split(","):
        pairs = [(s, rows[(s, t, arm)], rows[(s, t, a.base)]) for (s, t, c) in rows if c == arm and (s, t, a.base) in rows]
        n = len(pairs)
        point = 100 * sum(x - y for _, x, y in pairs) / n
        by = {}
        for s, x, y in pairs:
            by.setdefault(s, []).append(x - y)
        keys = sorted(by)
        rng = random.Random(5)
        draws = []
        for _ in range(a.draws):
            d = [v for k in rng.choices(keys, k=len(keys)) for v in by[k]]
            draws.append(100 * sum(d) / len(d))
        draws.sort()
        print(f"[{arm} - {a.base}] hidden raised {point:+.1f} points; n {n}; "
              f"{100 * sum(x for _, x, _ in pairs) / n:.1f} vs {100 * sum(y for _, _, y in pairs) / n:.1f}; "
              f"by user ({len(keys)}): {draws[int(0.025 * len(draws))]:+.1f}..{draws[int(0.975 * len(draws)) - 1]:+.1f}")

main()
