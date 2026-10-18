"""Sleep-compiled stores for StreamBench (family F11, SLEEP-SPEC.md).

    python3 benchmarks/memory-stream/sleep.py prep --world code [--batch 10]   # label-free inputs per batch
    python3 benchmarks/memory-stream/sleep.py stats --world code               # what the compiled store holds

`prep` writes `sleep/<world>/in/<batch>.json`: the raw sessions with every label removed. The sleep compiler
(an LLM subagent on a different model from the authors) writes `sleep/<world>/out/<batch>.json`. `rows()` turns
those ops into store rows, each visible from the end of the session that produced it (event order). A superseded
or dropped row is invalid from the end of the session that superseded or dropped it.

Batches are compiled in parallel, each with no view of the others. Duplicates across batches stay in the store,
as a write path without global dedup would leave them. A supersede can only name a row of its own batch.
"""
import argparse, glob, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
KEEP = ("t", "k", "text", "name", "input", "output", "task", "report", "from", "summary")


def prep(world, batch):
    stream = json.load(open(os.path.join(HERE, "worlds", world, "stream.json")))
    d = os.path.join(HERE, "sleep", world, "in")
    os.makedirs(d, exist_ok=True)
    ss = stream["sessions"]
    for b in range(0, len(ss), batch):
        part = ss[b:b + batch]
        name = f"{world}-sleep-b{b // batch:02d}"
        sessions = [{"id": s["id"], "ts": s["ts"], "kind": s["kind"],
                     "events": [{k: e[k] for k in KEEP if k in e} for e in s["events"]]} for s in part]
        json.dump({"batch": name, "store_before": [], "sessions": sessions,
                   "output": f"benchmarks/memory-stream/sleep/{world}/out/{name}.json"},
                  open(os.path.join(d, f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(sessions))


def rows(stream, world, tag="out", strict=False):
    """Store rows from the compiled ops: {id, text, kind, when, t, invalid_at} with t in event order.

    strict=True (leak-free): a batch's rows become visible only after the batch's last session. The compiler read the
    whole batch at once, so a row written for an early session may carry cues taken from a later one."""
    end = {}
    order = 0
    for s in stream["sessions"]:
        for e in s["events"]:
            order += 1
            e.setdefault("_order", order)
        end[s["id"]] = max((e["_order"] for e in s["events"]), default=order)
    out = {}
    for p in sorted(glob.glob(os.path.join(HERE, "sleep", world, tag, "*.json"))):
        d = json.load(open(p))
        last = max((end.get(s["id"], 0) for s in d["sessions"]), default=0)
        for s in d["sessions"]:
            t = last if strict else end.get(s["id"])
            if t is None:
                continue
            for op in s.get("ops", []):
                kind = op.get("op")
                if kind == "add" and op.get("text"):
                    rid = f"{d['batch']}:{op['id']}"
                    out[rid] = {"id": rid, "text": op["text"], "kind": op.get("kind"), "when": op.get("when") or {},
                                "entities": op.get("entities") or [], "t": t + 0.5, "invalid_at": None}
                elif kind == "supersede":
                    rid = f"{d['batch']}:{op.get('old')}"
                    if rid in out:
                        out[rid]["invalid_at"] = t + 0.5
                elif kind == "drop":
                    rid = f"{d['batch']}:{op.get('id')}"
                    if rid in out:
                        out[rid]["invalid_at"] = t + 0.5
    return list(out.values())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep", "stats"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--batch", type=int, default=10)
    a = ap.parse_args()
    if a.cmd == "prep":
        prep(a.world, a.batch)
    else:
        stream = json.load(open(os.path.join(HERE, "worlds", a.world, "stream.json")))
        r = rows(stream, a.world)
        print(len(r), "rows,", sum(1 for x in r if x["invalid_at"]), "invalidated")
