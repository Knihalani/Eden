"""M3 (D908): the tagger's length-invariance gate fixture, short real constraints built deterministically (no model).

Each fixture is a fact cut to a connector-style snippet: its title plus the one body sentence that shares the most
content words with what makes it binding (an M2 test task's `detail`; for the sim's train5-6 facts, whose worlds carry
no detail, the request). Sources: M2 v2's test split (first N tasks in file order) and the sim's held-out train5-6
(the tagger trained on train1-4), plus two hand-written fixtures. Every line should read as a constraint.

  python3 -I short_fixture.py --m2 worlds-test.jsonl --sim train-worlds.jsonl.gz --out short-constraints.jsonl
"""
import argparse, gzip, json, re

STOP = set("the a an and or of to in on for with is are be was this that it as at by from your you i we not no".split())
words = lambda s: {w for w in re.findall(r"[a-z0-9]+", s.lower()) if w not in STOP and len(w) > 2}  # noqa: E731


def sentences(body):
    out = []
    for line in body.split("\n"):
        out += [s.strip() for s in re.split(r"(?<=[.!?])\s+", line) if len(s.strip().split()) >= 4]
    return out


def snippet(item, key):
    lines = item["text"].split("\n", 1) if "title" not in item else [item["title"], item["text"]]
    title, body = (lines + [""])[:2] if "title" not in item else lines
    ss = sentences(body) or [body.strip()[:200]]
    best = max(ss, key=lambda s: (len(words(s) & words(key)), -ss.index(s)))
    return {"title": title.strip(), "text": best}


if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--m2", required=True)
    a.add_argument("--sim", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--m2-n", type=int, default=30)
    a.add_argument("--sim-n", type=int, default=20)
    o = a.parse_args()
    rows = [
        {"src": "hand", "title": "Zed Quinn contract on hold",
         "text": "Do not pay Zed Quinn: the Globex renewal payment is on hold until legal signs off"},
        {"src": "hand", "title": "Harlow venue", "text": "Payments to Harlow are on hold until the deposit dispute ends."},
    ]
    n = 0
    for line in open(o.m2):
        w = json.loads(line)
        by = {i["id"]: i for i in w["items"]}
        for t in w["tasks"]:
            if n >= o.m2_n:
                break
            if t["fact"] in by:
                rows.append({"src": f"m2-test/{w['id']}/{t['id']}", **snippet(by[t["fact"]], t["detail"])})
                n += 1
        if n >= o.m2_n:
            break
    w = json.loads(gzip.open(o.sim, "rt").readline())
    by = {i["id"]: i for i in w["items"]}
    seen = set()
    for t in w["tasks"]:
        if t["suite"] in ("train5", "train6") and t["template"] not in seen and t["pos"] in by and len(seen) < o.sim_n:
            seen.add(t["template"])
            rows.append({"src": f"sim/{t['suite']}/{t['template']}", **snippet(by[t["pos"]], t["request"])})
    with open(o.out, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"{len(rows)} short constraints -> {o.out}")
