# F2 (A): the intent requests of planted items, decoys and other items, with word-overlap statistics against their
# own item. usage: python3 -I look.py CORPUS.jsonl INTENT.jsonl[.gz] [N samples]
import gzip, json, re, sys, random
STOP = set("a an the of to in on at for with and or is are was be been am do does did my me i you your we our it its this that these those from by as about into over up out if so not no can could should would will what when where who how which there their them they he she his her have has had just any some need want get".split())
def terms(t):
    return {w for w in re.findall(r"[a-z0-9][a-z0-9'-]*", t.lower()) if len(w) > 1 and w not in STOP}
def stem(w):
    for s in ("ing", "ed", "es", "s"):
        if len(w) > len(s) + 3 and w.endswith(s): return w[: -len(s)]
    return w
def st(t): return {stem(w) for w in terms(t)}
op = lambda f: gzip.open(f, "rt") if f.endswith(".gz") else open(f)
req = {}
for l in op(sys.argv[2]):
    d = json.loads(l); req[d["h"]] = d.get("r") or []
random.seed(1)
planted, other = [], []
for l in open(sys.argv[1]):
    w = json.loads(l)
    pl = {t["planted"] for t in w["tasks"]}
    for it in w["items"]:
        (planted if it["id"] in pl else other).append((w["variant"], it))
def share(it):
    body = st(it["title"] + " " + it["text"]); out = []
    for r in req.get(it["h"], []):
        q = st(r); out.append((len(q & body) / max(1, len(q)), r))
    return out
for name, group in (("planted hidden", [i for v, i in planted if v == "hidden"]), ("planted control (decoy)", [i for v, i in planted if v == "control"]), ("other", [i for v, i in other])):
    sh = [s for it in group for s, _ in share(it)]
    none = sum(1 for it in group if not req.get(it["h"]))
    if not sh: continue
    sh.sort()
    q = lambda p: sh[int(p * (len(sh) - 1))]
    print(f"{name}: items {len(group)}, without requests {none}, requests {len(sh)}, overlap share p10 {q(.1):.2f} p25 {q(.25):.2f} p50 {q(.5):.2f} p75 {q(.75):.2f}; zero-overlap {sum(1 for s in sh if s == 0)}")
n = int(sys.argv[3]) if len(sys.argv) > 3 else 0
for v, it in random.sample(planted, n):
    print("\n", v, it["id"], "|", it["title"], "|", it["text"][-260:].replace("\n", " "))
    for s, r in share(it): print(f"    {s:.2f}  {r}")
