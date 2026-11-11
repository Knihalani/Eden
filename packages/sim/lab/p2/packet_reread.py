"""P2 (weak point C1): how many packet characters the agent reads again over a day, per arm, from pi-ab `--days` runs.

    python3 -I packet_reread.py --base eden OUT.json [OUT.json ...]

A day is a run of `user.worlds[0].daySizes` tasks; the agent's transcript keeps every packet of the day (D336's kept
layout, the shipped one). The day's recap turn is not counted (it is not a graded task). Every model request of a task reads the day's earlier packets and the task's own
again, so a task re-reads (packet characters handed earlier that day + its own) x its model requests. Per arm, per
task: packet characters handed, characters re-read, the same in
tokens at 4 characters a token **[EST]**, and the agent's measured prompt tokens a task (`promptTokens`: plain, cache
read and cache write together); against `--base`, the paired difference of each, intervals by whole users resampled.
"""
import argparse
import json
import random
from collections import defaultdict


def rows_of(path):
    j = json.load(open(path))
    seed = j["seeds"][0] if j.get("seeds") else 0
    order = [t["id"] for t in j["tasks"]]
    kind = {t["id"]: t.get("kind") for t in j["tasks"]}
    res = defaultdict(dict)
    for r in j["results"]:
        res[r["condition"]][r["task"]] = r
    # Day boundaries: the run's day sizes (`user.worlds[0].daySizes`), which sum to the task list.
    sizes = j["user"]["worlds"][0]["daySizes"]
    starts, at = set(), 0
    for n in sizes:
        starts.add(at)
        at += n
    out = {}
    for cond, by in res.items():
        day_chars = 0
        per = {}
        for k, tid in enumerate(order):
            if k in starts:
                day_chars = 0
            r = by.get(tid)
            if not r or kind.get(tid) is None:
                continue
            own = r.get("injectedChars", 0)
            calls = r.get("modelCalls", 0)
            per[tid] = {"handed": own, "reread": (day_chars + own) * calls, "prompt": r.get("promptTokens", 0)}
            day_chars += own
        out[cond] = per
    return seed, out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="eden")
    ap.add_argument("files", nargs="+")
    a = ap.parse_args()
    users = {}
    for f in a.files:
        seed, out = rows_of(f)
        users[seed] = out
    conds = sorted({c for u in users.values() for c in u})
    keys = ("handed", "reread", "prompt")
    print(f"{'arm':12} {'tasks':>6} {'handed ch/t':>12} {'re-read ch/t':>13} {'re-read tok/t [EST]':>20} {'agent prompt tok/t':>19}")
    for c in conds:
        rs = [v for u in users.values() for v in u.get(c, {}).values()]
        if not rs:
            continue
        m = {k: sum(r[k] for r in rs) / len(rs) for k in keys}
        print(f"{c:12} {len(rs):6d} {m['handed']:12.0f} {m['reread']:13.0f} {m['reread'] / 4:20.0f} {m['prompt']:19.0f}")
    rnd = random.Random(1)
    for c in conds:
        if c == a.base:
            continue
        pairs = {s: [(u[c][t], u[a.base][t]) for t in u.get(c, {}) if t in u.get(a.base, {})] for s, u in users.items()}
        pairs = {s: p for s, p in pairs.items() if p}
        if not pairs:
            continue
        def diff(sel, k):
            ps = [p for s in sel for p in pairs[s]]
            return sum(x[k] - y[k] for x, y in ps) / max(1, len(ps))
        line = [f"{c} - {a.base}:"]
        for k in keys:
            est = diff(list(pairs), k)
            boots = sorted(diff([rnd.choice(list(pairs)) for _ in pairs], k) for _ in range(2000))
            line.append(f"{k} {est:+.0f} ({boots[50]:+.0f}..{boots[1949]:+.0f})")
        print("  ".join(line))


if __name__ == "__main__":
    main()
