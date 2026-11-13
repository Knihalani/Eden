import json, sys, gzip

S = sys.argv[1]
cardsp = sys.argv[2]
d = json.load(open(S + "/base.json"))
rows = {(r["suite"], r["seed"], r["variant"], r["template"]): r for r in d["perTask"]}
worlds = {}
for l in open(S + "/corpus.jsonl"):
    w = json.loads(l)
    worlds[(w["suite"], w["seed"], w["variant"])] = w
cards = {}
for l in gzip.open(cardsp, "rt"):
    c = json.loads(l)
    base = c["h"].split(":")[0]
    if c["h"].endswith(":f3") or base not in cards:
        cards[base] = c


def surf(r):
    return bool(r["delivered"] or r.get("askCited"))


out = []
for k, r in rows.items():
    if k[2] != "hidden" or surf(r):
        continue
    w = worlds[k[:3]]
    t = [t for t in w["tasks"] if t["template"] == k[3]][0]
    items = {i["id"]: i for i in w["items"]}
    it = items[t["planted"]]
    cw = worlds[(k[0], k[1], "control")]
    ct = [t for t in cw["tasks"] if t["template"] == k[3]][0]
    citems = {i["id"]: i for i in cw["items"]}
    ci = citems[ct["planted"]]
    cr = rows[(k[0], k[1], "control", k[3])]
    c = cards.get(it["h"], {})
    cc = cards.get(ci["h"], {})
    out.append(
        dict(
            k=k,
            req=t["request"],
            creq=ct["request"],
            row={x: r.get(x) for x in ["cached", "pushPoolAt", "pushHanded", "askCited", "inReplay", "why"]},
            title=it["title"],
            text=it["text"][:600],
            card=c.get("c"),
            r=c.get("r"),
            ctitle=ci["title"],
            ctext=ci["text"][:600],
            ccard=cc.get("c"),
            cr=cc.get("r"),
            csurf=surf(cr),
            cpool=cr.get("pushPoolAt"),
        )
    )
print(len(out))
json.dump(out, open(S + "/miss.json", "w"), indent=1)
