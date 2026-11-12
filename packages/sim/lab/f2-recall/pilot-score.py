"""F2's subagent-simulated pilot (docs/research/f2-push-recall.md §5): each arm's replies read by the shipped rule.

    python3 -I pilot-score.py PILOT_DIR

Per arm and stratum (rows the recorded API check dropped or kept the planted item on, control rows with the
look-alike in the pool, neutral rows): planted named, look-alike named, rows with any yes. Then each arm against W
row by row (gained, lost), with W2 (the shipped check asked again) as the noise floor, and subagent W against the
recorded API answers on the same rows (how far the stand-in is from the real check). A reply that cannot be read
counts as the check failing open (named nothing new here).
"""
import collections
import json
import os
import re
import sys

NO_HIT = re.compile(r"^\s*(?:(?:none|n/a)(?![\w]).*|(?:nothing|no)?\s*\.?\s*)$", re.I | re.S)


def parse(reply, n):
    """The shipped `parseCompare`: yes needs act true and a hits that lands; None when unreadable."""
    if not isinstance(reply, str) or not re.match(r'^\s*\{\s*"items"\s*:\s*\[', reply):
        return None
    try:
        ents = json.loads(reply[reply.index("{"):reply.rindex("}") + 1])["items"]
    except Exception:
        return None
    out = []
    for e in ents[:12]:
        if not isinstance(e, dict):
            return None
        if e.get("act") not in (True, "true"):
            continue
        hits = e.get("hits")
        if hits is not None and not isinstance(hits, str):
            return None
        if hits is None or NO_HIT.match(hits):
            continue
        i = e.get("i")
        i = int(i) if isinstance(i, str) and i.isdigit() else i
        if not isinstance(i, int) or not 1 <= i <= n:
            return None
        if i - 1 not in out and len(out) < 5:
            out.append(i - 1)
    return out


def main():
    d = sys.argv[1]
    meta = {m["id"]: m for m in json.load(open(os.path.join(d, "meta.json")))}
    named = collections.defaultdict(dict)  # arm -> id -> set of item ids, or None
    for f in sorted(os.listdir(os.path.join(d, "out"))):
        arm = f.rsplit("-", 1)[0]
        for line in open(os.path.join(d, "out", f)):
            if not line.strip():
                continue
            r = json.loads(line)
            m = meta[r["id"]]
            at = parse(r["reply"] if isinstance(r["reply"], str) else json.dumps(r["reply"]), len(m["items"]))
            named[arm][r["id"]] = None if at is None else {m["items"][i] for i in at}
    named["API"] = {i: set(m["recorded"] or []) for i, m in meta.items()}
    strata = ["dropped", "kept", "control", "neutral"]
    print("subagent-simulated pilot; API = the recorded live check on the same rows")
    print(f"{'arm':4} {'rows':>4} {'unread':>6} " + " ".join(f"{s:>9}" for s in strata) + "  (planted / look-alike / any yes)")
    for arm in ["API", "W", "W2", "A", "R"]:
        if arm not in named:
            continue
        got = named[arm]
        cells = []
        for s in strata:
            ids = [i for i, m in meta.items() if m["stratum"] == s and i in got]
            if s == "neutral":
                k = sum(bool(got[i]) for i in ids)
            else:
                k = sum(got[i] is not None and meta[i]["planted"] in got[i] for i in ids)
            cells.append(f"{k:>4}/{len(ids):<4}")
        unread = sum(v is None for v in got.values())
        print(f"{arm:4} {len(got):>4} {unread:>6} " + " ".join(f"{c:>9}" for c in cells))
    print("\nrow by row against W (planted or look-alike named; neutral: any yes), gained/lost:")
    for arm in ["API", "W2", "A", "R"]:
        if arm not in named or "W" not in named:
            continue
        row = []
        for s in strata:
            g = l = 0
            for i, m in meta.items():
                if m["stratum"] != s or i not in named[arm] or i not in named["W"]:
                    continue
                f = (lambda x: bool(x)) if s == "neutral" else (lambda x, p=m["planted"]: x is not None and p in x)
                a, w = f(named[arm][i]), f(named["W"][i])
                g += a and not w
                l += w and not a
            row.append(f"{s} +{g} -{l}")
        print(f"  {arm:4} " + "; ".join(row))


if __name__ == "__main__":
    main()
