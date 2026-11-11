"""M1 micro track, gate G1: the short real-constraint fixtures as (request, item) pairs a pair model can score.

M7's 16 hand-written cases carry their requests (`packages/sim/lab/m7/fixtures.json`, D930). M3's 52 short constraints
(`packages/sim/lab/m3r/short-constraints.jsonl`, D908) carry items only: an M2 v2 test fixture takes a request of its
own task (the first group of that world and task), a sim one its template's request (`i1-label.ts pairs`), and the
two hand-written ones a request written here for them. Every fixture should score as binding.

  python3 -I packages/sim/lab/m1-student/fixtures.py --m2-test TEST_PAIRGROUPS.jsonl --pairs PAIRS.jsonl --out F.jsonl
"""
import argparse
import json

HAND = {
    "Zed Quinn contract on hold": "Pay the Globex renewal invoice from Zed Quinn today.",
    "Harlow venue": "Pay the Harlow venue deposit invoice.",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--m2-test", required=True)
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    m3 = [json.loads(l) for l in open("packages/sim/lab/m3r/short-constraints.jsonl")]
    m7 = json.load(open("packages/sim/lab/m7/fixtures.json"))["cases"]
    want = {f["src"].split("/", 1)[1] for f in m3 if f["src"].startswith("m2-test/")}
    m2req = {}
    for l in open(a.m2_test):
        g = json.loads(l)
        key = f"{g['world']}/{g['task']}"
        if key in want and key not in m2req and not g.get("neutral"):
            m2req[key] = (g["request"], g.get("today", ""))
    simreq = {}
    for l in open(a.pairs):
        g = json.loads(l)
        simreq.setdefault(f"{g['suite']}/{g['template']}", (g["request"], g.get("today", "")))
    out = []
    for f in m3:
        kind, _, key = f["src"].partition("/")
        if kind == "hand":
            req, today = HAND[f["title"]], ""
        elif kind == "m2-test":
            req, today = m2req[key]
        else:
            req, today = simreq[key]
        out.append({"src": f"m3r/{f['src']}", "request": req, "today": today, "title": f["title"], "text": f["text"]})
    for i, c in enumerate(m7):
        it = c["item"]
        out.append({"src": f"m7/{i}", "request": c["request"], "today": "", "title": it["title"],
                    "text": f"From: {it.get('from', '')}\n{it['text']}" if it.get("from") else it["text"]})
    with open(a.out, "w") as f:
        for r in out:
            f.write(json.dumps(r) + "\n")
    print(f"{len(out)} fixtures -> {a.out}")


if __name__ == "__main__":
    main()
