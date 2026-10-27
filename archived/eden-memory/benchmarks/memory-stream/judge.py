"""LLM-judge ceiling (F8) on StreamBench: a strong model sees the turn, its recent context and every visible row
of a store, and picks the rows the agent needs now (often none). It costs far too much for a hook; it measures
what a non-lexical decision could reach on the same store.

    python3 benchmarks/memory-stream/judge.py prep --world code --store sleep [--per 15] [--neg 110] [--nonhuman 30]
    python3 benchmarks/memory-stream/score.py --world code --store sleep --systems judge   (reads judge/<world>-<store>/out)

The sample: every dev need event (human and trigger), plus a seeded random sample of dev no-need human events and
non-human events. Metrics on a sample are reported with the sample's sizes. The base-rate rows reweight need and
no-need events, so they stay valid.
"""
import argparse, glob, json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def context(stream, eid, n=6):
    for s in stream["sessions"]:
        ids = [e["id"] for e in s["events"]]
        if eid in ids:
            at = ids.index(eid)
            prev = [e for e in s["events"][:at] if e["t"] in ("human", "assistant", "trigger", "peer", "notification")]
            return [{"t": e["t"], "text": e["text_all"][:600]} for e in prev[-n:]]
    return []


def prep(a):
    import score, sleep
    stream, items = score.load_stream(a.world)
    evs = [e for e in score.scored_events(stream) if e["_split"] == "dev" and e["t"] != "tool"]
    rows = sleep.rows(stream, a.world, strict=a.strict) if a.store == "sleep" else score.oracle_store(stream, items, evs)
    rng = random.Random(7)
    need = [e for e in evs if set(e["labels"]["needs"]) - set(e["labels"].get("in_context", []))]
    negh = [e for e in evs if e["t"] in ("human", "trigger") and e not in need]
    nonh = [e for e in evs if e["t"] in ("notification", "peer")]
    pick = need + rng.sample(negh, min(a.neg, len(negh))) + rng.sample(nonh, min(a.nonhuman, len(nonh)))
    rng.shuffle(pick)
    d = os.path.join(HERE, "judge", f"{a.world}-{a.store}")
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    for b in range(0, len(pick), a.per):
        part = pick[b:b + a.per]
        cases = [{"event": e["id"], "at": e["_order"], "type": e["t"], "text": e["text_all"][:3000],
                  "recent": context(stream, e["id"])} for e in part]
        last = max(c["at"] for c in cases)
        store = [{"id": r["id"], "from": r["t"], "until": r.get("invalid_at"), "text": r["text"]}
                 for r in rows if r["t"] < last]
        name = f"j{b // a.per:02d}"
        json.dump({"batch": name, "store": store, "cases": cases,
                   "output": f"benchmarks/memory-stream/judge/{a.world}-{a.store}/out/{name}.json"},
                  open(os.path.join(d, "in", f"{name}.json"), "w"), ensure_ascii=False, indent=1)
        print(name, len(cases), "cases", len(store), "rows")


def prep_seq(a):
    """One case per file, each with the store visible at its own moment (C4-E9: batching flatters a verifier).
    A seeded subsample of the existing judge sample's human events."""
    src = os.path.join(HERE, "judge", f"{a.world}-sleep", "in")
    rows, cases = {}, []
    for p in sorted(glob.glob(os.path.join(src, "*.json"))):
        j = json.load(open(p))
        rows.update({r["id"]: r for r in j["store"]})
        cases += [c for c in j["cases"] if c["type"] == "human"]
    rng = random.Random(21)
    pick = sorted(rng.sample(cases, min(a.n, len(cases))), key=lambda c: c["at"])
    d = os.path.join(HERE, "judge", f"{a.world}-sleep-seq")
    os.makedirs(os.path.join(d, "in"), exist_ok=True)
    os.makedirs(os.path.join(d, "out"), exist_ok=True)
    for n, c in enumerate(pick):
        store = [r for r in rows.values() if r["from"] < c["at"] and (r["until"] is None or r["until"] > c["at"])]
        name = f"s{n:03d}"
        json.dump({"batch": name, "store": sorted(store, key=lambda r: r["from"]), "cases": [c],
                   "output": f"benchmarks/memory-stream/judge/{a.world}-sleep-seq/out/{name}.json"},
                  open(os.path.join(d, "in", f"{name}.json"), "w"), ensure_ascii=False, indent=1)
    print(len(pick), "cases")


def packets(world, store, tag=""):
    out = {}
    sub = f"{world}-{store}" + (f"-{tag}" if tag else "")
    for p in glob.glob(os.path.join(HERE, "judge", sub, "out", "*.json")):
        for c in json.load(open(p))["cases"]:
            out[c["event"]] = c.get("needed", [])
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["prep", "prep-seq"])
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--world", required=True)
    ap.add_argument("--store", default="sleep")
    ap.add_argument("--per", type=int, default=15)
    ap.add_argument("--neg", type=int, default=110)
    ap.add_argument("--nonhuman", type=int, default=30)
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args()
    prep_seq(a) if a.cmd == "prep-seq" else prep(a)
