"""F13 agent-pull: the host model decides when memory is needed and what to ask; the hook never injects.

The agent sees the turn, its recent context and a one-screen **memory index**: the store's most frequent entity
phrases, with how many rows each has. It may call `recall(query)`. A call runs lexical retrieval with compiled cues on
the sleep store (strict visibility) for its query and returns at most `k` rows. The cost is model tokens on every
turn, plus one tool round-trip when it calls. The hook's latency is unchanged.

    python3 benchmarks/memory-stream/agentpull.py prep --world code     # cases = the judge sample's events
    score.py --world code --store sleep --strict --systems "pull:k=2"  # reads agentpull/<world>/out
"""
import argparse, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def index(rows, at, n=30):
    count = {}
    for r in rows:
        if r["t"] < at and (r.get("invalid_at") is None or r["invalid_at"] > at):
            for k in r.get("entities") or []:
                k = k.strip()
                if k:
                    count[k] = count.get(k, 0) + 1
    top = sorted(count, key=lambda k: (-count[k], k))[:n]
    return [f"{k} ({count[k]})" for k in top]


def prep(world, per):
    import score, sleep, judge
    stream, items = score.load_stream(world)
    evs = {e["id"]: e for e in score.scored_events(stream)}
    rows = sleep.rows(stream, world, strict=True)
    ids = []
    for p in sorted(glob.glob(os.path.join(HERE, "judge", f"{world}-sleep", "in", "*.json"))):
        ids += [c["event"] for c in json.load(open(p))["cases"]]
    d = os.path.join(HERE, "agentpull", world)
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    for b in range(0, len(ids), per):
        cases = []
        for eid in ids[b:b + per]:
            e = evs[eid]
            cases.append({"event": eid, "type": e["t"], "text": e["text_all"][:2500],
                          "recent": judge.context(stream, eid), "memory_index": index(rows, e["_order"])})
        name = f"p{b // per:02d}"
        json.dump({"batch": name, "cases": cases, "output": f"benchmarks/memory-stream/agentpull/{world}/out/{name}.json"},
                  open(os.path.join(d, "in", f"{name}.json"), "w"), indent=1, ensure_ascii=False)
        print(name, len(cases))


def calls(world):
    out = {}
    for p in glob.glob(os.path.join(HERE, "agentpull", world, "out", "*.json")):
        for c in json.load(open(p))["cases"]:
            out[c["event"]] = c.get("query") if c.get("call") else None
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep"])
    ap.add_argument("--world", required=True)
    ap.add_argument("--per", type=int, default=55)
    a = ap.parse_args()
    prep(a.world, a.per)
