# A16 (D336): for each arm's hidden tasks over a user's days, where the planted item reached the agent: this
# request's packet, an ask's answer, only an EARLIER request's packet that day (which an ephemeral layout then no
# longer shows), or nowhere; and how many of each were raised. Reads STEM.json (grades) and STEM.tl/tasks.jsonl.
# usage: python3 -I earlier.py STEM [STEM ...]
import json, sys, collections

out = collections.defaultdict(collections.Counter)
for stem in sys.argv[1:]:
    graded = {}
    for r in json.load(open(stem + ".json"))["results"]:
        if r.get("facts") is not None:
            graded[(r["task"], r["condition"])] = any(r["facts"].values())
    seen = collections.defaultdict(set)  # (arm, day) -> item ids in earlier packets
    for line in open(stem + ".tl/tasks.jsonl"):
        d = json.loads(line)
        arm, task = d["condition"], d["task"]
        day = task.split(":day")[1].split(":")[0] if ":day" in task else "?"
        key = (stem, arm, day)
        cited = set(d.get("cited", []))
        if d.get("kind") == "hidden" and d.get("planted") and (task, arm) in graded:
            p = d["planted"]
            where = (
                "this packet" if p in cited
                else "ask" if p in d.get("askCited", [])
                else "earlier packet only" if p in seen[key]
                else "nowhere"
            )
            out[arm][where] += 1
            out[arm][where + " raised"] += graded[(task, arm)]
        seen[key] |= cited
print("arm               this packet   ask   earlier packet only   nowhere   (raised of each)")
for arm, c in sorted(out.items()):
    cells = [f"{c[w]:3d} ({c[w + ' raised']:2d})" for w in ["this packet", "ask", "earlier packet only", "nowhere"]]
    print(f"{arm:17s} " + "   ".join(cells))
