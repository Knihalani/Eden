"""F6 pilot report ("subagent-simulated, single-shot"; docs/research/f6-uptake.md).

    python3 -I packages/sim/lab/f6/pilot-report.py SELECTED.json PROMPTS.json GRADES.jsonl PK_BASE,... PK_CHECKED,...

GRADES.jsonl lines: {"id": "<task>|<arm>", "facts": {"1": true, ...}}. A task raised (hidden) or a concern
(control) when any fact is true. Uptake = raised among hidden tasks whose packet (that arm's) cites the planted item.
Each lever against `base`: paired by task (the same task in both arms), McNemar exact two-sided p, and a 95%
bootstrap over templates (2,000 resamples, seed 7).
"""

import collections
import json
import math
import random
import sys

sel_f, prompts_f, grades_f, pk_base, pk_checked = sys.argv[1:6]
sel = {s["id"]: s for s in json.load(open(sel_f))}
prompts = {p["id"]: p for p in json.load(open(prompts_f))}
grades = {}
for line in open(grades_f):
    if line.strip():
        g = json.loads(line)
        grades[g["id"]] = any(bool(v) for v in g["facts"].values())


def pk(files):
    out = {}
    for f in files.split(","):
        for line in open(f):
            r = json.loads(line)
            ids = [i for p in r["packets"] for i in p["ids"]]
            out[(r["suite"], r["variant"], r["template"])] = (r["planted"] in ids, len(ids), sum(len(p["text"].encode()) for p in r["packets"]))
    return out


PK = {"base": pk(pk_base), "checked": pk(pk_checked)}
PK["guide"] = PK["base"]
arms = ["base", "checked", "guide"]
rows = []
for tid, s in sel.items():
    k = (s["suite"], s["variant"], s["template"])
    for a in arms:
        if f"{tid}|{a}" not in grades:
            continue
        planted, n, b = PK[a][k]
        rows.append(dict(task=tid, arm=a, kind=s["variant"], suite=s["suite"], tmpl=f"{s['suite']}:{s['template']}",
                         flag=grades[f"{tid}|{a}"], planted=planted, items=n, bytes=b))
done = collections.Counter(r["task"] for r in rows)
rows = [r for r in rows if done[r["task"]] == len(arms)]
print(f"subagent-simulated, single-shot pilot: {len(done)} tasks, {sum(1 for t in done.values() if t == 3)} graded in every arm")


def summary(xs):
    h = [x for x in xs if x["kind"] == "hidden"]
    up = [x for x in h if x["planted"]]
    c = [x for x in xs if x["kind"] == "control"]
    pk_ = [x for x in xs if x["items"]]
    return (sum(x["flag"] for x in h), len(h), sum(x["flag"] for x in up), len(up), sum(x["flag"] for x in c), len(c),
            sum(x["bytes"] for x in pk_) / max(1, len(pk_)))


for scope, f in (("all", lambda r: True), ("train", lambda r: r["suite"].startswith("train")),
                 ("dev20", lambda r: r["suite"].startswith("dev20"))):
    print(f"== {scope}")
    for a in arms:
        h, hn, u, un, c, cn, b = summary([r for r in rows if r["arm"] == a and f(r)])
        print(f"  {a:8} hidden {h}/{hn} ({h / max(1, hn):.1%})  uptake {u}/{un} ({u / max(1, un):.1%})  concerns {c}/{cn}  B/packet {b:.0f}")
    for a in ("checked", "guide"):
        base = {r["task"]: r for r in rows if r["arm"] == "base" and f(r)}
        arm = {r["task"]: r for r in rows if r["arm"] == a and f(r)}
        # Uptake pairs: hidden tasks with the planted item in both arms' packets.
        pairs = [(base[t], arm[t]) for t in base if base[t]["kind"] == "hidden" and base[t]["planted"] and arm[t]["planted"]]
        up = sum(1 for b, x in pairs if x["flag"] and not b["flag"])
        down = sum(1 for b, x in pairs if b["flag"] and not x["flag"])
        n = up + down
        p = min(1.0, 2 * sum(math.comb(n, i) for i in range(0, min(up, down) + 1)) / 2**n) if n else 1.0
        by = collections.defaultdict(list)
        for b, x in pairs:
            by[b["tmpl"]].append(int(x["flag"]) - int(b["flag"]))
        keys = sorted(by)
        rnd = random.Random(7)
        ds = []
        for _ in range(2000):
            d = [v for k in rnd.choices(keys, k=len(keys)) for v in by[k]]
            ds.append(100 * sum(d) / max(1, len(d)))
        ds.sort()
        point = 100 * (up - down) / max(1, len(pairs))
        cb = sum(r["flag"] for r in base.values() if r["kind"] == "control")
        ca = sum(r["flag"] for r in arm.values() if r["kind"] == "control")
        hb = sum(r["flag"] for r in base.values() if r["kind"] == "hidden")
        ha = sum(r["flag"] for r in arm.values() if r["kind"] == "hidden")
        print(f"  {a} vs base: uptake {point:+.1f} points ({ds[50]:+.1f}..{ds[1949]:+.1f}), {up} up / {down} down of "
              f"{len(pairs)} pairs, McNemar p={p:.3f}; hidden {ha - hb:+d}; control concerns {cb} -> {ca}")
