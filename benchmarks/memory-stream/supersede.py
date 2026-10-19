"""Cross-batch supersession at sleep (C5-E5).

The sleep compiler reads one batch of sessions at a time, and its `supersede` op can only name a row of the same
batch (sleep.rows prefixes ids with the current batch). A fact that changes in a later batch leaves the old row live
forever: in the code store, 3 of 375 rows ever get `invalid_at`; "the API is Express 4" and "the repo pins yarn" stay
visible after the migrations. C5-E4's downstream losses on no-need turns were mostly such stale rows.

This pass runs after each batch, as the sleep step would: a model sees the batch's new rows and every older row still
live, and lists the older rows each new row replaces (a corrected fact, a changed state, a finished task, a moved
date). sleep.rows(..., supersede=True) then sets the old row's invalid_at to the new row's time.

    python3 benchmarks/memory-stream/supersede.py prep --world code
    score.py --store sleep --strict --supersede ...
"""
import argparse, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def prep(world):
    import score, sleep
    stream, _ = score.load_stream(world)
    rows = sleep.rows(stream, world, strict=True)
    d = os.path.join(HERE, "sleep", world, "supersede")
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    batches = sorted({r["id"].split(":")[0] for r in rows})
    for b in batches[1:]:
        new = [r for r in rows if r["id"].startswith(b + ":")]
        t = min(r["t"] for r in new)
        old = [r for r in rows if r["t"] < t and (r["invalid_at"] is None or r["invalid_at"] > t)]
        json.dump({"batch": b, "new": [{"id": r["id"], "text": r["text"]} for r in new],
                   "older": [{"id": r["id"], "text": r["text"]} for r in old],
                   "output": f"benchmarks/memory-stream/sleep/{world}/supersede/out/{b}.json"},
                  open(os.path.join(d, "in", f"{b}.json"), "w"), indent=1, ensure_ascii=False)
        print(b, len(new), "new rows,", len(old), "older live rows")


def pairs(world):
    """{old row id: new row id} from the pass's outputs."""
    out = {}
    for p in glob.glob(os.path.join(HERE, "sleep", world, "supersede", "out", "*.json")):
        for x in json.load(open(p)).get("superseded", []):
            out.setdefault(x["old"], x["new"])
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep"])
    ap.add_argument("--world", required=True)
    a = ap.parse_args()
    prep(a.world)
