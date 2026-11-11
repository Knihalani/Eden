"""M1 micro track, gate G1: the short real-constraint fixtures as (request, item) pairs a pair model can score.

M7's 16 hand-written cases carry their requests (`packages/sim/lab/m7/fixtures.json`, D930). M3's 52 short constraints
(`packages/sim/lab/m3r/short-constraints.jsonl`, D908) carry items only: an M2 v2 test fixture takes a request of its
own task (the first group of that world and task), a sim one its template's request (`i1-label.ts pairs`), and the
two hand-written ones a request written here for them. Every fixture should score as binding.

  python3 -I packages/sim/lab/m1-student/fixtures.py --m2-test TEST_PAIRGROUPS.jsonl --pairs PAIRS.jsonl --out F.jsonl
"""
import argparse
import json

# The parent's hand audit (2026-11-11): M3 fixtures whose text, as given, states no binding constraint (the one-sentence
# cut kept a header or a pleasantry). They stay in the length probe; G1 reads the other 43.
DROP = {
    "m2-test/sw-00079/t4": "only 'Thanks for sending over invoice 1043.'",
    "m2-test/sw-00079/t8": "an applicant's pending status; not that the request's second rod is theirs",
    "sim/train5/dinner-guests-vegetarian": "title 'the 7th!!' and a From: line only",
    "sim/train5/wedding-no-plus-ones": "title 'Numbers for the 5th (sorry!!)' and a From: line only",
    "sim/train5/us-travel-authorisation-refused": "'Your application status has changed' and a From: line only",
    "sim/train5/valencia-hotel-night-works": "'A note for guests staying with us this autumn' and a From: line only",
    "sim/train5/passport-away-for-renewal": "'We've received your application' and a From: line only",
    "sim/train5/book-club-dinner-decline": "only 'sorry, meant to tell you last week and it slipped my mind'",
    "sim/train5/tennis-membership-lapsed": "title, then only a To: line",
}

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
        out.append({"src": f"m3r/{f['src']}", "request": req, "today": today, "title": f["title"], "text": f["text"],
                    "audited": f["src"] not in DROP})
    for i, c in enumerate(m7):
        it = c["item"]
        out.append({"src": f"m7/{i}", "audited": True, "request": c["request"], "today": "", "title": it["title"],
                    "text": f"From: {it.get('from', '')}\n{it['text']}" if it.get("from") else it["text"]})
    with open(a.out, "w") as f:
        for r in out:
            f.write(json.dumps(r) + "\n")
    print(f"{len(out)} fixtures -> {a.out}")


if __name__ == "__main__":
    main()
