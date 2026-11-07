# A17: hidden tasks whose planted item reached the agent in this request's packet, split by whether a packet or ask
# had handed it earlier that day (a re-show) or not, raised rate per arm. usage: python3 -I reshown.py STEM [STEM ...]
import json, sys, collections
c = collections.defaultdict(lambda: collections.Counter())
for stem in sys.argv[1:]:
    res = json.load(open(stem + ".json"))
    R = {(r["task"], r["condition"]): r for r in res["results"]}
    sizes = {w["seed"]: w["daySizes"] for w in res["user"]["worlds"]}
    ts = collections.defaultdict(list)
    for l in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(l); ts[(t["condition"], t["seed"])].append(t)
    for (cond, seed), xs in ts.items():
        i = 0
        for n in sizes[seed]:
            seen = set()
            for _ in range(n):
                if i >= len(xs): break
                t = xs[i]; i += 1
                pl = t.get("planted"); cited = t.get("cited") or []
                r = R.get((t["task"], cond))
                if t["kind"] == "hidden" and pl and pl in cited and r and r.get("facts") is not None:
                    w = "reshown" if pl in seen else "first"
                    c[cond][w] += 1; c[cond][w + "+"] += any(r["facts"].values())
                seen.update(cited); seen.update(t.get("askCited") or [])
for cond, v in sorted(c.items()):
    print(cond, " ".join(f"{w} {v[w+'+']}/{v[w]}" for w in ["first", "reshown"]))
