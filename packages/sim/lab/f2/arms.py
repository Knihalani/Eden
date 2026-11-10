# F2 (C): each pi-ab shard's hidden-raised and control-concern rates per arm, and the agent's $ per 1,000 task runs
# (docs/research/f2-quality.md). usage: python3 -I arms.py STEM [STEM ...]   (STEM.json, a pi-ab results file)
import json, sys
tot = {}
for stem in sys.argv[1:]:
    d = json.load(open(stem + ".json"))
    kinds = {t["id"]: t["kind"] for t in d["tasks"]}
    arms = {}
    for r in d["results"]:
        if not r.get("facts"):
            continue
        a = arms.setdefault(r["condition"], {"hidden": [], "control": [], "usd": []})
        a[kinds[r["task"]]].append(float(any(r["facts"].values())))
        a["usd"].append(r["costUsd"])
    bg = d.get("background")
    for name, a in arms.items():
        t = tot.setdefault(name, {"hidden": [], "control": [], "usd": []})
        for k in t:
            t[k] += a[k]
        print(f"seeds {d['seeds']} {name:11s} hidden {sum(a['hidden']):.0f}/{len(a['hidden'])} = {sum(a['hidden'])/len(a['hidden']):.3f}"
              f"  concerns {sum(a['control']):.0f}/{len(a['control'])}  agent $/1k {1000*sum(a['usd'])/len(a['usd']):.3f}")
for name, t in tot.items():
    print(f"all {name:11s} hidden {sum(t['hidden']):.0f}/{len(t['hidden'])} = {sum(t['hidden'])/len(t['hidden']):.3f}"
          f"  concerns {sum(t['control']):.0f}/{len(t['control'])}  agent $/1k {1000*sum(t['usd'])/len(t['usd']):.3f}")
