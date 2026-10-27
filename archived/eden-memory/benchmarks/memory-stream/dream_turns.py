"""C11-E2: the hook-side half of the action registry. For each dev judge-sample human turn, Jev answers one yes/no
question per action type of `dream/actions.json` ("does this turn involve …"), in one parallel request.

    TYPESAFE_API_KEY=… python3 benchmarks/memory-stream/dream_turns.py --world code
    → dream/<world>/turn-actions.json: {event: {type: p}}, plus per-call latency in dream/<world>/turn-calls.jsonl
"""
import argparse, glob, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from verify_jev import env, call, noul

QUESTION = ("Does the user's newest message `turn` ask the assistant to do, plan, decide or answer something that "
            "involves the activity in `activity`?")


def run(world, limit=0):
    import score, judge, methods
    cfg = env()
    if not cfg["TYPESAFE_API_KEY"]:
        sys.exit("TYPESAFE_API_KEY must be set (environment or .env)")
    types = json.load(open(os.path.join(HERE, "dream", "actions.json")))
    stream, _ = score.load_stream(world)
    jud = set()
    for p in glob.glob(os.path.join(HERE, "judge", f"{world}-sleep", "in", "*.json")):
        jud |= {c["event"] for c in json.load(open(p))["cases"]}
    evs = [e for e in score.scored_events(stream) if e["_split"] == "dev" and e["t"] == "human" and e["id"] in jud]
    d = os.path.join(HERE, "dream", world)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, "turn-actions.json")
    out = json.load(open(path)) if os.path.exists(path) else {}
    log = open(os.path.join(d, "turn-calls.jsonl"), "a")
    for e in sorted(evs, key=lambda e: e["_order"])[: limit or None]:
        if e["id"] in out:
            continue
        state = {"turn": methods.strip_paste(e["text_all"])[:3000], "recent": judge.context(stream, e["id"], 4)}
        qs = {k: {"type": "noul", "instructions": {"activity": v, "question": QUESTION}} for k, v in types.items()}
        reply, secs, attempts = call(cfg, state, qs)
        ans = reply.get("answers", {})
        out[e["id"]] = {k: noul(ans.get(k)) for k in types}
        log.write(json.dumps({"event": e["id"], "latency_s": round(secs, 3), "attempts": attempts,
                              "usage": reply.get("usage", {})}) + "\n")
        log.flush()
        json.dump(out, open(path, "w"), indent=1)
    print(world, len(out), "turns classified")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--world", required=True)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    run(a.world, a.limit)
