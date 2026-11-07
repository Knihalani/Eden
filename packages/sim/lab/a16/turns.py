# A16 (docs/research/a16-loop.md): where an arm's agent tokens go, by turn type, from pi-ab timelines
# (STEM.tl/tasks.jsonl). A request is a "tool turn" when the model stopped to call a tool, "final" otherwise.
# Per arm and kind: tasks, requests, tool turns, output tokens per tool turn and per final turn, cache writes of the
# first request and of later requests, and the asks' question length (characters).
# usage: python3 -I turns.py STEM [STEM ...]
import json, sys, collections

agg = collections.defaultdict(collections.Counter)
for stem in sys.argv[1:]:
    for line in open(stem + ".tl/tasks.jsonl"):
        d = json.loads(line)
        if not d["requests"] or d.get("kind") is None:
            continue
        a = agg[(d["condition"], d["kind"])]
        a["n"] += 1
        stops = [e["data"].get("stop") for e in d["events"] if e.get("ev") == "model.request" and e.get("ph") == "E"]
        for i, r in enumerate(d["requests"]):
            tool = i < len(stops) and stops[i] == "toolUse"
            a["req"] += 1
            a["tool"] += tool
            a["out_tool" if tool else "out_final"] += r["out"]
            a["w0" if i == 0 else "wl"] += r.get("cacheWrite") or 0
        for q in d.get("asks", []):
            a["asks"] += 1
            a["qchars"] += len(q["question"])
            a["abytes"] += q["bytes"]
print("arm    kind     n   req  tool  out/tool out/final out/task  write1st writeLater  asks  q.chars  ans.bytes")
for (arm, kind), a in sorted(agg.items()):
    n = a["n"]
    fin = a["req"] - a["tool"]
    print(
        f"{arm:6s} {kind:8s} {n:3d} {a['req']/n:5.2f} {a['tool']/n:5.2f} {a['out_tool']/max(1,a['tool']):8.0f} "
        f"{a['out_final']/max(1,fin):9.0f} {(a['out_tool']+a['out_final'])/n:8.0f} {a['w0']/n:9.0f} {a['wl']/n:10.0f} "
        f"{a['asks']/n:5.2f} {a['qchars']/max(1,a['asks']):8.0f} {a['abytes']/max(1,a['asks']):10.0f}"
    )
