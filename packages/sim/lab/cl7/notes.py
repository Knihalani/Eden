# Hidden tasks: was the note handed out (an injection with 0 items), and the paired raised outcomes.
import json, sys, collections
for stem in sys.argv[1:]:
    raised, note, items = {}, {}, {}
    d = json.load(open(stem + ".json"))
    for r in d["results"]:
        if r.get("facts") is not None: raised[(r["task"], r["condition"])] = any(r["facts"].values())
    for l in open(stem + ".tl/tasks.jsonl"):
        t = json.loads(l)
        inj = [e["data"] for e in t["events"] if e["ev"] == "eden.inject"]
        note[(t["task"], t["condition"])] = any(x["items"] == 0 for x in inj)
        items[(t["task"], t["condition"])] = sum(x["items"] for x in inj)
        kind = t["kind"]
        items[(t["task"], "kind")] = kind
    c = collections.Counter()
    for (task, cond), v in list(raised.items()):
        if cond != "eden+pushChecked" or (task, "eden") not in raised: continue
        k = items[(task, "kind")]
        c[(k, "note" if note.get((task, cond)) else "no-note", int(raised[(task, "eden")]), int(v))] += 1
    print(stem)
    for k in sorted(c): print("  kind=%s %s eden=%d pc=%d : %d" % (*k, c[k]))
