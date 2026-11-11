"""M3b (D914): H10's engine-drawn pairs. The `pushSupersede` trial scores, for each handed candidate, every newer
non-bulk item of the push pool; a funnel run over synth train worlds with `+stale` and the lab superseder's trace
(M3B_SUPERSEDE_TRACE, M3B_SUPERSEDE_TRACE_TEXT=1) records each such pair with its texts. A pair is a positive when it
is a task's (stale version, its fact): in M2 v2 every `revisionOf` pair is a silent-change task's (decoy, fact), and
`+stale` keeps exactly those decoys, so every other pool pair is a negative.

  python -I h10_pool_pairs.py --trace T1.jsonl [T2 ...] --rows R1.json [R2 ...] --out pairs.jsonl
Writes one {"a", "b", "y", "src"} line a distinct (a, b) text pair.
"""
import argparse, json

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--trace", nargs="+", required=True)
    ap.add_argument("--rows", nargs="+", required=True, help="the funnel's --json files of the same runs, in order")
    ap.add_argument("--out", required=True)
    o = ap.parse_args()
    seen, n, pos = {}, 0, 0
    for tf, rf in zip(o.trace, o.rows):
        positives = set()
        for t in json.load(open(rf))["perTask"]:
            if "staleId" in t:
                positives.add((t["user"], t["staleId"], t["factId"]))
        for line in open(tf):
            x = json.loads(line)
            n += 1
            y = int((x["user"], x["older"], x["newer"]) in positives)
            key = (x["a"], x["b"])
            # A pair met under several requests keeps the label its own ids gave (the same texts, the same label).
            if key not in seen or y:
                seen[key] = y
    with open(o.out, "w") as f:
        for (a, b), y in seen.items():
            pos += y
            f.write(json.dumps({"a": a, "b": b, "y": y, "src": "pool"}) + "\n")
    print(json.dumps({"scored": n, "distinct": len(seen), "positives": pos}))
