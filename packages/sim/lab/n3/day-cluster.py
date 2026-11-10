"""N3 (D519): paired differences over `pi-ab --days` runs with whole days resampled (a day's requests share one
agent transcript, so they are not independent), beside the task-level interval a17/days.py prints. Per pair B − A:
hidden raised, asks a task, agent $/1k. 5,000 draws, seed 1.
usage: python3 -I day-cluster.py A,B [A,B ...] -- STEM [STEM ...]"""
import collections, json, random, sys

cut = sys.argv.index("--")
pairs, stems = [p.split(",") for p in sys.argv[1:cut]], sys.argv[cut + 1:]
rows = {}
for stem in stems:
    res = json.load(open(stem + ".json"))
    R = {(r["task"], r["condition"]): r for r in res["results"]}
    sizes = {w["seed"]: w["daySizes"] for w in res["user"]["worlds"]}
    by = collections.defaultdict(list)
    for line in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(line)
        by[t["condition"]].append(t)
    for cond, ts in by.items():
        i = 0
        for d, n in enumerate(sizes[ts[0]["seed"]]):
            for _ in range(n):
                if i >= len(ts):
                    break
                t = ts[i]
                i += 1
                r = R.get((t["task"], cond))
                if not r or r.get("error") or r.get("facts") is None:
                    continue
                rows[(stem, t["task"], cond)] = dict(day=(stem, d), kind=t["kind"], hit=any(r["facts"].values()),
                                                     asks=len(t.get("asks") or []), usd=1000 * r["costUsd"])


def boot(diffs, clusters):
    rnd = random.Random(1)
    g = collections.defaultdict(list)
    for d, c in zip(diffs, clusters):
        g[c].append(d)
    gs, m = list(g.values()), sum(diffs) / len(diffs)
    day = sorted((lambda x: sum(x) / len(x))([d for q in rnd.choices(gs, k=len(gs)) for d in q]) for _ in range(5000))
    task = sorted(sum(rnd.choices(diffs, k=len(diffs))) / len(diffs) for _ in range(5000))
    return f"{m:+.4f} (days {day[125]:+.4f}..{day[4874]:+.4f}, {len(gs)} days; tasks {task[125]:+.4f}..{task[4874]:+.4f})"


for a, b in pairs:
    keys = [(s, t) for (s, t, c) in rows if c == a and (s, t, b) in rows]
    print(f"{b} − {a} (n {len(keys)} tasks)")
    for name, f, kind in (("hidden raised", lambda r: r["hit"], "hidden"), ("asks a task", lambda r: r["asks"], None),
                          ("agent $/1k", lambda r: r["usd"], None)):
        ks = [k for k in keys if kind is None or rows[(*k, a)]["kind"] == kind]
        print(f"  {name:14} n {len(ks):4}  " + boot([f(rows[(*k, b)]) - f(rows[(*k, a)]) for k in ks],
                                                     [rows[(*k, a)]["day"] for k in ks]))
