"""Reader metrics on a funnel JSON, against a baseline funnel JSON on the same tasks.

usage: python3 -I rscore.py BASE.json RUN.json [CACHE.jsonl]
"""
import json, sys, statistics

base = json.load(open(sys.argv[1]))["perTask"]
run = json.load(open(sys.argv[2]))["perTask"]
key = lambda t: (t["suite"], t["variant"], t["seed"], t["template"])
B = {key(t): t for t in base}
surf = lambda t: bool(t["delivered"] or t.get("askCited"))
n = {"hidden": 0, "control": 0}
agg = {v: {"base": 0, "run": 0, "flag": 0, "inpool": 0, "read": 0, "clear": 0, "capped": 0} for v in n}
lat = []
for t in run:
    b = B.get(key(t))
    if b is None:
        continue
    v = t["variant"]
    n[v] += 1
    a = agg[v]
    a["base"] += surf(b)
    a["run"] += surf(t)
    a["flag"] += bool(t.get("readerFlagged"))
    a["inpool"] += bool(t.get("readerInPool"))
    a["read"] += t.get("readerOutcome") == "read"
    a["clear"] += bool(t.get("readerFlags") == 0 and t.get("readerOutcome") == "read")
    ms = t.get("readerModelMs")
    if ms is not None:
        lat.append(ms)
    # With a 2.5 s wait, a call slower than that falls back to the baseline's answer (the packet is unchanged).
    a["capped"] += surf(b) if (ms is not None and ms > 2500) else surf(t)
for v in ("hidden", "control"):
    a = agg[v]
    name = "hidden" if v == "hidden" else "decoy "
    print(
        f"{name} n={n[v]}: surfaced base {a['base']} -> reader {a['run']} (2.5s-capped {a['capped']}); "
        f"reader flagged planted {a['flag']}, planted in reader pool {a['inpool']}, asks read {a['read']}, "
        f"read with nothing flagged {a['clear']}"
    )
if lat:
    lat.sort()
    q = lambda p: lat[min(len(lat) - 1, int(p * len(lat)))]
    print(f"model latency per task call: n={len(lat)} p50 {q(0.5)} ms p90 {q(0.9)} ms, over 2.5 s {sum(x > 2500 for x in lat)}")
kinds = {}
for t in run:
    if t.get("readerFlagged"):
        kinds.setdefault(t["variant"], {}).setdefault(t.get("readerKind"), 0)
        kinds[t["variant"]][t.get("readerKind")] += 1
print("flag kinds:", kinds)
